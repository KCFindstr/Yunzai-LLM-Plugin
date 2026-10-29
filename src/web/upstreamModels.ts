// suggestions shared with the terminal config editor
import { embeddingSuggestions, KNOWN_SYSTEMONE_MODELS, modelSuggestions } from '../../cli/schema.mjs'
import { resolveKeys } from '../core/config.ts'
import type { ProviderConfig } from '../core/configTypes.ts'
import { joinUrl } from '../llm/http.ts'

/**
 * Upstream model names for the model dropdowns: the curated list first, then whatever the provider's own model
 * list endpoint reports, so models released after this version still show up. Cached for 10 minutes.
 */
const cache = new Map<string, { at: number; models: string[] }>()
const TTL = 10 * 60_000

/** Model ids that can't be chat (or embedding) models. */
const NOT_CHAT = /embed|tts|whisper|dall-e|davinci|babbage|moderation|transcribe|image|audio|realtime|search-preview|sora|veo|imagen|lyria|aqa/i

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchList(p: ProviderConfig, kind: 'chat' | 'embedding'): Promise<string[]> {
  const key = resolveKeys(p.apiKey)[0]
  if (!key) throw new Error('提供商未配置 Key，只显示内置列表')
  const base = p.baseUrl ?? ''
  switch (p.type) {
    case 'anthropic': {
      const url = /\/v1\/?$/.test(base || 'https://api.anthropic.com') ? joinUrl(base, 'models?limit=1000') : joinUrl(base || 'https://api.anthropic.com', 'v1/models?limit=1000')
      const j = await getJson(url, { 'anthropic-version': '2023-06-01', ...(p.authStyle === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }) })
      return (j?.data ?? []).map((m: any) => m?.id).filter(Boolean)
    }
    case 'gemini': {
      const root = base || 'https://generativelanguage.googleapis.com'
      const url = /\/v1beta\/?$/.test(root) ? joinUrl(root, 'models?pageSize=1000') : joinUrl(root, 'v1beta/models?pageSize=1000')
      const j = await getJson(url, { 'x-goog-api-key': key })
      const method = kind === 'embedding' ? 'embedContent' : 'generateContent'
      return (j?.models ?? []).filter((m: any) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes(method))
        .map((m: any) => String(m?.name ?? '').replace(/^models\//, '')).filter(Boolean)
    }
    case 'openai':
    case 'openai-responses': {
      const j = await getJson(joinUrl(base || 'https://api.openai.com/v1', 'models'), { authorization: `Bearer ${key}` })
      const ids: string[] = (j?.data ?? []).map((m: any) => m?.id).filter(Boolean)
      return ids.filter(id => (kind === 'embedding' ? /embed/i.test(id) : !NOT_CHAT.test(id)))
    }
    default:
      return []
  }
}

export async function liveModels(name: string, p: ProviderConfig, kind: 'chat' | 'embedding', refresh = false): Promise<{ models: string[]; known: string[]; live: number; error?: string }> {
  const known: string[] = p.type === 'systemone' ? KNOWN_SYSTEMONE_MODELS : kind === 'embedding' ? embeddingSuggestions(p) : modelSuggestions(p)
  if (p.type === 'voyage' || p.type === 'systemone') return { models: known, known, live: 0 }
  const key = `${name}|${kind}|${p.type}|${p.baseUrl ?? ''}`
  let hit = cache.get(key)
  let error: string | undefined
  if (refresh || !hit || Date.now() - hit.at > TTL) {
    try {
      hit = { at: Date.now(), models: (await fetchList(p, kind)).sort() }
      cache.set(key, hit)
    } catch (err: any) {
      error = err?.message ?? String(err)
    }
  }
  const live = hit?.models ?? []
  return { models: [...new Set([...known, ...live])], known, live: live.length, ...(error ? { error } : {}) }
}
