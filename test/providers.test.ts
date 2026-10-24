import { mockServer } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { addUsage, chat, emptyUsage, usesServerState } from '../src/llm/index.ts'
import type { ChatParams, Msg } from '../src/llm/types.ts'
import type { ModelConfig, ProviderConfig } from '../src/core/configTypes.ts'

const tools = [{ name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }]

function params(provider: ProviderConfig, model: Partial<ModelConfig>, messages: Msg[], extra: Partial<ChatParams> = {}): ChatParams {
  return {
    provider: { maxRetries: 0, ...provider },
    model: { id: 'm', provider: 'p', model: 'test-model', ...model } as ModelConfig,
    system: 'SYS',
    messages,
    tools,
    thinking: 'low',
    maxTokens: 512,
    temperature: null,
    ...extra,
  }
}

const userMsg: Msg = { role: 'user', content: [{ type: 'text', text: '天气如何' }, { type: 'image', data: 'AAAA', mime: 'image/png' }] }

describe('readable provider thinking', () => {
  const cases = [
    { type: 'openai', response: { choices: [{ message: { content: 'answer', reasoning_content: 'visible thinking', reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-secret' }] } }] } },
    { type: 'openai-responses', response: { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'visible thinking' }], encrypted_content: 'opaque-secret' }, { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] } },
    { type: 'anthropic', response: { content: [{ type: 'thinking', thinking: 'visible thinking', signature: 'opaque-secret' }, { type: 'redacted_thinking', data: 'opaque-secret' }, { type: 'text', text: 'answer' }] } },
    { type: 'gemini', response: { steps: [{ type: 'thought', summary: [{ type: 'text', text: 'visible thinking' }, { type: 'image', data: 'opaque-secret' }], signature: 'opaque-secret' }, { type: 'model_output', content: [{ type: 'text', text: 'answer' }] }] } },
  ] as const
  for (const fixture of cases) it(`${fixture.type} extracts readable thinking without signatures or encrypted data`, async () => {
    const server = await mockServer(() => [200, fixture.response])
    try {
      const result = await chat(params({ type: fixture.type, baseUrl: server.url, apiKey: 'mock' }, {}, [userMsg]))
      assert.equal(result.text, 'answer')
      assert.equal(result.reasoning, 'visible thinking')
      const body = server.requests[0].body
      if (fixture.type === 'gemini') assert.equal(body.generation_config.thinking_summaries, 'auto')
      if (fixture.type === 'openai-responses') assert.equal(body.reasoning.summary, 'auto')
      if (fixture.type === 'anthropic') assert.equal(body.thinking.display, 'summarized')
    } finally { await server.close() }
  })
  for (const fixture of [
    { type: 'gemini', extraBody: { generation_config: { thinking_summaries: 'none' } } },
    { type: 'openai-responses', extraBody: { reasoning: { summary: null } } },
    { type: 'anthropic', extraBody: { thinking: { display: 'omitted' } } },
  ] as const) it(`${fixture.type} preserves explicit summary-display overrides`, async () => {
    const server = await mockServer(() => [200, {}])
    try {
      const result = await chat(params({ type: fixture.type, baseUrl: server.url, apiKey: 'mock' }, { extraBody: fixture.extraBody }, [userMsg]))
      const body = server.requests[0].body
      if (fixture.type === 'gemini') assert.equal(body.generation_config.thinking_summaries, 'none')
      if (fixture.type === 'openai-responses') assert.equal(body.reasoning.summary, null)
      if (fixture.type === 'anthropic') assert.equal(body.thinking.display, 'omitted')
      assert.equal(result.reasoning, undefined)
    } finally { await server.close() }
  })
})

describe('system prompt literal content', () => {
  for (const type of ['openai', 'anthropic', 'openai-responses', 'gemini'] as const) {
    it(`${type} preserves Markdown and intentional backslashes after JSON decoding`, async () => {
      const system = '# Persona\n1. **Bold**\n- Bullet\nKeep C:\\work\\notes and literal \\* untouched.'
      const server = await mockServer(() => [200, { id: 'example', status: 'completed', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], content: [{ type: 'text', text: 'ok' }], output: [], steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }], usage: {} }])
      try {
        await chat(params({ type, baseUrl: server.url, apiKey: 'mock' }, {}, [userMsg], { system }))
        const body = server.requests[0].body
        const received = type === 'openai' ? body.messages[0].content : type === 'anthropic' ? body.system[0].text : type === 'openai-responses' ? body.instructions : body.system_instruction
        assert.equal(received, system)
      } finally { await server.close() }
    })
  }
})

