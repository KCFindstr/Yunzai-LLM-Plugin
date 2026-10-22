import { truncate } from '../core/util.ts'
import { observeUsers, knownName } from './roster.ts'
import { markChatterHandled, recordChatter } from './chatter.ts'

interface Line {
  t: number
  uid: string
  name: string
  text: string
  mid?: string
  bot?: boolean
  /** conversation (session key) whose history already contains this line */
  conv?: string
}

const MAX_LINES = 40
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

/**
 * Lines already in `conv`'s own history (its handled messages and the bot's replies there) are skipped, so
 * they aren't sent twice; other members' exchanges with the bot still count as ambient context.
 */
export function recentLines(e: any, n: number, maxChars: number, conv?: string, withinMs = 30 * 60_000): string[] {
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
    if (conv && l.conv === conv) continue
    out.push(`${l.name}: ${truncate(l.text, maxChars)}`)
  }
  return out.reverse()
}

/** Number of other people's messages after the trigger message — used to decide whether to quote. */
export function messagesSince(e: any): number {
  const list = logs.get(keyOf(e)) ?? []
  const mid = e?.message_id != null ? String(e.message_id) : undefined
  const idx = mid ? list.findIndex(l => l.mid === mid) : -1
  if (idx < 0) return 0
  return list.slice(idx + 1).filter(l => !l.bot).length
}

export function clearGroupLogs() {
  logs.clear()
}
