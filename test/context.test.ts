import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { config } from '../src/core/config.ts'
import { LLMChat } from '../src/apps/chat.ts'
import { recordGroupMessage, recentLines, clearGroupLogs } from '../src/chat/groupLog.ts'
import { knownName, observeUsers, rosterLines } from '../src/chat/roster.ts'
import { appendTurn, clearSession, getSession, peekSession, recallSession, setSummary, truncateIfNeeded } from '../src/chat/session.ts'
import { compactSession } from '../src/chat/agent.ts'
import { KeyedLock, Semaphore, sleep } from '../src/core/util.ts'
import { Cooldown } from '../src/chat/ratelimit.ts'

let active = 0
let summaryReply = ''
let peak = 0
const server = await mockServer(async request => {
  active++
  peak = Math.max(peak, active)
  await sleep(30)
  active--
  const text = request.body.messages.at(-1).content
  if (String(request.body.messages[0]?.content).includes('片段：'))
    return [200, { choices: [{ message: { role: 'assistant', content: summaryReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
  return [200, { choices: [{ message: { role: 'assistant', content: `收到 ${String(text).split('\n').at(-1)}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
})
after(server.close)
writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: mock, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, thinking: off }\ndefaultModel: main\ntrigger: { userCooldown: 0 }\nchat: { sessionScope: group, summarize: false, thinking: off }\nreply:\n  quote: never\n  concurrency: 3\n  typing: { minDelay: 0, maxDelay: 0, charsPerSecond: 1000 }\n  groupRate: { count: 100, perSeconds: 1 }\n  globalRate: { count: 100, perSeconds: 1 }\nsticker: { enable: false }\ntools: { enable: false }\n`)
config.load()
beforeEach(() => { active = 0; peak = 0; clearGroupLogs() })

describe('message scheduling', () => {
  it('does not drop later mentions in a shared conversation and preserves turn order', async () => {
    const plugin = new LLMChat()
    const outputs: string[] = []
    const tasks = Array.from({ length: 6 }, (_, index) => {
      const { e } = fakeEvent({ group_id: 60001, message_id: `burst-${index}`, message: [{ type: 'at', qq: 10000 }, { type: 'text', text: `burst-${index}` }] })
      e.reply = async (text: string) => { outputs.push(text); return { message_id: `out-${index}` } }
      plugin.e = e
      return plugin.onMessage()
    })
    assert.deepEqual(await Promise.all(tasks), Array(6).fill(true))
    assert.equal(outputs.length, 6)
    outputs.forEach((output, index) => assert.match(output, new RegExp(`burst-${index}$`)))
    assert.equal(peak, 1, 'one conversation is serialized to keep history coherent')
    assert.equal(peekSession('10000:g60001')?.messages.length, 12)
  })

  it('processes independent conversations concurrently', async () => {
    await Promise.all([61001, 61002, 61003].map(async group_id => {
      const { e } = fakeEvent({ group_id })
      const plugin = new LLMChat()
      plugin.e = e
      await plugin.onMessage()
    }))
    assert.equal(peak, 3)
  })

  it('gives an explicit overload notice instead of silently ignoring a mention', async () => {
    config.set('chat.maxPending', 2)
    const sends: string[] = []
    try {
      await Promise.all([1, 2, 3].map(async index => {
        const { e } = fakeEvent({ group_id: 61100, message_id: `overload-${index}`, reply: async (text: string) => { sends.push(text); return { message_id: index } } })
        const plugin = new LLMChat()
        plugin.e = e
        await plugin.onMessage()
      }))
      assert.equal(sends.length, 3)
      assert.equal(sends.filter(text => text.includes('消息有点多')).length, 1)
    } finally { config.set('chat.maxPending', 20) }
  })

  it('reserves cooldown delays rather than discarding messages', () => {
    const cooldown = new Cooldown()
    const first = cooldown.reserve('alice', 5)
    assert.equal(cooldown.reserve('alice', 5) - first, 5000)
    assert.equal(cooldown.reserve('alice', 5) - first, 10000)
    assert.ok(cooldown.reserve('bob', 5) - first < 100)
  })

  it('reserves semaphore capacity for queued waiters and releases failed turns', async () => {
    const semaphore = new Semaphore(1)
    let concurrent = 0
    let maximum = 0
    const run = () => semaphore.run(async () => { concurrent++; maximum = Math.max(maximum, concurrent); await sleep(2); concurrent-- })
    await Promise.all(Array.from({ length: 30 }, run))
    assert.equal(maximum, 1)
    await assert.rejects(semaphore.run(async () => { throw Error('failed') }))
    await run()
    const lock = new KeyedLock()
    await assert.rejects(lock.run('key', async () => { throw Error('failed') }))
    assert.equal(await lock.run('key', async () => 42), 42)
  })
})

describe('recent identities and conversation layers', () => {
  it('retains real names when later events supply numeric placeholders and reads cached OneBot profiles', () => {
    const { e } = fakeEvent({ group_id: 62001, user_id: 1, sender: { nickname: '阿明' }, message: [{ type: 'at', qq: 7, name: '大肥鱼' }] })
    observeUsers(e)
    observeUsers({ ...e, sender: { nickname: '1' }, message: [] })
    assert.equal(knownName(e), '阿明')
    assert.ok(rosterLines(e, 12).some(line => line.includes('大肥鱼 [at:7]')))
    const cached = { ...e, user_id: 2, sender: { nickname: '2' }, bot: { gml: new Map([[62001, new Map([[2, { card: '群名片' }]])]]) } }
    observeUsers(cached)
    assert.equal(knownName(cached), '群名片')
    observeUsers({ ...e, user_id: 3, sender: { nickname: '3' }, message: [] })
    assert.ok(rosterLines(e, 12).some(line => line === '称呼未知 [at:3]'))
    assert.equal(rosterLines(e, 1).length, 1)
    assert.deepEqual(rosterLines({ ...e, group_id: 62002 }, 12), [])
  })

  it('never leaks later queued messages into an earlier triggering context', () => {
    const { e } = fakeEvent({ group_id: 63001 })
    recordGroupMessage({ ...e, message_id: 'before', message: [{ type: 'text', text: 'before' }] })
    recordGroupMessage({ ...e, message_id: 'trigger' })
    recordGroupMessage({ ...e, message_id: 'later', message: [{ type: 'text', text: 'later' }] })
    const lines = recentLines({ ...e, message_id: 'trigger' }, 10, 100)
    assert.ok(lines.some(line => line.includes('before')))
    assert.ok(!lines.some(line => line.includes('later')))
  })

  it('archives dropped context for scoped recall, skips secrets and clears it on reset', () => {
    const key = '10000:g64001'
    clearSession(key)
    const add = (text: string) => appendTurn(key, { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: '记住了' })
    add('周六一起看薄荷猫视频，称呼叫阿明')
    add('password=not-for-archive')
    add('最新消息')
    const dropped = truncateIfNeeded(key, { ...config.effective().chat, historyMaxTurns: 1 })
    assert.equal(dropped.length, 4)
    assert.match(recallSession(key, '薄荷猫').join(''), /阿明/)
    assert.doesNotMatch(recallSession(key, '').join(''), /password/)
    assert.deepEqual(recallSession('10000:g64002', ''), [])
    clearSession(key)
    assert.deepEqual(recallSession(key, ''), [])
  })

  it('keeps summary and episodic context across idle expiry without reusing provider state', () => {
    const key = '10000:p65001'
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '薄荷猫的约定' }] }, { role: 'assistant', content: '周末见' })
    setSummary(key, '周末看猫')
    const old = peekSession(key)!
    old.updatedAt = Date.now() - 4 * 3600_000
    old.state = { key: 'old', previousId: 'old', len: 2 }
    const fresh = getSession(key, 180)
    assert.notEqual(fresh, old)
    assert.equal(fresh.summary, '周末看猫')
    assert.equal(fresh.state, undefined)
    assert.equal(fresh.messages.length, 0)
    assert.match(recallSession(key, '薄荷猫').join(''), /周末见/)
  })

  it('retains a fallback summary and archive if model compaction fails', async () => {
    const key = '10000:p66001'
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '之前约好周六看猫' }] }, { role: 'assistant', content: '好的' })
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '现在的新消息' }] }, { role: 'assistant', content: '你好' })
    const eff = config.effective()
    eff.chat = { ...eff.chat, summarize: true, historyMaxTurns: 1 }
    const models = config.get().models
    config.get().models = []
    try { await compactSession(key, eff, {}) } finally { config.get().models = models }
    assert.match(peekSession(key)?.summary ?? '', /周六看猫/)
    assert.match(recallSession(key, '周六看猫').join(''), /好的/)
  })

  it('does not overwrite a reset conversation with an older in-flight summary', async () => {
    const key = '10000:p67001'
    for (const text of ['旧话题', '旧消息']) appendTurn(key, { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: '旧回复' })
    const eff = { ...config.effective(), chat: { ...config.effective().chat, summarize: true, historyMaxTurns: 1 } }
    const pending = compactSession(key, eff, {})
    clearSession(key)
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '新的开始' }] }, { role: 'assistant', content: '你好' })
    await pending
    assert.equal(peekSession(key)?.summary, undefined)
    assert.deepEqual(recallSession(key, ''), [])
  })

  it('replaces archived chunks with a summarized episode and merges the rolling summary', async () => {
    const key = '10000:p68001'
    clearSession(key)
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '周六一起看薄荷猫，你记得提醒我' }] }, { role: 'assistant', content: '好的' })
    appendTurn(key, { role: 'user', content: [{ type: 'text', text: '现在的新消息' }] }, { role: 'assistant', content: '你好' })
    const eff = { ...config.effective(), chat: { ...config.effective().chat, summarize: true, historyMaxTurns: 1 } }
    summaryReply = '片段：对方约周六看薄荷猫，要你提醒\n摘要：对方周六看薄荷猫，需要提醒'
    await compactSession(key, eff, {})
    assert.equal(peekSession(key)?.summary, '对方周六看薄荷猫，需要提醒')
    assert.deepEqual(peekSession(key)?.archive?.map(entry => [entry.text, entry.raw]), [['对方约周六看薄荷猫，要你提醒', undefined]])
    assert.match(recallSession(key, '薄荷猫').join(''), /要你提醒/)
  })

  it('settles chunks without re-summarizing when the reply ignores the format', async () => {
    const key = '10000:p69001'
    clearSession(key)
    for (const text of ['旧话题', '新消息']) appendTurn(key, { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: '嗯' })
    const eff = { ...config.effective(), chat: { ...config.effective().chat, summarize: true, historyMaxTurns: 1 } }
    summaryReply = '只有一段摘要'
    await compactSession(key, eff, {})
    assert.equal(peekSession(key)?.summary, '只有一段摘要')
    assert.equal(peekSession(key)?.archive?.length, 1)
    assert.equal(peekSession(key)?.archive?.[0].raw, undefined)
    assert.match(recallSession(key, '旧话题').join(''), /旧话题/)
  })
})
