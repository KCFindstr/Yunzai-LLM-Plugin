import { TMP, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { flushAllStores } from '../src/core/store.ts'
import { runTurn } from '../src/chat/agent.ts'
import { recentRollouts, recordRolloutContext, recordRolloutEvent, rolloutHistory, startRollout, updateRollout } from '../src/chat/rollouts.ts'
import { recentTurns } from '../src/chat/turnLog.ts'
import { registry } from '../src/tools/registry.ts'
import { peekSession } from '../src/chat/session.ts'

it('records each live model round and parallel tool result, then persists a filtered rollout and linked turn', async () => {
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const slowStarted = new Promise<void>(resolve => { started = resolve })
  const secret = 'rollout-test-secret'
  const server = await mockServer((_req, n) => n > 2 ? [500, { error: { message: 'model failed' } }] : [200, {
    choices: [{ message: n === 1 ? { content: '正在检查', reasoning_content: `先检查工具结果 ${secret} alice@example.com`, tool_calls: [
      { id: 'quick-call', type: 'function', function: { name: 'rollout_quick', arguments: JSON.stringify({ password: secret, query: '公开查询' }) } },
      { id: 'slow-call', type: 'function', function: { name: 'rollout_slow', arguments: '{}' } },
      { id: 'bad-call', type: 'function', function: { name: 'not_offered', arguments: '{}' } },
      { id: 'json-call', type: 'function', function: { name: 'rollout_quick', arguments: '{bad' } },
    ] } : { content: '检查完成' }, finish_reason: n === 1 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } },
  }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: ${secret}, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, pricing: { input: 1, output: 2 } }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false }\nmemory: { enable: false }\ntools: { webSearch: { enable: false } }\n`)
  config.load()
  registry.register({ name: 'rollout_quick', description: 'quick', parameters: {}, run: async () => ({
    content: `quick result ${secret} alice@example.com`,
    images: [{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', mime: 'image/png' }],
  }) })
  registry.register({ name: 'rollout_slow', description: 'slow', parameters: {}, run: async () => { started(); await gate; return 'slow result' } })
  const req = { e: fakeEvent().e, eff: config.effective(), input: { text: '检查一下', images: [], imageSegments: [] }, isAdmin: true, convKey: 'test:g30001' }
  let pending: ReturnType<typeof runTurn> | undefined
  try {
    pending = runTurn(req)
    await slowStarted
    await new Promise(resolve => setImmediate(resolve))
    const live = recentRollouts()[0]
    assert.equal(live.status, 'running')
    const events = rolloutHistory(live.id)!.events
    assert.ok(events.some(event => event.kind === 'response' && event.text === '正在检查'))
    assert.ok(events.some(event => event.kind === 'response' && event.reasoning?.includes('先检查工具结果') && event.reasoningTokens === 10))
    assert.ok(events.some(event => event.callId === 'quick-call' && event.phase === 'completed'))
    assert.ok(!events.some(event => event.callId === 'slow-call' && event.phase === 'completed'))
    assert.equal(events.filter(event => event.phase === 'completed' && event.isError).length, 2)
    release()
    const reply = await pending
    assert.equal(reply.kind, 'reply')
    if (reply.kind === 'reply') assert.equal(reply.text, '正在检查\n检查完成')
    const stored = peekSession(req.convKey)!.messages.at(-1)!
    assert.equal(stored.role === 'assistant' ? stored.content : undefined, '正在检查\n检查完成')
    assert.equal(recentTurns()[0].reply, '正在检查\n检查完成')
    const done = rolloutHistory(live.id)!
    assert.equal(done.status, 'completed')
    assert.equal(done.steps, 2)
    assert.equal(done.reply, '正在检查\n检查完成')
    assert.ok(done.context!.tools.some(tool => tool.name === 'rollout_quick'))
    assert.ok(!done.context!.tools.some(tool => tool.name === 'not_offered'))
    assert.ok(done.context!.messages.at(-1)!.text.includes('检查一下'))
    assert.ok(done.context!.system)
    assert.equal((recentRollouts()[0] as any).context, undefined)
    assert.equal(done.thinking, 'off')
    assert.equal(done.thinkingDecision?.source, 'fixed')
    assert.ok(done.events.filter(event => event.kind === 'response').every(event => event.thinking === 'off'))
    assert.equal(done.tokens?.input, 240)
    assert.ok(done.cost > 0)
    assert.equal(done.events.filter(event => event.kind === 'response').length, 2)
    assert.equal(done.events.find(event => event.callId === 'quick-call' && event.phase === 'completed')?.images?.length, 1)
    assert.equal(recentTurns()[0].rolloutId, live.id)
    assert.equal(recentRollouts('another-conversation').length, 0)
    assert.equal(rolloutHistory('../config'), undefined)
    const failed = await runTurn({ ...req, convKey: 'test:failure' })
    assert.equal(failed.kind, 'error')
    assert.equal(recentRollouts()[0].status, 'failed')
    assert.ok(rolloutHistory(recentRollouts()[0].id)!.events.some(event => event.kind === 'error'))
    flushAllStores()
    const index = fs.readFileSync(path.join(TMP, 'data/rollouts/index.json'), 'utf8')
    const directory = path.join(TMP, 'data/rollouts')
    const persisted = fs.readdirSync(directory).filter(file => file.endsWith('.json'))
      .map(file => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n')
    assert.ok(!('context' in JSON.parse(index).rollouts[0]))
    assert.ok(!('events' in JSON.parse(index).rollouts[0]))
    assert.ok(persisted.includes('先检查工具结果'))
    for (const hidden of [secret, 'alice@example.com']) assert.ok(!persisted.includes(hidden), hidden)
  } finally { release(); await pending; await server.close() }
})

it('bounds and filters request snapshots without persisting image bytes or provider-native data', () => {
  const id = startRollout({ conv: 'context', source: 'chat', input: 'inspect', inputImageCount: 1 })
  recordRolloutContext(id, {
    system: 'secret-password=do-not-display ' + '系统提示'.repeat(10000),
    current: { heading: '当前发言', text: 'current image request', recent: Array.from({ length: 100 }, () => 'password=do-not-display ' + '群聊'.repeat(1000)), roster: ['alice@example.com'], memory: 'apiKey=do-not-display', quote: '引用内容' },
    tools: Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: '工具描述'.repeat(1000), parameters: { description: '参数'.repeat(3000), apiKey: 'do-not-display' } })),
    messages: [
      ...Array.from({ length: 50 }, () => ({ role: 'assistant' as const, content: '历史消息'.repeat(3000), native: { provider: 'openai' as const, model: 'fake', data: { reasoning: 'hidden-native-reasoning' } } })),
      { role: 'user', content: [{ type: 'text', text: 'current image request' }, { type: 'image', data: 'image-byte-payload', mime: 'image/png' }] },
    ], nativeSearch: true,
  })
  const context = rolloutHistory(id)!.context!
  const raw = JSON.stringify(context)
  assert.ok(Buffer.byteLength(raw) <= 128 * 1024)
  assert.equal(context.truncated, true)
  assert.ok(context.omittedMessages > 0)
  assert.equal(context.messages.at(-1)!.imageCount, 1)
  assert.equal(context.messages.at(-1)!.text, 'current image request')
  assert.equal(context.current!.text, 'current image request')
  assert.ok(!context.current!.roster[0].includes('alice@example.com'))
  for (const hidden of ['image-byte-payload', 'hidden-native-reasoning', 'do-not-display']) assert.ok(!raw.includes(hidden), hidden)
  updateRollout(id, { status: 'completed' })
})

it('retains the Jev response and selected level when the main endpoint requires thinking to be disabled', async () => {
  let mainCalls = 0
  const server = await mockServer(req => {
    if (req.url === '/v1/systemone') return [200, {
      model: 'jev-latest', answers: { kind: { choice: 'question', confidence: 0.92, probabilities: { casual: 0.05, question: 0.92, complex: 0.03 } } },
      usage: { input_tokens: 120, output_tokens: 1 }, native: { reasoning: 'hidden-judge-reasoning' },
    }]
    if (++mainCalls === 1) return [400, { error: { message: 'reasoning_effort is unsupported' } }]
    return [200, { choices: [{ message: { content: '已回答' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }]
  })
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-secret, maxRetries: 0 }\nmodels:\n  - { id: thinking-main, provider: mock, model: fake }\ndefaultModel: thinking-main\nfallbackModels: []\nchat:\n  thinking: auto\n  summarize: false\n  autoThinking: { casual: low, question: medium, complex: high }\n  thinkingJudge: { mode: systemone, url: '${server.url}/v1/systemone', systemoneModel: jev-latest }\nmemory: { enable: false }\ntools: { enable: false }\n`)
  config.load()
  try {
    const result = await runTurn({ e: fakeEvent().e, eff: config.effective(), input: { text: '中秋节是几月几号', images: [], imageSegments: [] }, isAdmin: true, convKey: 'test:thinking' })
    assert.equal(result.kind, 'reply')
    const rollout = rolloutHistory(recentRollouts()[0].id)!
    assert.equal(rollout.thinking, 'off')
    assert.equal(rollout.thinkingDecision?.level, 'medium')
    assert.equal(rollout.thinkingDecision?.source, 'systemone')
    assert.equal(JSON.parse(rollout.thinkingDecision!.judge!.response).answers.kind.confidence, 0.92)
    assert.ok(!JSON.stringify(rollout).includes('hidden-judge-reasoning'))
    assert.equal(server.requests.filter(req => req.url === '/v1/systemone').length, 1)
    assert.equal(rollout.events.find(event => event.kind === 'response')?.thinking, 'off')
  } finally { await server.close() }
})

