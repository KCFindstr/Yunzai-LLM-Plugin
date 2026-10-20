import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG_FILE } from './paths.ts'
import { log } from './log.ts'
import { deepMerge, getPath, isPlainObject } from './util.ts'
import type { EffectiveConfig, ModelConfig, PluginConfig, ProviderConfig } from './configTypes.ts'

type Listener = (cfg: PluginConfig) => void

const USER_TEMPLATE = `# Yunzai-LLM-Plugin 用户配置（只需写要覆盖的项，其余使用 default_config.yaml 的默认值）
# 也可以私聊机器人发送 #llm帮助 查看如何用指令修改配置。
`

class ConfigManager {
  private cfg!: PluginConfig
  private listeners = new Set<Listener>()
  private watcher?: fs.FSWatcher
  private reloadTimer?: NodeJS.Timeout
  private effectiveCache = new Map<string, EffectiveConfig>()
  private selfWriteAt = 0
  version = 0

  constructor() {
    this.ensureUserFile()
    this.load()
  }

  private ensureUserFile() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true })
      if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, USER_TEMPLATE, 'utf8')
    } catch (err: any) {
      log.warn(`创建 config.yaml 失败: ${err.message}`)
    }
  }

  private readYaml(file: string): any {
    if (!fs.existsSync(file)) return {}
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  }

  load(): boolean {
    try {
      const def = this.readYaml(DEFAULT_CONFIG_FILE)
      const user = this.readYaml(CONFIG_FILE)
      this.cfg = normalize(deepMerge(def, user))
      this.version++
      this.effectiveCache.clear()
      for (const fn of this.listeners) {
        try {
          fn(this.cfg)
        } catch (err: any) {
          log.error('配置监听器出错', err)
        }
      }
      return true
    } catch (err: any) {
      log.error(`加载配置失败（保持旧配置）: ${err.message}`)
      if (!this.cfg) this.cfg = normalize({})
      return false
    }
  }

  watch() {
    if (this.watcher) return
    try {
      this.watcher = fs.watch(CONFIG_DIR, (_evt, file) => {
        if (file && path.basename(String(file)) !== 'config.yaml') return
        if (Date.now() - this.selfWriteAt < 1500) return
        clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
          if (this.load()) log.mark('config.yaml 已热重载')
        }, 500)
      })
      this.watcher.unref?.()
    } catch (err: any) {
      log.warn(`监听配置文件失败: ${err.message}`)
    }
  }

  unwatch() {
    this.watcher?.close()
    this.watcher = undefined
  }

  onChange(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get(): PluginConfig {
    return this.cfg
  }

  /** Read a value by dotted path from the effective config. */
  read(p: string) {
    return getPath(this.cfg, this.resolvePath(p))
  }

  /**
   * Write `value` at dotted path into config.yaml, preserving comments.
   * Arrays that only exist in defaults are copied into the user file first so index paths stay valid.
   */
  set(p: string, value: any) {
    this.mutate(doc => {
      const parts = this.resolvePath(p)
      this.materializeArrays(doc, parts)
      doc.setIn(parts, value)
    })
  }

  delete(p: string) {
    this.mutate(doc => {
      const parts = this.resolvePath(p)
      this.materializeArrays(doc, parts)
      doc.deleteIn(parts)
    })
  }

  /**
   * Dotted path -> keys. A segment becomes a number only when the effective value at that point is an array:
   * the yaml library creates a *sequence* for numeric keys, so `groups.123456` must stay a string.
   */
  resolvePath(p: string): (string | number)[] {
    const raw = p.split('.').filter(Boolean)
    const out: (string | number)[] = []
    let cur: any = this.cfg
    for (const seg of raw) {
      const key = Array.isArray(cur) && /^\d+$/.test(seg) ? Number(seg) : seg
      out.push(key)
      cur = cur?.[key as any]
    }
    return out
  }

  /** Apply arbitrary edits to the user YAML document. */
  mutate(fn: (doc: YAML.Document) => void) {
    const text = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : USER_TEMPLATE
    const doc = YAML.parseDocument(text)
    if (!doc.contents) doc.contents = doc.createNode({}) as any
    fn(doc)
    this.selfWriteAt = Date.now()
    fs.writeFileSync(CONFIG_FILE, doc.toString({ lineWidth: 0 }), 'utf8')
    this.load()
  }

  private materializeArrays(doc: YAML.Document, parts: (string | number)[]) {
    for (let i = 1; i < parts.length; i++) {
      if (typeof parts[i] !== 'number') continue
      const prefix = parts.slice(0, i)
      if (doc.hasIn(prefix)) continue
      const effective = getPath(this.cfg, prefix)
      if (Array.isArray(effective)) doc.setIn(prefix, doc.createNode(structuredClone(effective)))
    }
  }

  // ---------- lookups ----------

  getModel(id?: string): ModelConfig | undefined {
    if (!id) return undefined
    const key = id.toLowerCase()
    return (
      this.cfg.models.find(m => m.id.toLowerCase() === key) ??
      this.cfg.models.find(m => m.model.toLowerCase() === key)
    )
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.cfg.providers[name]
  }

  hasKey(provider?: ProviderConfig): boolean {
    if (!provider) return false
    return resolveKeys(provider.apiKey).length > 0
  }

  /** Default model: configured one, else first model whose provider has a key. */
  defaultModelId(): string {
    const c = this.cfg
    if (c.defaultModel && this.getModel(c.defaultModel)) return this.getModel(c.defaultModel)!.id
    const usable = c.models.find(m => this.hasKey(c.providers[m.provider]))
    return usable?.id ?? c.models[0]?.id ?? ''
  }

  isAdmin(e: any): boolean {
    if (e?.isMaster) return true
    const uid = String(e?.user_id ?? '')
    return this.cfg.admins.some(a => String(a) === uid)
  }

  /** Effective config for a conversation (group overrides applied). Cached per version. */
  effective(groupId?: string | number): EffectiveConfig {
    const key = `${this.version}:${groupId ?? ''}`
    const hit = this.effectiveCache.get(key)
    if (hit) return hit
    const c = this.cfg
    const g = (groupId != null && c.groups[String(groupId)]) || {}
    const chat = deepMerge(c.chat, g.chat ?? {})
    if (g.thinking) chat.thinking = g.thinking
    // group persona may be a preset name or a literal prompt
    const personaKey = g.persona ?? c.persona.active
    let personaPrompt = c.persona.presets[personaKey]
    if (personaPrompt == null)
      personaPrompt = g.persona && g.persona.length > 15 ? g.persona : (c.persona.presets.default ?? '')
    const eff: EffectiveConfig = {
      enable: c.enable && g.enable !== false,
      model: (g.model && this.getModel(g.model)?.id) || this.defaultModelId(),
      personaPrompt,
      chat,
      reply: deepMerge(c.reply, g.reply ?? {}),
      sticker: deepMerge(c.sticker, g.sticker ?? {}),
      tools: deepMerge(c.tools, g.tools ?? {}),
    }
    this.effectiveCache.set(key, eff)
    return eff
  }
}

