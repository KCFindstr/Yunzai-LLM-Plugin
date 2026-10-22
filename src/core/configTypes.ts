export type ProviderType = 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** `auto` picks a level per message (see chat.autoThinking). */
export type ThinkingSetting = ThinkingLevel | 'auto'
export type QuotaScope = 'user' | 'group' | 'global'

export interface ProviderConfig {
  type: ProviderType
  baseUrl?: string
  /** One key or several (rotated on 401/429). `env:NAME` reads process.env.NAME. */
  apiKey?: string | string[]
  headers?: Record<string, string>
  /** Seconds. */
  timeout?: number
  maxRetries?: number
  /** openai: which field carries the output cap. Default: max_completion_tokens for api.openai.com, else max_tokens. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** openai/openai-responses: send prompt_cache_key. Default true only for api.openai.com. */
  promptCacheKey?: boolean
  /** anthropic: x-api-key (default) or Authorization: Bearer. */
  authStyle?: 'x-api-key' | 'bearer'
  /** anthropic: prompt cache TTL. */
  cacheTtl?: '5m' | '1h'
  /** gemini (default true) / openai-responses (default false): reuse server-side conversation state. */
  serverState?: boolean
  /** gemini/openai-responses: store=false disables server state. */
  store?: boolean
  balance?: 'deepseek' | 'openrouter' | 'moonshot' | 'siliconflow' | 'none'
}

export interface Limits {
  /** USD per rolling 5 hours. null/0 = unlimited. */
  window5h?: number | null
  /** USD per rolling 7 days. */
  weekly?: number | null
}

export interface ModelQuota extends Limits {
  /** Scope for the shorthand window5h/weekly above. Defaults to quota.defaultScope. */
  scope?: QuotaScope
  user?: Limits
  group?: Limits
  global?: Limits
}

/** USD per 1M tokens (perSearch / perRequest: USD per call). */
export interface PriceConfig {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
  perSearch?: number
  perRequest?: number
}

export interface ModelConfig {
  id: string
  provider: string
  model: string
  vision?: boolean
  thinking?: ThinkingSetting
  temperature?: number | null
  topP?: number | null
  maxTokens?: number
  nativeSearch?: boolean
  /** false for models/endpoints without function calling support. */
  toolUse?: boolean
  pricing?: 'auto' | PriceConfig
  /** Name to look up in OpenRouter/LiteLLM price lists when it differs from `model`. */
  pricingId?: string
  quota?: ModelQuota
  /** Merged verbatim into the request body (provider-specific knobs). */
  extraBody?: Record<string, any>
}

export interface RateConfig {
  count: number
  perSeconds: number
}

export interface ThinkingJudgeConfig {
  /** heuristic = local keyword rules; model = a cheap configured model; systemone = Jev (TypeSafe) or self-hosted Kev */
  mode: 'heuristic' | 'model' | 'systemone'
  /** mode=model: model id (empty = utilityModel, then the default model) */
  model: string
  /** mode=systemone: endpoint, API key and model name */
  url: string
  apiKey: string
  systemoneModel: string
  timeoutMs: number
}

export interface ChatSection {
  maxPending: number
  rosterSize: number
  sessionScope: 'user' | 'group'
  sessionTimeout: number
  historyMaxTurns: number
  historyMaxTokens: number
  summarize: boolean
  groupContext: number
  groupContextMaxChars: number
  maxToolRounds: number
  maxOutputTokens: number
  temperature: number | null
  thinking: ThinkingSetting
  /** levels used by thinking=auto for casual chat / questions / complex requests */
  autoThinking: { casual: ThinkingLevel; question: ThinkingLevel; complex: ThinkingLevel }
  /** how thinking=auto classifies a message; falls back to the keyword heuristic on error/timeout */
  thinkingJudge: ThinkingJudgeConfig
  includeImages: boolean
  maxImages: number
  includeQuoted: boolean
}

export interface ReplySection {
  quote: 'auto' | 'always' | 'never'
  atUser: boolean
  maxBubbles: number
  maxChars: number
  longText: 'forward' | 'truncate'
  stripMarkdown: boolean
  /** false = plain text (OneBot); true = Markdown (e.g. official QQBot); auto = Markdown only on the QQBot adapter */
  markdown: boolean | 'auto'
  typing: { charsPerSecond: number; minDelay: number; maxDelay: number }
  groupRate: RateConfig
  globalRate: RateConfig
  concurrency: number
  errorNotice: boolean
  errorCooldown: number
  privateTyping: boolean
}

