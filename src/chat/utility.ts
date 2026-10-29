import { computeCost, resolvePrice } from '../billing/pricing.ts'
import { checkQuota, record, type QuotaCtx } from '../billing/ledger.ts'
import { config } from '../core/config.ts'
import type { ModelConfig, ProviderConfig, ThinkingLevel } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { chat, type ChatResult, type Part, type Usage } from '../llm/index.ts'

export interface Picked {
  model: ModelConfig
  provider: ProviderConfig
}

/** First configured model (by id) that has a provider with a key (and vision if required). */
export function pickModel(ids: (string | undefined)[], needVision = false): Picked | undefined {
  for (const id of ids) {
    const model = config.getModel(id)
    if (!model) continue
    const provider = config.getProvider(model.provider)
    if (!provider || !config.hasKey(provider)) continue
    if (needVision && model.vision === false) continue
    return { model, provider }
  }
  return undefined
}

/** Candidate list for background jobs (indexing, summaries): explicit > utility > default. */
export function utilityCandidates(explicit?: string, vision = false): string[] {
  const c = config.get()
  return [explicit, vision ? c.visionModel : undefined, c.utilityModel, config.defaultModelId(), ...c.models.map(m => m.id)].filter(
    (x): x is string => Boolean(x),
  )
}

/** One-shot, tool-less LLM call with billing. Throws on quota exhaustion or API error. */
export async function utilityChat(opts: {
  candidates: string[]
  vision?: boolean
  system: string
  user: Part[]
  maxTokens?: number
  quotaCtx: QuotaCtx
  /** override the model's own setting (e.g. 'off' for a latency-sensitive classifier call) */
  thinking?: ThinkingLevel
  temperature?: number
  signal?: AbortSignal
  /** Summaries must not settle their source records when the model runs out of output budget. */
  requireComplete?: boolean
}): Promise<{ text: string; model: ModelConfig; usage: Usage; cost: number }> {
  const picked = pickModel(opts.candidates, opts.vision)
  if (!picked) throw new Error(opts.vision ? '没有可用的视觉模型（需配置 vision 模型及 API Key）' : '没有可用的模型')
  const block = checkQuota(picked.model, opts.quotaCtx)
  if (block) throw new Error(`模型 ${picked.model.id} 额度已用完`)
  // background jobs (summaries, sticker naming) aren't judged: 'auto' runs at the first category's level
  // (a model without its own level stays off, unless the chat default it inherits is 'auto')
  const setting = picked.model.thinking ?? (config.get().chat.thinking === 'auto' ? 'auto' : undefined)
  const thinking: ThinkingLevel = opts.thinking ?? (!setting ? 'off' : setting === 'auto' ? config.fallbackLevel(picked.model) : setting)
  const call = (t: ThinkingLevel) =>
    chat({
      model: picked.model,
      provider: picked.provider,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      tools: [],
      thinking: t,
      maxTokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? picked.model.temperature ?? null,
      signal: opts.signal,
      store: false,
    })
  let res: ChatResult
  try {
    res = await call(thinking)
  } catch (err: any) {
    if (thinking !== 'off' && /reason|thinking|effort|output_config/.test(`${err?.message ?? ''} ${err?.body ?? ''}`.toLowerCase())) res = await call('off')
    else throw err
  }
  const cost = computeCost(res.usage, resolvePrice(picked.model))
  record(picked.model, opts.quotaCtx, cost, res.usage)
  log.debug(`utility call ${picked.model.id} in=${res.usage?.input ?? 0} out=${res.usage?.output ?? 0} cost=${cost.toFixed(5)}`)
  if (opts.requireComplete) {
    // Gemini can report a completed interaction even when reasoning consumed almost the entire cap.
    const nearGeminiCap = picked.provider.type === 'gemini' && res.usage.output >= (opts.maxTokens ?? 600) - 16
    if (/length|max_tokens|max_output_tokens|incomplete/i.test(res.stopReason) || nearGeminiCap)
      throw new Error('摘要生成达到输出上限，未保存不完整结果；请增大 chat.summaryMaxTokens 后重试')
    if (!res.text.trim() || /(?:^|\n)\s*(?:\d+[.)、]|[-*])\s*$/.test(res.text))
      throw new Error('摘要生成未返回完整正文，保留原文以便重试')
  }
  return { text: res.text, model: picked.model, usage: res.usage, cost }
}

/** Extract the first JSON object from model text (tolerates code fences / prose). */
export function extractJson(text: string): any {
  const t = text.replace(/```(?:json)?/gi, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return undefined
  }
}
