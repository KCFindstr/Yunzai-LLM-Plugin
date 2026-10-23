import { config, resolveKeys } from '../core/config.ts'
import type { ProviderConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { requestJson } from '../llm/http.ts'

/**
 * Text embeddings for recall. `voyage` speaks Voyage's /embeddings (input_type + output_dimension), or, for
 * contextualized models (voyage-context-*), /contextualizedembeddings, where the chunks of one document are embedded
 * together so each vector also reflects its neighbours. `openai` speaks the OpenAI-compatible shape (dimensions).
 * Vectors come back L2-normalized, so dot = cosine.
 */
export function embeddingReady(): boolean {
  const c = config.get().memory.embedding
  return c.enable && resolveKeys(c.apiKey).length > 0
}

/** Identifies the vector space; stored vectors with another tag are discarded. */
export function embeddingTag(): string {
  const c = config.get().memory.embedding
  return `${c.type}:${c.model}:${c.dimensions}`
}

/** Contextualized chunk model: callers should embed related chunks as one group. */
export function embeddingContextual(): boolean {
  const c = config.get().memory.embedding
  return c.type === 'voyage' && /^voyage-context/i.test(c.model)
}

// stay well under Voyage's per-request limits (1000 inputs, 16K chunks, 120K tokens; ~1 token per CJK character)
const MAX_GROUPS = 500
const MAX_CHARS = 60_000

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

async function request(path: string, body: any, signal?: AbortSignal): Promise<any> {
  const c = config.get().memory.embedding
  // requestJson only needs the transport fields; type is used for its key-rotation bucket
  const provider = { type: c.type, baseUrl: c.baseUrl, apiKey: c.apiKey, timeout: c.timeout, maxRetries: 1 } as unknown as ProviderConfig
  return requestJson(provider, key => ({ url: `${c.baseUrl.replace(/\/+$/, '')}${path}`, headers: { authorization: `Bearer ${key}` }, body }), signal)
}

/**
 * Embed groups of texts; returns one vector per text, grouped the same way. With a contextualized model each group
 * is one document (its texts are chunks seen together); with any other model groups are just flattened.
 */
export async function embedGroups(groups: string[][], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[][]> {
  groups = groups.filter(g => g.length)
  if (!groups.length) return []
  const c = config.get().memory.embedding
  if (!embeddingContextual()) {
    const flat = await embed(groups.flat(), kind, signal)
    let i = 0
    return groups.map(g => g.map(() => flat[i++]))
  }
  const out: Float32Array[][] = []
  for (const batch of batches(groups)) {
    const json = await request('/contextualizedembeddings', { inputs: batch, model: c.model, input_type: kind, output_dimension: c.dimensions }, signal)
    const docs: any[] = Array.isArray(json?.data) ? [...json.data].sort((a, b) => a.index - b.index) : []
    if (docs.length !== batch.length) throw new Error(`embedding 返回 ${docs.length} 组，应为 ${batch.length} 组`)
    docs.forEach((doc, i) => {
      const chunks: any[] = Array.isArray(doc?.data) ? [...doc.data].sort((a, b) => a.index - b.index) : []
      if (chunks.length !== batch[i].length) throw new Error(`embedding 第 ${i + 1} 组返回 ${chunks.length} 段，应为 ${batch[i].length} 段`)
      out.push(chunks.map(d => normalize(Float32Array.from(d.embedding))))
    })
    log.debug(`embedding ${c.model} ${kind} ${batch.length}组/${batch.flat().length}段 tokens=${json?.usage?.total_tokens ?? '?'}`)
  }
  return out
}

export async function embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return []
  // contextualized models: each text on its own (a query is a single-chunk input)
  if (embeddingContextual()) return (await embedGroups(texts.map(t => [t]), kind, signal)).map(g => g[0])
  const c = config.get().memory.embedding
  const body =
    c.type === 'voyage'
      ? { input: texts, model: c.model, input_type: kind, output_dimension: c.dimensions }
      : { input: texts, model: c.model, dimensions: c.dimensions }
  const json = await request('/embeddings', body, signal)
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
