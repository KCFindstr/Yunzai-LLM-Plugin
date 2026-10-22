import type { QuotaCtx } from '../billing/ledger.ts'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { flushChatter } from './chatter.ts'
import { CHATTER_PROMPT, DAY_PROMPT } from './prompt.ts'
import { indexArchive, pendingChatter, peekSession, sessionsWithWork, setDayDigest, setEpisode, staleDay } from './session.ts'
import { utilityCandidates, utilityChat } from './utility.ts'

/**
 * Background archive work that doesn't wait for the bot to be spoken to: summarizing buffered group chatter and
 * writing daily digests. Runs every few minutes; also called after each reply for that conversation.
 */

const TICK_MS = 5 * 60_000
const BACKOFF_MS = 3600_000
const busy = new Set<string>()
const failedUntil = new Map<string, number>()
let timer: NodeJS.Timeout | undefined

const hhmm = (ts: number) => new Date(ts + 8 * 3600_000).toISOString().slice(11, 16)

/** Summarize one day's worth of pending chatter chunks (up to 3) into a single archive entry. */
async function summarizeChatter(key: string, ctx: QuotaCtx): Promise<boolean> {
  const pending = pendingChatter(key).slice(0, 3)
  if (!pending.length) return false
  const session = peekSession(key)
  const { text } = await utilityChat({
    candidates: utilityCandidates(),
    system: CHATTER_PROMPT,
    user: [{ type: 'text', text: `${pending[0].day ?? ''} 的群聊记录：\n${pending.map(entry => entry.text).join('\n')}` }],
    maxTokens: 500,
    quotaCtx: ctx,
  })
  if (peekSession(key) !== session) return false
  setEpisode(key, pending, `【群聊】${text.trim().slice(0, 400)}`)
  return true
}

/** Write (or refresh) the digest for the oldest past day that needs one. */
export async function digestDay(key: string, ctx: QuotaCtx): Promise<boolean> {
  const stale = staleDay(key)
  if (!stale) return false
  const session = peekSession(key)
  const lines = stale.entries.map(entry => `- ${hhmm(entry.at)} ${entry.text}`).join('\n')
  const { text } = await utilityChat({
    candidates: utilityCandidates(),
    system: DAY_PROMPT,
    user: [{ type: 'text', text: `日期：${stale.day}\n${stale.prev ? `之前写过的当日概要：${stale.prev.text}\n` : ''}当天的聊天片段：\n${lines}` }],
    maxTokens: 700,
    quotaCtx: ctx,
  })
  if (peekSession(key) !== session || !text.trim()) return false
  setDayDigest(key, stale.day, text.trim().slice(0, 600), stale.entries.map(entry => entry.id!).filter(Boolean))
  log.info(`已整理 ${key} 的 ${stale.day} 当日概要`)
  return true
}

/** All pending archive work for one session, one step at a time; failures back off for an hour. */
export async function maintainArchive(key: string, ctx: QuotaCtx = {}) {
  if (busy.has(key) || (failedUntil.get(key) ?? 0) > Date.now() || !config.get().chat.summarize) return
  busy.add(key)
  try {
    let changed = false
    for (let i = 0; i < 6 && (await summarizeChatter(key, ctx)); i++) changed = true
    for (let i = 0; i < 3 && (await digestDay(key, ctx)); i++) changed = true
    if (changed) await indexArchive(key).catch(err => log.warn(`旧聊天向量索引失败: ${err?.message ?? err}`))
  } catch (err: any) {
    failedUntil.set(key, Date.now() + BACKOFF_MS)
    log.warn(`整理旧聊天失败（${key}，1小时后重试）: ${err?.message ?? err}`)
  } finally {
    busy.delete(key)
  }
}

export async function runArchiveJobs() {
  if (!config.get().memory.enable) return
  flushChatter()
  for (const key of sessionsWithWork()) await maintainArchive(key)
}

export function startArchiveJobs() {
  if (timer) return
  timer = setInterval(() => void runArchiveJobs().catch(err => log.warn('后台整理旧聊天出错', err)), TICK_MS)
  timer.unref?.()
}

export function stopArchiveJobs() {
  clearInterval(timer)
  timer = undefined
}
