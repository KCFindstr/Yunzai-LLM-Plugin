import { config, resolveKeys } from '../core/config.ts'
import type { ProviderConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { requestJson } from '../llm/http.ts'

/**
 * Text embeddings for recall. `voyage` speaks Voyage's /embeddings (input_type + output_dimension);
 * `openai` speaks the OpenAI-compatible shape (dimensions). Vectors come back L2-normalized, so dot = cosine.
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

export async function embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return []
  const c = config.get().memory.embedding
  // requestJson only needs the transport fields; type is used for its key-rotation bucket
  const provider = { type: c.type, baseUrl: c.baseUrl, apiKey: c.apiKey, timeout: c.timeout, maxRetries: 1 } as unknown as ProviderConfig
  const body =
    c.type === 'voyage'
      ? { input: texts, model: c.model, input_type: kind, output_dimension: c.dimensions }
      : { input: texts, model: c.model, dimensions: c.dimensions }
  const json = await requestJson(
    provider,
    key => ({ url: `${c.baseUrl.replace(/\/+$/, '')}/embeddings`, headers: { authorization: `Bearer ${key}` }, body }),
    signal,
  )
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
