import type { ProviderType } from '../core/configTypes.ts'
import { anthropic } from './anthropic.ts'
import { gemini } from './gemini.ts'
import { openaiChat } from './openaiChat.ts'
import { openaiResponses } from './openaiResponses.ts'
import type { Adapter, ChatParams, ChatResult } from './types.ts'
import { LLMError } from './types.ts'

const adapters: Record<ProviderType, Adapter> = {
  openai: openaiChat,
  'openai-responses': openaiResponses,
  anthropic,
  gemini,
}

export const PROVIDER_TYPES = Object.keys(adapters) as ProviderType[]

/** Whether this provider type can chain turns server-side (and whether it's enabled). */
export function usesServerState(p: ChatParams['provider']): boolean {
  if (p.type === 'gemini') return (p.serverState ?? true) && (p.store ?? true)
  if (p.type === 'openai-responses') return (p.serverState ?? false) && (p.store ?? p.serverState ?? false)
  return false
}

export async function chat(p: ChatParams): Promise<ChatResult> {
  const adapter = adapters[p.provider.type]
  if (!adapter) throw new LLMError(`不支持的 provider 类型: ${p.provider.type}`)
  return adapter.chat(p)
}

export * from './types.ts'
