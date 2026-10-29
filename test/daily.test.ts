import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

// mock utility model: answers by which prompt it was given
const prompts: string[] = []
const server = await mockServer(async request => {
  const system = String(request.body.messages[0]?.content ?? '')
  prompts.push(system)
  const content = system.includes('普通群聊记录')
    ? '岛风和雪风在群里约好周末一起去看猫展'
    : system.includes('这一天的概要')
      ? '这天岛风和雪风约好周末看猫展，还讨论了原神配队'
      : '片段：岛风问了原神配队\n摘要：岛风在研究原神配队'
  return [200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
})
after(server.close)
writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: mock, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, thinking: off }\ndefaultModel: main\nchat: { sessionScope: member, summarize: true }\nmemory: { crossChatRecall: false }\n`)

const { config } = await import('../src/core/config.ts')
config.load()
const { addDays, localDay, parseDateHints } = await import('../src/chat/dates.ts')
const { appendTurn, clearSession, getSession, pendingArchive, peekSession, recallSession, staleDay, truncateIfNeeded } = await import('../src/chat/session.ts')
const { maintainArchive } = await import('../src/chat/archiveJobs.ts')
const { clearChatter, flushChatter } = await import('../src/chat/chatter.ts')
const { clearGroupLogs, markHandled, recordGroupMessage } = await import('../src/chat/groupLog.ts')
const { recallSources } = await import('../src/memory/tool.ts')

const DAY = 86400_000
const today = localDay()
const yesterday = addDays(today, -1)
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })

/** Two turns yesterday and one today, then trim everything but the last turn into the archive. */
function seedAcrossDays(key: string) {
  clearSession(key)
  appendTurn(key, user('昨天聊原神配队'), { role: 'assistant', content: '推荐双火' })
  appendTurn(key, user('昨天还聊了猫'), { role: 'assistant', content: '猫猫可爱' })
  appendTurn(key, user('今天的新话题'), { role: 'assistant', content: '好' })
  appendTurn(key, user('现在'), { role: 'assistant', content: '嗯' })
  const s = peekSession(key)!
  s.turnTimes = [Date.now() - DAY, Date.now() - DAY + 60_000, Date.now(), Date.now()]
  truncateIfNeeded(key, { ...config.effective().chat, historyMaxTurns: 1 })
}

beforeEach(() => { prompts.length = 0 })

describe('date phrases', () => {
  // Thursday 2026-10-22, noon UTC+8
  const now = Date.parse('2026-10-22T04:00:00Z')
  const cases: [string, string | undefined, string | undefined][] = [
    ['昨天聊了什么', '2026-10-21', '2026-10-21'],
    ['上周六的约定', '2026-10-17', '2026-10-17'],
    ['周六说好的', '2026-10-17', '2026-10-17'],
    ['上周', '2026-10-12', '2026-10-18'],
    ['周末去哪了', '2026-10-17', '2026-10-18'],
    ['十月二十号', '2026-10-20', '2026-10-20'],
    ['12月25日', '2025-12-25', '2025-12-25'],
    ['3天前', '2026-10-19', '2026-10-19'],
    ['上个月', '2026-09-01', '2026-09-30'],
    ['下周一见', undefined, undefined],
    ['明天再说', undefined, undefined],
    ['没有日期', undefined, undefined],
  ]
  for (const [text, from, to] of cases)
    it(`parses ${text}`, () => assert.deepEqual(parseDateHints(text, now), from ? { from, to } : undefined))
})

describe('daily archive', () => {
  it('splits archived turns by the day they happened and summarizes one day at a time', () => {
    const key = '10000:p81001'
    seedAcrossDays(key)
    const archive = peekSession(key)!.archive!
    assert.deepEqual(archive.map(a => a.day), [yesterday, today])
    assert.match(archive[0].text, /原神配队[\s\S]*猫/)
    assert.deepEqual(pendingArchive(key).map(a => a.day), [yesterday])
  })

  it('writes a digest for a finished day, finds it by date, and rebuilds it when that day gains entries', async () => {
    const key = '10000:p81002'
    seedAcrossDays(key)
    // nothing is digested while that day's chunks are still raw
    assert.equal(staleDay(key), undefined)
    await maintainArchive(key)
    // the bot's own turns are summarized by compactSession, not the background job
    for (const a of peekSession(key)!.archive!) delete a.raw
    await maintainArchive(key)
    const days = peekSession(key)!.days!
    assert.equal(days.length, 1)
    assert.equal(days[0].day, yesterday)
    assert.match(days[0].text, /看猫展/)
    assert.equal(staleDay(key), undefined)

    const hits = await recallSession(key, '昨天聊了什么', 3, { range: { from: yesterday, to: yesterday } })
    assert.match(hits[0], new RegExp(`^【${yesterday} 当日概要】`))
    assert.ok(!hits.some(h => h.includes('今天的新话题')))

    peekSession(key)!.archive!.push({ id: 'late', at: Date.now() - DAY, day: yesterday, text: '昨天晚些时候又聊了显卡' })
    assert.equal(staleDay(key)?.day, yesterday)
  })

  it('keeps daily digests when an idle session is pruned', () => {
    const key = '10000:p81003'
    seedAcrossDays(key)
    const s = peekSession(key)!
    s.days = [{ id: 'dold', day: addDays(today, -40), text: '四十天前的概要', at: Date.now(), sources: [] }]
    s.updatedAt = Date.now() - 40 * DAY
    for (const a of s.archive!) a.at = Date.now() - 40 * DAY
    getSession('10000:p81099', 180) // first call in this process runs the hourly prune
    const after = peekSession(key)!
    assert.deepEqual(after.messages, [])
    assert.equal(after.archive, undefined)
    assert.equal(after.days?.[0].text, '四十天前的概要')
  })
})

describe('group chatter', () => {
  beforeEach(() => { clearChatter(); clearGroupLogs() })
  const say = (uid: number, mid: string, text: string, at = false) =>
    recordGroupMessage(fakeEvent({ user_id: uid, group_id: 82001, message_id: mid, sender: { user_id: uid, nickname: `u${uid}` }, message: [...(at ? [{ type: 'at', qq: 10000 }] : []), { type: 'text', text }] }).e)

  it('archives and summarizes chatter that did not involve the bot, skipping handled messages', async () => {
    say(1, 'c1', '周末去看猫展吗')
    say(2, 'c2', '好啊一起去')
    say(3, 'c3', '我也想去')
    say(1, 'c4', '机器人你说呢', true)
    markHandled(fakeEvent({ group_id: 82001, message_id: 'c4' }).e, '10000:g82001:u1')
    // nothing yet: too few lines and not quiet for long
    assert.deepEqual(flushChatter(), [])
    assert.deepEqual(flushChatter(Date.now() + 3 * 3600_000), ['10000:g82001'])
    const chunk = peekSession('10000:g82001')!.archive!.at(-1)!
    assert.equal(chunk.chat, true)
    assert.match(chunk.text, /猫展/)
    assert.doesNotMatch(chunk.text, /机器人你说呢/)

    await maintainArchive('10000:g82001')
    const entry = peekSession('10000:g82001')!.archive!.at(-1)!
    assert.equal(entry.raw, undefined)
    assert.match(entry.text, /^【群聊】岛风和雪风/)
    assert.ok(prompts.some(p => p.includes('普通群聊记录')))
    // the bot's rolling summary is untouched by chatter
    assert.equal(peekSession('10000:g82001')!.summary, undefined)
  })

  it('lets a member-scoped conversation recall the group chatter', async () => {
    const e = fakeEvent({ group_id: 82001, user_id: 1 }).e
    const extra = recallSources(e, 'member')
    assert.deepEqual(extra, [{ key: '10000:g82001', label: '群聊' }])
    const hits = await recallSession('10000:g82001:u1', '猫展', 3, { extra })
    assert.match(hits.join('\n'), /\[群聊\].*猫展/)
  })

  it('does not record chatter when the feature is off', () => {
    config.get().memory.groupChatArchive = false
    try {
      say(5, 'x1', '这条不该被记录')
      assert.deepEqual(flushChatter(Date.now() + 2 * DAY), [])
    } finally {
      config.get().memory.groupChatArchive = true
    }
  })
})

describe('cross-chat recall', () => {
  it('is off by default, and when on lets a private chat search only groups the person is in', async () => {
    const pm = fakeEvent({ group_id: undefined, message_type: 'private', user_id: 1 }).e
    assert.deepEqual(recallSources(pm, 'member'), [])
    config.get().memory.crossChatRecall = true
    try {
      const keys = recallSources(pm, 'member').map(s => s.key)
      assert.ok(keys.includes('10000:g82001'))
      // someone never seen in that group gets nothing
      assert.deepEqual(recallSources(fakeEvent({ group_id: undefined, user_id: 999 }).e, 'member'), [])
      // and groups never reach into private chats
      assert.deepEqual(recallSources(fakeEvent({ group_id: 82001, user_id: 1 }).e, 'group'), [])
    } finally {
      config.get().memory.crossChatRecall = false
    }
  })
})