describe('openai chat completions', () => {
  it('builds request, parses tool calls, usage and cost', async () => {
    const srv = await mockServer(() => [
      200,
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'thinking...',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, cost: 0.0012 },
      },
    ])
    after(srv.close)
    const res = await chat(params({ type: 'openai', baseUrl: `${srv.url}/v1`, apiKey: 'k1' }, {}, [userMsg]))
    const req = srv.requests[0]
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer k1')
    assert.equal(req.body.messages[0].role, 'system')
    assert.equal(req.body.messages[1].content[1].type, 'image_url')
    assert.match(req.body.messages[1].content[1].image_url.url, /^data:image\/png;base64,AAAA/)
    assert.equal(req.body.max_tokens, 512, 'compat servers get max_tokens')
    assert.equal(req.body.reasoning_effort, 'low')
    assert.equal(req.body.tools[0].function.name, 'get_weather')
    assert.equal(req.body.prompt_cache_key, undefined, 'only sent to api.openai.com by default')
    assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'get_weather', args: { city: '上海' } }])
    assert.equal(res.usage.cacheRead, 800)
    assert.equal(res.usage.input, 200)
    assert.equal(res.usage.cost, 0.0012)
    assert.equal(res.native?.data.reasoning_content, 'thinking...', 'reasoning_content kept for replay')
  })

  it('replays native assistant + tool results and strips <think>', async () => {
    const srv = await mockServer(() => [200, { choices: [{ message: { content: '<think>hmm</think>晴天' }, finish_reason: 'stop' }], usage: {} }])
    after(srv.close)
    const native = { provider: 'openai' as const, model: 'test-model', data: { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } }
    const msgs: Msg[] = [
      userMsg,
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: {} }], native },
      { role: 'tool', results: [{ id: 'c1', name: 'get_weather', content: '晴' }] },
    ]
    const res = await chat(params({ type: 'openai', baseUrl: srv.url, apiKey: 'k' }, { vision: false }, msgs))
    const body = srv.requests[0].body
    assert.equal(body.messages[1].content[1].text, '[图片]', 'images dropped for non-vision models')
    assert.equal(body.messages[2].reasoning_content, 'r')
    assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'c1', content: '晴' })
    assert.equal(res.text, '晴天')
    assert.equal(res.reasoning, 'hmm')
  })

  it('rotates keys on 401 and retries 429', async () => {
    const srv = await mockServer((req, n) =>
      n === 1 ? [401, { error: { message: 'bad key' } }] : n === 2 ? [429, { error: { message: 'slow down' } }] : [200, { choices: [{ message: { content: 'ok' } }] }],
    )
    after(srv.close)
    const res = await chat(params({ type: 'openai', baseUrl: srv.url, apiKey: ['bad', 'good'], maxRetries: 2 }, {}, [userMsg]))
    assert.equal(res.text, 'ok')
    assert.equal(srv.requests[0].headers.authorization, 'Bearer bad')
    assert.equal(srv.requests[1].headers.authorization, 'Bearer good')
  })
})