it('bounds history and retention and marks unfinished records interrupted after restart', () => {
  const id = startRollout({ conv: 'bounds', source: 'chat', input: 'bounded test', inputImageCount: 0 })
  for (let i = 0; i < 505; i++) recordRolloutEvent(id, { kind: 'response', text: `step ${i}` })
  assert.equal(rolloutHistory(id)!.events.length, 500)
  assert.equal(rolloutHistory(id)!.dropped, 6)
  recordRolloutEvent(id, { kind: 'tool', text: 'result', args: '数据'.repeat(20000) })
  assert.ok(rolloutHistory(id)!.events.at(-1)!.args!.length <= 12000)
  updateRollout(id, { status: 'completed' })
  for (let i = 0; i < 301; i++) {
    const completed = startRollout({ conv: 'retention', source: 'chat', input: `request ${i}`, inputImageCount: 0 })
    updateRollout(completed, { status: 'completed' })
  }
  assert.ok(recentRollouts().length > 300)
  assert.ok(rolloutHistory(id))
  const running = startRollout({ conv: 'restart', source: 'chat', input: 'pending', inputImageCount: 0 })
  updateRollout(running, { status: 'running' })
  flushAllStores()
  const script = `const { config } = await import('./src/core/config.ts'); config.load(); const { rolloutHistory } = await import('./src/chat/rollouts.ts'); console.log(JSON.stringify(rolloutHistory('${running}')))`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, env: process.env })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout.trim().split('\n').at(-1)!).status, 'interrupted')
})


