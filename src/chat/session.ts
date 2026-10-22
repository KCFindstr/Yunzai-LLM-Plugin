import type { ChatSection } from '../core/configTypes.ts'
import { JsonStore } from '../core/store.ts'
import { estimateTokens, similarity, truncate } from '../core/util.ts'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { isSensitive } from '../memory/store.ts'
import { decodeVector, dot, embed, embeddingReady, embeddingTag, encodeVector } from '../memory/embed.ts'
import type { AssistantMsg, Msg, UserMsg } from '../llm/types.ts'
import { partsToText } from '../llm/types.ts'

/** Persisted history contains only plain user/assistant text — no tool transcripts, images or provider-raw data. */
export interface ArchiveEntry { id?: string; at: number; text: string; raw?: boolean }

export interface StoredSession {
  messages: Msg[]
  summary?: string
  /** Older context: one entry per trimmed chunk; `raw` until compactSession replaces it with a summary. */
  archive?: ArchiveEntry[]
  updatedAt: number
  /** Server-side chain (gemini/responses): valid while messages.length === len and the model key matches. */
  state?: { key: string; previousId: string; len: number }
}

const store = new JsonStore<Record<string, StoredSession>>('sessions.json', {})
/** Archive embeddings, kept out of sessions.json (rewritten every turn). Per session: vector space tag + id → base64 float32. */
const vectors = new JsonStore<Record<string, { tag: string; v: Record<string, string> }>>('recall-vectors.json', {})

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function dropVectors(key: string) {
  if (!vectors.data[key]) return
  delete vectors.data[key]
  vectors.save()
}

export function sessionKey(e: any, scope: ChatSection['sessionScope']): string {
  if (e.group_id) return scope === 'group' ? `${e.self_id}:g${e.group_id}` : `${e.self_id}:g${e.group_id}:u${e.user_id}`
  return `${e.self_id}:p${e.user_id}`
}

const PRUNE_AFTER = 30 * 86400_000
let lastPrune = 0

/** Drop sessions idle for days so sessions.json doesn't grow with every user ever seen. */
function pruneIdle() {
  if (Date.now() - lastPrune < 3600_000) return
  lastPrune = Date.now()
  let n = 0
  for (const [k, s] of Object.entries(store.data))
    if (Date.now() - (s?.updatedAt ?? 0) > PRUNE_AFTER) {
      delete store.data[k]
      dropVectors(k)
      n++
    }
  if (n) store.save()
}

export function getSession(key: string, timeoutMin: number): StoredSession {
  pruneIdle()
  const s = store.data[key]
  if (s && Date.now() - s.updatedAt < timeoutMin * 60_000) return s
  if (s) archiveMessages(s, s.messages)
  const recent = s?.messages.slice(-2).map(message => message.role === 'user' ? partsToText(message.content) : message.role === 'assistant' ? message.content : '').join('\n')
  const fresh: StoredSession = { messages: [], summary: s?.summary || (recent && !isSensitive(recent) ? truncate(recent, 800) : undefined), archive: s?.archive, updatedAt: Date.now() }
  store.data[key] = fresh
  store.save()
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
  dropVectors(key)
  store.save()
  return had
}

