import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { appendTurn } from '../src/chat/session.ts'
import { markHandled, recordBotMessage, recordGroupMessage } from '../src/chat/groupLog.ts'
import { recentRollouts, rolloutHistory } from '../src/chat/rollouts.ts'

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
    assert.ok(current.indexOf('随后机器人回复') < current.indexOf('【消息】\n当前请求'))
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
