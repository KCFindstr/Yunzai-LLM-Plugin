import type { QuotaCtx } from '../billing/ledger.ts'
import { config } from '../core/config.ts'
import type { ProactiveSection } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { systemoneChoice } from '../llm/systemone.ts'
import { briefSegments, lastBotMessageAt } from './groupLog.ts'
import { botLineFor, groupLines, judgeTarget, LAST_MESSAGE_ONLY, messageHeading, renderTranscript, type JudgeTranscript } from './judge.ts'
import { utilityChat } from './utility.ts'

/**
 * Proactive replies: speaking up in a group without being addressed, in groups that enable it
 * (groups.<id>.proactive.enable). Two gates: each message is sampled with probability p; at the end of a
 * `window`-second window that had a sampled message, one judge call scores how fitting a reply to the newest message
 * is, and the bot replies when the score clears a threshold that is high right after the bot itself last replied in
 * the group and decays towards `end`. With judge 'always' there is no judge call: a sampled window replies.
 */

/** Judge calls can wait a little longer than auto thinking: nobody is waiting on them. */
const JUDGE_TIMEOUT_MS = 10_000

/** threshold(t) = end + (start - end) * 0.5^(t / halfLife); never spoke (t = Infinity) -> end. */
export function thresholdAt(t: ProactiveSection['threshold'], seconds: number | undefined): number {
  if (seconds == null || !Number.isFinite(seconds)) return t.end
  return t.end + (t.start - t.end) * Math.pow(0.5, Math.max(0, seconds) / Math.max(1, t.halfLife))
}

export function proactivePrompt(cfg: ProactiveSection): string {
  return [
    '你在帮QQ群里的聊天机器人决定要不要主动接话：没有人@它，它只是在群里看到了这些聊天。按下面的标准，评估它现在针对【待评估的消息】接一句话有多合适。',
    '只输出 0 到 100 的整数（0 = 绝对不该说话，100 = 非常适合接话），不要其他内容。',
    `适合插话：${cfg.criteria.reply || '（未设置）'}`,
    `不该插话：${cfg.criteria.skip || '（未设置）'}`,
    LAST_MESSAGE_ONLY,
  ].join('\n')
}

/** 0-100 (or 0-1) from a chat model's answer, as 0-1. */
export function parseScore(text: string): number | undefined {
  const m = /\d+(?:\.\d+)?/.exec(text)
  if (!m) return undefined
  const v = Number(m[0])
  return Math.min(1, Math.max(0, v > 1 ? v / 100 : v))
}

export interface ProactiveVerdict {
  /** 0-1: how fitting a reply is; undefined when the judge failed */
  score?: number
  threshold: number
  reply: boolean
  /** seconds since the bot itself last replied in the group (undefined: not since the plugin started) */
  sinceLast?: number
  model?: string
  source?: 'model' | 'systemone'
  response?: string
  ms: number
  cost?: number
  error?: string
}

export async function judgeProactive(transcript: JudgeTranscript, cfg: ProactiveSection, sinceLast: number | undefined, quotaCtx: QuotaCtx): Promise<ProactiveVerdict> {
  const started = Date.now()
  const threshold = thresholdAt(cfg.threshold, sinceLast)
  const state = renderTranscript(transcript)
  // 'always': the probability gate is the only one
  if (cfg.judge === 'always') return { score: 1, threshold, reply: true, sinceLast, model: 'always', ms: 0 }
  try {
    const target = judgeTarget(cfg.judge || config.get().autoThinking.judge)
    if (target.kind === 'systemone') {
      const a = await systemoneChoice(target.model, state, {
        instructions: `机器人现在要不要主动针对【待评估的消息】接话？${LAST_MESSAGE_ONLY}`,
        criteria: { reply: cfg.criteria.reply || '适合接话', skip: cfg.criteria.skip || '不该接话' },
      }, JUDGE_TIMEOUT_MS)
      const score = a.probabilities.reply ?? (a.choice === 'reply' ? a.confidence ?? 1 : a.choice === 'skip' ? 1 - (a.confidence ?? 1) : undefined)
      return { score, threshold, reply: score != null && score >= threshold, sinceLast, model: a.model, source: 'systemone', response: a.response, ms: Date.now() - started, cost: a.cost }
    }
    const { text, model, cost } = await utilityChat({
      candidates: target.candidates,
      system: proactivePrompt(cfg),
      user: [{ type: 'text', text: state }],
      maxTokens: 8,
      thinking: 'off',
      temperature: 0,
      quotaCtx,
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    })
    const score = parseScore(text)
    return { score, threshold, reply: score != null && score >= threshold, sinceLast, model: model.id, source: 'model', response: text, ms: Date.now() - started, cost }
  } catch (err: any) {
    return { threshold, reply: false, sinceLast, ms: Date.now() - started, error: err?.message ?? String(err) }
  }
}

