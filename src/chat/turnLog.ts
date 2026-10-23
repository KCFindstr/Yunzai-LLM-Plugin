import { JsonStore } from '../core/store.ts'
import { truncate } from '../core/util.ts'

/** One chat-model turn, as shown in the web UI's recent-turns list. */
export interface TurnRecord {
  rolloutId?: string
  at: number
  conv: string
  userId?: string
  userName?: string
  groupId?: string
  model?: string
  input: string
  reply: string
  tools: string[]
  cost: number
  ms: number
  tokens?: { input: number; output: number; cacheRead: number; inputIncomplete?: boolean }
  error?: string
}

const MAX = 300
const store = new JsonStore<{ v: 1; turns: TurnRecord[] }>('turns.json', { v: 1, turns: [] })

export function recordTurn(t: TurnRecord) {
  store.data.turns.push({ ...t, input: truncate(t.input, 1000), reply: truncate(t.reply, 2000), error: t.error && truncate(t.error, 500) })
  if (store.data.turns.length > MAX) store.data.turns.splice(0, store.data.turns.length - MAX)
  store.save()
}

/** Newest first. */
export function recentTurns(opts: { conv?: string; limit?: number } = {}): TurnRecord[] {
  const list = opts.conv ? store.data.turns.filter(t => t.conv === opts.conv) : store.data.turns
  return list.slice(-(opts.limit ?? 100)).reverse()
}
