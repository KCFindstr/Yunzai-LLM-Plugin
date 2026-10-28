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
    assert.ok(registry.forTurn(context(0, 3)).every(tool => tool.budgetExempt))
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
    for (const message of messages) assert.match(message.content, /【工具余量】budget_probe：剩余 2 次；全局剩余 0 次（辅助工具不占）；剩余工具轮次 2，此后仅可调用辅助工具/)
  } finally { await server.close(); registry.unregisterWhere(tool => tool.name === 'budget_probe') }
})


it('exempts mixed-batch helpers from global calls while reserving ordinary calls, and caps each helper', async () => {
  let ordinary = 0, cheap = 0
  registry.register({ name: 'ordinary_probe', description: 'test', parameters: {}, run: async () => { ordinary++; return 'ok' } })
  registry.register({ name: 'cheap_probe', budgetExempt: true, description: 'test', parameters: {}, run: async () => { cheap++; return 'ok' } })
  const ctx = context(1, 1)
  ctx.eff.tools.enable = true
  const offered = [registry.get('ordinary_probe')!, registry.get('cheap_probe')!]
  try {
    await registry.execute(['cheap_probe', 'ordinary_probe', 'ordinary_probe', 'cheap_probe'].map((name, i) => ({ id: String(i), name, args: {} })), ctx, offered)
    assert.equal(ordinary, 1); assert.equal(cheap, 2)
    assert.equal(ctx.turn.toolCalls, 1); assert.equal(ctx.turn.helperCalls?.cheap_probe, 2)
    await registry.execute(Array.from({ length: 35 }, (_, i) => ({ id: String(i), name: 'cheap_probe', args: {} })), ctx, offered)
    assert.equal(cheap, 32); assert.equal(ctx.turn.toolCalls, 1)
    ctx.eff.chat.maxToolCalls = 0
    assert.ok(registry.forTurn(ctx).some(tool => tool.name === 'cheap_probe'))
    assert.ok(!registry.forTurn(ctx).some(tool => tool.name === 'ordinary_probe'))
  } finally { registry.unregisterWhere(tool => ['ordinary_probe', 'cheap_probe'].includes(tool.name)) }
})


it('enforces configured helper caps before parallel work, including malformed and failed calls', async () => {
  const original = registry.get('read_file')
  let executed = 0
  registry.register({ name: 'read_file', budgetExempt: true, description: 'test', parameters: {}, run: async () => { executed++; throw Error('failed read') } })
  const ctx = context(0, 1)
  ctx.eff.tools.enable = true
  ctx.eff.tools.readFile.maxPerTurn = 2
  ctx.eff.tools.loadSkill.maxPerTurn = 0
  const def = registry.get('read_file')!
  try {
    assert.match(registry.specs([def], ctx)[0].description, /每次回复最多调用 2 次/)
    const { results } = await registry.execute([
      { id: 'invalid', name: 'read_file', args: { _invalid_json: true } },
      { id: 'failed', name: 'read_file', args: {} },
      { id: 'blocked', name: 'read_file', args: {} },
    ], ctx, [def])
    assert.equal(executed, 1)
    assert.equal(ctx.turn.helperCalls?.read_file, 2)
    assert.equal(ctx.turn.toolCalls ?? 0, 0)
    assert.ok(results.every(result => result.isError && result.remaining === '剩余 0 次' && result.globalRemaining === 0))
    const repeated = await registry.execute([{ id: 'not-offered', name: 'read_file', args: {} }], ctx, [])
    assert.equal(repeated.results[0].remaining, '剩余 0 次')
    assert.equal(ctx.turn.toolCalls ?? 0, 0, 'an exhausted helper never consumes the ordinary quota')
    ctx.eff.tools.readFile.maxPerTurn = 0
    assert.ok(!registry.forTurn(ctx).some(tool => tool.name === 'read_file'))
    const normalized = normalize({ tools: { sendImage: { maxPerTurn: 5 }, readFile: { maxPerTurn: -2 }, loadSkill: { maxPerTurn: 100 }, listStickers: { maxPerTurn: 'invalid' } } })
    assert.deepEqual([normalized.tools.sendImage.maxPerTurn, normalized.tools.readFile.maxPerTurn, normalized.tools.loadSkill.maxPerTurn, normalized.tools.listStickers.maxPerTurn], [5, 0, 32, 4])
  } finally { registry.unregisterWhere(tool => tool.name === 'read_file'); if (original) registry.register(original) }
})


it('keeps one tool list for the whole reply and counts helper-only rounds toward maxToolRounds', async () => {
  const toolCall = (name: string) => ({ id: name + Math.random(), type: 'function', function: { name, arguments: '{}' } })
  const lists: string[] = []
  let helper = 0, ordinary = 0, script: (n: number) => any
  const server = await mockServer((request, n) => {
    lists.push(JSON.stringify(request.body.tools.map((tool: any) => tool.function.name)))
    const message = script(n)
    return [200, { choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }]
  })
  writeUserConfig(`providers:
  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: fake }
defaultModel: main
fallbackModels: []
chat: { thinking: off, summarize: false, maxToolRounds: 2, maxToolCalls: 1 }
memory: { enable: false }
`)
  config.load()
  registry.register({ name: 'helper_probe', budgetExempt: true, description: 'test', parameters: {}, run: async () => { helper++; return 'ok' } })
  registry.register({ name: 'ordinary_probe', description: 'test', parameters: {}, run: async () => { ordinary++; return 'ok' } })
  const turn = (convKey: string) => runTurn({ e: fakeEvent().e, eff: config.effective(), input: { text: '测试', images: [], imageSegments: [] }, isAdmin: true, convKey })
  try {
    // Round 1: helper only. Round 2: the ordinary budget runs out mid-batch. Then only the final answer is left.
    script = n => n === 1 ? { content: '', tool_calls: [toolCall('helper_probe')] }
      : n === 2 ? { content: '', tool_calls: [toolCall('ordinary_probe'), toolCall('ordinary_probe'), toolCall('helper_probe')] }
      : { content: '完成' }
    const first = await turn('rounds-a')
    assert.equal(first.kind, 'reply'); assert.equal(server.requests.length, 3)
    assert.equal(ordinary, 1); assert.equal(helper, 2)
    assert.equal(new Set(lists).size, 1, 'the offered tools never change between rounds')
    const results = server.requests[2].body.messages.filter((message: any) => message.role === 'tool')
    assert.match(results[0].content, /剩余工具轮次 1/)
    assert.ok(results.slice(1).every((message: any) => /剩余工具轮次 0，请直接给出最终回复/.test(message.content)))
    assert.match(results[2].content, /普通工具的全局调用次数已用完/)
    // A model that keeps calling helpers is stopped by the round limit, not by a hidden helper cap.
    helper = 0; server.requests.length = 0
    script = () => ({ content: '', tool_calls: [toolCall('helper_probe')] })
    await turn('rounds-b')
    assert.equal(server.requests.length, 3); assert.equal(helper, 2)
  } finally { await server.close(); registry.unregisterWhere(tool => ['helper_probe', 'ordinary_probe'].includes(tool.name)) }
})