/** The judge's view of the newest message `e`: the group chat before it, then the message itself. */
export function proactiveTranscript(e: any, context: number): JudgeTranscript {
  return {
    bot: botLineFor(e),
    recent: groupLines(e, Math.max(0, context - 1)),
    heading: messageHeading(e),
    text: briefSegments(e.message, e.self_id),
  }
}

export interface ProactiveRecord extends ProactiveVerdict {
  at: number
  groupId: string
  text: string
}

/** Latest decisions, newest last, for the web UI. */
const history: ProactiveRecord[] = []
export const recentProactive = () => [...history].reverse()
function remember(r: ProactiveRecord) {
  history.push(r)
  if (history.length > 50) history.splice(0, history.length - 50)
}

interface GroupState {
  timer?: NodeJS.Timeout
  sampled: boolean
  last?: any
  running: boolean
}
const groups = new Map<string, GroupState>()
const keyOf = (e: any) => `${e.self_id}:${e.group_id}`

export type Respond = (e: any) => Promise<void>

/** A group message nobody addressed to the bot (callers have already checked blacklists and triggers). */
export function considerProactive(e: any, respond: Respond, random = Math.random) {
  if (!e?.group_id || String(e.user_id) === String(e.self_id)) return
  const eff = config.effective(e.group_id)
  if (!eff.enable || !eff.proactive.enable) return
  const cfg = eff.proactive
  const key = keyOf(e)
  const s = groups.get(key) ?? { sampled: false, running: false }
  groups.set(key, s)
  const sampled = random() < cfg.probability
  s.last = e
  s.sampled ||= sampled
  if (s.timer) return
  s.timer = setTimeout(() => void closeWindow(key, respond), cfg.window * 1000)
  s.timer.unref?.()
}

async function closeWindow(key: string, respond: Respond) {
  const s = groups.get(key)
  if (!s) return
  s.timer = undefined
  const e = s.last
  const sampled = s.sampled
  s.sampled = false
  if (!sampled || !e || s.running) return
  const cfg = config.effective(e.group_id).proactive
  if (!cfg.enable) return
  const last = lastBotMessageAt(e)
  const sinceLast = last != null ? (Date.now() - last) / 1000 : undefined
  s.running = true
  try {
    const v = await judgeProactive(proactiveTranscript(e, cfg.context), cfg, sinceLast, { groupId: e.group_id, isAdmin: false })
    const text = briefSegments(e.message, e.self_id)
    remember({ ...v, at: Date.now(), groupId: String(e.group_id), text: brief(text, 60) })
    log.info(`主动发言判断 群${e.group_id}：${v.error ? `失败（${v.error}）` : `分数 ${v.score?.toFixed(2) ?? '?'} / 阈值 ${v.threshold.toFixed(2)} → ${v.reply ? '接话' : '不接话'}`}（${v.ms}ms）：${brief(text, 40)}`)
    if (v.reply) await respond(e)
  } finally {
    s.running = false
  }
}


export function resetProactive() {
  for (const s of groups.values()) clearTimeout(s.timer)
  groups.clear()
  history.length = 0
}
