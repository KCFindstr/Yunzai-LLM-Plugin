import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

let reply = '岛风，该喝水啦'
const llm = await mockServer(() => [200, { choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }])
after(() => llm.close())

writeUserConfig(`
providers:
  mock: { type: openai, baseUrl: ${llm.url}, apiKey: k, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: fake }
defaultModel: main
fallbackModels: []
pricing: { sources: [] }
persona: { botName: 天津风 }
memory: { enable: false }
sticker: { enable: false }
chat: { summarize: false }
reply: { typing: { minDelay: 0, maxDelay: 0 } }
tools: { schedule: { maxPerUser: 2, maxChain: 1 } }
`)

const { config } = await import('../src/core/config.ts')
const { addTask, getTask, listTasks, nextOccurrence, parseTime, resetSchedules, tick, wakeEvent } = await import('../src/chat/schedule.ts')
const { registerScheduleTool } = await import('../src/tools/schedule.ts')
const { registry } = await import('../src/tools/registry.ts')
const { peekSession, sessionKey } = await import('../src/chat/session.ts')
registerScheduleTool()

// 2026-10-30 is a Friday; 10:00 in China is 02:00 UTC
const FRI_10 = Date.UTC(2026, 9, 30, 2, 0)
const HOUR = 3600_000

const sentTo: { target: string; msg: any }[] = []
;(globalThis as any).Bot = {
  10000: {
    adapter: { id: 'QQ', name: 'OneBotv11' },
    pickGroup: (id: any) => ({ sendMsg: async (msg: any) => { sentTo.push({ target: `g${id}`, msg }); return { message_id: `s${sentTo.length}` } } }),
    pickFriend: (id: any) => ({ sendMsg: async (msg: any) => { sentTo.push({ target: `p${id}`, msg }); return { message_id: `s${sentTo.length}` } } }),
  },
}

const flush = () => new Promise(r => setImmediate(r))
const until = async (done: () => boolean) => { const end = Date.now() + 5000; while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 10)) }

function toolCtx(over: Record<string, any> = {}, turn: Record<string, any> = {}) {
  const { e } = fakeEvent({ msg: '10分钟后提醒我喝水', ...over })
  const eff = config.effective(e.group_id)
  return { e, eff, isAdmin: false, model: config.getModel('main')!, turn: { commands: 0, searches: 0, fetches: 0, images: [], ...turn } as any }
}
const schedule = (args: Record<string, any>, ctx = toolCtx()) => registry.get('schedule')!.run(args, ctx as any).then(r => typeof r === 'string' ? { content: r } : r)

const owner = { createdBy: 'chat' as const, selfId: '10000', userId: '20001', userName: '岛风', groupId: '30001', admin: false, chain: 0 }

beforeEach(() => { resetSchedules(); sentTo.length = 0; reply = '岛风，该喝水啦'; llm.requests.length = 0 })

describe('schedule times', () => {
  it('reads China time, with or without a date', () => {
    assert.equal(parseTime('2026-10-31 08:30', FRI_10), Date.UTC(2026, 9, 31, 0, 30))
    assert.equal(parseTime('11:00', FRI_10), FRI_10 + HOUR)
    assert.equal(parseTime('09:00', FRI_10), FRI_10 + 23 * HOUR, 'a passed time of day means tomorrow')
    assert.equal(parseTime('10-29 08:00', FRI_10), Date.UTC(2027, 9, 29, 0, 0), 'a passed date without a year means next year')
    assert.equal(parseTime('2026-02-30 08:00', FRI_10), undefined)
    assert.equal(parseTime('明天', FRI_10), undefined)
  })

  it('moves repeats to their next time after now', () => {
    assert.equal(nextOccurrence(FRI_10, 'none', undefined, FRI_10), undefined)
    assert.equal(nextOccurrence(FRI_10, 'daily', undefined, FRI_10), FRI_10 + 24 * HOUR)
    assert.equal(nextOccurrence(FRI_10, 'weekdays', undefined, FRI_10), FRI_10 + 3 * 24 * HOUR, 'Friday -> Monday')
    assert.equal(nextOccurrence(FRI_10, 'weekly', undefined, FRI_10 + 8 * 24 * HOUR), FRI_10 + 14 * 24 * HOUR)
    assert.equal(nextOccurrence(FRI_10, 'interval', 90, FRI_10 + 2 * HOUR), FRI_10 + 3 * HOUR)
  })
})

