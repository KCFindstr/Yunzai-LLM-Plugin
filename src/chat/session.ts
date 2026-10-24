import type { ChatSection } from '../core/configTypes.ts'
import { JsonStore } from '../core/store.ts'
import { randomBytes } from 'node:crypto'
import { estimateTokens, similarity, truncate } from '../core/util.ts'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { isSensitive } from '../memory/store.ts'
import { decodeVector, dot, embed, embedGroups, embeddingContextual, embeddingReady, embeddingTag, encodeVector } from '../memory/embed.ts'
import type { AssistantMsg, Msg, UserMsg } from '../llm/types.ts'
import { partsToText } from '../llm/types.ts'
import { addDays, localDay, type DayRange } from './dates.ts'
import { automaticRecallQuery, recallText } from './recallText.ts'

/** Persisted history contains only plain user/assistant text — no tool transcripts, images or provider-raw data. */
export interface ArchiveEntry {
  id?: string
  at: number
  /** local day the chat happened (UTC+8) */
  day?: string
  text: string
  raw?: boolean
  /** group chatter that didn't involve the bot (summarized by the background job, not into the rolling summary) */
  chat?: boolean
}

/** One digest per conversation per past day; `sources` are the archive entry ids folded into it. */
export interface DayEntry { id: string; day: string; text: string; at: number; sources: string[] }

export interface StoredSession {
  /** Separate AGY thread/workspace for this chat session; discarded with a session reset/timeout. */
  agy?: { workspaceId: string; conversationId?: string; runtime?: 'host-v1' }
  messages: Msg[]
  summary?: string
  /** Older context: one entry per trimmed chunk; `raw` until compactSession replaces it with a summary. */
  archive?: ArchiveEntry[]
  /** Daily digests, kept `memory.dailyDays` (longer than the 30-day archive). */
  days?: DayEntry[]
  /** When each stored user/assistant pair happened, aligned with the end of `messages`. */
  turnTimes?: number[]
  updatedAt: number
  /** Server-side chain (gemini/responses): valid while messages.length === len and the model key matches. */
  state?: { key: string; previousId: string; len: number }
}

const store = new JsonStore<Record<string, StoredSession>>('sessions.json', {})
/** Archive embeddings, kept out of sessions.json (rewritten every turn). Per session: vector space tag + id → base64 float32. */
const vectors = new JsonStore<Record<string, { tag: string; v: Record<string, string> }>>('recall-vectors.json', {})

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

function dropVectors(key: string, keep?: Set<string>) {
  const entry = vectors.data[key]
  if (!entry) return
  if (keep?.size) entry.v = Object.fromEntries(Object.entries(entry.v).filter(([id]) => keep.has(id)))
  else delete vectors.data[key]
  vectors.save()
}

const dayOf = (entry: ArchiveEntry) => entry.day ?? localDay(entry.at)
const keepDays = (days: DayEntry[] = []) => {
  const oldest = addDays(localDay(), -config.get().memory.dailyDays)
  return days.filter(d => d.day >= oldest)
}

export function sessionKey(e: any, scope: ChatSection['sessionScope']): string {
  if (e.group_id) return scope === 'group' ? `${e.self_id}:g${e.group_id}` : `${e.self_id}:g${e.group_id}:u${e.user_id}`
  return `${e.self_id}:p${e.user_id}`
}

const PRUNE_AFTER = 30 * 86400_000
let lastPrune = 0

/**
 * Drop sessions idle for a month so sessions.json doesn't grow with every user ever seen. Their daily digests
 * outlive the detail: an idle session shrinks to just its digests until those age out too.
 */
function pruneIdle() {
  if (Date.now() - lastPrune < 3600_000) return
  lastPrune = Date.now()
  let n = 0
  for (const [k, s] of Object.entries(store.data)) {
    if (Date.now() - Math.max(s?.updatedAt ?? 0, ...(s?.archive ?? []).map(entry => entry.at)) <= PRUNE_AFTER) continue
    const days = keepDays(s.days)
    if (days.length === (s.days?.length ?? 0) && !s.messages.length && !s.archive?.length && !s.summary) continue
    n++
    if (days.length) {
      store.data[k] = { messages: [], days, updatedAt: s.updatedAt }
      dropVectors(k, new Set(days.map(d => d.id)))
    } else {
      delete store.data[k]
      dropVectors(k)
    }
  }
  if (n) store.save()
}

