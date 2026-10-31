import type { QuotaCtx } from '../billing/ledger.ts'
import { resolvePrice } from '../billing/pricing.ts'
import { config } from '../core/config.ts'
import type { SystemOneModelConfig } from '../core/configTypes.ts'
import { formatNow, truncate } from '../core/util.ts'
import { botNickname, senderName } from '../core/yunzai.ts'
import { log } from '../core/log.ts'
import { partsToText } from '../llm/types.ts'
import { systemoneChoice } from '../llm/systemone.ts'
import { recentLines } from './groupLog.ts'
import { peekSession } from './session.ts'
import { utilityCandidates, utilityChat } from './utility.ts'

/**
 * What a judge (auto thinking level, proactive replies) reads: recent context laid out like the main model's prompt,
 * then the message to evaluate. Judges are told to evaluate only that last message.
 */
export interface JudgeTranscript {
  /** who the bot is, so the judge can tell when it is being addressed (see botLine) */
  bot?: string
  /** this conversation's recent turns with the bot (user messages as stored, then 你：reply) */
  history?: string[]
  /** recent group chat lines, numbered like 【最近群聊】 in the main prompt */
  recent?: string[]
  /** the quoted message, as 【引用 …】 */
  quote?: string
  /** 【消息｜time｜群…｜发言人 …】 */
  heading: string
  text: string
  /** pictures (not stickers) and stickers attached to the message */
  images?: number
}

export const LAST_MESSAGE_ONLY = '只评估【待评估的消息】这一条；前面的聊天记录只用来理解语境（追问、指代、话题），不要按前面的消息判断。'

/** Identifies the bot to a judge: its name and platform ID, and how mentions of it are written. */
export function botLine(name: string, selfId?: string | number): string {
  return `【机器人】你在评估的是QQ聊天机器人「${name || '机器人'}」${selfId != null ? `(平台ID ${selfId})` : ''}收到的消息；聊天记录里的「你」指这个机器人，[at:you] 表示@它，[at:ID] 表示@别人，叫它的名字也是在叫它。`
}

export function botLineFor(e: any): string {
  return botLine(config.get().persona.botName || botNickname(e), e?.self_id)
}

export function renderTranscript(t: JudgeTranscript): string {
  const out: string[] = []
  if (t.bot) out.push(t.bot)
  if (t.history?.length) out.push('【最近对话·仅供理解语境】', ...t.history)
  if (t.recent?.length) out.push('【最近群聊·仅供理解语境】', ...t.recent)
  out.push('【待评估的消息】')
  if (t.quote) out.push(t.quote)
  out.push(t.heading, t.text.slice(0, 800) || '（空：只@了你，没有说话）')
  if (t.images) out.push(`（附带 ${t.images} 张图片或表情）`)
  return out.join('\n')
}

/** Last `n` messages of a conversation with the bot, rendered as the main model sees them. */
export function historyLines(convKey: string, n: number): string[] {
  if (n <= 0) return []
  const s = peekSession(convKey)
  return (s?.messages ?? []).slice(-n).flatMap(m =>
    m.role === 'user' ? [truncate(partsToText(m.content), 300)] : m.role === 'assistant' && m.content ? [`你：${truncate(m.content, 200)}`] : [])
}

/** Heading of the current message, as in buildHeader. */
export function messageHeading(e: any, isAdmin = false): string {
  const who = `${senderName(e)}(平台ID ${e.user_id})${isAdmin ? '［管理员］' : ''}`
  return e.group_id
    ? `【消息｜${formatNow()}｜群「${truncate(String(e.group_name ?? e.group_id), 20)}」｜发言人 ${who}】`
    : `【消息｜${formatNow()}｜私聊｜对方 ${who}】`
}

/** Recent group lines before `e` (excluded), with the configured per-line budget. */
export function groupLines(e: any, n: number, conv?: string): string[] {
  const chat = config.effective(e?.group_id).chat
  return recentLines(e, n, chat.groupContextMaxChars, conv, chat.groupContextMaxAgeMinutes * 60_000)
}

export type JudgeTarget = { kind: 'systemone'; model: SystemOneModelConfig } | { kind: 'model'; candidates: string[] }

/** A judge id names a System One model or a chat model; empty = utilityModel, then the default model. */
export function judgeTarget(id: string): JudgeTarget {
  const so = config.getSystemoneModel(id)
  if (so) return { kind: 'systemone', model: so }
  return { kind: 'model', candidates: utilityCandidates(id || undefined) }
}

export interface ChoiceResult {
  /** chosen name (one of the criteria keys), when the judge's answer could be parsed */
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
  model: string
  source: 'model' | 'systemone'
  response: string
  inputTokens?: number
  outputTokens?: number
  cost?: number
  ms: number
}

/** Longest name first, so "question" isn't matched inside "big-question". */
export function parseChoice(out: string, names: string[]): string | undefined {
  const lower = out.toLowerCase()
  const hit = [...names].sort((a, b) => b.length - a.length).find(n => lower.includes(n.toLowerCase()))
  return hit
}

/**
 * One classification over `criteria` (name -> description). A chat model is asked for the name only, without
 * thinking; System One answers the same question natively, with probabilities.
 */
export async function judgeChoice(opts: {
  judge: string
  system: string
  instructions: string
  criteria: Record<string, string>
  transcript: string
  timeoutMs: number
  quotaCtx: QuotaCtx
}): Promise<ChoiceResult> {
  const target = judgeTarget(opts.judge)
  const names = Object.keys(opts.criteria)
  if (target.kind === 'systemone') {
    const a = await systemoneChoice(target.model, opts.transcript, { instructions: opts.instructions, criteria: opts.criteria }, opts.timeoutMs)
    const choice = a.choice && parseChoice(a.choice, names)
    return { choice, probabilities: a.probabilities, confidence: a.confidence, model: a.model, source: 'systemone', response: a.response, inputTokens: a.inputTokens, outputTokens: a.outputTokens, cost: a.cost, ms: a.ms }
  }
  const started = Date.now()
  const { text, model, usage, cost } = await utilityChat({
    candidates: target.candidates,
    system: opts.system,
    user: [{ type: 'text', text: opts.transcript }],
    maxTokens: 16,
    thinking: 'off',
    temperature: 0,
    quotaCtx: opts.quotaCtx,
    signal: AbortSignal.timeout(opts.timeoutMs),
  })
  const choice = parseChoice(text, names)
  const price = resolvePrice(model)
  log.debug(`[judge ${model.id}] ${Date.now() - started}ms choice=${choice ?? 'unknown'}(${text.trim()}) in=${usage?.input ?? '?'} price=${price ? `$${price.input}/M` : 'unknown'} cost=$${(cost ?? 0).toFixed(5)}`)
  return { choice, model: model.id, source: 'model', response: text, inputTokens: usage.input, outputTokens: usage.output, cost, ms: Date.now() - started }
}

/** System prompt for a chat-model judge choosing among `criteria`. */
export function choicePrompt(intro: string, criteria: Record<string, string>): string {
  const names = Object.keys(criteria)
  return [
    `${intro}只输出一个类别名：${names.join('、')}。不要输出其他内容。`,
    ...Object.entries(criteria).map(([name, desc]) => `${name}：${desc || '（无描述）'}`),
    LAST_MESSAGE_ONLY,
  ].join('\n')
}
