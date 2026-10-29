import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config, resolveKeys, deepseekToolKey } from './config.ts'
import { AGY_EXECUTABLE } from './paths.ts'
import type { EffectiveConfig, ModelConfig } from './configTypes.ts'

const exec = promisify(execFile)
export const setupRuntime = { exec }
export type RuntimeKind = 'sandbox' | 'computer' | 'agy' | 'lens'
export interface RuntimeState { ready: boolean; checks: { label: string; ok: boolean }[]; checkedAt: number }
const names: Record<string, RuntimeKind> = { run_code: 'sandbox', computer_task: 'computer', agy: 'agy', google_lens: 'lens' }
const cache = new Map<string, { until: number; state?: RuntimeState; pending?: Promise<RuntimeState> }>()
const scripts = {
  sandbox: ['test -r /opt/llm-sandbox/runner.py && test -x /opt/llm-images/mount.sh', 'command -v bwrap >/dev/null && command -v node >/dev/null && id sbx >/dev/null 2>&1', 'systemctl is-active --quiet llm-sandbox-firewall.service'],
  computer: ['test -r /opt/llm-desktop/client.py && test -x /opt/llm-images/mount.sh', 'systemctl is-active --quiet llm-desktop.service'],
  lens: ['test -r /opt/llm-agy/google-image-search.py && test -d /usr/local/lib/agy-browser/playwright && test -x /opt/llm-images/mount.sh', 'systemctl is-active --quiet llm-desktop.service'],
}
const labels = {
  sandbox: ['代码运行器', '隔离环境与运行语言', '沙盒网络隔离服务'], computer: ['桌面客户端', '桌面服务'],
  lens: ['图片搜索与浏览器依赖', '桌面服务'],
}
const settings = (kind: RuntimeKind, eff: EffectiveConfig) => eff.tools[kind === 'sandbox' ? 'exec' : kind === 'lens' ? 'googleLens' : kind]
const keyFor = (kind: RuntimeKind, eff: EffectiveConfig) => kind === 'agy' ? `agy:${eff.tools.agy.executable}` : `${kind}:${eff.tools[kind === 'sandbox' ? 'exec' : kind === 'lens' ? 'googleLens' : kind].distro}`

