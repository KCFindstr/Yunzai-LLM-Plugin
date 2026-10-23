import { TMP, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { flushAllStores } from '../src/core/store.ts'
import { runTurn } from '../src/chat/agent.ts'
import { recentRollouts, recordRolloutEvent, rolloutHistory, startRollout, updateRollout } from '../src/chat/rollouts.ts'
import { recentTurns } from '../src/chat/turnLog.ts'
import { registry } from '../src/tools/registry.ts'

it('records each live model round and parallel tool result, then persists a filtered rollout and linked turn', async () => {
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const slowStarted = new Promise<void>(resolve => { started = resolve })
  const secret = 'rollout-test-secret'
  const server = await mockServer((_req, n) => n > 2 ? [500, { error: { message: 'model failed' } }] : [200, {
    choices: [{ message: n === 1 ? { content: '正在检查', reasoning_content: 'provider-private-reasoning', tool_calls: [
      { id: 'quick-call', type: 'function', function: { name: 'rollout_quick', arguments: JSON.stringify({ password: secret, query: '公开查询' }) } },
      { id: 'slow-call', type: 'function', function: { name: 'rollout_slow', arguments: '{}' } },
      { id: 'bad-call', type: 'function', function: { name: 'not_offered', arguments: '{}' } },
      { id: 'json-call', type: 'function', function: { name: 'rollout_quick', arguments: '{bad' } },
    ] } : { content: '检查完成' }, finish_reason: n === 1 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 20 },
  }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: ${secret}, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, pricing: { input: 1, output: 2 } }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false }\nmemory: { enable: false }\ntools: { webSearch: { enable: false } }\n`)
  config.load()
  registry.register({ name: 'rollout_quick', description: 'quick', parameters: {}, run: async () => `quick result ${secret} alice@example.com` })
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
    assert.ok(events.some(event => event.callId === 'quick-call' && event.phase === 'completed'))
    assert.ok(!events.some(event => event.callId === 'slow-call' && event.phase === 'completed'))
    assert.equal(events.filter(event => event.phase === 'completed' && event.isError).length, 2)
    release()
    assert.equal((await pending).kind, 'reply')
    const done = rolloutHistory(live.id)!
    assert.equal(done.status, 'completed')
    assert.equal(done.steps, 2)
    assert.equal(done.reply, '检查完成')
    assert.equal(done.tokens?.input, 240)
    assert.ok(done.cost > 0)
    assert.equal(done.events.filter(event => event.kind === 'response').length, 2)
    assert.equal(recentTurns()[0].rolloutId, live.id)
    assert.equal(recentRollouts('another-conversation').length, 0)
    assert.equal(rolloutHistory('../config'), undefined)
    const failed = await runTurn({ ...req, convKey: 'test:failure' })
    assert.equal(failed.kind, 'error')
    assert.equal(recentRollouts()[0].status, 'failed')
    assert.ok(rolloutHistory(recentRollouts()[0].id)!.events.some(event => event.kind === 'error'))
    flushAllStores()
    const persisted = fs.readFileSync(path.join(TMP, 'data/rollouts.json'), 'utf8')
    for (const hidden of [secret, 'alice@example.com', 'provider-private-reasoning']) assert.ok(!persisted.includes(hidden), hidden)
  } finally { release(); await pending; await server.close() }
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
  assert.equal(recentRollouts().length, 300)
  assert.equal(rolloutHistory(id), undefined)
  const running = startRollout({ conv: 'restart', source: 'chat', input: 'pending', inputImageCount: 0 })
  updateRollout(running, { status: 'running' })
  flushAllStores()
  const script = `const { config } = await import('./src/core/config.ts'); config.load(); const { rolloutHistory } = await import('./src/chat/rollouts.ts'); console.log(JSON.stringify(rolloutHistory('${running}')))`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, env: process.env })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout.trim().split('\n').at(-1)!).status, 'interrupted')
})