describe('anthropic messages', () => {
  it('uses at most four explicit cache points and preserves stable prefixes with Haiku', async () => {
    const srv = await mockServer((_request, index) => [200, {
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      usage: index === 1 ? { input_tokens: 10, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 0 } }
        : { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 600, cache_creation_input_tokens: 50 },
    }])
    after(srv.close)
    const provider: ProviderConfig = { type: 'anthropic', baseUrl: srv.url, apiKey: 'test-key', cacheTtl: '5m' }
    const firstMessages: Msg[] = [userMsg, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', args: {} }] }, { role: 'tool', results: [{ id: 'c1', name: 'get_weather', content: 'sunny' }] }]
    const first = await chat(params(provider, { model: 'claude-haiku-5-5', topP: 0.8 }, firstMessages, { thinking: 'off', temperature: 0.3 }))
    const extended: Msg[] = [...firstMessages, { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'get_weather', args: {} }] }, { role: 'tool', results: [{ id: 'c2', name: 'get_weather', content: 'cloudy' }] }]
    const second = await chat(params(provider, { model: 'claude-haiku-5-5' }, extended, { thinking: 'off' }))
    const before = srv.requests[0].body
    const nextBody = srv.requests[1].body
    const withoutMarkers = value => JSON.parse(JSON.stringify(value, (key, entry) => key === 'cache_control' ? undefined : entry))
    assert.deepEqual(nextBody.tools, before.tools)
    assert.deepEqual(nextBody.system, before.system)
    assert.deepEqual(withoutMarkers(nextBody.messages.slice(0, 3)), withoutMarkers(before.messages))
    assert.equal(JSON.stringify(nextBody).match(/"cache_control"/g)?.length, 4)
    assert.deepEqual(nextBody.tools.at(-1).cache_control, { type: 'ephemeral' })
    assert.equal(before.temperature, undefined)
    assert.equal(before.top_p, undefined)
    assert.equal(before.thinking, undefined)
    assert.equal(first.usage.cacheWrite, 600)
    assert.equal(second.usage.cacheRead, 600)
    assert.equal(second.usage.input, 20)
  })

  it('reports one-hour cache writes separately from five-minute writes', async () => {
    const srv = await mockServer(() => [200, { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 700 } } }])
    after(srv.close)
    const result = await chat(params({ type: 'anthropic', baseUrl: srv.url, apiKey: 'test-key', cacheTtl: '1h' }, { model: 'claude-haiku-4-5' }, [userMsg], { thinking: 'off' }))
    assert.deepEqual(srv.requests[0].body.tools.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(result.usage.cacheWrite, 200)
    assert.equal(result.usage.cacheWrite1h, 700)
    assert.equal(result.usage.input, 3)
  })

  it('sets cache breakpoints, adaptive thinking and parses usage', async () => {
    const srv = await mockServer(() => [
      200,
      {
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '我查一下' },
          { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: '北京' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
          server_tool_use: { web_search_requests: 1 },
        },
      },
    ])
    after(srv.close)
    const res = await chat(params({ type: 'anthropic', baseUrl: srv.url, apiKey: 'ak' }, { model: 'claude-sonnet-5-5' }, [userMsg], { nativeSearch: true }))
    const req = srv.requests[0]
    assert.equal(req.url, '/v1/messages')
    assert.equal(req.headers['x-api-key'], 'ak')
    assert.equal(req.headers['anthropic-version'], '2023-06-01')
    assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' })
    const lastBlock = req.body.messages.at(-1).content.at(-1)
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' }, 'breakpoint on last user block')
    assert.equal(req.body.messages[0].content[1].source.type, 'base64')
    assert.deepEqual(req.body.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(req.body.output_config, { effort: 'low' })
    assert.equal(req.body.temperature, undefined)
    assert.equal(req.body.tools.at(-1).type, 'web_search_20260209')
    assert.equal(req.body.tools[0].input_schema.type, 'object')
    assert.equal(res.text, '我查一下')
    assert.deepEqual(res.toolCalls, [{ id: 'tu1', name: 'get_weather', args: { city: '北京' } }])
    assert.deepEqual(
      { input: res.usage.input, cacheRead: res.usage.cacheRead, cacheWrite: res.usage.cacheWrite, search: res.usage.webSearches },
      { input: 10, cacheRead: 3000, cacheWrite: 500, search: 1 },
    )
  })

  it('replays native blocks (with signatures) and merges tool results into a user turn', async () => {
    const srv = await mockServer(() => [200, { content: [{ type: 'text', text: '北京晴' }], stop_reason: 'end_turn', usage: {} }])
    after(srv.close)
    const native = { provider: 'anthropic' as const, model: 'claude-x', data: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu1', name: 'get_weather', input: {} }] }
    const msgs: Msg[] = [
      userMsg,
      { role: 'assistant', content: '', toolCalls: [{ id: 'tu1', name: 'get_weather', args: {} }], native },
      { role: 'tool', results: [{ id: 'tu1', name: 'get_weather', content: '晴' }] },
    ]
    await chat(params({ type: 'anthropic', baseUrl: `${srv.url}/v1`, apiKey: 'ak', authStyle: 'bearer', cacheTtl: '1h' }, { model: 'claude-x' }, msgs, { thinking: 'off' }))
    const req = srv.requests[0]
    assert.equal(req.url, '/v1/messages')
    assert.equal(req.headers.authorization, 'Bearer ak')
    assert.equal(req.body.messages[1].content[0].signature, 'sig')
    assert.equal(req.body.messages[2].content[0].type, 'tool_result')
    assert.deepEqual(req.body.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.equal(req.body.thinking, undefined)
  })
})