/** Cached, bounded, read-only checks. No setup script, model call, or installer is executed. */
export async function checkRuntime(kind: RuntimeKind, eff: EffectiveConfig, force = false): Promise<RuntimeState> {
  const key = keyFor(kind, eff), existing = cache.get(key)
  if (existing?.pending) return existing.pending
  if (!force && existing?.state && existing.until > Date.now()) return existing.state
  const item: { until: number; state?: RuntimeState; pending?: Promise<RuntimeState> } = { until: 0 }
  cache.set(key, item)
  item.pending = (async () => {
    const checks: RuntimeState['checks'] = []
    if (kind !== 'agy') {
      const distro = eff.tools[kind === 'sandbox' ? 'exec' : kind === 'lens' ? 'googleLens' : kind].distro
      checks.push({ label: 'Windows / WSL 环境', ok: process.platform === 'win32' && /^[\w.-]+$/.test(distro) })
      if (checks[0].ok) {
        const script = `import subprocess,json\ncommands=${JSON.stringify(scripts[kind])}\nprint(json.dumps([subprocess.run(['sh','-c',c],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2).returncode==0 for c in commands]))`
        let values: boolean[] = []
        try {
          const { stdout } = await setupRuntime.exec('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'python3', '-c', script], { windowsHide: true, timeout: 8000, maxBuffer: 16384 })
          const parsed = JSON.parse(stdout)
          if (Array.isArray(parsed)) values = parsed
        } catch { /* Missing/stopped/unprovisioned environments stay unavailable. */ }
        checks.push(...labels[kind].map((label, i) => ({ label, ok: values[i] === true })))
      }
    }
    if (kind === 'agy') {
      checks.push({ label: 'Windows 宿主机（无需 WSL）', ok: process.platform === 'win32' })
      const executable = path.resolve(eff.tools.agy.executable || AGY_EXECUTABLE)
      checks.push({ label: 'AGY CLI', ok: fs.existsSync(executable) })
      let cliAvailable = false
      if (checks.every(c => c.ok)) {
        try {
          const { stdout, stderr } = await setupRuntime.exec(executable, ['--help'], { windowsHide: true, timeout: 6000, maxBuffer: 32768 })
          cliAvailable = /--sandbox\b/.test(stdout + stderr) && /--dangerously-skip-permissions\b/.test(stdout + stderr)
        } catch { /* Check CLI availability only; do not probe login, model access or permissions. */ }
      }
      checks.push({ label: '宿主机 CLI 可运行（sandbox + turbo）', ok: cliAvailable })
    }
    const state = { ready: checks.every(c => c.ok), checks, checkedAt: Date.now() }
    item.state = state; item.until = Date.now() + 60_000; item.pending = undefined
    return state
  })()
  return item.pending
}

export function runtimeToolReady(name: string, eff: EffectiveConfig): boolean {
  if (name === 'web_search') return searchReady(eff)
  const kind = names[name]
  if (!kind) return true
  if (!settings(kind, eff).enable) return false
  if (kind === 'sandbox' && !eff.tools.exec.languages.length) return false
  if (kind === 'computer') {
    if (!computerModelReady(eff)) return false
  }
  const entry = cache.get(keyFor(kind, eff))
  if (!entry?.state || entry.until <= Date.now()) void checkRuntime(kind, eff)
  return entry?.state?.ready ?? false
}
export async function prepareRuntimeTools(eff: EffectiveConfig, tools = Object.keys(names), isAdmin?: boolean) {
  if (!eff.tools.enable) return
  await Promise.all([...new Set(tools.map(name => names[name]).filter(kind => kind && settings(kind, eff).enable
    && (isAdmin !== false || settings(kind, eff).access === 'all')))].map(kind => checkRuntime(kind, eff)))
}

const httpUrl = (value: string) => { try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }
function computerModelReady(eff: EffectiveConfig) {
  const model = config.getModel(eff.tools.computer.model || eff.model || config.defaultModelId())
  return Boolean(model && model.vision !== false && model.toolUse !== false && config.hasKey(config.getProvider(model.provider)))
}
/** Search setup is checked without making a search request. Native search needs the actual turn's model. */
export function searchReady(eff: EffectiveConfig, model?: ModelConfig): boolean {
  const ws = eff.tools.webSearch
  if (!ws.enable || ws.provider === 'none') return false
  if (ws.provider === 'native') {
    const selected = model ?? config.getModel(eff.model || config.defaultModelId())
    return Boolean(selected && selected.nativeSearch !== false && ['anthropic', 'openai-responses', 'gemini'].includes(config.getProvider(selected.provider)?.type ?? ''))
  }
  if (ws.provider === 'deepseek') return Boolean(deepseekToolKey(ws.apiKey))
  if (ws.provider === 'searxng') return httpUrl(ws.baseUrl)
  return ['anysearch', 'jina'].includes(ws.provider) || resolveKeys(ws.apiKey).length > 0
}
export async function setupStatus(force = false) {
  const c = config.get(), eff = config.effective(), id = config.defaultModelId(), model = config.getModel(id)
  const modelReady = (id: string) => { const m = config.getModel(id); return Boolean(m?.model && config.hasKey(c.providers[m.provider]) && httpUrl(c.providers[m.provider]?.baseUrl ?? '')) }
  const embedding = c.memory.embedding, judge = c.autoThinking.judge
  const embeddingModel = config.getEmbeddingModel(embedding.model), embeddingProvider = embeddingModel && c.providers[embeddingModel.provider]
  const systemone = config.getSystemoneModel(judge), systemoneProvider = systemone && c.providers[systemone.provider]
  const typesafe = /typesafe\.ai/i.test(systemoneProvider?.baseUrl ?? '')
  const judgeReady = systemone ? Boolean(systemoneProvider && httpUrl(systemoneProvider.baseUrl ?? '') && (!typesafe || resolveKeys(systemoneProvider.apiKey).length > 0))
    : modelReady(judge || c.utilityModel || id)
  const automatic = (model?.thinking ?? c.chat.thinking) === 'auto'
  const [sandbox, agy, computer, lens] = await Promise.all((['sandbox', 'agy', 'computer', 'lens'] as const).map(kind => checkRuntime(kind, eff, force)))
  const computerReady = computerModelReady(eff)
  const visionReady = c.visionModel ? modelReady(c.visionModel) && config.getModel(c.visionModel)?.vision !== false
    : c.models.some(m => m.vision !== false && modelReady(m.id))
  const rolesReady = (!c.utilityModel || modelReady(c.utilityModel)) && c.fallbackModels.every(modelReady) && visionReady
  const limitedModels = c.models.filter(m => m.quota && [m.quota, m.quota.user, m.quota.group, m.quota.global].some(q => (q?.window5h ?? 0) > 0 || (q?.weekly ?? 0) > 0)).length
  return {
    models: { ready: Boolean(id && modelReady(id)), modelId: id, detail: id ? `默认模型：${id}` : '请先添加提供商和聊天模型' },
    roles: { ready: rolesReady, detail: '后台模型、识图模型与备用顺序' },
    search: { ready: eff.tools.enable && (eff.tools.webSearch.enable && eff.tools.webSearch.provider !== 'none' ? searchReady(eff, model) : eff.tools.webFetch.enable),
      detail: eff.tools.webSearch.enable && eff.tools.webSearch.provider !== 'none' ? `搜索：${eff.tools.webSearch.provider}${searchReady(eff, model) ? '' : ' · 缺少密钥、地址或模型不支持'}` : '搜索未开启，可单独启用网页读取' },
    budgets: { ready: limitedModels > 0, detail: limitedModels ? `${limitedModels} 个模型已设置额度` : '尚未设置额度，可按模型限制每人、每群和全局用量' },
    embedding: { ready: embedding.enable && c.memory.enable && Boolean(embeddingProvider && httpUrl(embeddingProvider.baseUrl ?? '') && resolveKeys(embeddingProvider.apiKey).length > 0),
      detail: embeddingModel ? `${embeddingModel.id} · ${embeddingModel.model}` : '用于检索旧聊天' },
    jev: { ready: automatic && judgeReady, detail: `${systemone ? `System One ${systemone.id}` : `小模型判断 ${judge || c.utilityModel || id}`}${automatic ? '' : ' · 默认模型尚未启用自动思考强度'}` },
    sandbox: { ...sandbox, enabled: eff.tools.exec.enable }, agy: { ...agy, enabled: eff.tools.agy.enable },
    computer: { ...computer, ready: computer.ready && computerReady, checks: [...computer.checks, { label: '可用视觉 / 工具模型', ok: computerReady }], enabled: eff.tools.computer.enable }, lens: { ...lens, enabled: eff.tools.googleLens.enable },
  }
}
