import { recordUsageCall } from '../billing/history.ts'
import { computeCost, DEFAULT_JEV_PRICE, resolveModelPrice } from '../billing/pricing.ts'
import { config, resolveKeys } from '../core/config.ts'
import type { SystemOneModelConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { emptyUsage, type Usage } from './types.ts'
import { joinUrl } from './http.ts'

export interface ChoiceAnswer {
  choice?: string
  confidence?: number
  /** choice -> probability, when the service reports them */
  probabilities: Record<string, number>
  model: string
  inputTokens?: number
  outputTokens: number
  cost: number
  ms: number
  /** the classification response without provider metadata, for rollouts and the playground */
  response: string
}

/** Default endpoint path under the provider's base URL (TypeSafe Jev and self-hosted Kev alike). */
const PATH = 'systemone'

/**
 * Ask a TypeSafe System One model one `choice` question about `state`. Criteria map each choice to its description.
 * Billed like other calls (`systemone:<model>` in the usage history).
 */
export async function systemoneChoice(target: SystemOneModelConfig, state: string, question: { instructions: string; criteria: Record<string, string> }, timeoutMs: number): Promise<ChoiceAnswer> {
  const provider = config.getProvider(target.provider)
  if (!provider || provider.type !== 'systemone') throw new Error(`System One 模型 ${target.id} 的提供商 ${target.provider} 不存在或不是 systemone 类型`)
  const started = Date.now()
  const key = resolveKeys(provider.apiKey)[0]
  const url = joinUrl(provider.baseUrl || 'https://api.typesafe.ai/v1', PATH)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...provider.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: target.model, state, questions: { answer: { type: 'choice', instructions: question.instructions, criteria: question.criteria } } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`System One HTTP ${res.status}`)
  const j: any = await res.json()
  // answers are keyed by question name; accept any single answer from compatible servers
  const ans = j?.answers?.answer ?? Object.values(j?.answers ?? {})[0] as any
  const ms = Date.now() - started
  const modelName = String(j?.model || target.model)
  const price = resolveModelPrice(modelName) ?? (/typesafe\.ai/i.test(url) ? { ...DEFAULT_JEV_PRICE, source: 'builtin' } : undefined)
  const inputTokens = j?.usage?.input_tokens ?? j?.usage?.prompt_tokens ?? j?.usage?.input
  const outputTokens = j?.usage?.output_tokens ?? j?.usage?.completion_tokens ?? j?.usage?.output ?? 0
  const usage: Usage = {
    ...emptyUsage(),
    input: inputTokens ?? 0,
    output: outputTokens,
    cost: typeof j?.cost === 'number' ? j.cost : typeof j?.usage?.cost === 'number' ? j.usage.cost : undefined,
  }
  const cost = computeCost(usage, price)
  recordUsageCall({ id: `systemone:${modelName}`, provider: 'systemone', model: modelName }, cost,
    { ...usage, ...(inputTokens == null ? { inputIncomplete: true } : {}) }, price)
  const raw = ans?.probabilities
  const probability = (name: string) => {
    const value = Array.isArray(raw) ? raw.find((entry: any) => (entry?.choice ?? entry?.name) === name) : raw?.[name]
    const score = value && typeof value === 'object' ? value.probability ?? value.score ?? value.prob : value
    return typeof score === 'number' && Number.isFinite(score) ? score : undefined
  }
  const probabilities = Object.fromEntries(Object.keys(question.criteria).map(name => [name, probability(name)]).filter(([, v]) => v != null)) as Record<string, number>
  const choice = typeof ans?.choice === 'string' ? ans.choice : undefined
  const confidence = typeof ans?.confidence === 'number' && Number.isFinite(ans.confidence) ? ans.confidence : undefined
  log.debug(`[systemone ${modelName}] ${ms}ms choice=${choice ?? '?'}${confidence != null ? ` conf=${confidence.toFixed(2)}` : ''}${Object.keys(probabilities).length ? ` probs=(${Object.entries(probabilities).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')})` : ''} in=${inputTokens ?? '?'} cost=$${cost.toFixed(6)}`)
  const response = JSON.stringify({ model: modelName, answers: { kind: { choice, confidence, probabilities } }, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, cost }, null, 2)
  return { choice, confidence, probabilities, model: modelName, inputTokens, outputTokens, cost, ms, response }
}