export function getSession(key: string, timeoutMin: number): StoredSession {
  pruneIdle()
  const s = store.data[key]
  if (s && Date.now() - s.updatedAt < timeoutMin * 60_000) return s
  if (s) archiveMessages(s, s.messages, alignedTimes(s))
  const recent = s?.messages.slice(-2).map(message => message.role === 'user' ? partsToText(message.content) : message.role === 'assistant' ? message.content : '').join('\n')
  const fresh: StoredSession = { messages: [], turnTimes: [], summary: s?.summary || (recent && !isSensitive(recent) ? truncate(recent, 800) : undefined), archive: s?.archive, days: s?.days, updatedAt: Date.now() }
  store.data[key] = fresh
  store.save()
  return fresh
}

export function peekSession(key: string): StoredSession | undefined {
  return store.data[key]
}

export function getAgySession(key: string, timeoutMin: number) {
  const session = getSession(key, timeoutMin)
  if (!session.agy) {
    session.agy = { workspaceId: randomBytes(5).toString('hex'), runtime: 'host-v1' }
    store.save()
  } else if (session.agy.runtime !== 'host-v1') {
    // Legacy conversations belong to the obsolete private profile and retain its policies/context.
    session.agy = { workspaceId: session.agy.workspaceId, runtime: 'host-v1' }
    store.save()
  }
  return session.agy
}

export function rememberAgyConversation(key: string, workspaceId: string, conversationId: string) {
  const session = store.data[key]
  if (session?.agy?.workspaceId !== workspaceId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId)) return false
  if (session.agy.conversationId === conversationId) return true
  session.agy.conversationId = conversationId
  store.save()
  return true
}

export function toStoredUser(m: UserMsg): UserMsg {
  return { role: 'user', content: [{ type: 'text', text: partsToText(m.content) }] }
}

/** One time per stored pair; history saved before turn times existed is dated at the last activity. */
function alignedTimes(s: StoredSession): number[] {
  const pairs = Math.floor(s.messages.length / 2)
  if (!pairs) return []
  const times = (s.turnTimes ?? []).slice(-pairs)
  return [...Array(pairs - times.length).fill(s.updatedAt), ...times]
}

export function appendTurn(key: string, user: UserMsg, assistant: AssistantMsg) {
  const s = store.data[key] ?? (store.data[key] = { messages: [], updatedAt: Date.now() })
  s.turnTimes = [...alignedTimes(s), Date.now()]
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
  const times = alignedTimes(s)
  const dropped = s.messages.splice(0, drop)
  s.turnTimes = times.slice(drop / 2)
  archiveMessages(s, dropped, times.slice(0, drop / 2))
  s.state = undefined
  store.save()
  return dropped
}

/** Archive trimmed or expired turns as raw chunks, one per calendar day so a summary never spans two days. */
function archiveMessages(session: StoredSession, messages: Msg[], times: number[] = []) {
  const byDay = new Map<string, { texts: string[]; at: number }>()
  for (let index = 0; index < messages.length; index += 2) {
    const text = messages.slice(index, index + 2).map(message => message.role === 'user' ? `对方：${partsToText(message.content)}` : message.role === 'assistant' ? `你：${message.content}` : '').filter(Boolean).join('\n')
    if (!text || isSensitive(text)) continue
    const at = times[index / 2] ?? session.updatedAt
    const group = byDay.get(localDay(at)) ?? { texts: [], at }
    group.texts.push(text)
    group.at = Math.max(group.at, at)
    byDay.set(localDay(at), group)
  }
  const archive = session.archive ??= []
  for (const [day, group] of byDay) archive.push({ id: newId(), at: group.at, day, text: truncate(group.texts.join('\n'), 4000), raw: true })
  session.archive = archive.filter(entry => Date.now() - entry.at < PRUNE_AFTER).slice(-120)
}

/** Raw chunks of one kind waiting to be summarized, all from the oldest such day. */
function pendingOf(key: string, chat: boolean): ArchiveEntry[] {
  const raw = (store.data[key]?.archive ?? []).filter(entry => entry.raw && Boolean(entry.chat) === chat)
  if (!raw.length) return []
  const day = raw.map(dayOf).sort()[0]
  return raw.filter(entry => dayOf(entry) === day)
}

/** The bot's own trimmed/expired turns waiting to be summarized (by compactSession, after a reply). */
export const pendingArchive = (key: string) => pendingOf(key, false)
/** Group chatter waiting to be summarized (by the background job). */
export const pendingChatter = (key: string) => pendingOf(key, true)

