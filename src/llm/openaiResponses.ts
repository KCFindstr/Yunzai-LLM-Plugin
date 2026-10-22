import { deepMerge } from '../core/util.ts'
import { dataUrl, genCallId, openaiEffort, parseArgs } from './common.ts'
import { joinUrl, requestJson } from './http.ts'
import type { Adapter, ChatParams, ChatResult, ToolCall } from './types.ts'
import { stripThink } from './types.ts'

/** OpenAI Responses API (POST /responses). */
export const openaiResponses: Adapter = {
  async chat(p: ChatParams): Promise<ChatResult> {
    const base = p.provider.baseUrl || 'https://api.openai.com/v1'
    const official = /api\.openai\.com/i.test(base)
    const vision = p.model.vision !== false
    const store = p.provider.store ?? p.provider.serverState ?? false
    const msgs = p.state ? p.messages.slice(p.state.skip) : p.messages
    const input: any[] = []

    for (const m of msgs) {
      if (m.role === 'user') {
        input.push({
          role: 'user',
          content: m.content.map(c =>
            c.type === 'text'
              ? { type: 'input_text', text: c.text }
              : vision
                ? { type: 'input_image', image_url: dataUrl(c), detail: c.detail ?? 'low' }
                : { type: 'input_text', text: '[图片]' },
          ),
        })
      } else if (m.role === 'assistant') {
        if (m.native?.provider === 'openai-responses' && m.native.model === p.model.model) {
          input.push(...m.native.data)
          continue
        }
        if (m.content) input.push({ role: 'assistant', content: m.content })
        for (const tc of m.toolCalls ?? [])
          input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.args) })
      } else {
        for (const r of m.results) input.push({ type: 'function_call_output', call_id: r.id, output: r.content })
      }
    }

    let body: any = { model: p.model.model, input, instructions: p.system, max_output_tokens: p.maxTokens, store }
    if (p.state) body.previous_response_id = p.state.previousId
    const tools: any[] = p.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
    if (p.nativeSearch) tools.push({ type: 'web_search' })
    if (tools.length) body.tools = tools
    const effort = openaiEffort(p.thinking)
    if (effort) {
      body.reasoning = { effort }
      if (!store) body.include = ['reasoning.encrypted_content']
    }
    if (p.temperature != null) body.temperature = p.temperature
    if (p.model.topP != null) body.top_p = p.model.topP
    if ((p.provider.promptCacheKey ?? official) && p.cacheKey) body.prompt_cache_key = p.cacheKey
    if (p.model.extraBody) body = deepMerge(body, p.model.extraBody)

    const res = await requestJson(
      p.provider,
      key => ({ url: joinUrl(base, 'responses'), headers: { authorization: `Bearer ${key}` }, body }),
      p.signal,
    )

    const output: any[] = Array.isArray(res?.output) ? res.output : []
    let text = ''
    const toolCalls: ToolCall[] = []
    let searches = 0
    for (const item of output) {
      if (item?.type === 'message')
        for (const c of item.content ?? []) if (c?.type === 'output_text') text += c.text ?? ''
      if (item?.type === 'function_call')
        toolCalls.push({ id: item.call_id || genCallId(), name: item.name, args: parseArgs(item.arguments) })
      if (item?.type === 'web_search_call') searches++
    }
    if (!text && typeof res?.output_text === 'string') text = res.output_text

    const u = res?.usage ?? {}
    const cacheRead = u.input_tokens_details?.cached_tokens ?? 0
    return {
      text: stripThink(text),
      toolCalls,
      usage: {
        input: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
        cacheRead,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: u.output_tokens ?? 0,
        reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
        webSearches: searches,
      },
      native: { provider: 'openai-responses', model: p.model.model, data: output },
      stopReason: res?.status === 'incomplete' ? `incomplete:${res?.incomplete_details?.reason ?? ''}` : (res?.status ?? 'unknown'),
      responseId: store ? res?.id : undefined,
    }
  },
}
