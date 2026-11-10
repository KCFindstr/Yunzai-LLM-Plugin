import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProviderConfig } from '../core/configTypes.ts'
import { resolveKeys } from '../core/config.ts'
import { requestJson } from './http.ts'
import { LLMError } from './types.ts'

const exec = promisify(execFile)
const tokens = new Map<string, { until: number; pending: Promise<string> }>()

function executable(provider: ProviderConfig): string {
  if (provider.gcloudPath?.trim()) return provider.gcloudPath.trim()
  if (process.platform !== 'win32') return 'gcloud'
  const roots = [process.env.CLOUDSDK_ROOT_DIR,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Cloud SDK', 'google-cloud-sdk'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Google', 'Cloud SDK', 'google-cloud-sdk'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Cloud SDK', 'google-cloud-sdk')]
  return roots.filter(Boolean).map(root => path.join(root!, 'bin', 'gcloud.cmd')).find(file => fs.existsSync(file)) ?? 'gcloud.cmd'
}

/** Cache only in memory, refresh early, and share concurrent CLI invocations. Never log stdout/stderr. */
export async function vertexToken(provider: ProviderConfig, refresh = false): Promise<string> {
  const file = executable(provider)
  const serviceAccount = provider.serviceAccount?.trim() || ''
  if (serviceAccount && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount))
    throw new LLMError('Vertex AI serviceAccount 应为服务账号邮箱')
  const cacheKey = JSON.stringify([file, serviceAccount])
  const hit = tokens.get(cacheKey)
  if (!refresh && hit && hit.until > Date.now()) return hit.pending
  const entry = { until: Infinity, pending: Promise.resolve('') }
  entry.pending = Promise.resolve().then(async () => {
    try {
      const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
      // Windows .cmd launchers need cmd.exe. Reject shell metacharacters; arguments are fixed literals.
      if (process.platform === 'win32' && /["%!\r\n&|<>^]/.test(file)) throw new Error('Invalid gcloud path')
      const args = ['auth', 'print-access-token', '--quiet', ...(serviceAccount ? [`--impersonate-service-account=${serviceAccount}`] : [])]
      const { stdout } = process.platform === 'win32' && /\.cmd$/i.test(file)
        ? await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `""${file}" ${args.join(' ')}"`], { ...options, windowsVerbatimArguments: true })
        : await exec(file, args, options)
      const token = stdout.trim()
      if (!token || /\s/.test(token)) throw new Error('Invalid gcloud output')
      entry.until = Date.now() + 45 * 60_000
      return token
    } catch {
      if (tokens.get(cacheKey) === entry) tokens.delete(cacheKey)
      throw new LLMError('Vertex AI 无法获取访问令牌。请在机器人运行账户下执行 gcloud auth login；配置 serviceAccount 时还须授予模拟权限并启用 IAM Credentials API；找不到 CLI 时设置 gcloudPath。')
    }
  })
  tokens.set(cacheKey, entry)
  return entry.pending
}

export async function vertexRequest(provider: ProviderConfig, url: string, body: any, signal?: AbortSignal): Promise<any> {
  const request = (p: ProviderConfig) => requestJson(p, key => ({ url, body, headers: { authorization: `Bearer ${key.replace(/^Bearer\s+/i, '')}` } }), signal)
  // Optional externally managed OAuth access tokens, including env:NAME. These are not Gemini API keys.
  if (resolveKeys(provider.apiKey).length) return request(provider)
  // A custom/proxy URL must not silently receive credentials from the host's gcloud login.
  let endpoint: URL
  try { endpoint = new URL(url) }
  catch { throw new LLMError('Vertex AI 接口地址无效') }
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(endpoint.hostname))
    throw new LLMError('自动 OAuth 令牌仅发送到 Google 官方 Vertex AI HTTPS 接口；自定义代理须显式配置访问令牌。')
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted()
    const token = await vertexToken(provider, attempt > 0)
    try { return await request({ ...provider, apiKey: token }) }
    catch (error) {
      if (!(error instanceof LLMError) || error.status !== 401 || attempt > 0) throw error
    }
  }
}
