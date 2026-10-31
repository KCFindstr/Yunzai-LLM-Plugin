import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { completeAgyJob } from '../src/tools/agy.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'
import { sessionKey } from '../src/chat/session.ts'

for (const protocol of ['openai', 'openai-responses'] as const) it(`reuses the initiating session request/cache prefix for ${protocol} completion`, async () => {
  let captured: ToolCtx | undefined, sideEffects = 0
  const image = Buffer.from('89504e470d0a1a0a01020000', 'hex')
  registry.register({ name: 'cache_capture', description: 'Capture a worker request', parameters: {}, run: async (_args, ctx) => { captured = ctx; return 'accepted' } })
  registry.register({ name: 'cache_side_effect', description: 'Must not run from worker data', parameters: {}, run: async () => { sideEffects++; return 'bad' } })
  registry.register({ name: 'send_image', description: 'Send an output image', parameters: { type: 'object', properties: { path: { type: 'string' } } }, budgetExempt: true,
    run: async (_args, ctx) => { ctx.turn.images.push(image); return 'selected' } })
  // the auto-thinking judge is a System One model on the same mock server; its calls are not chat requests
  let chatN = 0
  const server = await mockServer(request => {
    if (request.url === '/v1/systemone') return [200, { model: 'jev', answers: { answer: { choice: 'complex' } } }]
    const n = ++chatN
    const calls = n === 1 ? [{ name: 'cache_capture', args: {} }] : n === 3
      ? [{ name: 'cache_side_effect', args: {} }, { name: 'send_image', args: { path: '/work/agy/aabbccddee/out/result.png' } }] : []
    const text = n === 2 ? 'Working on it' : n === 4 ? 'Here is the result' : ''
    if (protocol === 'openai-responses') return [200, { id: `response-${n}`, output: calls.length
      ? calls.map((call, i) => ({ type: 'function_call', call_id: `call-${n}-${i}`, name: call.name, arguments: JSON.stringify(call.args) }))
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 10 } }]
    return [200, { choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((call, i) => ({ id: `call-${n}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }]
  })
  try {
    writeUserConfig(`providers:\n  mock: { type: ${protocol}, baseUrl: '${server.url}', apiKey: original-key, promptCacheKey: true, serverState: ${protocol === 'openai-responses'}, maxRetries: 0 }\n  judge: { type: systemone, baseUrl: '${server.url}/v1' }\nmodels:\n  - { id: main, provider: mock, model: original-model, thinking: auto, temperature: 0.3, maxTokens: 2345 }\ndefaultModel: main\nfallbackModels: []\nsystemoneModels:\n  - { id: jevmock, provider: judge, model: jev }\nautoThinking: { judge: jevmock, levels: { casual: low, question: medium, complex: high } }\nchat:\n  summarize: false\nmemory: { enable: false }\nsticker: { enable: false }\ntools:\n  webSearch: { enable: false }\n`)
    config.load()
    const e = fakeEvent().e, eff = config.effective(), convKey = sessionKey(e, eff.chat.sessionScope)
    const first = await runTurn({ e, eff, convKey, isAdmin: true, input: { text: 'hello there', images: [], imageSegments: [] } })
    assert.equal(first.kind, 'reply')
    assert.ok(captured?.turn.sessionConfig)
    // A configuration reload must not silently change the worker's original reply configuration.
    config.set('models.0.model', 'changed-model')
    config.set('models.0.thinking', 'off')
    config.set('providers.mock.apiKey', 'changed-key')
    registry.register({ ...registry.get('cache_capture')!, description: 'Changed after the initiating request' })
    let delivered = false
    await completeAgyJob({ id: 'aabbccddee', rolloutId: first.rolloutId, owner: '', task: 'original request', status: 'completed', createdAt: 0, updatedAt: 0 },
      { report: '分析复杂任务完成。'.repeat(20) + '\n/work/agy/aabbccddee/out/result.png' }, captured!, {
        runTurn: request => { assert.equal(request.eff, eff); assert.equal(request.sessionConfig, captured!.turn.sessionConfig); return runTurn(request) },
        deliver: async (_event, text, _eff, opts) => { delivered = true; assert.equal(text, 'Here is the result'); assert.deepEqual(opts.images, [image]) },
      })
    assert.ok(delivered)
    assert.equal(sideEffects, 1, 'worker completion can invoke tools')
    const chats = server.requests.filter(request => request.url !== '/v1/systemone')
    assert.equal(chats.length, 4)
    assert.equal(server.requests.length - chats.length, 1, 'completion reuses resolved thinking instead of invoking another judge')
    const original = chats[1].body, completion = chats[2].body
    assert.deepEqual(completion.tools, original.tools)
    assert.equal(completion.prompt_cache_key, original.prompt_cache_key)
    assert.equal(completion.model, 'original-model')
    assert.equal(chats[2].headers.authorization, 'Bearer original-key')
    assert.equal(completion.temperature, original.temperature)
    if (protocol === 'openai-responses') {
      assert.equal(completion.instructions, original.instructions)
      assert.deepEqual(completion.reasoning, original.reasoning)
      assert.equal(completion.max_output_tokens, original.max_output_tokens)
      assert.equal(completion.previous_response_id, 'response-2', 'a callback in the original rollout may continue its chain')
      assert.equal(completion.input.length, 1)
    } else {
      assert.deepEqual(completion.messages[0], original.messages[0])
      assert.equal(completion.reasoning_effort, original.reasoning_effort)
      assert.equal(completion.max_tokens, original.max_tokens)
      assert.ok(completion.messages.some((message: any) => message.content === 'Working on it'))
    }
  } finally {
    registry.unregisterWhere(tool => ['cache_capture', 'cache_side_effect', 'send_image'].includes(tool.name))
    await server.close()
  }
})
