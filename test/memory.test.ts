import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

const replies: any[] = []
const srv = await mockServer((_req, n) => [200, replies[n - 1] ?? text('（无）')])
function text(t: string) {
  return { choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
}
function memCall(args: any) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name: 'memory', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

writeUserConfig(`
providers:
  mock: { type: openai, baseUrl: '${srv.url}', apiKey: k, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: m, pricing: { input: 1, output: 1 } }
defaultModel: main
fallbackModels: []
chat: { summarize: false, groupContext: 0 }
reply: { quote: never, typing: { charsPerSecond: 1000, minDelay: 0, maxDelay: 0 }, groupRate: { count: 100, perSeconds: 60 } }
trigger: { userCooldown: 0 }
sticker: { enable: false }
tools: { webSearch: { enable: false }, botCommand: { enable: false } }
memory: { userMaxEntries: 4, userMaxChars: 60, groupMaxEntries: 3, groupMaxChars: 60, entryMaxChars: 20 }
`)

const { setLoaderForTest } = await import('../src/core/yunzai.ts')
const { LLMChat } = await import('../src/apps/chat.ts')
const { registerMemoryTool } = await import('../src/memory/tool.ts')
const store = await import('../src/memory/store.ts')
const { maybeCompact } = await import('../src/memory/compact.ts')
const { config } = await import('../src/core/config.ts')
setLoaderForTest({ priority: [], deal: async () => {} }, { getGroup: () => ({}) })
registerMemoryTool()

after(() => srv.close())
beforeEach(() => {
  srv.requests.length = 0
  replies.length = 0
})

describe('memory store bounds', () => {
  it('dedupes, enforces per-entry/entry-count/total limits and refuses sensitive data', () => {
    const k = 'u-bounds'
    assert.equal(store.addMemory('user', k, '喜欢被叫阿明').ok, true)
    const dup = store.addMemory('user', k, '喜欢被叫阿明哦')
    assert.ok(dup.ok && dup.merged, 'near-duplicate merged instead of added')
    assert.equal(store.listMemory('user', k).length, 1)
    assert.match((store.addMemory('user', k, '这是一条非常非常非常非常长的超过二十个字的记忆内容') as any).reason, /最多 20 字/)
    assert.match((store.addMemory('user', k, '我的密码是 hunter2') as any).reason, /敏感/)
    assert.match((store.addMemory('user', k, '手机13812345678') as any).reason, /敏感/)
    for (const t of ['主玩原神', '常用胡桃', '生日十月一日']) assert.equal(store.addMemory('user', k, t).ok, true)
    const full = store.addMemory('user', k, '喜欢猫')
    assert.ok(!full.ok && full.full, 'entry cap reached')
    const u = store.usage('user', k)
    assert.ok(u.entries <= 4 && u.chars <= 60)
    const id = store.listMemory('user', k)[0].id
    assert.match((store.updateMemory('user', k, id, '超'.repeat(19)) as any).reason ?? 'ok', /上限|ok/)
    assert.ok(store.usage('user', k).chars <= 60, 'update cannot push total over the budget')
  })

  it('render never exceeds limits even if they are lowered later', () => {
    const k = 'u-render'
    for (const t of ['一一一一一', '二二二二二', '三三三三三']) store.addMemory('user', k, t)
    config.set('memory.userMaxEntries', 2)
    assert.equal(store.renderMemory('user', k).length, 2)
    config.set('memory.userMaxEntries', 4)
  })
})

describe('memory consolidation', () => {
  it('replaces the list with a validated, smaller version', async () => {
    const k = 'u-compact'
    for (const t of ['喜欢原神', '原神玩家', '喜欢胡桃', '常用胡桃']) store.addMemory('user', k, t)
    replies.push(text('["原神玩家，喜欢胡桃"]'))
    await maybeCompact('user', k, { userId: k })
    assert.deepEqual(store.listMemory('user', k).map(m => m.text), ['原神玩家，喜欢胡桃'])
  })

  it('keeps the list unchanged when the model output breaks the limits', async () => {
    const k = 'u-compact-bad'
    for (const t of ['aaaa1', 'bbbb2', 'cccc3', 'dddd4']) store.addMemory('user', k, t)
    replies.push(text(JSON.stringify(['x'.repeat(50)])))
    await maybeCompact('user', k, { userId: k })
    assert.equal(store.listMemory('user', k).length, 4)
  })
})

describe('memory in conversation', () => {
  it('model saves a memory; next turn sees it as a stable prefix and the system prompt is unchanged', async () => {
    replies.push(memCall({ action: 'add', scope: 'user', text: '喜欢被叫小龙' }), text('好的小龙'), text('小龙你好'))
    const t1 = fakeEvent({ user_id: 50001, message_id: 'x1' })
    await Object.assign(new LLMChat(), { e: t1.e }).onMessage()
    assert.deepEqual(t1.sent.map(s => s.msg), ['好的小龙'])
    assert.match(srv.requests[1].body.messages.at(-1).content, /已记住 \[m\w+\] 喜欢被叫小龙/)
    assert.deepEqual(store.listMemory('user', '50001').map(m => m.text), ['喜欢被叫小龙'])

    const t2 = fakeEvent({ user_id: 50001, message_id: 'x2' })
    await Object.assign(new LLMChat(), { e: t2.e }).onMessage()
    const b1 = srv.requests[0].body
    const b3 = srv.requests[2].body
    assert.equal(b1.messages[0].content, b3.messages[0].content, 'system prompt byte-identical')
    assert.match(b3.messages[1].content, /【长期记忆·关于 小明\(平台ID 50001\)】\n\[m\w+\] 喜欢被叫小龙/)
    assert.doesNotMatch(b1.messages[1].content, /长期记忆/)
  })

  it('refuses group-memory writes from non-admins when groupWrite=admin', async () => {
    config.set('memory.groupWrite', 'admin')
    replies.push(memCall({ action: 'add', scope: 'group', text: '群规：不刷屏' }), text('嗯'))
    const t = fakeEvent({ user_id: 50002, message_id: 'y1' })
    await Object.assign(new LLMChat(), { e: t.e }).onMessage()
    assert.match(srv.requests[1].body.messages.at(-1).content, /不能修改群记忆/)
    assert.equal(store.listMemory('group', '30001').length, 0)
    config.set('memory.groupWrite', 'all')
  })
})
