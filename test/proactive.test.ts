import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

// judge answers with a score; the main model answers '[skip]' when asked to stay quiet
let score = '80'
let reply = '我也想去！'
const llm = await mockServer(req => {
  const system = String(req.body.messages?.[0]?.content ?? '')
  const content = /主动接话/.test(system) ? score : reply
  return [200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2 } }]
})
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
tools: { enable: false }
sticker: { enable: false }
chat: { summarize: false }
proactive: { judge: main, window: 5, probability: 0.5 }
groups:
  '30001': { proactive: { enable: true } }
`)

const { config } = await import('../src/core/config.ts')
const { considerProactive, parseScore, recentProactive, resetProactive, thresholdAt } = await import('../src/chat/proactive.ts')
const { clearGroupLogs, recordBotMessage, recordGroupMessage } = await import('../src/chat/groupLog.ts')
const { runTurn } = await import('../src/chat/agent.ts')
const { peekSession } = await import('../src/chat/session.ts')

let mid = 0
const message = (text: string, group = 30001, user = 20001) => {
  const { e } = fakeEvent({ group_id: group, user_id: user, message_id: `p${++mid}`, message: [{ type: 'text', text }], msg: text, atBot: false, sender: { user_id: user, nickname: `群友${user}`, card: `群友${user}` } })
  recordGroupMessage(e)
  return e
}
const randoms = (...values: number[]) => () => values.shift() ?? 0.99
const flush = () => new Promise(r => setImmediate(r))
/** real HTTP round trips happen while setTimeout is mocked: spin the event loop until done (3s at most) */
const until = async (done: () => boolean) => { const end = Date.now() + 3000; while (!done() && Date.now() < end) await flush() }
const judgeCalls = () => llm.requests.filter(r => /主动接话/.test(String(r.body.messages?.[0]?.content ?? '')))

beforeEach(() => { resetProactive(); clearGroupLogs(); llm.requests.length = 0; score = '80'; reply = '我也想去！' })

describe('proactive reply threshold', () => {
  it('decays from start to end with the half-life; never spoke = end', () => {
    const t = { start: 0.95, end: 0.6, halfLife: 900 }
    assert.equal(thresholdAt(t, 0), 0.95)
    assert.ok(Math.abs(thresholdAt(t, 900) - 0.775) < 1e-9)
    assert.ok(thresholdAt(t, 3600) < 0.63)
    assert.equal(thresholdAt(t, undefined), 0.6)
  })

  it('reads the judge’s score as 0–1', () => {
    assert.deepEqual(['85', ' 0.7 ', '分数：40', '150', 'no'].map(parseScore), [0.85, 0.7, 0.4, 1, undefined])
  })
})

describe('proactive replies', () => {
  it('only in groups that enable them', () => {
    let calls = 0
    considerProactive(message('今晚吃什么', 30003), async () => { calls++ }, () => 0)
    assert.equal(calls, 0)
    assert.equal(config.effective(30003).proactive.enable, false)
    assert.equal(config.effective().proactive.enable, false, 'never outside a group')
  })

  it('probability alone never replies: a sampled message still has to pass the judge', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    score = '10'
    const replied: any[] = []
    considerProactive(message('都在吗'), async e => { replied.push(e) }, () => 0)
    await flush()
    assert.equal(replied.length, 0, 'nothing before the judge')
    t.mock.timers.tick(5000)
    t.mock.timers.reset()
    await until(() => recentProactive().length > 0)
    assert.equal(judgeCalls().length, 1)
    assert.deepEqual([recentProactive()[0].score, recentProactive()[0].reply, replied.length], [0.1, false, 0])
  })

  it('judge mode: messages are sampled independently, one judge call at the end of the window on the newest message', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const replied: any[] = []
    const respond = async (e: any) => { replied.push(e) }
    const sample = randoms(0.9, 0.2, 0.9)
    for (const text of ['周末去哪', '去看猫展吧', '天津风去不去']) considerProactive(message(text), respond, sample)
    assert.equal(judgeCalls().length, 0, 'nothing before the window ends')
    t.mock.timers.tick(5000)
    t.mock.timers.reset()
    await until(() => replied.length > 0)
    assert.equal(judgeCalls().length, 1)
    assert.equal(replied.length, 1)
    assert.equal(replied[0].msg, '天津风去不去')
    const state = String(judgeCalls()[0].body.messages.at(-1).content)
    assert.match(state, /^【机器人】.*「天津风」/)
    assert.match(state, /去看猫展吧/)
    assert.ok(state.trimEnd().endsWith('天津风去不去'))
    assert.equal(recentProactive()[0].reply, true)
  })

  it('judge always: the probability gate alone decides, without a judge call', async t => {
    config.set('groups.30001.proactive.judge', 'always')
    t.after(() => config.delete('groups.30001.proactive.judge'))
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const replied: any[] = []
    considerProactive(message('有人吗'), async e => { replied.push(e) }, () => 0)
    t.mock.timers.tick(5000)
    t.mock.timers.reset()
    await until(() => replied.length > 0)
    assert.equal(replied.length, 1)
    assert.equal(judgeCalls().length, 0)
    considerProactive(message('没抽中'), async e => { replied.push(e) }, () => 0.99)
    await flush()
    assert.equal(replied.length, 1)
  })

  it('judge mode: no sampled message, no judge call; a fresh bot message raises the bar', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const replied: any[] = []
    const respond = async (e: any) => { replied.push(e) }
    considerProactive(message('嗯'), respond, () => 0.9)
    t.mock.timers.tick(5000)
    await flush()
    assert.equal(judgeCalls().length, 0)
    const e = message('那明天呢')
    recordBotMessage(e, '我刚说过话')
    considerProactive(e, respond, () => 0)
    t.mock.timers.tick(5000)
    t.mock.timers.reset()
    await until(() => recentProactive().length > 0)
    assert.equal(judgeCalls().length, 1)
    const v = recentProactive()[0]
    assert.ok(v.threshold > 0.94, `just spoke: ${v.threshold}`)
    assert.deepEqual([v.score, v.reply, replied.length], [0.8, false, 0])
  })

  it('a proactive turn may stay quiet, leaving no trace in the conversation', async () => {
    const e = message('今天好热')
    const eff = config.effective(30001)
    reply = '[skip]'
    const quiet = await runTurn({ e, eff, input: { text: '今天好热', images: [], imageSegments: [] }, isAdmin: false, convKey: 'proactive:quiet', proactive: true })
    assert.equal(quiet.kind, 'reply')
    assert.equal(quiet.kind === 'reply' && quiet.skipped, true)
    assert.equal(peekSession('proactive:quiet')?.messages.length ?? 0, 0)
    reply = '是啊，空调开起来'
    const spoke = await runTurn({ e, eff, input: { text: '今天好热', images: [], imageSegments: [] }, isAdmin: false, convKey: 'proactive:spoke', proactive: true })
    assert.equal(spoke.kind === 'reply' && spoke.text, '是啊，空调开起来')
    const sent = String(llm.requests.at(-1)!.body.messages.at(-1).content)
    assert.match(sent, /【主动发言】没有人@你/)
    assert.ok(sent.indexOf('今天好热') < sent.indexOf('【主动发言】'), 'proactive prompt should be attached to the end after message text')
    const stored = peekSession('proactive:spoke')!.messages[0]
    assert.match(JSON.stringify(stored), /你主动接话的群消息/)
  })
})