export function resolveKeys(apiKey?: string | string[]): string[] {
  const arr = Array.isArray(apiKey) ? apiKey : apiKey ? [apiKey] : []
  return arr
    .map(k => String(k ?? '').trim())
    .map(k => (k.startsWith('env:') ? (process.env[k.slice(4)] ?? '').trim() : k))
    .filter(k => k && !/^(sk-)?your[-_]/i.test(k) && k !== 'sk-your-api-key-here')
}

function asArray<T>(v: any): T[] {
  if (Array.isArray(v)) return v
  if (v == null || v === '') return []
  return [v]
}

/** Fill gaps so the rest of the code can rely on shapes. Defaults live in default_config.yaml. */
export function normalize(raw: any): PluginConfig {
  const c: any = isPlainObject(raw) ? raw : {}
  c.enable = c.enable !== false
  c.admins = asArray(c.admins)
  c.providers = isPlainObject(c.providers) ? c.providers : {}
  for (const [name, p] of Object.entries<any>(c.providers)) {
    if (!isPlainObject(p) || !p.type) delete c.providers[name]
  }
  c.models = asArray<any>(c.models)
    .filter(m => isPlainObject(m) && m.model && m.provider)
    .map(m => ({ ...m, id: String(m.id ?? m.model) }))
  c.defaultModel = String(c.defaultModel ?? '')
  c.fallbackModels = asArray<string>(c.fallbackModels).map(String)
  c.utilityModel = String(c.utilityModel ?? '')
  c.visionModel = String(c.visionModel ?? '')
  c.persona = isPlainObject(c.persona) ? c.persona : {}
  c.persona.botName = String(c.persona.botName ?? '')
  c.persona.active = String(c.persona.active ?? 'default')
  c.persona.presets = isPlainObject(c.persona.presets) ? c.persona.presets : {}
  c.groups = isPlainObject(c.groups) ? c.groups : {}
  c.trigger = isPlainObject(c.trigger) ? c.trigger : {}
  for (const k of ['prefixes', 'groupWhitelist', 'groupBlacklist', 'userBlacklist']) c.trigger[k] = asArray(c.trigger[k])
  c.trigger.priority = Number(c.trigger.priority ?? 99999)
  c.chat = isPlainObject(c.chat) ? c.chat : {}
  c.quota = isPlainObject(c.quota) ? c.quota : {}
  c.quota.defaultScope ??= 'user'
  c.reply = isPlainObject(c.reply) ? c.reply : {}
  c.reply.typing ??= { charsPerSecond: 12, minDelay: 600, maxDelay: 5000 }
  c.reply.groupRate ??= { count: 6, perSeconds: 60 }
  c.reply.globalRate ??= { count: 30, perSeconds: 60 }
  c.sticker = isPlainObject(c.sticker) ? c.sticker : {}
  c.tools = isPlainObject(c.tools) ? c.tools : {}
  c.tools.webSearch ??= { enable: false, provider: 'none' }
  c.tools.webFetch ??= { enable: false }
  c.tools.botCommand ??= { enable: false }
  c.tools.botCommand.blacklist = asArray(c.tools.botCommand.blacklist)
  c.tools.botCommand.hints = asArray(c.tools.botCommand.hints)
  c.tools.http = asArray(c.tools.http)
  c.tools.disabled = asArray(c.tools.disabled)
  c.skills = isPlainObject(c.skills) ? c.skills : { enable: true }
  const m = isPlainObject(c.memory) ? c.memory : {}
  const n = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  c.memory = {
    enable: m.enable !== false,
    userMaxEntries: n(m.userMaxEntries, 15),
    userMaxChars: n(m.userMaxChars, 800),
    groupMaxEntries: n(m.groupMaxEntries, 25),
    groupMaxChars: n(m.groupMaxChars, 1500),
    entryMaxChars: n(m.entryMaxChars, 100),
    groupWrite: ['all', 'admin', 'off'].includes(m.groupWrite) ? m.groupWrite : 'all',
    autoCompact: m.autoCompact !== false,
    maxWritesPerTurn: n(m.maxWritesPerTurn, 3),
  }
  c.pricing = isPlainObject(c.pricing) ? c.pricing : {}
  c.pricing.sources = asArray(c.pricing.sources ?? ['openrouter', 'litellm'])
  c.pricing.refreshHours ??= 24
  return c as PluginConfig
}

export const config = new ConfigManager()
