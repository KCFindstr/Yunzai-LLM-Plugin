import { fakeEvent, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'

writeUserConfig('memory:\n  embedding: { enable: false }\n')
const { config } = await import('../src/core/config.ts')
config.load()
const { appendTurn, peekSession, recallSession } = await import('../src/chat/session.ts')
const { automaticRecallQuery, recallText } = await import('../src/chat/recallText.ts')
const { buildHeader, buildMemoryBlock } = await import('../src/chat/prompt.ts')
const { addMemory } = await import('../src/memory/store.ts')
const key = '10000:g62501'
appendTurn(key, { role: 'user', content: [{ type: 'text', text: '新消息' }] }, { role: 'assistant', content: '好' })
const at = Date.now() - 2 * 86400_000
const day = new Date(at + 8 * 3600_000).toISOString().slice(0, 10)
peekSession(key)!.archive = [
  { id: 'unrelated', at, day, text: '对方：【2026-10-22 周四 15:28｜群「1」｜发言人 小明(平台ID 5)】\n[at:you] 48\n你：48 是什么暗号喵！' },
  { id: 'topic', at, day, text: '对方：【消息｜2026-10-22 周四 15:29｜群「1」｜发言人 小红(平台ID 4)】\n[at:you] 显卡驱动怎么装\n你：从官方安装驱动。' },
]

it('never retrieves old chat merely because it shares the at-you transport marker', async () => {
  assert.deepEqual(await recallSession(key, '[at:you] 你来回答一下'), [])
  assert.deepEqual(await recallSession(key, '[at:you]'), [])
  assert.equal(recallText('对方：【消息｜2026-10-22｜发言人 小明(平台ID 5)】\n[at:you] 正文').trim(), '正文')
  const hits = await recallSession(key, '[at:you] 显卡驱动', 3, { automatic: true })
  assert.equal(hits.length, 1)
  assert.match(hits[0], /官方安装驱动/)
})

it('skips vague automatic queries before calling an embedding provider, while preserving date recall', async t => {
  config.get().memory.embedding.enable = true
  config.get().memory.embedding.apiKey = 'fixture-key'
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected embedding request') })
  for (const text of ['[at:you] 你来回答一下', '[at:you] [图片]', '继续', '这是谁？', '[at:7] [at:you] 看懂了吗', '[图片]\n懂了没', '你看得懂吗？']) {
    assert.equal(automaticRecallQuery(text), '')
    assert.deepEqual(await recallSession(key, text, 2, { automatic: true }), [])
  }
  assert.equal(calls, 0)
  config.get().memory.embedding.enable = false
  assert.equal((await recallSession(key, '', 3, { range: { from: day, to: day } })).length, 2)
  assert.equal((await recallSession(key, '继续', 3, { automatic: true, range: { from: day, to: day } })).length, 2)
})

it('puts user facts only in the memory block and keeps the roster limited to identities', () => {
  const { e } = fakeEvent({ group_id: 62502, user_id: 62503, sender: { nickname: '小明' } })
  const fact = '喜欢低糖的薄荷茶'
  assert.equal(addMemory('user', String(e.user_id), fact).ok, true)
  const memory = buildMemoryBlock(e, { user: true, group: false })
  const header = buildHeader(e, config.effective(e.group_id), { text: '你好', images: [], imageSegments: [] }, false, { memory })
  assert.equal(header.context.roster.some(line => line.includes(fact)), false)
  assert.equal(header.sent.split(fact).length - 1, 1)
  assert.ok(header.context.roster.some(line => line.includes('小明 [at:62503]')))
})