describe('openai responses', () => {
  it('maps input items and output items', async () => {
    const srv = await mockServer(() => [
      200,
      {
        id: 'resp_1',
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          { type: 'function_call', call_id: 'fc1', name: 'get_weather', arguments: '{"city":"杭州"}' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
        ],
        usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 40 } },
      },
    ])
    after(srv.close)
    const res = await chat(params({ type: 'openai-responses', baseUrl: srv.url, apiKey: 'k' }, {}, [userMsg], { nativeSearch: true, cacheKey: 'ck' }))
    const b = srv.requests[0].body
    assert.equal(srv.requests[0].url, '/responses')
    assert.equal(b.instructions, 'SYS')
    assert.equal(b.input[0].content[0].type, 'input_text')
    assert.equal(b.input[0].content[1].type, 'input_image')
    assert.equal(b.store, false)
    assert.deepEqual(b.include, ['reasoning.encrypted_content'])
    assert.deepEqual(b.reasoning, { effort: 'low', summary: 'auto' })
    assert.ok(b.tools.some((t: any) => t.type === 'web_search'))
    assert.equal(b.tools[0].name, 'get_weather')
    assert.equal(res.text, '好的')
    assert.deepEqual(res.toolCalls[0], { id: 'fc1', name: 'get_weather', args: { city: '杭州' } })
    assert.equal(res.usage.webSearches, 1)
    assert.equal(res.usage.input, 500)
    assert.equal(res.responseId, undefined, 'no server state when store=false')
  })
})