export function clearSessionsWhere(pred: (key: string) => boolean): number {
  let n = 0
  for (const k of Object.keys(store.data))
    if (pred(k)) {
      delete store.data[k]
      dropVectors(k)
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
  archiveMessages(s, dropped)
  s.state = undefined
  store.save()
  return dropped
}

function archiveMessages(session: StoredSession, messages: Msg[]) {
  const pairs: string[] = []
  for (let index = 0; index < messages.length; index += 2) {
    const text = messages.slice(index, index + 2).map(message => message.role === 'user' ? `对方：${partsToText(message.content)}` : message.role === 'assistant' ? `你：${message.content}` : '').filter(Boolean).join('\n')
    if (text && !isSensitive(text)) pairs.push(text)
  }
  const archive = session.archive ??= []
  if (pairs.length) archive.push({ id: newId(), at: session.updatedAt, text: truncate(pairs.join('\n'), 4000), raw: true })
  session.archive = archive.filter(entry => Date.now() - entry.at < PRUNE_AFTER).slice(-60)
}

/** Archive chunks still waiting to be summarized. */
export function pendingArchive(key: string): ArchiveEntry[] {
  return (store.data[key]?.archive ?? []).filter(entry => entry.raw)
}

/**
 * Replace the given raw chunks with one summarized episode, or without `text` just mark them settled.
 * No-op if the session was reset meanwhile.
 */
export function setEpisode(key: string, pending: ArchiveEntry[], text?: string) {
  const s = store.data[key]
  if (!s?.archive || !pending.length || !pending.every(entry => s.archive!.includes(entry))) return
  if (text) {
    const index = s.archive.indexOf(pending[0])
    s.archive = s.archive.filter(entry => !pending.includes(entry))
    s.archive.splice(index, 0, { id: newId(), at: pending.at(-1)!.at, text })
  } else for (const entry of pending) delete entry.raw
  store.save()
}

/**
 * Embed archive entries that have no vector yet and drop vectors of entries that are gone.
 * No-op without a configured embedding model. Throws on API errors.
 */
export async function indexArchive(key: string, signal?: AbortSignal) {
  const archive = store.data[key]?.archive
  if (!archive?.length || !embeddingReady()) return
  const tag = embeddingTag()
  for (const entry of archive) if (!entry.id) { entry.id = newId(); store.save() }
  const current = () => (vectors.data[key]?.tag === tag ? vectors.data[key].v : {})
  const missing = archive.filter(entry => !current()[entry.id!])
  const embedded = await embed(missing.map(entry => entry.text), 'document', signal)
  // the archive may have changed (or been cleared) while waiting; keep only vectors of entries still there
  if (!store.data[key]) return
  const live = new Set((store.data[key].archive ?? []).map(entry => entry.id))
  const v: Record<string, string> = {}
  for (const [id, vec] of Object.entries(current())) if (live.has(id)) v[id] = vec
  missing.forEach((entry, i) => { if (live.has(entry.id)) v[entry.id!] = encodeVector(embedded[i]) })
  if (!missing.length && Object.keys(v).length === Object.keys(current()).length) return
  vectors.data[key] = { tag, v }
  vectors.save()
}

/**
 * Search this session's archive. Lexical (bigram + keyword) scoring always runs; with an embedding model
 * configured, cosine similarity is added and also admits hits that share no words with the query.
 * Embedding failures (or `signal` timing out) fall back to lexical-only results.
 */
export async function recallSession(key: string, query: string, count = 3, signal?: AbortSignal): Promise<string[]> {
  const entries = (store.data[key]?.archive ?? []).filter(entry => Date.now() - entry.at < PRUNE_AFTER)
  if (!entries.length) return []
  const terms = query.toLowerCase().match(/[a-z0-9_-]{3,}|[\p{Script=Han}]{2,}/gu) ?? []
  const cosine = new Map<ArchiveEntry, number>()
  if (query.trim().length >= 2 && embeddingReady()) {
    try {
      await indexArchive(key, signal)
      const [q] = await embed([query], 'query', signal)
      const v = vectors.data[key]?.v ?? {}
      for (const entry of entries) if (entry.id && v[entry.id]) cosine.set(entry, dot(q, decodeVector(v[entry.id])))
    } catch (err: any) {
      log.warn(`旧聊天向量检索失败，改用关键词: ${err?.message ?? err}`)
    }
  }
  const minScore = config.get().memory.embedding.minScore
  return entries.map((entry, index) => {
    const lexical = similarity(query, entry.text) + terms.reduce((score, term) => score + (entry.text.toLowerCase().includes(term) ? 0.2 : 0), 0)
    return { entry, index, lexical, cos: cosine.get(entry), score: lexical + (cosine.get(entry) ?? 0) }
  })
    .filter(hit => !query.trim() || hit.lexical >= 0.06 || (hit.cos ?? -1) >= minScore)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, Math.min(5, Math.max(1, count)))
    .map(hit => `${new Date(hit.entry.at).toISOString().slice(0, 10)} ${truncate(hit.entry.text, 600)}`)
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

/** Overview of every stored session for the web UI, most recently active first. */
export function listSessions() {
  return Object.entries(store.data)
    .map(([key, s]) => ({
      key,
      messages: s.messages.length,
      updatedAt: s.updatedAt,
      summary: s.summary,
      archive: s.archive?.length ?? 0,
      vectors: Object.keys(vectors.data[key]?.v ?? {}).length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Archive entries of one session with whether each has a vector in the current embedding space. */
export function archiveInfo(key: string) {
  const v = vectors.data[key]?.tag === embeddingTag() ? vectors.data[key].v : {}
  return (store.data[key]?.archive ?? []).map(entry => ({ ...entry, vector: Boolean(entry.id && v[entry.id]) }))
}

export function deleteArchiveEntry(key: string, id: string): boolean {
  const s = store.data[key]
  if (!s?.archive?.some(entry => entry.id === id)) return false
  s.archive = s.archive.filter(entry => entry.id !== id)
  if (vectors.data[key]?.v[id]) {
    delete vectors.data[key].v[id]
    vectors.save()
  }
  store.save()
  return true
}

/** Every archive entry that has a vector in the current embedding space (for the web UI's projection). */
export function allVectors(onlyKey?: string): { key: string; id: string; at: number; text: string; vec: Float32Array }[] {
  const tag = embeddingTag()
  const out: { key: string; id: string; at: number; text: string; vec: Float32Array }[] = []
  for (const [key, s] of Object.entries(store.data)) {
    if (onlyKey && key !== onlyKey) continue
    const v = vectors.data[key]?.tag === tag ? vectors.data[key].v : {}
    for (const entry of s.archive ?? []) if (entry.id && v[entry.id]) out.push({ key, id: entry.id, at: entry.at, text: entry.text, vec: decodeVector(v[entry.id]) })
  }
  return out
}
