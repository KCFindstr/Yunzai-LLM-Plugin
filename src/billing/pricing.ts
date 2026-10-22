import { config } from '../core/config.ts'
import type { ModelConfig, PriceConfig, ProviderType } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { JsonStore } from '../core/store.ts'
import type { Usage } from '../llm/types.ts'

/** USD per 1M tokens; perSearch/perRequest in USD per call. */
export interface Price extends PriceConfig {
  input: number
  output: number
  source: string
}

/** First-party Anthropic, DeepSeek, and Google Gemini list prices. Others come from remote price lists or config. */
const BUILTIN: Record<string, Omit<Price, 'source'>> = {
  // DeepSeek
  'deepseek-chat': { input: 0.28, output: 0.42, cacheRead: 0.028 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 },
  'deepseek-v3': { input: 0.28, output: 0.42, cacheRead: 0.028 },
  'deepseek-r1': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  // Gemini
  'gemini-4-argon': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  // TypeSafe System One
  jev: { input: 0.042, output: 0 },
  kev: { input: 0, output: 0 },
}

/** Default price for TypeSafe System One Jev models ($0.042/1M input tokens, free outputs). */
export const DEFAULT_JEV_PRICE: Omit<Price, 'source'> = { input: 0.042, output: 0 }
/** Default price for self-hosted Kev models (local, $0). */
export const DEFAULT_KEV_PRICE: Omit<Price, 'source'> = { input: 0, output: 0 }

export function isJevModel(id: string): boolean {
  const norm = normalizeModelId(id)
  return norm === 'jev' || /^jev([-_].*)?$/.test(norm)
}

export function isKevModel(id: string): boolean {
  const norm = normalizeModelId(id)
  return norm === 'kev' || /^kev([-_].*)?$/.test(norm)
}

/** Approximate native web-search prices (USD/search) when the price list has none. */
const DEFAULT_SEARCH_PRICE: Partial<Record<ProviderType, number>> = {
  anthropic: 0.01,
  'openai-responses': 0.01,
  gemini: 0.014,
}

interface PriceCache {
  fetchedAt: number
  entries: Record<string, Price>
}

const cache = new JsonStore<PriceCache>('pricing-cache.json', { fetchedAt: 0, entries: {} }, 1000)
let refreshing: Promise<void> | undefined
let timer: NodeJS.Timeout | undefined
const warned = new Set<string>()

/** "anthropic/claude-sonnet-4.5:beta" -> "claude-sonnet-4-5"; "claude-haiku-4-5-20251001" -> "claude-haiku-4-5". */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .trim()
    .replace(/^.*\//, '')
    .replace(/:.*$/, '')
    .replace(/\./g, '-')
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/-latest$/, '')
}