describe('gemini interactions', () => {
  it('uses the same model/provider/storage decision in the adapter and chat loop', async () => {
    const srv = await mockServer(() => [200, { id: 'next', status: 'completed', steps: [], usage: {} }])
    after(srv.close)
    const messages: Msg[] = [userMsg, { role: 'assistant', content: 'old' }, { role: 'user', content: [{ type: 'text', text: 'new' }] }]
    const cases: { provider?: Partial<ProviderConfig>; model?: Partial<ModelConfig>; store?: boolean; enabled: boolean }[] = [
      { enabled: true },
      { provider: { serverState: false }, enabled: false },
      { provider: { serverState: false }, model: { serverState: true }, enabled: true },
      { provider: { serverState: true }, model: { serverState: false }, enabled: false },
      { provider: { store: false }, model: { serverState: true }, enabled: false },
      { provider: { store: false }, store: true, enabled: true },
      { store: false, enabled: false },
      { model: { extraBody: { store: false } }, enabled: false },
      { model: { extraBody: { store: true, previous_interaction_id: 'unsafe-partial' } }, store: false, enabled: false },
      { model: { serverState: false, extraBody: { store: true } }, enabled: false },
    ]
    for (const c of cases) {
      const p = params({ type: 'gemini', baseUrl: srv.url, apiKey: 'test', ...c.provider }, c.model ?? {}, messages, { store: c.store, state: { previousId: 'old', skip: 2 } })
      assert.equal(usesServerState(p.provider, p.model, p.store), c.enabled)
      const result = await chat(p)
      const body = srv.requests.at(-1)!.body
      assert.equal(body.store, c.enabled)
      assert.equal(body.previous_interaction_id, c.enabled ? 'old' : undefined)
      assert.equal(body.input.length, c.enabled ? 1 : 3)
      assert.equal(result.responseId, c.enabled ? 'next' : undefined)
      assert.equal(result.usage.inputIncomplete, c.enabled ? true : undefined)
      assert.equal(body.system_instruction, 'SYS')
      assert.equal(body.tools[0].name, 'get_weather')
      assert.equal(body.generation_config.thinking_level, 'low')
    }
  })

  it('retains incomplete input metadata when aggregating subsequent tool calls', () => {
    const partial = { ...emptyUsage(), input: 97, inputIncomplete: true }
    assert.equal(addUsage(emptyUsage(), partial).inputIncomplete, true)
    assert.equal(addUsage(partial, emptyUsage()).inputIncomplete, true)
    assert.equal(addUsage(emptyUsage(), emptyUsage()).inputIncomplete, undefined)
  })

  it('sends steps, parses function_call and usage', async () => {
    const srv = await mockServer(() => [
      200,
      {
        id: 'int_1',
        status: 'requires_action',
        steps: [
          { type: 'thought', signature: 'c2ln' },
          { type: 'function_call', id: 'g1', name: 'get_weather', arguments: { city: '广州' } },
        ],
        usage: { total_input_tokens: 1200, total_cached_tokens: 1000, total_output_tokens: 30, total_thought_tokens: 70, total_tool_use_tokens: 0 },
      },
    ])
    after(srv.close)
    const res = await chat(params({ type: 'gemini', baseUrl: srv.url, apiKey: 'gk' }, {}, [userMsg]))
    const req = srv.requests[0]
    assert.equal(req.url, '/v1beta/interactions')
    assert.equal(req.headers['x-goog-api-key'], 'gk')
    assert.equal(req.body.system_instruction, 'SYS')
    assert.equal(req.body.input[0].type, 'user_input')
    assert.deepEqual(req.body.input[0].content[1], { type: 'image', data: 'AAAA', mime_type: 'image/png' })
    assert.equal(req.body.generation_config.thinking_level, 'low')
    assert.equal(req.body.tools[0].type, 'function')
    assert.equal(req.body.store, true)
    assert.deepEqual(res.toolCalls, [{ id: 'g1', name: 'get_weather', args: { city: '广州' } }])
    assert.equal(res.usage.input, 200)
    assert.equal(res.usage.cacheRead, 1000)
    assert.equal(res.usage.output, 100)
    assert.equal(res.responseId, 'int_1')
  })

  it('with server state only sends new steps + previous_interaction_id', async () => {
    const srv = await mockServer(() => [200, { id: 'int_2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '广州多云' }] }], usage: {} }])
    after(srv.close)
    const msgs: Msg[] = [
      userMsg,
      { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'get_weather', args: {} }] },
      { role: 'tool', results: [{ id: 'g1', name: 'get_weather', content: '多云' }] },
    ]
    const res = await chat(params({ type: 'gemini', baseUrl: srv.url, apiKey: 'gk' }, {}, msgs, { state: { previousId: 'int_1', skip: 2 } }))
    const b = srv.requests[0].body
    assert.equal(b.previous_interaction_id, 'int_1')
    assert.deepEqual(b.input, [{ type: 'function_result', call_id: 'g1', name: 'get_weather', result: '多云' }])
    assert.equal(b.system_instruction, 'SYS', 'system instructions must be resent on tool-result continuations')
    assert.equal(b.tools[0].name, 'get_weather', 'tool schemas are interaction-scoped')
    assert.equal(b.generation_config.thinking_level, 'low')
    assert.equal(res.usage.inputIncomplete, true)
    assert.equal(res.text, '广州多云')
  })

  it('a model with serverState: false resends the whole transcript and stores nothing', async () => {
    const srv = await mockServer(() => [200, { id: 'int_3', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }], usage: {} }])
    after(srv.close)
    const msgs: Msg[] = [userMsg, { role: 'assistant', content: '之前的回复' }, { role: 'user', content: [{ type: 'text', text: '新问题' }] }]
    const res = await chat(params({ type: 'gemini', baseUrl: srv.url, apiKey: 'gk' }, { serverState: false }, msgs, { state: { previousId: 'int_1', skip: 2 } }))
    const b = srv.requests[0].body
    assert.equal(b.previous_interaction_id, undefined)
    assert.equal(b.store, false)
    assert.equal(b.input.length, 3)
    assert.equal(res.responseId, undefined)
  })

  it('throws on failed interactions', async () => {
    const srv = await mockServer(() => [200, { id: 'x', status: 'failed', errors: [{ code: 'safety', message: 'blocked' }] }])
    after(srv.close)
    await assert.rejects(chat(params({ type: 'gemini', baseUrl: srv.url, apiKey: 'gk' }, {}, [userMsg])), /blocked/)
  })
})

