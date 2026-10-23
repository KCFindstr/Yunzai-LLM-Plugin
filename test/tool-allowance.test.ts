import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config, normalize } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'
import { registerWebTools } from '../src/tools/web.ts'

function context(maxCalls: number, maxFetches: number): ToolCtx {
  return { e: {}, eff: normalize({ chat: { maxToolCalls: maxCalls }, tools: { webFetch: { enable: true, reader: 'direct', allowPrivateNetwork: true, maxPerTurn: maxFetches } } }) as any,
    isAdmin: true, model: { id: 'test', model: 'test', provider: 'test' }, turn: { images: [], commands: 0, searches: 0, fetches: 0 } }
}

it('reserves individual global calls across parallel batches and reports final tool/global allowances consistently', async () => {
  const server = await mockServer(() => [200, { text: '内容' }])
  registerWebTools()
  try {
    const ctx = context(2, 3)
    const result = await registry.execute([1, 2, 3].map(id => ({ id: String(id), name: 'web_fetch', args: { url: server.url } })), ctx, [registry.get('web_fetch')!])
    assert.equal(server.requests.length, 2)
    assert.equal(ctx.turn.toolCalls, 2); assert.equal(ctx.turn.fetches, 2)
    assert.ok(result.results.every(result => result.remaining === '剩余 1 次' && result.globalRemaining === 0))
    assert.equal(result.results[2].isError, true)
    await registry.execute([{ id: 'again', name: 'web_fetch', args: { url: server.url } }], ctx, [registry.get('web_fetch')!])
    assert.equal(server.requests.length, 2)
    const ownLimit = context(5, 1)
    const own = await registry.execute([1, 2].map(id => ({ id: String(id), name: 'web_fetch', args: { url: server.url } })), ownLimit, [registry.get('web_fetch')!])
    assert.ok(own.results.every(result => result.remaining === '剩余 0 次' && result.globalRemaining === 3))
    assert.equal(own.results.filter(result => result.isError).length, 1)
    assert.ok(!registry.forTurn(context(0, 3)).length)
  } finally { await server.close() }
})

it('counts failed/unavailable/malformed attempts globally without inventing per-tool consumption', async () => {
  registerWebTools()
  const ctx = context(3, 3)
  const results = (await registry.execute([
    { id: 'invalid', name: 'web_fetch', args: { _invalid_json: true } },
    { id: 'unknown', name: 'unknown', args: {} },
    { id: 'missing', name: 'web_fetch', args: {} },
  ], ctx, [registry.get('web_fetch')!])).results
  assert.equal(ctx.turn.toolCalls, 3); assert.equal(ctx.turn.fetches, 0)
  assert.ok(results.every(result => result.isError && result.globalRemaining === 0))
  assert.equal(results[0].remaining, '剩余 3 次')
  assert.equal(results[1].remaining, '不可用')
})

it('includes both allowances on every model-visible tool result and requests a final answer at zero global calls', async () => {
  const server = await mockServer((_req, n) => [200, { choices: [{ message: n === 1 ? { content: '', tool_calls: [1, 2].map(id => ({ id: String(id), type: 'function', function: { name: 'budget_probe', arguments: '{}' } })) } : { content: '已完成' }, finish_reason: n === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, maxToolRounds: 3, maxToolCalls: 1 }\nmemory: { enable: false }\n`)
  config.load()
  let executed = 0
  registry.register({ name: 'budget_probe', description: 'test', parameters: {}, remaining: () => `剩余 ${3 - executed} 次`, run: async () => { executed++; return '完成' } })
  try {
    const result = await runTurn({ e: fakeEvent().e, eff: config.effective(), input: { text: '检查额度', images: [], imageSegments: [] }, isAdmin: true, convKey: 'budget-test' })
    assert.equal(result.kind, 'reply'); assert.equal(executed, 1)
    const messages = server.requests[1].body.messages.filter(message => message.role === 'tool')
    assert.equal(messages.length, 2)
    for (const message of messages) assert.match(message.content, /【工具余量】budget_probe：剩余 2 次；全局剩余 0 次；剩余工具轮次 2，请直接给出最终回复/)
  } finally { await server.close(); registry.unregisterWhere(tool => tool.name === 'budget_probe') }
})
