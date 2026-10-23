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

export { usesServerState } from './state.ts'

export async function chat(p: ChatParams): Promise<ChatResult> {
  const adapter = adapters[p.provider.type]
  if (!adapter) throw new LLMError(`不支持的 provider 类型: ${p.provider.type}`)
  return adapter.chat(p)
}

export * from './types.ts'
