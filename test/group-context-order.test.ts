import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { appendTurn } from '../src/chat/session.ts'
import { markHandled, recordBotMessage, recordGroupMessage } from '../src/chat/groupLog.ts'
import { recentRollouts, rolloutHistory } from '../src/chat/rollouts.ts'

it('includes messages from the last twelve hours in the prompt and excludes older messages', async t => {
  const server = await mockServer(() => [200, { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, groupContext: 16 }\nmemory: { enable: false }\ntools: { enable: false }\n`)
  config.load()
  const { e } = fakeEvent({ group_id: 77301, message_id: 'current' })
  const now = Date.now()
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  for (const [age, text] of [[12 * 60 * 60_000 + 1, 'outside-window'], [12 * 60 * 60_000, 'twelve-hours-ago'], [60 * 60_000, 'one-hour-ago']] as const) {
    clock = now - age
    recordGroupMessage({ ...e, message_id: text, message: [{ type: 'text', text }] })
  }
  clock = now
  recordGroupMessage(e)
  try {
    await runTurn({ e, eff: config.effective(), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey: 'twelve-hour-context' })
    const current = server.requests[0].body.messages.at(-1).content
    assert.match(current, /twelve-hours-ago/)
    assert.match(current, /one-hour-ago/)
    assert.doesNotMatch(current, /outside-window/)
    const sessionTimeout = config.effective(e.group_id).chat.sessionTimeout
    const { groupLines } = await import('../src/chat/judge.ts')
    config.set('chat.groupContextMaxAgeMinutes', 30)
    assert.deepEqual(groupLines(e, 16), [], 'judges respect the global age setting')
    await runTurn({ e, eff: config.effective(e.group_id), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey: 'short-context' })
    assert.doesNotMatch(server.requests.at(-1)!.body.messages.at(-1).content, /one-hour-ago|twelve-hours-ago/)
    config.set('groups.77301.chat.groupContextMaxAgeMinutes', 120)
    assert.match(groupLines(e, 16).join('\n'), /one-hour-ago/)
    await runTurn({ e, eff: config.effective(e.group_id), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey: 'group-context-override' })
    const overridden = server.requests.at(-1)!.body.messages.at(-1).content
    assert.match(overridden, /one-hour-ago/)
    assert.doesNotMatch(overridden, /twelve-hours-ago|outside-window/)
    assert.equal(config.effective(e.group_id).chat.sessionTimeout, sessionTimeout)
  } finally { await server.close() }
})

it('sends overlapping session exchanges in the chronological group window and snapshots the separate sources', async () => {
  const server = await mockServer(() => [200, { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, sessionScope: group, groupContext: 10 }\nmemory: { enable: false }\ntools: { enable: false }\n`)
  config.load()
  const { e } = fakeEvent({ group_id: 77101, message_id: 'current' })
  const conv = `${e.self_id}:g${e.group_id}`
  const previous = { ...e, message_id: 'old', message: [{ type: 'text', text: '先问机器人' }] }
  recordGroupMessage(previous)
  markHandled(previous, conv)
  recordGroupMessage({ ...e, user_id: 999, message_id: 'middle', message: [{ type: 'text', text: '中间有人插话' }] })
  recordBotMessage(e, '随后机器人回复', conv)
  appendTurn(conv, { role: 'user', content: [{ type: 'text', text: '先问机器人' }] }, { role: 'assistant', content: '随后机器人回复' })
  recordGroupMessage({ ...e, message: [{ type: 'text', text: '当前请求' }] })
  recordGroupMessage({ ...e, message_id: 'future', message: [{ type: 'text', text: '稍后才出现的消息' }] })
  try {
    assert.equal((await runTurn({ e, eff: config.effective(), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey: conv })).kind, 'reply')
    const sent = server.requests[0].body.messages
    const current = sent.at(-1).content
    assert.match(current, /【最近群聊】/)
    assert.ok(current.indexOf('先问机器人') < current.indexOf('中间有人插话'))
    assert.ok(current.indexOf('中间有人插话') < current.indexOf('随后机器人回复'))
    assert.ok(current.indexOf('随后机器人回复') < current.indexOf('【消息｜'))
    assert.match(current, /【消息｜[^\n]+｜发言人 [^\n]+】\n当前请求$/)
    assert.doesNotMatch(current, /稍后才出现的消息/)
    assert.match(current, /1\. \[\d{4}-/)
    assert.ok(sent.slice(0, -1).some(message => message.content === '先问机器人'))
    const context = rolloutHistory(recentRollouts(conv)[0].id)!.context!
    assert.deepEqual(context.messages.map(message => message.source), ['history', 'history', 'current'])
    assert.equal(context.current!.text, '当前请求')
    assert.equal(context.current!.recent.length, 3)
    assert.ok(context.current!.recent[0].includes('先问机器人'))
    assert.ok(context.current!.recent[2].includes('随后机器人回复'))
  } finally { await server.close() }
})

it('sends and snapshots all 100 configured recent group messages before the combined message header', async () => {
  const server = await mockServer(() => [200, { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, groupContext: 100 }\nmemory: { enable: false }\ntools: { enable: false }\n`)
  config.load()
  const { e } = fakeEvent({ group_id: 77201, message_id: 'trigger' })
  for (let i = 0; i < 130; i++) recordGroupMessage({ ...e, message_id: `past-${i}`, message: [{ type: 'text', text: `group-line-${i};` }] })
  recordGroupMessage(e)
  recordGroupMessage({ ...e, message_id: 'future', message: [{ type: 'text', text: 'future-message' }] })
  try {
    await runTurn({ e, eff: config.effective(), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey: 'hundred-lines' })
    const current = server.requests[0].body.messages.at(-1).content
    assert.equal((current.match(/group-line-\d+;/g) ?? []).length, 100)
    assert.match(current, /group-line-30;/); assert.match(current, /group-line-129;/)
    assert.doesNotMatch(current, /group-line-29;|future-message/)
    assert.match(current, /【消息｜[^\n]+】\n当前请求$/)
    const saved = rolloutHistory(recentRollouts('hundred-lines')[0].id)!.context!.current!
    assert.equal(saved.recent.length, 100)
    assert.match(saved.recent[0], /group-line-30;/)
    assert.match(saved.heading, /^【消息｜/)
  } finally { await server.close() }
})

it('treats twenty history turns as forty messages and applies lowered limits before building the next request', async () => {
  const server = await mockServer(() => [200, { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, historyMaxTurns: 20, historyMaxTokens: 100000, groupContext: 0 }\nmemory: { enable: false }\ntools: { enable: false }\n`)
  config.load()
  const request = (convKey: string) => ({ e: fakeEvent({ message_type: 'private', group_id: undefined }).e, eff: config.effective(), input: { text: '当前请求', images: [], imageSegments: [] }, isAdmin: true, convKey })
  const seed = (key: string, count: number) => { for (let i = 0; i < count; i++) appendTurn(key, { role: 'user', content: [{ type: 'text', text: `history-question-${i}` }] }, { role: 'assistant', content: `history-answer-${i}` }) }
  try {
    seed('twenty-turns', 20)
    await runTurn(request('twenty-turns'))
    const full = rolloutHistory(recentRollouts('twenty-turns')[0].id)!.context!
    assert.deepEqual(full.history, { turns: 20, messages: 40, maxTurns: 20 })
    assert.equal(full.messages.filter(message => message.source === 'history').length, 40)
    assert.equal(full.omittedMessages, 0)
    seed('oversized-history', 31)
    await runTurn(request('oversized-history'))
    const trimmed = rolloutHistory(recentRollouts('oversized-history')[0].id)!.context!
    assert.ok(trimmed.history!.turns <= 20)
    const sent = server.requests[1].body.messages
    assert.equal(sent.filter(message => typeof message.content === 'string' && /^history-question-/.test(message.content)).length, trimmed.history!.turns)
    assert.ok(!sent.some(message => message.content === 'history-question-0'))
  } finally { await server.close() }
})
