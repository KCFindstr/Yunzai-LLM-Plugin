import type { QuotaCtx } from '../billing/ledger.ts'
import { config } from '../core/config.ts'
import type { AutoThinkingSection, ModelConfig, ThinkingLevel, ThinkingSetting } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { choicePrompt, judgeChoice, LAST_MESSAGE_ONLY, renderTranscript, type JudgeTranscript } from './judge.ts'

/** Chosen category: one of autoThinking.categories names. */
export type MessageKind = string

/** System prompt for a chat-model judge (stable for a given category list, so providers can cache it). */
export function judgePrompt(cfg: AutoThinkingSection = config.get().autoThinking): string {
  return choicePrompt('你是消息分类器。QQ群里的聊天机器人收到一条消息，判断回复它需要多少思考。', criteriaOf(cfg))
}

export const criteriaOf = (cfg: AutoThinkingSection) => Object.fromEntries(cfg.categories.map(k => [k.name, k.description]))

export interface Judgement {
  kind: MessageKind
  /** who decided: the judge, or the fallback (first category) when it failed or answered nothing usable */
  source: 'model' | 'systemone' | 'fallback'
  ms: number
  judge?: JudgeResponse
  fallbackReason?: string
}

export interface JudgeResponse {
  kind?: MessageKind
  model: string
  response: string
  probabilities?: Record<string, number>
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

export interface ThinkingDecision extends Omit<Judgement, 'kind' | 'source'> {
  setting: ThinkingSetting
  level: ThinkingLevel
  kind?: MessageKind
  source: Judgement['source'] | 'fixed' | 'uniform' | 'unsupported'
}

/**
 * Classify the last message of `transcript` into an auto-thinking category. Any judge failure, timeout or
 * unparseable answer falls back to the first category.
 */
export async function judgeMessage(transcript: JudgeTranscript, quotaCtx: QuotaCtx, cfg: AutoThinkingSection = config.get().autoThinking): Promise<Judgement> {
  const started = Date.now()
  const fallback = cfg.categories[0]?.name ?? 'casual'
  let judge: JudgeResponse | undefined
  let fallbackReason: string | undefined
  try {
    const r = await judgeChoice({
      judge: cfg.judge,
      system: judgePrompt(cfg),
      instructions: `QQ群聊天机器人回复【待评估的消息】需要多少思考？${LAST_MESSAGE_ONLY}`,
      criteria: criteriaOf(cfg),
      transcript: renderTranscript(transcript),
      timeoutMs: cfg.timeoutMs,
      quotaCtx,
    })
    judge = { kind: r.choice, model: r.model, response: r.response, probabilities: r.probabilities, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost }
    if (r.choice) return { kind: r.choice, source: r.source, ms: Date.now() - started, judge }
    fallbackReason = `无法解析判断结果，使用第一个类别 ${fallback}`
    log.info(`思考强度判断：无法解析结果，使用第一个类别 ${fallback}`)
  } catch (err: any) {
    fallbackReason = err?.message ?? String(err)
    log.info(`思考强度判断失败（${fallbackReason}），使用第一个类别 ${fallback}`)
  }
  return { kind: fallback, source: 'fallback', ms: Date.now() - started, ...(judge ? { judge } : {}), fallbackReason }
}

/**
 * Resolve a thinking setting for this message. `auto` asks the judge for a category and uses `model`'s level for it
 * (models[].autoThinking, then autoThinking.levels). Note: on Anthropic, changing effort between turns invalidates
 * the cached message prefix, so `auto` trades some cache hits for cheaper casual replies there.
 */
export async function resolveThinkingDecision(setting: ThinkingSetting, model: ModelConfig | undefined, transcript: JudgeTranscript, quotaCtx: QuotaCtx): Promise<ThinkingDecision> {
  if (setting !== 'auto') return { setting, level: setting, source: 'fixed', ms: 0 }
  const cfg = config.get().autoThinking
  const levels = cfg.categories.map(k => config.autoLevel(model, k.name))
  if (levels.every(l => l === levels[0])) return { setting, level: levels[0] ?? 'low', source: 'uniform', ms: 0 }
  const j = await judgeMessage(transcript, quotaCtx, cfg)
  const level = config.autoLevel(model, j.kind)
  log.info(`思考强度 ${level}（${j.kind}，由 ${j.source} 判断，${j.ms}ms）：${brief(transcript.text, 40)}`)
  return { ...j, setting, level }
}
