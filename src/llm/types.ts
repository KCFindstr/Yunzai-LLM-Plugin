import type { ModelConfig, ProviderConfig, ProviderType, ThinkingLevel } from '../core/configTypes.ts'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  /** base64 (no data: prefix) */
  data?: string
  mime?: string
  url?: string
  detail?: 'low' | 'high' | 'auto' | 'original'
}

export type Part = TextPart | ImagePart

export interface ToolCall {
  id: string
  name: string
  args: Record<string, any>
}

export interface ToolResult {
  id: string
  name: string
  content: string
  isError?: boolean
  /** images for vision models to look at (e.g. web_fetch of an image URL); dropped for models without vision */
  images?: ImagePart[]
}

/** Provider-raw assistant output, replayed verbatim to the same provider+model inside one tool loop. */
export interface NativeTurn {
  provider: ProviderType
  model: string
  data: any
}

export interface UserMsg {
  role: 'user'
  content: Part[]
}

export interface AssistantMsg {
  role: 'assistant'
  content: string
  toolCalls?: ToolCall[]
  native?: NativeTurn
  /** Server-side id of the response that produced this message (gemini/responses state). */
  responseId?: string
}

export interface ToolMsg {
  role: 'tool'
  results: ToolResult[]
}

export type Msg = UserMsg | AssistantMsg | ToolMsg

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, any>
}

export interface Usage {
  /** Uncached input tokens billed at the full input rate. */
  input: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  /** Output tokens including reasoning. */
  output: number
  reasoning: number
  webSearches: number
  /** USD cost reported by the provider (e.g. OpenRouter); overrides computed cost. */
  cost?: number
  /** Historical input/cache tokens may be missing from provider usage; calculated cost can undercount. */
  inputIncomplete?: boolean
}

export function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, webSearches: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    webSearches: a.webSearches + b.webSearches,
    cost: a.cost != null || b.cost != null ? (a.cost ?? 0) + (b.cost ?? 0) : undefined,
    ...(a.inputIncomplete || b.inputIncomplete ? { inputIncomplete: true } : {}),
  }
}

export interface ServerState {
  previousId: string
  /** messages[0..skip) already live on the server under previousId. */
  skip: number
}

export interface ChatParams {
  model: ModelConfig
  provider: ProviderConfig
  system: string
  messages: Msg[]
  tools: ToolSpec[]
  /** Enable the provider's built-in web search tool. */
  nativeSearch?: boolean
  thinking: ThinkingLevel
  maxTokens: number
  temperature?: number | null
  /** Stable key that groups requests sharing a prefix (OpenAI prompt_cache_key). */
  cacheKey?: string
  state?: ServerState
  /** override provider.store (Gemini): one-shot calls never chain, so they shouldn't persist server state */
  store?: boolean
  signal?: AbortSignal
}

export interface ChatResult {
  text: string
  /** Readable thinking or reasoning summaries explicitly returned by the provider. */
  reasoning?: string
  toolCalls: ToolCall[]
  usage: Usage
  native?: NativeTurn
  stopReason: string
  /** Server-side id when the provider keeps state (gemini interactions / responses). */
  responseId?: string
  /** true when the provider asks us to resend to continue (anthropic pause_turn). */
  pause?: boolean
}

export interface Adapter {
  chat(p: ChatParams): Promise<ChatResult>
}

export class LLMError extends Error {
  status?: number
  retryable: boolean
  body?: string
  constructor(message: string, opts: { status?: number; retryable?: boolean; body?: string } = {}) {
    super(message)
    this.name = 'LLMError'
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.body = opts.body
  }
}

/** Remove <think>…</think> blocks some compatible servers inline into content. */
export function stripThink(text: string): string {
  // second pass: a dangling </think> means the server omitted the opening tag
  return (text || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/^[\s\S]*?<\/think>\s*/i, '')
}

/** Extract readable inline thinking without changing the delivered answer. */
export function inlineThinking(text: string): string | undefined {
  const blocks = [...text.matchAll(/<think>([\s\S]*?)<\/think>/gi)].map(match => match[1])
  if (!blocks.length) {
    const dangling = text.match(/^([\s\S]*?)<\/think>/i)
    if (dangling) blocks.push(dangling[1])
  }
  return joinThinking(...blocks)
}

export function joinThinking(...parts: unknown[]): string | undefined {
  return parts.filter((part): part is string => typeof part === 'string' && !!part.trim()).join('\n\n') || undefined
}

export function partsToText(parts: Part[]): string {
  return parts.map(p => (p.type === 'text' ? p.text : '[图片]')).join('')
}
