import { resolveKeys } from '../core/config.ts'
import type { ProviderConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { sleep } from '../core/util.ts'
import { LLMError } from './types.ts'

const rr = new Map<string, number>()

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: any
}

function errorMessage(status: number, text: string): string {
  try {
    const j = JSON.parse(text)
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.[0]?.error?.message
    if (m) return `HTTP ${status}: ${typeof m === 'string' ? m : JSON.stringify(m)}`
  } catch {}
  return `HTTP ${status}: ${text.slice(0, 300)}`
}

/**
 * POST JSON with key rotation and retries.
 * 401/403 rotate to the next key; 408/409/429/5xx and network errors back off and retry.
 */
export async function requestJson(
  provider: ProviderConfig,
  build: (key: string) => BuiltRequest,
  signal?: AbortSignal,
): Promise<any> {
  const keys = resolveKeys(provider.apiKey)
  if (!keys.length) throw new LLMError('未配置 API Key', { retryable: false })
  const id = `${provider.type}:${provider.baseUrl}`
  const start = rr.get(id) ?? 0
  rr.set(id, start + 1)
  const maxRetries = provider.maxRetries ?? 2
  const timeoutMs = (provider.timeout ?? 120) * 1000
  let lastErr: LLMError | undefined

  for (let attempt = 0; attempt <= maxRetries + keys.length - 1; attempt++) {
    const key = keys[(start + attempt) % keys.length]
    const req = build(key)
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    let res: Response
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...req.headers, ...(provider.headers ?? {}) },
        body: JSON.stringify(req.body),
        signal: AbortSignal.any(signals),
      })
    } catch (err: any) {
      if (signal?.aborted) throw new LLMError('请求已取消')
      lastErr = new LLMError(`网络错误: ${err?.cause?.code ?? err?.name ?? ''} ${err?.message ?? err}`, { retryable: true })
      if (attempt >= maxRetries) break
      await sleep(1000 * 2 ** attempt)
      continue
    }

    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new LLMError(`响应不是合法 JSON: ${text.slice(0, 200)}`)
      }
    }

    const status = res.status
    lastErr = new LLMError(errorMessage(status, text), {
      status,
      body: text.slice(0, 2000),
      retryable: [408, 409, 429, 500, 502, 503, 504, 529].includes(status),
    })
    if ((status === 401 || status === 403) && keys.length > 1) {
      log.warn(`API Key ${key.slice(0, 6)}… 鉴权失败(${status})，切换下一个`)
      continue
    }
    if (!lastErr.retryable || attempt >= maxRetries) break
    const ra = Number(res.headers.get('retry-after'))
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : 1500 * 2 ** attempt
    log.warn(`${lastErr.message}，${Math.round(wait / 1000)}s 后重试`)
    await sleep(wait)
  }
  throw lastErr ?? new LLMError('请求失败')
}

export function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`
}