describe('schedule tool', () => {
  it('creates, lists and cancels tasks of this chat', async () => {
    const made = await schedule({ action: 'create', task: '提醒岛风喝水', delayMinutes: 10 })
    assert.ok(!made.isError, made.content)
    assert.equal(listTasks().length, 1)
    assert.equal(listTasks()[0].groupId, '30001')
    assert.equal(listTasks()[0].request, '10分钟后提醒我喝水')
    const id = listTasks()[0].id
    assert.match((await schedule({ action: 'list' })).content, new RegExp(id))
    // someone else in the group neither sees nor cancels it
    const other = toolCtx({ user_id: 20002, sender: { user_id: 20002, nickname: '雪风' } })
    assert.match((await schedule({ action: 'list' }, other)).content, /没有进行中/)
    assert.equal((await schedule({ action: 'cancel', id }, other)).isError, true)
    assert.ok(!(await schedule({ action: 'cancel', id })).isError)
    assert.equal(getTask(id)!.status, 'cancelled')
  })

  it('rejects bad times and enforces per-user and chain limits', async () => {
    assert.equal((await schedule({ action: 'create', task: 'x', at: '后天' })).isError, true)
    assert.equal((await schedule({ action: 'create', task: 'x', delayMinutes: 600 * 24 * 60 })).isError, true)
    assert.equal((await schedule({ action: 'create', task: 'x', delayMinutes: 5, repeat: 'interval', everyMinutes: 5 })).isError, true, 'below minInterval')
    assert.ok(!(await schedule({ action: 'create', task: 'a', delayMinutes: 5 })).isError)
    assert.ok(!(await schedule({ action: 'create', task: 'b', delayMinutes: 5 })).isError)
    assert.match((await schedule({ action: 'create', task: 'c', delayMinutes: 5 })).content, /上限 2/)
    resetSchedules()
    // a wake-up may schedule once more (maxChain 1), not twice
    assert.ok(!(await schedule({ action: 'create', task: 'again', delayMinutes: 30 }, toolCtx({}, { scheduleChain: 1 }))).isError)
    assert.match((await schedule({ action: 'create', task: 'again', delayMinutes: 30 }, toolCtx({}, { scheduleChain: 2 }))).content, /流程限制/)
  })
})

describe('firing', () => {
  it('runs a due task in its chat and finishes one-off tasks', async () => {
    const t = addTask(owner, { task: '提醒岛风喝水', nextAt: Date.now() + 60_000, repeat: 'none' })
    t.nextAt = Date.now() - 1000
    await tick()
    await until(() => t.status !== 'active')
    assert.equal(t.status, 'done', t.lastError ?? '')
    assert.equal(t.runs, 1)
    assert.deepEqual(sentTo.map(s => s.target), ['g30001'])
    const prompt = String(llm.requests.at(-1)!.body.messages.at(-1).content)
    assert.match(prompt, /【定时任务·到点提醒/)
    assert.match(prompt, /提醒岛风喝水/)
    assert.match(prompt, /\[at:20001\]/)
    assert.ok(peekSession(sessionKey(wakeEvent(t), config.effective('30001').chat.sessionScope))?.messages.length, 'the wake-up is part of the conversation')
  })

  it('moves a repeat on, may stay quiet, and records failures without stopping', async () => {
    const t = addTask({ ...owner, groupId: undefined }, { task: '看看网页更新没有', nextAt: Date.now() + 60_000, repeat: 'daily' })
    const due = t.nextAt = Date.now() - 1000
    reply = '[skip]'
    await tick()
    await until(() => t.runs === 1)
    assert.equal(t.status, 'active')
    assert.equal(t.nextAt, due + 24 * HOUR)
    assert.equal(sentTo.length, 0)
    assert.match(t.lastResult ?? '', /无需发消息/)
  })

  it('waits while the bot is offline and drops tasks that are far too late', async () => {
    const offline = addTask({ ...owner, selfId: '99999' }, { task: '早安', nextAt: Date.now() + 60_000, repeat: 'none' })
    offline.nextAt = Date.now() - 1000
    assert.equal(wakeEvent(offline), undefined)
    await tick()
    await flush()
    assert.equal(offline.status, 'active')
    offline.nextAt = Date.now() - 25 * HOUR
    await tick()
    assert.equal(offline.status, 'missed')
    const daily = addTask(owner, { task: '早安', nextAt: Date.now() + 60_000, repeat: 'daily' })
    const due = daily.nextAt = Date.now() - 2 * HOUR
    await tick()
    assert.equal(daily.status, 'active')
    assert.equal(daily.nextAt, due + 24 * HOUR, 'a late repeat skips to its next time')
    assert.equal(daily.runs, 0)
  })
})