export interface StickerSection {
  enable: boolean
  probability: number
  cooldown: number
  maxInPrompt: number
  indexModel: string
  sendAs: 'sticker' | 'image'
  /** send a copy scaled to at most this many px (QQ shows large images like photos); 0 = original */
  maxSendSize: number
}

export interface HttpToolConfig {
  name: string
  description: string
  parameters?: Record<string, any>
  url: string
  method?: string
  headers?: Record<string, string>
  body?: any
  maxChars?: number
}

export interface ToolsSection {
  enable: boolean
  webSearch: {
    enable: boolean
    provider: 'native' | 'anysearch' | 'tavily' | 'brave' | 'searxng' | 'jina' | 'none'
    apiKey: string
    baseUrl: string
    maxResults: number
    maxPerTurn: number
  }
  webFetch: {
    enable: boolean
    maxChars: number
    timeout: number
    reader: 'direct' | 'jina'
    jinaKey: string
    allowPrivateNetwork: boolean
    maxPerTurn: number
  }
  botCommand: {
    enable: boolean
    inPrompt: number
    ack: boolean
    allowMasterCommands: boolean
    blacklist: string[]
    hints: { cmd: string; desc: string }[]
  }
  http: HttpToolConfig[]
  renderHtml: { enable: boolean; width: number; maxHeight: number; allowNetwork: boolean }
  exec: ExecToolConfig
  computer: ComputerConfig
  disabled: string[]
}

export type ExecLanguage = 'python' | 'node' | 'bash'

export interface ComputerConfig {
  enable: boolean
  distro: string
  access: 'admin' | 'all'
  model: string
  maxSteps: number
  maxMinutes: number
  maxInputTokens: number
  maxOutputTokens: number
  maxQueue: number
  recentScreenshots: number
  maxTokensPerStep: number
  thinking: ThinkingLevel
  checkpointSteps: number
}

/** run_code: sandboxed execution in a dedicated WSL distro (see exec/ and cli/exec-setup.mjs) */
export interface ExecToolConfig {
  enable: boolean
  distro: string
  /** who may trigger it: admins only, or everyone who can chat */
  access: 'admin' | 'all'
  languages: ExecLanguage[]
  /** seconds per run */
  timeout: number
  memoryMB: number
  diskMB: number
  /** characters of stdout/stderr returned to the model */
  maxOutput: number
  maxRunsPerTurn: number
}

export interface TriggerSection {
  at: boolean
  replyToBot: boolean
  alias: boolean
  prefixes: string[]
  private: 'off' | 'master' | 'all'
  emptyAtReply: boolean
  groupWhitelist: (string | number)[]
  groupBlacklist: (string | number)[]
  userBlacklist: (string | number)[]
  priority: number
  userCooldown: number
}

export interface PersonaSection {
  botName: string
  active: string
  presets: Record<string, string>
}

export interface MemorySection {
  enable: boolean
  userMaxEntries: number
  userMaxChars: number
  groupMaxEntries: number
  groupMaxChars: number
  entryMaxChars: number
  /** who can cause the model to write group memory */
  groupWrite: 'all' | 'admin' | 'off'
  autoCompact: boolean
  maxWritesPerTurn: number
}

export interface GroupOverride {
  enable?: boolean
  model?: string
  persona?: string
  thinking?: ThinkingSetting
  chat?: Partial<ChatSection>
  reply?: Partial<ReplySection>
  sticker?: Partial<StickerSection>
  tools?: Partial<ToolsSection>
}

export interface PluginConfig {
  enable: boolean
  admins: (string | number)[]
  providers: Record<string, ProviderConfig>
  models: ModelConfig[]
  defaultModel: string
  fallbackModels: string[]
  utilityModel: string
  visionModel: string
  persona: PersonaSection
  groups: Record<string, GroupOverride>
  trigger: TriggerSection
  chat: ChatSection
  quota: { defaultScope: QuotaScope; exemptAdmins: boolean; notifyCooldown: number }
  reply: ReplySection
  sticker: StickerSection
  tools: ToolsSection
  skills: { enable: boolean }
  memory: MemorySection
  pricing: { sources: ('openrouter' | 'litellm')[]; refreshHours: number }
}

/** Effective per-conversation view (group overrides applied). */
export interface EffectiveConfig {
  enable: boolean
  model: string
  personaPrompt: string
  chat: ChatSection
  reply: ReplySection
  sticker: StickerSection
  tools: ToolsSection
}