/** Add a chunk of group chatter (one day) to a group session's archive, creating the session if needed. */
export function archiveChatter(key: string, day: string, text: string, at: number) {
  const s = store.data[key] ?? (store.data[key] = { messages: [], turnTimes: [], updatedAt: Date.now() })
  const archive = s.archive ??= []
  archive.push({ id: newId(), at, day, text: truncate(text, 4000), raw: true, chat: true })
  s.archive = archive.filter(entry => Date.now() - entry.at < PRUNE_AFTER).slice(-120)
  store.save()
}

/** Sessions that have background work: chatter to summarize or a past day without an up-to-date digest. */
export function sessionsWithWork(): string[] {
  return Object.keys(store.data).filter(key => pendingChatter(key).length || staleDay(key))
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
    s.archive.splice(index, 0, { id: newId(), at: Math.max(...pending.map(entry => entry.at)), day: dayOf(pending[0]), text, ...(pending[0].chat ? { chat: true } : {}) })
  } else for (const entry of pending) delete entry.raw
  store.save()
}

/**
 * The oldest past day whose archive has entries not yet folded into that day's digest. Days with chunks still
 * waiting to be summarized are skipped until those are done, so a digest is built from summaries.
 */
export function staleDay(key: string): { day: string; entries: ArchiveEntry[]; prev?: DayEntry } | undefined {
  const s = store.data[key]
  if (!s?.archive?.length) return undefined
  const today = localDay()
  const byDay = new Map<string, ArchiveEntry[]>()
  for (const entry of s.archive) if (dayOf(entry) < today) byDay.set(dayOf(entry), [...(byDay.get(dayOf(entry)) ?? []), entry])
  for (const day of [...byDay.keys()].sort()) {
    const entries = byDay.get(day)!
    if (entries.some(entry => entry.raw)) continue
    const prev = s.days?.find(d => d.day === day)
    if (!prev || entries.some(entry => entry.id && !prev.sources.includes(entry.id))) return { day, entries, prev }
  }
  return undefined
}

/** Store (or replace) a day's digest. No-op if the session was reset meanwhile. */
export function setDayDigest(key: string, day: string, text: string, sources: string[]) {
  const s = store.data[key]
  if (!s) return
  const old = s.days?.find(d => d.day === day)
  const entry: DayEntry = { id: `d${day.replaceAll('-', '')}${Date.now().toString(36)}`, day, text, at: Date.now(), sources }
  s.days = keepDays([...(s.days ?? []).filter(d => d.day !== day), entry]).sort((a, b) => a.day.localeCompare(b.day))
  if (old && vectors.data[key]?.v[old.id]) {
    delete vectors.data[key].v[old.id]
    vectors.save()
  }
  store.save()
}

/** Everything searchable in a session: detailed archive entries plus daily digests. */
function searchable(key: string): { id?: string; at: number; day: string; text: string; kind: 'episode' | 'day'; raw?: boolean }[] {
  const s = store.data[key]
  if (!s) return []
  return [
    ...(s.archive ?? []).filter(entry => Date.now() - entry.at < PRUNE_AFTER).map(entry => ({ id: entry.id, at: entry.at, day: dayOf(entry), text: entry.text, kind: 'episode' as const, raw: entry.raw })),
    // a digest sorts as the end of its day (23:59:59 UTC+8)
    ...keepDays(s.days).map(d => ({ id: d.id, at: Date.parse(`${d.day}T15:59:59Z`), day: d.day, text: d.text, kind: 'day' as const })),
  ]
}

/**
 * Embed archive entries and daily digests that have no vector yet, and drop vectors of entries that are gone.
 * No-op without a configured embedding model. Throws on API errors.
 */
