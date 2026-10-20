import type { ChatSection } from '../core/configTypes.ts'
import { JsonStore } from '../core/store.ts'
import { estimateTokens } from '../core/util.ts'
import type { AssistantMsg, Msg, UserMsg } from '../llm/types.ts'
import { partsToText } from '../llm/types.ts'

/** Persisted history contains only plain user/assistant text — no tool transcripts, images or provider-raw data. */
export interface StoredSession {
  messages: Msg[]
  summary?: string
  updatedAt: number
  /** Server-side chain (gemini/responses): valid while messages.length === len and the model key matches. */
  state?: { key: string; previousId: string; len: number }
}

const store = new JsonStore<Record<string, StoredSession>>('sessions.json', {})

export function sessionKey(e: any, scope: ChatSection['sessionScope']): string {
  if (e.group_id) return scope === 'group' ? `${e.self_id}:g${e.group_id}` : `${e.self_id}:g${e.group_id}:u${e.user_id}`
  return `${e.self_id}:p${e.user_id}`
}

const PRUNE_AFTER = 3 * 86400_000
let lastPrune = 0

/** Drop sessions idle for days so sessions.json doesn't grow with every user ever seen. */
function pruneIdle() {
  if (Date.now() - lastPrune < 3600_000) return
  lastPrune = Date.now()
  let n = 0
  for (const [k, s] of Object.entries(store.data))
    if (Date.now() - (s?.updatedAt ?? 0) > PRUNE_AFTER) {
      delete store.data[k]
      n++
    }
  if (n) store.save()
}

export function getSession(key: string, timeoutMin: number): StoredSession {
  pruneIdle()
  const s = store.data[key]
  if (s && Date.now() - s.updatedAt < timeoutMin * 60_000) return s
  const fresh: StoredSession = { messages: [], updatedAt: Date.now() }
  store.data[key] = fresh
  return fresh
}

export function peekSession(key: string): StoredSession | undefined {
  return store.data[key]
}

export function toStoredUser(m: UserMsg): UserMsg {
  return { role: 'user', content: [{ type: 'text', text: partsToText(m.content) }] }
}

export function appendTurn(key: string, user: UserMsg, assistant: AssistantMsg) {
  const s = store.data[key] ?? (store.data[key] = { messages: [], updatedAt: Date.now() })
  s.messages.push(toStoredUser(user), { role: 'assistant', content: assistant.content })
  s.updatedAt = Date.now()
  store.save()
}

export function setServerState(key: string, state: StoredSession['state']) {
  const s = store.data[key]
  if (!s) return
  s.state = state
  store.save()
}

export function clearSession(key: string): boolean {
  const had = Boolean(store.data[key]?.messages.length)
  delete store.data[key]
  store.save()
  return had
}

export function clearSessionsWhere(pred: (key: string) => boolean): number {
  let n = 0
  for (const k of Object.keys(store.data))
    if (pred(k)) {
      delete store.data[k]
      n++
    }
  store.save()
  return n
}

export function msgTokens(m: Msg): number {
  if (m.role === 'user') return estimateTokens(partsToText(m.content)) + 4
  if (m.role === 'assistant') return estimateTokens(m.content) + 4
  return m.results.reduce((a, r) => a + estimateTokens(r.content), 0)
}

/**
 * Chunked truncation: once over budget, drop the oldest turns down to ~half the budget in one go.
 * A sliding window would change the prefix every turn and defeat prompt caching.
 * Returns the dropped messages (for optional summarization).
 */
export function truncateIfNeeded(key: string, chat: ChatSection): Msg[] {
  const s = store.data[key]
  if (!s) return []
  const turns = s.messages.length / 2
  const tokens = s.messages.reduce((a, m) => a + msgTokens(m), 0) + estimateTokens(s.summary ?? '')
  if (turns <= chat.historyMaxTurns && tokens <= chat.historyMaxTokens) return []

  const targetTurns = Math.max(1, Math.floor(chat.historyMaxTurns / 2))
  const targetTokens = Math.floor(chat.historyMaxTokens / 2)
  let drop = 0
  let remainingTokens = tokens
  while (drop < s.messages.length - 2) {
    const remainingTurns = (s.messages.length - drop) / 2
    if (remainingTurns <= targetTurns && remainingTokens <= targetTokens) break
    remainingTokens -= msgTokens(s.messages[drop]) + msgTokens(s.messages[drop + 1])
    drop += 2
  }
  const dropped = s.messages.splice(0, drop)
  s.state = undefined
  store.save()
  return dropped
}

export function setSummary(key: string, summary: string) {
  const s = store.data[key]
  if (!s) return
  s.summary = summary
  s.state = undefined
  store.save()
}

export function sessionStats() {
  const keys = Object.keys(store.data)
  return { count: keys.length, messages: keys.reduce((a, k) => a + store.data[k].messages.length, 0) }
}
