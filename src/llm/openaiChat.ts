import { deepMerge } from '../core/util.ts'
import { dataUrl, genCallId, openaiEffort, parseArgs } from './common.ts'
import { joinUrl, requestJson } from './http.ts'
import type { Adapter, ChatParams, ChatResult, Part, ToolCall } from './types.ts'
import { stripThink } from './types.ts'

function userContent(parts: Part[], vision: boolean): any {
  if (!parts.some(p => p.type === 'image')) return parts.map(p => (p.type === 'text' ? p.text : '')).join('')
  return parts.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    if (!vision) return { type: 'text', text: '[图片]' }
    return { type: 'image_url', image_url: { url: dataUrl(p), detail: p.detail === 'original' ? 'high' : p.detail ?? 'low' } }
  })
}

function contentText(c: any): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x?.text ?? ''))).join('')
  return ''
}

/** Keep only fields the API accepts back as an assistant message. */
function sanitizeAssistant(msg: any, calls: ToolCall[]): any {
  const out: any = { role: 'assistant', content: msg.content ?? null }
  if (calls.length)
    out.tool_calls = calls.map(c => ({
      id: c.id,
      type: 'function',
      function: {
        name: c.name,
        arguments:
          msg.tool_calls?.find((t: any) => t?.id === c.id)?.function?.arguments ?? JSON.stringify(c.args),
      },
    }))
  // DeepSeek-style thinking must be echoed back during a tool loop
  if (msg.reasoning_content != null) out.reasoning_content = msg.reasoning_content
  if (out.content == null && !out.tool_calls) out.content = ''
  return out
}

export const openaiChat: Adapter = {
  async chat(p: ChatParams): Promise<ChatResult> {
    const base = p.provider.baseUrl || 'https://api.openai.com/v1'
    const official = /api\.openai\.com/i.test(base)
    const vision = p.model.vision !== false
    const messages: any[] = [{ role: 'system', content: p.system }]

    for (const m of p.messages) {
      if (m.role === 'user') messages.push({ role: 'user', content: userContent(m.content, vision) })
      else if (m.role === 'assistant') {
        if (m.native?.provider === 'openai' && m.native.model === p.model.model) {
          messages.push(m.native.data)
          continue
        }
        const msg: any = { role: 'assistant', content: m.content || null }
        if (m.toolCalls?.length)
          msg.tool_calls = m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        if (msg.content == null && !msg.tool_calls) msg.content = ''
        messages.push(msg)
      } else for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
    }

    let body: any = { model: p.model.model, messages }
    if (p.tools.length)
      body.tools = p.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    const field = p.provider.maxTokensField ?? (official ? 'max_completion_tokens' : 'max_tokens')
    body[field] = p.maxTokens
    const effort = openaiEffort(p.thinking)
    if (effort) body.reasoning_effort = effort
    // DeepSeek models think by default; 'off' has to be explicit there
    else if (p.thinking === 'off' && (/deepseek/i.test(base) || /^deepseek/i.test(p.model.model))) body.thinking = { type: 'disabled' }
    if (p.temperature != null) body.temperature = p.temperature
    if (p.model.topP != null) body.top_p = p.model.topP
    if ((p.provider.promptCacheKey ?? official) && p.cacheKey) body.prompt_cache_key = p.cacheKey
    if (/openrouter\.ai/i.test(base)) body.usage = { include: true }
    if (p.model.extraBody) body = deepMerge(body, p.model.extraBody)

    const res = await requestJson(
      p.provider,
      key => ({ url: joinUrl(base, 'chat/completions'), headers: { authorization: `Bearer ${key}` }, body }),
      p.signal,
    )

    const choice = res?.choices?.[0] ?? {}
    const msg = choice.message ?? {}
    const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc: any) => tc?.function?.name)
      .map((tc: any) => ({ id: tc.id || genCallId(), name: tc.function.name, args: parseArgs(tc.function.arguments) }))
    const u = res?.usage ?? {}
    const prompt = u.prompt_tokens ?? 0
    const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0
    const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0

    return {
      text: stripThink(contentText(msg.content)),
      toolCalls,
      usage: {
        input: Math.max(0, prompt - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        cacheWrite1h: 0,
        output: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
        webSearches: 0,
        cost: typeof u.cost === 'number' ? u.cost : undefined,
      },
      native: { provider: 'openai', model: p.model.model, data: sanitizeAssistant(msg, toolCalls) },
      stopReason: choice.finish_reason ?? 'unknown',
    }
  },
}