describe('tool result images', () => {
  const img = { type: 'image' as const, data: 'QUJD', mime: 'image/png', detail: 'auto' as const }
  const toolMsgs: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: '看看这张图' }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'web_fetch', args: {} }, { id: 't2', name: 'get_weather', args: {} }] },
    { role: 'tool', results: [{ id: 't1', name: 'web_fetch', content: '已打开图片', images: [img] }, { id: 't2', name: 'get_weather', content: '晴' }] },
  ]
  const ok = { openai: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} },
    anthropic: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} },
    'openai-responses': { id: 'r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: {} },
    gemini: { id: 'i', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }], usage: {} } }
  async function send(type: keyof typeof ok, vision = true) {
    const srv = await mockServer(() => [200, ok[type]])
    after(srv.close)
    await chat(params({ type, baseUrl: srv.url, apiKey: 'k' }, { vision, serverState: false }, toolMsgs, { thinking: 'off' }))
    return srv.requests[0].body
  }

  it('anthropic puts the images inside the matching tool_result', async () => {
    const results = (await send('anthropic')).messages[2].content
    assert.deepEqual(results[0].content, [{ type: 'text', text: '已打开图片' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }])
    assert.equal(results[1].content, '晴')
  })

  it('openai chat follows the tool messages with a labelled user image message', async () => {
    const m = (await send('openai')).messages
    assert.deepEqual(m.slice(3, 5).map((x: any) => [x.role, x.content]), [['tool', '已打开图片'], ['tool', '晴']])
    assert.deepEqual(m[5], { role: 'user', content: [{ type: 'text', text: '【工具 web_fetch 返回的图片】' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD', detail: 'auto' } }] })
  })

  it('openai responses and gemini add the images as a user input after the results', async () => {
    const r = (await send('openai-responses')).input
    assert.equal(r.at(-2).type, 'function_call_output')
    assert.deepEqual(r.at(-1).content[1], { type: 'input_image', image_url: 'data:image/png;base64,QUJD', detail: 'auto' })
    const g = (await send('gemini')).input
    assert.equal(g.at(-2).type, 'function_result')
    assert.deepEqual(g.at(-1), { type: 'user_input', content: [{ type: 'text', text: '【工具 web_fetch 返回的图片】' }, { type: 'image', data: 'QUJD', mime_type: 'image/png' }] })
  })

  it('drops tool images for models without vision', async () => {
    assert.equal((await send('anthropic', false)).messages[2].content[0].content, '已打开图片')
    assert.equal((await send('openai', false)).messages.length, 5)
    assert.equal((await send('openai-responses', false)).input.at(-1).type, 'function_call_output')
    assert.equal((await send('gemini', false)).input.at(-1).type, 'function_result')
  })
})