export async function indexArchive(key: string, signal?: AbortSignal) {
  const s = store.data[key]
  if (!s || !embeddingReady()) return
  for (const entry of s.archive ?? []) if (!entry.id) { entry.id = newId(); store.save() }
  const items = [...(s.archive ?? []).map(entry => ({ id: entry.id!, text: entry.text })), ...(s.days ?? []).map(d => ({ id: d.id, text: `${d.day} 当日概要：${d.text}` }))]
  if (!items.length) return
  const tag = embeddingTag()
  const current = () => (vectors.data[key]?.tag === tag ? vectors.data[key].v : {})
  const isMissing = (item: { id: string }) => !current()[item.id]
  // contextualized models embed a day's entries together as one document: a day with any new entry is redone whole
  // (its neighbours' context changed); each digest is a document of its own
  let groups: { id: string; text: string }[][]
  if (embeddingContextual()) {
    const byDay = new Map<string, ArchiveEntry[]>()
    for (const entry of [...(s.archive ?? [])].sort((a, b) => a.at - b.at)) byDay.set(dayOf(entry), [...(byDay.get(dayOf(entry)) ?? []), entry])
    groups = [
      ...[...byDay.values()].map(list => list.map(entry => ({ id: entry.id!, text: entry.text }))),
      ...items.filter(item => item.id.startsWith('d') && (s.days ?? []).some(d => d.id === item.id)).map(item => [item]),
    ].filter(g => g.some(isMissing))
  } else groups = items.filter(isMissing).map(item => [item])
  const missing = groups.flat()
  const vecs = await embedGroups(groups.map(g => g.map(item => item.text)), 'document', signal)
  const embedded = vecs.flat()
  // the session may have changed (or been cleared) while waiting; keep only vectors of entries still there
  const now = store.data[key]
  if (!now) return
  const live = new Set([...(now.archive ?? []).map(entry => entry.id), ...(now.days ?? []).map(d => d.id)])
  const v: Record<string, string> = {}
  for (const [id, vec] of Object.entries(current())) if (live.has(id)) v[id] = vec
  missing.forEach((item, i) => { if (live.has(item.id)) v[item.id] = encodeVector(embedded[i]) })
  if (!missing.length && Object.keys(v).length === Object.keys(current()).length) return
  vectors.data[key] = { tag, v }
  vectors.save()
}

export interface RecallOptions {
  /** Per-turn recall skips requests without a topic instead of browsing old history. */
  automatic?: boolean
  /** Only entries from these days (inclusive). Within a range every entry counts as relevant; digests come first. */
  range?: DayRange
  /** Other sessions to search as well (opt-in cross-chat recall), with a label shown on their results. */
  extra?: { key: string; label: string }[]
  signal?: AbortSignal
}

const hhmm = (ts: number) => new Date(ts + 8 * 3600_000).toISOString().slice(11, 16)

/**
 * Shared by automatic context and the recall tool. Prefer vector similarity when embeddings are available;
 * use lexical search only without usable embeddings or after a provider failure. Date ranges admit all
 * entries from those days, with daily digests first.
 */
export async function recallSession(key: string, query: string, count = 3, opts: RecallOptions = {}): Promise<string[]> {
  const { range, extra = [], signal } = opts
  const original = query
  query = opts.automatic ? automaticRecallQuery(query) : recallText(query)
  if (!range && !query && (opts.automatic || original.trim())) return []
  const sources = [{ key, label: '' }, ...extra.filter(x => x.key !== key)]
  const gather = () => sources.flatMap(src => searchable(src.key).map(entry => ({ ...entry, key: src.key, label: src.label })))
    .filter(entry => !range || (entry.day >= range.from && entry.day <= range.to))
  let entries = gather()
  if (!entries.length) return []
  const terms = query.toLowerCase().match(/[a-z0-9_-]{3,}|[\p{Script=Han}]{2,}/gu) ?? []
  const cosine = new Map<(typeof entries)[number], number>()
  if (query.trim().length >= 2 && embeddingReady()) {
    try {
      for (const src of sources) await indexArchive(src.key, signal)
      // Indexing can assign IDs to legacy entries; compare against their newly created vectors immediately.
      entries = gather()
      const [q] = await embed([query], 'query', signal)
      for (const entry of entries) {
        // vectors from another model share the dimension but not the space: never compare across them
        const vec = entry.id && vectors.data[entry.key]?.tag === embeddingTag() && vectors.data[entry.key].v[entry.id]
        if (vec) cosine.set(entry, dot(q, decodeVector(vec)))
      }
    } catch (err: any) {
      cosine.clear()
      log.warn(`旧聊天向量检索失败，改用关键词: ${err?.message ?? err}`)
    }
  }
  const minScore = config.get().memory.embedding.minScore
  const semantic = cosine.size > 0
  return entries.map(entry => {
    const text = recallText(entry.text)
    const lexical = similarity(query, text) + terms.reduce((score, term) => score + (text.toLowerCase().includes(term) ? 0.2 : 0), 0)
    // asked about a date: that day's digest is the best overview of it
    return { entry, lexical, cos: cosine.get(entry), score: (semantic ? cosine.get(entry) ?? -1 : lexical) + (range && entry.kind === 'day' ? 1 : 0) }
  })
    .filter(hit => range || !query.trim() || (semantic ? (hit.cos ?? -1) >= minScore : hit.lexical >= 0.06))
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .slice(0, Math.min(config.get().memory.recallLimit, Math.max(1, count)))
    .map(({ entry }) => {
      const where = entry.label ? `·${entry.label}` : ''
      return entry.kind === 'day'
        ? `【${entry.day} 当日概要${where}】${truncate(entry.text, 600)}`
        : `${entry.day} ${hhmm(entry.at)}${entry.label ? ` [${entry.label}]` : ''} ${truncate(entry.text, 600)}`
    })
}