const perM = (v: any) => {
  const n = Number(v)
  return Number.isFinite(n) ? n * 1e6 : undefined
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function loadOpenRouter(into: Record<string, Price>) {
  const j = await fetchJson('https://openrouter.ai/api/v1/models')
  for (const m of j?.data ?? []) {
    const pr = m?.pricing
    const input = perM(pr?.prompt)
    const output = perM(pr?.completion)
    if (input == null || output == null || input < 0) continue
    const price: Price = {
      input,
      output,
      cacheRead: perM(pr.input_cache_read),
      cacheWrite: perM(pr.input_cache_write),
      perSearch: Number(pr.web_search) || undefined,
      source: 'openrouter',
    }
    for (const id of [m.id, m.canonical_slug].filter(Boolean)) {
      const k = normalizeModelId(id)
      into[k] ??= price
    }
  }
}

async function loadLiteLLM(into: Record<string, Price>) {
  const j = await fetchJson('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json')
  // Unprefixed keys are first-party listings; prefer them over bedrock/vertex/etc. variants.
  const keys = Object.keys(j).sort((a, b) => Number(a.includes('/')) - Number(b.includes('/')))
  for (const key of keys) {
    const m = j[key]
    if (!m || (m.mode && !['chat', 'responses', 'completion'].includes(m.mode))) continue
    const input = perM(m.input_cost_per_token)
    const output = perM(m.output_cost_per_token)
    if (input == null || output == null) continue
    const k = normalizeModelId(key)
    into[k] ??= {
      input,
      output,
      cacheRead: perM(m.cache_read_input_token_cost),
      cacheWrite: perM(m.cache_creation_input_token_cost),
      cacheWrite1h: perM(m.cache_creation_input_token_cost_above_1hr),
      source: 'litellm',
    }
  }
}

export async function refreshPrices(force = false): Promise<void> {
  const hours = config.get().pricing.refreshHours || 24
  if (!force && Date.now() - cache.data.fetchedAt < hours * 3600_000) return
  refreshing ??= (async () => {
    const entries: Record<string, Price> = {}
    for (const src of config.get().pricing.sources) {
      try {
        if (src === 'openrouter') await loadOpenRouter(entries)
        else if (src === 'litellm') await loadLiteLLM(entries)
      } catch (err: any) {
        log.warn(`获取 ${src} 价格表失败: ${err.message}`)
      }
    }
    if (Object.keys(entries).length) {
      cache.data = { fetchedAt: Date.now(), entries }
      cache.save()
      log.info(`价格表已更新，共 ${Object.keys(entries).length} 个模型`)
    }
  })().finally(() => (refreshing = undefined))
  return refreshing
}

export function startPriceRefresh() {
  refreshPrices().catch(() => {})
  clearInterval(timer)
  timer = setInterval(() => refreshPrices().catch(() => {}), 3600_000)
  timer.unref?.()
}

export function stopPriceRefresh() {
  clearInterval(timer)
}

export function resolvePrice(model: ModelConfig): Price | undefined {
  const providerType = config.getProvider(model.provider)?.type
  const withSearch = (p: Price): Price => ({
    ...p,
    perSearch: p.perSearch ?? (providerType ? DEFAULT_SEARCH_PRICE[providerType] : undefined),
  })
  if (model.pricing && typeof model.pricing === 'object' && model.pricing.input != null && model.pricing.output != null)
    return withSearch({ ...(model.pricing as any), source: 'config' })
  const id = normalizeModelId(model.pricingId || model.model)
  if (BUILTIN[id]) return withSearch({ ...BUILTIN[id], source: 'builtin' })
  if (isJevModel(id)) return withSearch({ ...DEFAULT_JEV_PRICE, source: 'builtin' })
  if (isKevModel(id)) return withSearch({ ...DEFAULT_KEV_PRICE, source: 'builtin' })
  const remote = cache.data.entries[id]
  if (remote) return withSearch(remote)
  if (!warned.has(id)) {
    warned.add(id)
    log.warn(`模型 ${model.id}(${model.model}) 价格未知，额度统计将按 $0 计算。请在配置中设置 pricing 或 pricingId`)
  }
  return undefined
}

/** Resolve price for an arbitrary model name or id (e.g. System One judges, classifiers) without a ModelConfig. */
export function resolveModelPrice(modelName: string): Price | undefined {
  const m = config.getModel(modelName)
  if (m) {
    const p = resolvePrice(m)
    if (p) return p
  }
  const id = normalizeModelId(modelName)
  if (BUILTIN[id]) return { ...BUILTIN[id], source: 'builtin' }
  if (isJevModel(id)) return { ...DEFAULT_JEV_PRICE, source: 'builtin' }
  if (isKevModel(id)) return { ...DEFAULT_KEV_PRICE, source: 'builtin' }
  const remote = cache.data.entries[id]
  if (remote) return remote
  return undefined
}

export function computeCost(u: Usage, price?: Price): number {
  if (u.cost != null && Number.isFinite(u.cost)) return u.cost
  if (!price) return 0
  const cr = price.cacheRead ?? price.input * 0.5
  const cw = price.cacheWrite ?? price.input * 1.25
  const cw1 = price.cacheWrite1h ?? price.input * 2
  return (
    (u.input * price.input + u.cacheRead * cr + u.cacheWrite * cw + u.cacheWrite1h * cw1 + u.output * price.output) / 1e6 +
    u.webSearches * (price.perSearch ?? 0) +
    (price.perRequest ?? 0)
  )
}

export function priceCacheInfo() {
  return { fetchedAt: cache.data.fetchedAt, count: Object.keys(cache.data.entries).length }
}
