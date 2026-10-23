import type { ModelConfig, ProviderConfig } from '../core/configTypes.ts'

/** Shared by the chat loop and adapters so disabling storage never sends only a partial transcript. */
export function usesServerState(provider: ProviderConfig, model?: ModelConfig, store?: boolean): boolean {
  if (provider.type === 'gemini')
    return (model?.serverState ?? provider.serverState ?? true) && (store ?? model?.extraBody?.store ?? provider.store ?? true)
  if (provider.type === 'openai-responses')
    return (provider.serverState ?? false) && (store ?? provider.store ?? provider.serverState ?? false)
  return false
}
