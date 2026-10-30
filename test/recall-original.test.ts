import { fakeEvent, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'

writeUserConfig('memory: { enable: true }\n')
const { config } = await import('../src/core/config.ts')
config.load()
const { appendTurn, clearSession, peekSession, sessionKey } = await import('../src/chat/session.ts')
const { registry } = await import('../src/tools/registry.ts')
const { registerMemoryTool } = await import('../src/memory/tool.ts')
registerMemoryTool()

const recall = (args: Record<string, any>, e: any) => registry.get('recall')!.run(args, { e, eff: config.effective(e.group_id), isAdmin: false, turn: {} } as any)
  .then(r => (typeof r === 'string' ? { content: r, isError: false } : r))

it('opens the original chat behind a summary, a page at a time', async () => {
  const { e } = fakeEvent({ msg: '还记得那张猫图吗' })
  const key = sessionKey(e, config.effective(e.group_id).chat.sessionScope)
  clearSession(key)
  appendTurn(key, { role: 'user', content: [{ type: 'text', text: '开始' }] }, { role: 'assistant', content: '好' })
  const s = peekSession(key)!
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const long = `岛风风：看这只猫 [图片1:/work/attachments/abc/image-1.jpg]\n${'喵'.repeat(5000)}`
  s.archive = [
    { id: 'ep1', at: Date.now() - 3600_000, day, text: '岛风风发了一张猫图，约好周六去看猫', sourceText: long },
    { id: 'ep2', at: Date.now() - 1800_000, day, text: '聊了火锅' },
  ]
  s.days = [{ id: 'd1', day, text: '岛风风发猫图并约周六看猫；聊火锅', at: Date.now(), sources: ['ep1', 'ep2'] }]

  const found = await recall({ query: '猫图' }, e)
  assert.match(found.content, /原文 id=ep1/)

  const first = await recall({ id: 'ep1' }, e)
  assert.match(first.content, /\/work\/attachments\/abc\/image-1\.jpg/)
  assert.match(first.content, /继续读用 offset=3000/)
  const rest = await recall({ id: 'ep1', offset: 3000 }, e)
  assert.match(rest.content, /从第 3000 字起/)
  assert.doesNotMatch(rest.content, /继续读/)

  // a digest's original is the chat of the episodes it was written from
  assert.match((await recall({ id: 'd1' }, e)).content, /看这只猫/)
  // an entry without a kept original, and other chats' entries, can't be opened
  assert.equal((await recall({ id: 'ep2' }, e)).isError, true)
  const { e: other } = fakeEvent({ user_id: 20099, group_id: 30099, sender: { user_id: 20099, nickname: '雪风' } })
  assert.equal((await recall({ id: 'ep1' }, other)).isError, true)
})
