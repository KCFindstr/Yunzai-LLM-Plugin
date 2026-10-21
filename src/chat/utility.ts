import { computeCost, resolvePrice } from '../billing/pricing.ts'
import { checkQuota, record, type QuotaCtx } from '../billing/ledger.ts'
import { config } from '../core/config.ts'
import type { ModelConfig, ProviderConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { chat, type Part } from '../llm/index.ts'

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
}): Promise<{ text: string; model: ModelConfig }> {
  const picked = pickModel(opts.candidates, opts.vision)
  if (!picked) throw new Error(opts.vision ? '没有可用的视觉模型（需配置 vision 模型及 API Key）' : '没有可用的模型')
  const block = checkQuota(picked.model, opts.quotaCtx)
  if (block) throw new Error(`模型 ${picked.model.id} 额度已用完`)
  let thinking = picked.model.thinking ?? 'off'
  let res: any
  try {
    res = await chat({
      model: picked.model,
      provider: picked.provider,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      tools: [],
      thinking,
      maxTokens: opts.maxTokens ?? 600,
      temperature: picked.model.temperature ?? null,
    })
  } catch (err: any) {
    if (thinking !== 'off' && /reason|thinking|effort|output_config/.test(`${err?.message ?? ''} ${err?.body ?? ''}`.toLowerCase())) {
      res = await chat({
        model: picked.model,
        provider: picked.provider,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        tools: [],
        thinking: 'off',
        maxTokens: opts.maxTokens ?? 600,
        temperature: picked.model.temperature ?? null,
      })
    } else {
      throw err
    }
  }
  const cost = computeCost(res.usage, resolvePrice(picked.model))
  record(picked.model, opts.quotaCtx, cost, res.usage)
  log.debug(`utility call ${picked.model.id} cost=${cost.toFixed(5)}`)
  return { text: res.text, model: picked.model }
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
