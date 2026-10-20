import { truncate } from '../core/util.ts'

interface Line {
  t: number
  uid: string
  name: string
  text: string
  mid?: string
  bot?: boolean
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
        out += String(s.qq) === String(selfId) ? '@你 ' : `@${s.name || s.qq} `
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
  if (!e?.group_id || String(e.user_id) === String(e.self_id)) return
  const text = briefSegments(e.message, e.self_id)
  if (!text) return
  const key = keyOf(e)
  const list = logs.get(key) ?? []
  list.push({
    t: Date.now(),
    uid: String(e.user_id),
    name: String(e.sender?.card || e.sender?.nickname || e.user_id),
    text: truncate(text, 200),
    mid: e.message_id != null ? String(e.message_id) : undefined,
  })
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
  logs.set(key, list)
}

export function recordBotMessage(e: any, text: string) {
  if (!e?.group_id || !text) return
  const key = keyOf(e)
  const list = logs.get(key) ?? []
  list.push({ t: Date.now(), uid: String(e.self_id), name: '你', text: truncate(text.replace(/\s+/g, ' '), 200), bot: true })
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
  logs.set(key, list)
}

/** Recent lines before the triggering message (excluded), oldest first. */
export function recentLines(e: any, n: number, maxChars: number, withinMs = 30 * 60_000): string[] {
  if (!e?.group_id || n <= 0) return []
  const list = logs.get(keyOf(e)) ?? []
  const mid = e.message_id != null ? String(e.message_id) : undefined
  const cutoff = Date.now() - withinMs
  const out: string[] = []
  for (let i = list.length - 1; i >= 0 && out.length < n; i--) {
    const l = list[i]
    if (l.t < cutoff) break
    if (mid && l.mid === mid) continue
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
