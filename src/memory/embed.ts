import { config, resolveKeys } from '../core/config.ts'
import type { EmbeddingModelConfig, ProviderConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { requestJson } from '../llm/http.ts'

interface Target {
  model: EmbeddingModelConfig
  provider: ProviderConfig
  /** request shape: Voyage's, or OpenAI-compatible /embeddings */
  kind: 'voyage' | 'openai'
}

/** memory.embedding.model (or `id`) resolved to its embeddingModels entry and provider. */
function target(id = config.get().memory.embedding.model): Target | undefined {
  const model = config.getEmbeddingModel(id)
  const provider = model && config.getProvider(model.provider)
  if (!model || !provider || !['voyage', 'openai', 'openai-responses'].includes(provider.type)) return undefined
  return { model, provider, kind: provider.type === 'voyage' ? 'voyage' : 'openai' }
}

/**
 * Text embeddings for recall. `voyage` speaks Voyage's /embeddings (input_type + output_dimension), or, for
 * contextualized models (voyage-context-*), /contextualizedembeddings, where the chunks of one document are embedded
 * together so each vector also reflects its neighbours. `openai` speaks the OpenAI-compatible shape (dimensions).
 * Vectors come back L2-normalized, so dot = cosine.
 */
export function embeddingReady(): boolean {
  const t = target()
  return config.get().memory.embedding.enable && Boolean(t && resolveKeys(t.provider.apiKey).length > 0)
}

/** Identifies the vector space; stored vectors with another tag are discarded. Unchanged by the config migration. */
export function embeddingTag(): string {
  const t = target()
  return t ? `${t.kind}:${t.model.model}:${t.model.dimensions}` : 'none'
}

/** Upstream model of memory.embedding.model, for display. */
export function embeddingModelName(): string {
  return target()?.model.model ?? config.get().memory.embedding.model
}

/** Contextualized chunk model: callers should embed related chunks as one group. */
export function embeddingContextual(t = target()): boolean {
  return t?.kind === 'voyage' && /^voyage-context/i.test(t.model.model)
}

// stay well under Voyage's per-request limits: 1000 inputs, 16K chunks, and for voyage-context-4 without
// auto-chunking 32K tokens per request (~1 token per CJK character)
const MAX_GROUPS = 500
const MAX_CHARS = 20_000

/** Split groups into request-sized batches, never splitting a group. */
function batches(groups: string[][]): string[][][] {
  const out: string[][][] = []
  let cur: string[][] = []
  let chars = 0
  for (const g of groups) {
    const size = g.reduce((a, t) => a + t.length, 0)
    if (cur.length && (cur.length >= MAX_GROUPS || chars + size > MAX_CHARS)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(g)
    chars += size
  }
  if (cur.length) out.push(cur)
  return out
}

async function request(t: Target, path: string, body: any, signal?: AbortSignal): Promise<any> {
  const base = (t.provider.baseUrl || (t.kind === 'voyage' ? 'https://api.voyageai.com/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '')
  // embeddings sit on the recall path: a short timeout and one retry unless the provider says otherwise
  const provider = { ...t.provider, timeout: t.provider.timeout ?? 10, maxRetries: t.provider.maxRetries ?? 1 }
  return requestJson(provider, key => ({ url: `${base}${path}`, headers: { ...t.provider.headers, authorization: `Bearer ${key}` }, body }), signal)
}

function need(t: Target | undefined): Target {
  if (!t) throw new Error(`向量模型 ${config.get().memory.embedding.model || '（未选择）'} 不存在或其提供商不支持向量`)
  return t
}

/**
 * Embed groups of texts; returns one vector per text, grouped the same way. With a contextualized model each group
 * is one document (its texts are chunks seen together); with any other model groups are just flattened.
 */
export async function embedGroups(groups: string[][], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[][]> {
  groups = groups.filter(g => g.length)
  if (!groups.length) return []
  const t = need(target())
  const c = t.model
  if (!embeddingContextual(t)) {
    const flat = await embed(groups.flat(), kind, signal)
    let i = 0
    return groups.map(g => g.map(() => flat[i++]))
  }
  // a document over the per-request budget (a very busy day) is embedded as consecutive parts, then stitched back
  const parts: { group: number; texts: string[] }[] = []
  groups.forEach((g, group) => {
    let cur: string[] = []
    let chars = 0
    for (const t of g) {
      if (cur.length && chars + t.length > MAX_CHARS) {
        parts.push({ group, texts: cur })
        cur = []
        chars = 0
      }
      cur.push(t.slice(0, MAX_CHARS))
      chars += Math.min(t.length, MAX_CHARS)
    }
    parts.push({ group, texts: cur })
  })
  const flat: Float32Array[][] = []
  for (const batch of batches(parts.map(p => p.texts))) {
    const json = await request(t, '/contextualizedembeddings', { inputs: batch, model: c.model, input_type: kind, output_dimension: c.dimensions }, signal)
    const docs: any[] = Array.isArray(json?.data) ? [...json.data].sort((a, b) => a.index - b.index) : []
    if (docs.length !== batch.length) throw new Error(`embedding 返回 ${docs.length} 组，应为 ${batch.length} 组`)
    docs.forEach((doc, i) => {
      const chunks: any[] = Array.isArray(doc?.data) ? [...doc.data].sort((a, b) => a.index - b.index) : []
      if (chunks.length !== batch[i].length) throw new Error(`embedding 第 ${i + 1} 组返回 ${chunks.length} 段，应为 ${batch[i].length} 段`)
      flat.push(chunks.map(d => normalize(Float32Array.from(d.embedding))))
    })
    log.debug(`embedding ${c.model} ${kind} ${batch.length}组/${batch.flat().length}段 tokens=${json?.usage?.total_tokens ?? '?'}`)
  }
  const out: Float32Array[][] = groups.map(() => [])
  parts.forEach((p, i) => out[p.group].push(...flat[i]))
  return out
}

export async function embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return []
  // contextualized models: each text on its own (a query is a single-chunk input)
  if (embeddingContextual()) return (await embedGroups(texts.map(t => [t]), kind, signal)).map(g => g[0])
  return embedWith(need(target()), texts, kind, signal)
}

/** Embed with a specific embedding model id (connection test): returns the vectors' dimension and latency. */
export async function testEmbedding(id: string): Promise<{ dimensions: number; ms: number }> {
  const t = target(id)
  if (!t) throw new Error(`向量模型 ${id} 不存在或其提供商不支持向量`)
  const started = Date.now()
  const [v] = embeddingContextual(t)
    ? (await request(t, '/contextualizedembeddings', { inputs: [['测试 test']], model: t.model.model, input_type: 'query', output_dimension: t.model.dimensions })).data?.[0]?.data?.map((d: any) => d.embedding) ?? []
    : (await embedWith(t, ['测试 test'], 'query'))
  if (!v?.length) throw new Error('接口没有返回向量')
  return { dimensions: v.length, ms: Date.now() - started }
}

async function embedWith(t: Target, texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
  const c = t.model
  const body =
    t.kind === 'voyage'
      ? { input: texts, model: c.model, input_type: kind, output_dimension: c.dimensions }
      : { input: texts, model: c.model, dimensions: c.dimensions }
  const json = await request(t, '/embeddings', body, signal)
  const data: any[] = Array.isArray(json?.data) ? [...json.data].sort((a, b) => a.index - b.index) : []
  if (data.length !== texts.length) throw new Error(`embedding 返回 ${data.length} 条，应为 ${texts.length} 条`)
  log.debug(`embedding ${c.model} ${kind} ${texts.length}条 tokens=${json?.usage?.total_tokens ?? '?'}`)
  return data.map(d => normalize(Float32Array.from(d.embedding)))
}

function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export const encodeVector = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')

export function decodeVector(s: string): Float32Array {
  const b = Buffer.from(s, 'base64')
  // copy out: Buffer's pooled byteOffset isn't guaranteed to be 4-aligned
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
