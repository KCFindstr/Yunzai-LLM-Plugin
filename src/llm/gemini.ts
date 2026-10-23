import { deepMerge } from '../core/util.ts'
import { genCallId, geminiThinking, parseArgs } from './common.ts'
import { joinUrl, requestJson } from './http.ts'
import { usesServerState } from './state.ts'
import type { Adapter, ChatParams, ChatResult, ToolCall } from './types.ts'
import { LLMError } from './types.ts'

/**
 * Gemini Interactions API (POST /v1beta/interactions).
 * Input/outputs are "steps": user_input, model_output, thought, function_call, function_result, google_search_call…
 * With store=true the agent chains turns via previous_interaction_id and only sends new steps.
 */
export const gemini: Adapter = {
  async chat(p: ChatParams): Promise<ChatResult> {
    const base = p.provider.baseUrl || 'https://generativelanguage.googleapis.com'
    const url = /\/v1beta\/?$/.test(base) ? joinUrl(base, 'interactions') : joinUrl(base, 'v1beta/interactions')
    const store = usesServerState(p.provider, p.model, p.store)
    const state = store ? p.state : undefined
    const vision = p.model.vision !== false
    const msgs = state ? p.messages.slice(state.skip) : p.messages
    const input: any[] = []

    for (const m of msgs) {
      if (m.role === 'user') {
        input.push({
          type: 'user_input',
          content: m.content.map(c =>
            c.type === 'text'
              ? { type: 'text', text: c.text }
              : vision && c.data
                ? { type: 'image', data: c.data, mime_type: c.mime || 'image/png' }
                : vision && c.url
                  ? { type: 'image', uri: c.url }
                  : { type: 'text', text: '[图片]' },
          ),
        })
      } else if (m.role === 'assistant') {
        if (m.native?.provider === 'gemini' && m.native.model === p.model.model) {
          input.push(...m.native.data)
          continue
        }
        if (m.content) input.push({ type: 'model_output', content: [{ type: 'text', text: m.content }] })
        for (const tc of m.toolCalls ?? []) input.push({ type: 'function_call', id: tc.id, name: tc.name, arguments: tc.args })
      } else {
        for (const r of m.results)
          input.push({
            type: 'function_result',
            call_id: r.id,
            name: r.name,
            result: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })
      }
    }

    const generation_config: any = { max_output_tokens: p.maxTokens }
    const thinkingLevel = geminiThinking(p.thinking)
    if (thinkingLevel) generation_config.thinking_level = thinkingLevel
    if (p.temperature != null) generation_config.temperature = p.temperature
    if (p.model.topP != null) generation_config.top_p = p.model.topP
    let body: any = { model: p.model.model, input, system_instruction: p.system, store, generation_config }
    if (state) body.previous_interaction_id = state.previousId
    const tools: any[] = p.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
    if (p.nativeSearch) tools.push({ type: 'google_search' }, { type: 'url_context' })
    if (tools.length) body.tools = tools
    if (p.model.extraBody) body = deepMerge(body, p.model.extraBody)
    // A one-shot store=false or disabled chain must also override extraBody storage settings.
    body.store = store
    if (!store) delete body.previous_interaction_id

    const res = await requestJson(p.provider, key => ({ url, headers: { 'x-goog-api-key': key }, body }), p.signal)

    if (res?.status === 'failed') {
      const e = res?.errors?.[0]
      throw new LLMError(`Gemini interaction failed: ${e?.message ?? e?.code ?? 'unknown'}`)
    }

    const steps: any[] = Array.isArray(res?.steps) ? res.steps : []
    let text = ''
    const toolCalls: ToolCall[] = []
    let searchSteps = 0
    for (const s of steps) {
      if (s?.type === 'model_output')
        for (const c of s.content ?? []) if (c?.type === 'text') text += c.text ?? ''
      if (s?.type === 'function_call') toolCalls.push({ id: s.id || genCallId(), name: s.name, args: parseArgs(s.arguments) })
      if (s?.type === 'google_search_call') searchSteps++
    }

    const u = res?.usage ?? {}
    const cached = u.total_cached_tokens ?? 0
    const thought = u.total_thought_tokens ?? 0
    const grounding = Array.isArray(u.grounding_tool_count)
      ? u.grounding_tool_count.find((g: any) => g?.type === 'google_search')?.count
      : undefined
    return {
      text,
      toolCalls,
      usage: {
        input: Math.max(0, (u.total_input_tokens ?? 0) + (u.total_tool_use_tokens ?? 0) - cached),
        cacheRead: cached,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: (u.total_output_tokens ?? 0) + thought,
        reasoning: thought,
        webSearches: grounding ?? searchSteps,
        // Google currently omits historical input/cache usage on some chained Interactions.
        // https://discuss.ai.google.dev/t/187450 — keep the reported numbers, flag their limits.
        ...(state ? { inputIncomplete: true } : {}),
      },
      native: { provider: 'gemini', model: p.model.model, data: steps },
      stopReason: res?.status ?? 'unknown',
      responseId: store ? res?.id : undefined,
    }
  },
}