/** Sessions of the given groups that exist (group-wide or this member's), for cross-chat recall. */
export function groupSessionsFor(selfId: string | number, userId: string | number, groups: { id: string; name?: string }[]): { key: string; label: string }[] {
  return groups.flatMap(g => [`${selfId}:g${g.id}`, `${selfId}:g${g.id}:u${userId}`]
    .filter(key => store.data[key])
    .map(key => ({ key, label: `群「${g.name ?? g.id}」` })))
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
      days: s.days?.length ?? 0,
      vectors: Object.keys(vectors.data[key]?.v ?? {}).length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Archive entries of one session with whether each has a vector in the current embedding space. */
export function archiveInfo(key: string) {
  const v = vectors.data[key]?.tag === embeddingTag() ? vectors.data[key].v : {}
  return (store.data[key]?.archive ?? []).map(entry => ({ ...entry, vector: Boolean(entry.id && v[entry.id]) }))
}

/** Daily digests of one session with whether each has a vector. */
export function dayInfo(key: string) {
  const v = vectors.data[key]?.tag === embeddingTag() ? vectors.data[key].v : {}
  return (store.data[key]?.days ?? []).map(d => ({ ...d, vector: Boolean(v[d.id]) }))
}

export function deleteArchiveEntry(key: string, id: string): boolean {
  const s = store.data[key]
  if (!s?.archive?.some(entry => entry.id === id) && !s?.days?.some(d => d.id === id)) return false
  s.archive = (s.archive ?? []).filter(entry => entry.id !== id)
  s.days = (s.days ?? []).filter(d => d.id !== id)
  if (vectors.data[key]?.v[id]) {
    delete vectors.data[key].v[id]
    vectors.save()
  }
  store.save()
  return true
}

/** Every archive entry that has a vector in the current embedding space (for the web UI's projection). */
export function allVectors(onlyKey?: string): { key: string; id: string; at: number; day: string; kind: 'episode' | 'day'; text: string; vec: Float32Array }[] {
  const tag = embeddingTag()
  const out: { key: string; id: string; at: number; day: string; kind: 'episode' | 'day'; text: string; vec: Float32Array }[] = []
  for (const key of Object.keys(store.data)) {
    if (onlyKey && key !== onlyKey) continue
    const v = vectors.data[key]?.tag === tag ? vectors.data[key].v : {}
    for (const entry of searchable(key)) if (entry.id && v[entry.id]) out.push({ key, id: entry.id, at: entry.at, day: entry.day, kind: entry.kind, text: entry.text, vec: decodeVector(v[entry.id]) })
  }
  return out
}

/** Sessions with archive entries or digests that have no vector in the current embedding space. */
export function sessionsMissingVectors(): string[] {
  if (!embeddingReady()) return []
  const tag = embeddingTag()
  return Object.entries(store.data).filter(([key, s]) => {
    const v = vectors.data[key]?.tag === tag ? vectors.data[key].v : {}
    return [...(s.archive ?? []), ...(s.days ?? [])].some(entry => !entry.id || !v[entry.id])
  }).map(([key]) => key)
}

/**
 * Re-embed everything with the current model (e.g. after switching models). Vectors from another model are never
 * used for scoring; until a session is re-embedded its recall falls back to keywords. Returns sessions redone and
 * the total vector count in the current space.
 */
export async function reindexAll(force = false): Promise<{ sessions: number; vectors: number }> {
  if (!embeddingReady()) throw new Error('没有配置向量模型的 API Key')
  if (force) for (const key of Object.keys(vectors.data)) vectors.data[key].tag = '' // mark stale so everything is redone
  let sessions = 0
  for (const key of sessionsMissingVectors()) {
    await indexArchive(key)
    sessions++
  }
  const count = Object.values(vectors.data).reduce((a, x) => a + (x.tag === embeddingTag() ? Object.keys(x.v).length : 0), 0)
  vectors.save()
  return { sessions, vectors: count }
}