it('merges multiple tool rounds, ignores empty final text, and retains text when a later request fails', async () => {
  const server = await mockServer((_req, n) => {
    if (n === 5) return [500, { error: { message: 'later round failed' } }]
    const tool = n !== 3
    return [200, { choices: [{ message: { content: n === 3 ? '   ' : `round ${n}`, ...(tool ? {
      tool_calls: [{ id: `call-${n}`, type: 'function', function: { name: 'merge_probe', arguments: '{}' } }],
    } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }]
  })
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false }\nmemory: { enable: false }\n`)
  config.load()
  registry.register({ name: 'merge_probe', description: 'probe', parameters: {}, run: async () => 'tool result' })
  const req = { e: fakeEvent().e, eff: config.effective(), input: { text: 'merge', images: [], imageSegments: [] }, isAdmin: true, convKey: 'merge:empty' }
  try {
    const merged = await runTurn(req)
    assert.equal(merged.kind, 'reply')
    if (merged.kind === 'reply') assert.equal(merged.text, 'round 1\nround 2')
    const stored = peekSession(req.convKey)!.messages.at(-1)!
    assert.equal(stored.role === 'assistant' ? stored.content : undefined, 'round 1\nround 2')
    const partial = await runTurn({ ...req, convKey: 'merge:failure' })
    assert.equal(partial.kind, 'reply')
    if (partial.kind === 'reply') assert.equal(partial.text, 'round 4')
    assert.equal(server.requests.length, 5)
  } finally { await server.close(); registry.unregisterWhere(tool => tool.name === 'merge_probe') }
})
