import { config } from '../core/config.ts'
import { captureImageSegments, getQuoted, quoteBody, quoteLabel } from './message.ts'
import { chatImageScope, imageLabel, truncateImageText } from './images.ts'
import { formatNow, truncate } from '../core/util.ts'
import { observeUsers, knownName, rememberMessage } from './roster.ts'
import { markChatterHandled, recordChatter, updateChatterImages } from './chatter.ts'

interface Line {
  t: number
  uid: string
  name: string
  text: string
  /** quoted (replied-to) message; its text shares the line's character budget */
  quote?: { label: string; text: string; labels: string[] }
  mid?: string
  bot?: boolean
  /** conversation (session key) whose history already contains this line */
  conv?: string
}

// Room for a 100-message context plus the trigger and messages queued after it.
const MAX_LINES = 200
const logs = new Map<string, Line[]>()

const keyOf = (e: any) => `${e?.self_id}:${e?.group_id}`

/** Short one-line rendering of a message's segments for ambient context. */
export function briefSegments(message: any[], selfId?: any): string {
  let out = ''
  for (const s of message ?? []) {
    switch (s?.type) {
      case 'text':
        out += s.text ?? ''
        break
      case 'at':
        out += `[at:${String(s.qq) === String(selfId) ? 'you' : s.qq}]${s.name ? `(${s.name})` : ''} `
        break
      case 'image':
        out += s.sub_type == 1 || /表情/.test(s.summary ?? '') ? '[表情包]' : '[图片]'
        break
      case 'mface':
        out += `[表情:${(s.summary ?? '').replace(/[[\]]/g, '')}]`
        break
      case 'face':
        out += '[表情]'
        break
      case 'record':
        out += '[语音]'
        break
      case 'video':
        out += '[视频]'
        break
      case 'file':
        out += `[文件:${s.name ?? ''}]`
        break
      case 'json':
      case 'xml':
        out += '[卡片]'
        break
      case 'forward':
        out += '[聊天记录]'
        break
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function recordGroupMessage(e: any) {
  observeUsers(e)
  if (!e?.group_id || String(e.user_id) === String(e.self_id)) return
  const text = briefSegments(e.message, e.self_id)
  if (!text) return
  const key = keyOf(e)
  const list = logs.get(key) ?? []
  const name = `${knownName(e) || '群友'}(平台ID ${e.user_id})`
  rememberMessage(e, text)
  recordChatter(e, name, text)
  list.push({
    t: Date.now(),
    uid: String(e.user_id),
    name,
    text: truncate(text, 200),
    mid: e.message_id != null ? String(e.message_id) : undefined,
  })
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
  logs.set(key, list)
  const cfg = config.get(), eff = config.effective(e.group_id)
  const images = cfg.enable && eff.enable && eff.chat.includeImages && !cfg.trigger.groupBlacklist.map(String).includes(String(e.group_id)) && (!cfg.trigger.groupWhitelist.length || cfg.trigger.groupWhitelist.map(String).includes(String(e.group_id)))
  attachQuote(e, list, list.at(-1)!, images)
  if (images) {
    const line = list.at(-1)!
    e._llmImageCapture ??= captureImageSegments(e.message ?? [], chatImageScope(e))
    void e._llmImageCapture.then((stored: Awaited<ReturnType<typeof captureImageSegments>>) => {
      if (!stored.savedImages.length) return
      const labels = stored.savedImages.map(imageLabel).join('\n')
      line.text += '\n' + labels
      updateChatterImages(e, labels)
    }).catch(() => {})
  }
}

const IMAGE_LABEL = /\n?\[图片\d+:\/work\/attachments\/[^\]\r\n]+\]/g

/** A reply's quoted message: from this log when it is recent, otherwise fetched from the adapter. */
function attachQuote(e: any, list: Line[], line: Line, images: boolean) {
  const reply = (e.message ?? []).find((segment: any) => segment?.type === 'reply')
  if (!reply) return
  const replyId = e.reply_id ?? reply.data?.id ?? reply.id ?? reply.data?.message_id ?? reply.message_id
  const cached = replyId != null ? list.find(l => l.mid === String(replyId)) : undefined
  if (cached) {
    line.quote = {
      label: `【引用 ${cached.bot ? `你(平台ID ${cached.uid})` : cached.name}】`,
      text: cached.text.replace(IMAGE_LABEL, ''),
      labels: cached.text.match(IMAGE_LABEL)?.map(label => label.trim()) ?? [],
    }
    return
  }
  void getQuoted(e).then(async q => {
    if (!q) return
    line.quote = { label: quoteLabel(q), text: truncate((q.text || '[非文本消息]').replace(/\s+/g, ' '), 200), labels: [] }
    if (!images || !q.imageUrls.length) return
    const stored = await captureImageSegments(q.imageUrls.map(url => ({ type: 'image', url })), chatImageScope(e))
    const uid = q.senderId ? undefined : imageSender(e, stored.savedImages.map(image => image.path))
    if (uid) line.quote.label = quoteLabel({ senderId: uid, fromBot: false, name: knownName(e, uid) || q.name })
    line.quote.labels = stored.savedImages.map(imageLabel)
  }).catch(() => {})
}

/**
 * Laid out like the current message: the quote, then the message on the next line. The message keeps its
 * text and the quoted text gets what is left of `maxChars`; image labels are not counted.
 */
function renderLine(l: Line, maxChars: number): string {
  if (!l.quote) return truncateImageText(l.text, maxChars)
  const room = maxChars - l.text.replace(IMAGE_LABEL, '').trim().length
  const quoted = room >= 4 ? quoteBody(truncate(l.quote.text, room), l.quote.labels) : ['…', ...l.quote.labels].join(' ')
  return `${l.quote.label}${quoted}\n${truncateImageText(l.text, maxChars)}`
}

/**
 * Sender of a quoted image whose author the platform omitted: the one person in this bot/group's log who
 * posted those exact bytes (saved paths are content hashes). Unknown when nobody or several people did.
 */
export function imageSender(e: any, paths: string[]): string | undefined {
  if (!e?.group_id || !paths.length) return undefined
  const senders = new Set((logs.get(keyOf(e)) ?? []).filter(l => paths.some(p => l.text.includes(`:${p}]`))).map(l => l.uid))
  return senders.size === 1 ? [...senders][0] : undefined
}

export function recordBotMessage(e: any, text: string, conv?: string) {
  if (!e?.group_id || !text) return
  const key = keyOf(e)
  const list = logs.get(key) ?? []
  list.push({ t: Date.now(), uid: String(e.self_id), name: '你', text: truncate(text.replace(/\s+/g, ' '), 200), bot: true, conv })
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
  logs.set(key, list)
}

/** Recent lines before the triggering message (excluded), oldest first. */
/** Mark the triggering message as part of conversation `conv` (it is now in that session's history). */
export function markHandled(e: any, conv: string) {
  if (!e?.group_id || e.message_id == null) return
  markChatterHandled(e)
  const l = (logs.get(keyOf(e)) ?? []).find(x => x.mid === String(e.message_id))
  if (l) l.conv = conv
}

/** Keep overlapping exchanges: removing them loses how bot conversations interleave with group chatter. */
export function recentLines(e: any, n: number, maxChars: number, conv?: string, withinMs = 30 * 60_000): string[] {
  n = Math.min(100, Math.max(0, Math.floor(n)))
  if (!e?.group_id || n <= 0) return []
  const list = logs.get(keyOf(e)) ?? []
  const mid = e.message_id != null ? String(e.message_id) : undefined
  const cutoff = Date.now() - withinMs
  const out: string[] = []
  const trigger = mid ? list.findIndex(line => line.mid === mid) : -1
  for (let i = (trigger < 0 ? list.length : trigger) - 1; i >= 0 && out.length < n; i--) {
    const l = list[i]
    if (l.t < cutoff) break
    if (mid && l.mid === mid) continue
    out.push(`[${formatNow(new Date(l.t))}] ${l.name}: ${renderLine(l, maxChars)}`)
  }
  return out.reverse().map((line, index) => `${index + 1}. ${line}`)
}

/** Number of other people's messages after the trigger message — used to decide whether to quote. */
export function messagesSince(e: any): number {
  const list = logs.get(keyOf(e)) ?? []
  const mid = e?.message_id != null ? String(e.message_id) : undefined
  const idx = mid ? list.findIndex(l => l.mid === mid) : -1
  if (idx < 0) return 0
  return list.slice(idx + 1).filter(l => !l.bot).length
}

/** Exact message-id match in this bot/group only; never infer a quote's author from the current speaker. */
export function cachedMessageSender(e: any, messageId: unknown): string | undefined {
  if (!e?.group_id || messageId == null) return undefined
  return logs.get(keyOf(e))?.find(line => line.mid === String(messageId))?.uid
}

export function clearGroupLogs() {
  logs.clear()
}
