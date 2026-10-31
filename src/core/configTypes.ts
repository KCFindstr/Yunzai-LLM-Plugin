/** Provider types with a chat adapter in src/llm. */
export type ProviderType = 'openai' | 'openai-responses' | 'anthropic' | 'gemini'
/** Any provider: chat, Voyage embeddings, or a TypeSafe System One classifier (Jev / self-hosted Kev). */
export type AnyProviderType = ProviderType | 'voyage' | 'systemone'
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** `auto` picks a level per message (see autoThinking). */
export type ThinkingSetting = ThinkingLevel | 'auto'
export type QuotaScope = 'user' | 'group' | 'global'

export interface ProviderConfig {
  type: AnyProviderType
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
  /** gemini (default true) / openai-responses (default false): reuse server state only within a rollout. */
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
  /** thinking=auto: level per auto-thinking category, overriding autoThinking.levels */
  autoThinking?: Record<string, ThinkingLevel>
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
  /**
   * Gemini: override the provider's serverState for this model (default true).
   * Both stateful and stateless Interactions support implicit caching. Chained usage can omit historical
   * input/cache tokens, so a zero reported cache count does not establish a cache miss.
   */
  serverState?: boolean
}

/** Embedding model for recall over the chat archive (provider type voyage or OpenAI-compatible). */
export interface EmbeddingModelConfig {
  id: string
  provider: string
  model: string
  dimensions: number
}

/** TypeSafe System One classifier (Jev, or a self-hosted Kev), usable as a judge. */
export interface SystemOneModelConfig {
  id: string
  provider: string
  model: string
}

export interface RateConfig {
  count: number
  perSeconds: number
}

export interface ChatSection {
  maxPending: number
  rosterSize: number
  sessionScope: 'user' | 'group'
  sessionTimeout: number
  historyMaxTurns: number
  historyMaxTokens: number
  summarize: boolean
  /** Output budget, including reasoning, for history summaries and daily digests. */
  summaryMaxTokens: number
  groupContext: number
  /** Maximum age of ambient group messages, in minutes (independent of session expiry). */
  groupContextMaxAgeMinutes: number
  groupContextMaxChars: number
  maxToolRounds: number
  /** Non-exempt tool-call attempts per reply, including calls in parallel batches. */
  maxToolCalls: number
  maxOutputTokens: number
  temperature: number | null
  thinking: ThinkingSetting
  includeImages: boolean
  maxImages: number
  includeQuoted: boolean
}

export interface AutoThinkingCategory {
  /** what the judge answers with */
  name: string
  /** shown to the judge */
  description: string
}

/** thinking=auto: a judge sorts each message into a category; the model's level for it is used. */
export interface AutoThinkingSection {
  /** chat model id or System One model id; empty = utilityModel, then the default model */
  judge: string
  timeoutMs: number
  /** recent messages (this conversation and the group chat, each) shown to the judge for context */
  context: number
  /** default level per category; models[].autoThinking overrides */
  levels: Record<string, ThinkingLevel>
  /** in order; the first one is also the fallback when judging fails */
  categories: AutoThinkingCategory[]
}

/** Speaking up in groups without being addressed. Enabled per group (groups.<id>.proactive.enable). */
export interface ProactiveSection {
  /** first gate: each message is sampled with this probability; only sampled windows reach the judge */
  probability: number
  /** seconds; at most one judge call per window, at its end, if a message in it was sampled */
  window: number
  /** chat or System One model id; 'always' = no judge, a sampled window replies; empty = autoThinking.judge, then utilityModel / default model */
  judge: string
  context: number
  criteria: { reply: string; skip: string }
  /** second gate: reply when the judge's score >= end + (start - end) * 0.5^(t / halfLife), t = seconds since the bot last replied in the group */
  threshold: { start: number; end: number; halfLife: number }
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
  sendImage: { maxPerTurn: number }
  readFile: { maxPerTurn: number }
  loadSkill: { maxPerTurn: number }
  listStickers: { maxPerTurn: number }
  webSearch: {
    enable: boolean
    provider: 'native' | 'deepseek' | 'anysearch' | 'tavily' | 'brave' | 'searxng' | 'jina' | 'none'
    apiKey: string
    baseUrl: string
    maxResults: number
    maxPerTurn: number
  }
  webFetch: {
    enable: boolean
    maxChars: number
    timeout: number
    reader: 'direct' | 'jina' | 'deepseek'
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
  googleLens: { enable: boolean; access: 'admin' | 'all'; distro: string }
  agy: AgyConfig
  schedule: ScheduleConfig
  disabled: string[]
}

export interface ScheduleConfig {
  enable: boolean
  access: 'admin' | 'all'
  /** Active tasks per person (admins are not limited). */
  maxPerUser: number
  /** Shortest repeat interval, minutes. */
  minInterval: number
  /** How many times in a row a wake-up may schedule the next one (0 = never). */
  maxChain: number
}

export interface AgyConfig {
  enable: boolean
  access: 'admin' | 'all'
  executable: string
  maxMinutes: number
  maxQueue: number
  /** How many times in a row a background result turn may start another job (0 = never). */
  maxChainDepth: number
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
  /** How many times in a row a background result turn may start another job (0 = never). */
  maxChainDepth: number
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
  /** Days to keep per-conversation daily digests (archive detail is kept 30 days). */
  dailyDays: number
  /** Private chats may also recall the archives of groups the person is in (never the other way round). */
  crossChatRecall: boolean
  /** Keep and summarize group messages that don't involve the bot, so recall and daily digests cover them. */
  groupChatArchive: boolean
  /** Most results one recall search returns (recall tool, per-turn recall, web vector query), 1-100. */
  recallLimit: number
  embedding: EmbeddingSection
}

/** Recall over the chat archive by embeddings. */
export interface EmbeddingSection {
  enable: boolean
  /** embeddingModels id */
  model: string
  /** Cosine similarity at which an archive entry counts as relevant even without shared keywords. */
  minScore: number
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
  proactive?: Partial<ProactiveSection> & { enable?: boolean }
  /** Names in this group (platform ID -> name), overriding the global `names`. */
  names?: Record<string, string>
}

export interface PluginConfig {
  enable: boolean
  admins: (string | number)[]
  providers: Record<string, ProviderConfig>
  models: ModelConfig[]
  embeddingModels: EmbeddingModelConfig[]
  systemoneModels: SystemOneModelConfig[]
  defaultModel: string
  fallbackModels: string[]
  utilityModel: string
  visionModel: string
  persona: PersonaSection
  groups: Record<string, GroupOverride>
  /** Platform ID -> name, overriding whatever the adapter reports (QQBot often reports none). */
  names: Record<string, string>
  trigger: TriggerSection
  chat: ChatSection
  autoThinking: AutoThinkingSection
  /** defaults for groups that enable proactive replies */
  proactive: ProactiveSection
  quota: { defaultScope: QuotaScope; exemptAdmins: boolean; notifyCooldown: number }
  reply: ReplySection
  sticker: StickerSection
  tools: ToolsSection
  skills: { enable: boolean }
  memory: MemorySection
  pricing: { sources: ('openrouter' | 'litellm')[]; refreshHours: number }
  web: WebSection
}

/** Built-in management web UI. */
export interface WebSection {
  enable: boolean
  host: string
  port: number
  /** Login password; empty = a random one is generated once and saved in data/web-auth.json. */
  password: string
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
  /** enabled only by groups.<id>.proactive.enable */
  proactive: ProactiveSection & { enable: boolean }
}
