import { deepMerge } from '../core/util.ts'
import { anthropicEffort } from './common.ts'
import { joinUrl, requestJson } from './http.ts'
import type { Adapter, ChatParams, ChatResult, ToolCall } from './types.ts'

const CACHEABLE_TAIL = new Set(['text', 'image', 'tool_result'])

/** Models that accept the dynamic-filtering web search tool version. */
function searchToolType(model: string): string {
  return /(opus|sonnet)-(4-[6-9]|5)/i.test(model) ? 'web_search_20260209' : 'web_search_20250305'
}

/** Anthropic Messages API (POST /v1/messages) and compatible endpoints. */
export const anthropic: Adapter = {
  async chat(p: ChatParams): Promise<ChatResult> {
    const base = p.provider.baseUrl || 'https://api.anthropic.com'
    const url = /\/v1\/?$/.test(base) ? joinUrl(base, 'messages') : joinUrl(base, 'v1/messages')
    const cc: any = p.provider.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    const vision = p.model.vision !== false
    const messages: { role: 'user' | 'assistant'; content: any[] }[] = []

    const push = (role: 'user' | 'assistant', blocks: any[]) => {
      if (!blocks.length) return
      const last = messages[messages.length - 1]
      if (last && last.role === role) last.content.push(...blocks)
      else messages.push({ role, content: [...blocks] })
    }

    for (const m of p.messages) {
      if (m.role === 'user') {
        push(
          'user',
          m.content
            .map(c => {
              if (c.type === 'text') return c.text ? { type: 'text', text: c.text } : null
              if (!vision) return { type: 'text', text: '[图片]' }
              return c.data
                ? { type: 'image', source: { type: 'base64', media_type: c.mime || 'image/png', data: c.data } }
                : { type: 'image', source: { type: 'url', url: c.url } }
            })
            .filter(Boolean),
        )
      } else if (m.role === 'assistant') {
        if (m.native?.provider === 'anthropic' && m.native.model === p.model.model) {
          push('assistant', m.native.data)
          continue
        }
        const blocks: any[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
        push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }])
      } else {
        push(
          'user',
          m.results.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content || '(empty)',
            ...(r.isError ? { is_error: true } : {}),
          })),
        )
      }
    }

    const earlierUser = messages.slice(0, -1).findLast(message => message.role === 'user')
    if (earlierUser) {
      const index = earlierUser.content.length - 1
      if (CACHEABLE_TAIL.has(earlierUser.content[index]?.type)) earlierUser.content[index] = { ...earlierUser.content[index], cache_control: cc }
    }
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'user') {
      const i = lastMsg.content.length - 1
      if (CACHEABLE_TAIL.has(lastMsg.content[i]?.type)) lastMsg.content[i] = { ...lastMsg.content[i], cache_control: cc }
    }

    let body: any = {
      model: p.model.model,
      max_tokens: p.maxTokens,
      // Breakpoint here caches tools + system, shared by every conversation using this persona.
      system: [{ type: 'text', text: p.system, cache_control: cc }],
      messages,
    }
    const tools: any[] = p.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    if (p.nativeSearch) tools.push({ type: searchToolType(p.model.model), name: 'web_search', max_uses: 3 })
    if (tools.length) tools[tools.length - 1].cache_control = cc
    if (tools.length) body.tools = tools
    const effort = anthropicEffort(p.thinking)
    if (effort) {
      body.thinking = { type: 'adaptive' }
      body.output_config = { effort }
    }
    const noSampling = /(?:haiku|sonnet|opus)[-.]5[-.]5(?:\b|$)/i.test(p.model.model)
    if (!noSampling && p.temperature != null) body.temperature = p.temperature
    if (!noSampling && p.model.topP != null) body.top_p = p.model.topP
    if (p.model.extraBody) body = deepMerge(body, p.model.extraBody)

    const res = await requestJson(
      p.provider,
      key => ({
        url,
        headers: {
          'anthropic-version': '2023-06-01',
          ...(p.provider.authStyle === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }),
        },
        body,
      }),
      p.signal,
    )

    const content: any[] = Array.isArray(res?.content) ? res.content : []
    let text = ''
    const toolCalls: ToolCall[] = []
    for (const b of content) {
      if (b?.type === 'text') text += b.text ?? ''
      else if (b?.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} })
    }

    const u = res?.usage ?? {}
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const created = u.cache_creation_input_tokens ?? (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) + w1h
    return {
      text,
      toolCalls,
      usage: {
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: Math.max(0, created - w1h),
        cacheWrite1h: w1h,
        output: u.output_tokens ?? 0,
        reasoning: 0,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
      },
      native: { provider: 'anthropic', model: p.model.model, data: content },
      stopReason: res?.stop_reason ?? 'unknown',
      pause: res?.stop_reason === 'pause_turn',
    }
  },
}
