import { fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { commandEvent, commandForward, commandMarkdown } from '../src/commands/reply.ts'
import type { ReplySection } from '../src/core/configTypes.ts'
import { config } from '../src/core/config.ts'
import { LLMAdmin } from '../src/apps/admin.ts'

const settings = (markdown: ReplySection['markdown']) => ({ markdown }) as ReplySection

describe('command reply formatting', () => {
  it('preserves literal commands, dollar prices, placeholders and untrusted Markdown', () => {
    assert.equal(commandMarkdown('【价格】\n#llm设置 <路径>\n$1/$2\n*[name](url) &amp;'),
      '## 价格\n\n- ` #llm设置 <路径> `\n\n` $1 `/` $2 `\n\n\\*\\[name\\]\\(url\\) &amp;amp;')
  })

  it('keeps plain replies unchanged when Markdown is disabled', () => {
    const original = { reply() {} }
    assert.equal(commandEvent(original, settings(false)), original)
  })

  it('formats only text while preserving segments, arguments and the original event', async () => {
    const image = { type: 'image', file: Buffer.from('image') }
    const calls: any[] = []
    const original = { group_id: 1, reply(...args: any[]) { assert.equal(this, original); calls.push(args); return 123 } }
    const wrapped = commandEvent(original, settings(true))
    const message = ['$1', image, { type: 'text', data: { text: '#llm帮助' } }]
    assert.equal(await wrapped.reply(message, true, { at: false }), 123)
    assert.deepEqual(calls, [[['` $1 `', image, { type: 'text', data: { text: '- ` #llm帮助 `' } }], true, { at: false }]])
    assert.equal(message[0], '$1')
    assert.equal(calls[0][0][1], image)
    assert.notEqual(wrapped.reply, original.reply)
  })

  it('uses existing auto mode adapter detection', () => {
    const qq = { group_id: 1, adapter_name: 'QQBot', reply: (text: string) => text }
    assert.equal(commandEvent(qq, settings('auto')).reply('$1'), '` $1 `')
    const onebot = { adapter_name: 'OneBot', reply: (text: string) => text }
    assert.equal(commandEvent(onebot, settings('auto')), onebot)
  })

  it('formats real help and error responses using the group override', async () => {
    config.set('reply.markdown', false)
    config.set('groups.30001.reply.markdown', true)
    const { e, sent } = fakeEvent({ msg: '#llm帮助', message: [{ type: 'text', text: '#llm帮助' }] })
    const admin = new LLMAdmin()
    admin.e = e
    await admin.dispatch()
    assert.match(sent[0].msg, /^## LLM 对话/)
    assert.ok(sent[0].msg.includes('` #llm帮助 `'))
    assert.ok(sent[0].msg.includes('` #llm删除记忆 <编号> `'))
    e.msg = '#llm不存在'
    await admin.dispatch()
    assert.ok(sent.at(-1)!.msg.includes('` #llm帮助 `'))
    config.set('groups.30001.reply.markdown', false)
    await admin.dispatch()
    assert.equal(sent.at(-1)!.msg, '没有这个指令，发送 #llm帮助 查看全部指令')
  })

  it('merges all admin help sections into one Markdown message without forwarding', async () => {
    config.set('reply.markdown', true)
    const forwarded: any[] = []
    const forward = { type: 'forward', id: 'help' }
    const { e, sent } = fakeEvent({
      isMaster: true,
      group_id: 40001,
      msg: '#llm帮助',
      group: { makeForwardMsg(nodes: any[]) { forwarded.push(nodes); return forward } },
    })
    const admin = new LLMAdmin()
    admin.e = e
    await admin.dispatch()
    assert.equal(sent.length, 1)
    assert.equal(forwarded.length, 0)
    assert.match(sent[0].msg, /^## LLM 对话/)
    assert.ok(sent[0].msg.includes('` #llm帮助 `'))
    assert.ok(sent[0].msg.includes('\n\n## 管理 · 基础'))
    assert.ok(sent[0].msg.includes('## 管理 · 工具 / 技能 / 指令'))
    config.set('reply.markdown', false)
    await admin.dispatch()
    assert.equal(forwarded.length, 1)
    assert.equal(sent[1].msg, forward)
    assert.match(forwarded[0][0].message, /^【LLM 对话/)
  })

  it('formats merged Markdown exactly once and preserves plain mode fallback nodes', async () => {
    const { e, sent } = fakeEvent()
    await commandForward(commandEvent(e, settings(true)), ['$1', '#llm帮助'])
    assert.deepEqual(sent.map(item => item.msg), ['` $1 `\n\n- ` #llm帮助 `'])
    await commandForward(commandEvent(e, settings(false)), ['$1', '#llm帮助'])
    assert.deepEqual(sent.slice(1).map(item => item.msg), ['$1', '#llm帮助'])
  })

  it('delivers help sections when Yunzai returns a forward error instead of throwing', async () => {
    const sections: string[] = []
    let forwardAttempts = 0
    const e = {
      self_id: 10000,
      group: { makeForwardMsg: (nodes: any[]) => ({ type: 'node', data: nodes }) },
      reply(message: any) {
        if (message.type === 'node') {
          forwardAttempts++
          return { error: [new Error('Unknown or unsupported API')] }
        }
        sections.push(message)
        return { message_id: `sent-${sections.length}` }
      },
    }
    await commandForward(commandEvent(e, settings(false)), ['【帮助】\n#llm帮助', '【价格】\n$1/$2'])
    assert.equal(forwardAttempts, 1)
    assert.deepEqual(sections, ['【帮助】\n#llm帮助', '【价格】\n$1/$2'])
  })

  it('forces unformatted DM commands even when Markdown is explicitly enabled', async () => {
    const { e, sent } = fakeEvent({ group_id: undefined, isGroup: false, message_type: 'private', msg: '#llm不存在' })
    config.set('reply.markdown', true)
    const admin = new LLMAdmin()
    admin.e = e
    await admin.dispatch()
    assert.equal(sent[0].msg, '没有这个指令，发送 #llm帮助 查看全部指令')
    assert.equal(commandEvent(e, settings(true)), e)
  })
})
