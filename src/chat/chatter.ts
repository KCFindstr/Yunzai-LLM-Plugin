import { config } from '../core/config.ts'
import { JsonStore } from '../core/store.ts'
import { truncate } from '../core/util.ts'
import { isSensitive } from '../memory/store.ts'
import { localDay } from './dates.ts'
import { archiveChatter } from './session.ts'

/**
 * Group chatter that doesn't involve the bot, buffered on disk until there's enough to summarize. Flushed chunks
 * become `chat` entries in the group session's archive (`<self>:g<group>`), where the background job summarizes
 * them and folds them into that day's digest. Messages the bot answered are skipped: they are in its own history.
 */

interface Line { t: number; name: string; text: string; mid?: string; handled?: boolean }

const store = new JsonStore<Record<string, Line[]>>('group-chatter.json', {})
const MAX_BUFFERED = 2000
const CHUNK_LINES = 50
const CHUNK_CHARS = 4000
const QUIET_MS = 2 * 3600_000

/** Whether this group's chatter should be kept (feature on, plugin enabled there, not filtered out). */
function enabledFor(groupId: string): boolean {
  const c = config.get()
  if (!c.memory.enable || !c.memory.groupChatArchive || !config.effective(groupId).enable) return false
  const white = c.trigger.groupWhitelist.map(String)
  if (white.length && !white.includes(groupId)) return false
  return !c.trigger.groupBlacklist.map(String).includes(groupId)
}

export function recordChatter(e: any, name: string, text: string) {
  if (!e?.group_id || !text || isSensitive(text) || !enabledFor(String(e.group_id))) return
  const key = `${e.self_id}:${e.group_id}`
  const list = store.data[key] ??= []
  list.push({ t: Date.now(), name, text: truncate(text, 300), mid: e.message_id != null ? String(e.message_id) : undefined })
  if (list.length > MAX_BUFFERED) list.splice(0, list.length - MAX_BUFFERED)
  store.save()
}

/** The bot handled this message: it is (or will be) in the bot's own session history. */
export function markChatterHandled(e: any) {
  if (!e?.group_id || e.message_id == null) return
  const line = store.data[`${e.self_id}:${e.group_id}`]?.find(l => l.mid === String(e.message_id))
  if (line) {
    line.handled = true
    store.save()
  }
}

const render = (lines: Line[]) => lines.map(l => `${new Date(l.t + 8 * 3600_000).toISOString().slice(11, 16)} ${l.name}: ${l.text}`).join('\n')

/**
 * Move buffered chatter into group archives: whole past days, and today's lines once there are enough of them
 * (or the group has been quiet for a while). Returns the session keys that received new chunks.
 */
export function flushChatter(now = Date.now()): string[] {
  const touched = new Set<string>()
  const today = localDay(now)
  for (const [key, list] of Object.entries(store.data)) {
    if (!list.length) {
      delete store.data[key]
      continue
    }
    const [selfId, groupId] = key.split(':')
    const lines = list.filter(l => !l.handled)
    const byDay = new Map<string, Line[]>()
    for (const l of lines) byDay.set(localDay(l.t), [...(byDay.get(localDay(l.t)) ?? []), l])
    const flushed = new Set<Line>(list.filter(l => l.handled && localDay(l.t) < today))
    for (const [day, dayLines] of byDay) {
      const chars = dayLines.reduce((a, l) => a + l.text.length, 0)
      const ready = day < today || dayLines.length >= CHUNK_LINES || chars >= CHUNK_CHARS || now - dayLines.at(-1)!.t > QUIET_MS
      // a single stray message isn't worth a summary of its own until the day is over
      if (!ready || (day === today && dayLines.length < 3)) continue
      for (let i = 0; i < dayLines.length; i += CHUNK_LINES) {
        const chunk = dayLines.slice(i, i + CHUNK_LINES)
        archiveChatter(`${selfId}:g${groupId}`, day, render(chunk), chunk.at(-1)!.t)
      }
      for (const l of dayLines) flushed.add(l)
      // handled lines of a flushed day are no longer needed either
      for (const l of list) if (l.handled && localDay(l.t) === day) flushed.add(l)
      touched.add(`${selfId}:g${groupId}`)
    }
    if (flushed.size) {
      store.data[key] = list.filter(l => !flushed.has(l))
      if (!store.data[key].length) delete store.data[key]
    }
  }
  if (touched.size) store.save()
  return [...touched]
}

export function clearChatter() {
  for (const key of Object.keys(store.data)) delete store.data[key]
  store.save()
}
