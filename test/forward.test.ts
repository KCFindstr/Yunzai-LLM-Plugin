import { fakeEvent, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { config } from '../src/core/config.ts'
import { clearGroupLogs, recentLines, recordGroupMessage } from '../src/chat/groupLog.ts'
import { forwardLines, segmentsToText } from '../src/chat/message.ts'

/** Forward segment as the QQBot bridge reports it, after the OneBot adapter flattens `data`. */
const node = (nickname: string, message: any[]) => ({ message_type: 'group', nickname, sender: { nickname }, message })
const text = (value: string) => ({ type: 'text', data: { text: value } })
const forward = (content: any[]) => ({ type: 'forward', id: 'qqforward_test', content })

describe('forwarded chat records', () => {
  it('renders each inner message with its own limit', () => {
    const long = '长'.repeat(500)
    const out = segmentsToText([forward([
      node('🧸', [text('有人加我的鱼')]),
      node('花海', [text(long)]),
      node('Royce', [{ type: 'image', data: { url: 'https://example.com/a.png', sub_type: 0 } }]),
      node('233', [text('666')]),
    ])])
    assert.match(out, /【聊天记录 4条】/)
    assert.match(out, /🧸: 有人加我的鱼/)
    assert.match(out, /Royce: \[图片\]/)
    // the long message is cut, but the messages after it are kept
    assert.match(out, /233: 666/)
    assert.ok(!out.includes(long))
  })

  it('summarizes inner messages beyond the count limit', () => {
    const lines = forwardLines(forward(Array.from({ length: 10 }, (_, index) => node(`u${index}`, [text(`m${index}`)]))), undefined, { perNode: 50, nodes: 3 })
    assert.deepEqual(lines, ['u0: m0', 'u1: m1', 'u2: m2', '（其余 7 条略）'])
  })

  it('keeps a placeholder for forwards without inline content and for nested forwards', () => {
    assert.equal(segmentsToText([{ type: 'forward', id: 'x' }]), '[聊天记录]')
    const out = segmentsToText([forward([node('a', [{ type: 'forward', data: { id: 'y', content: [node('b', [text('deep')])] } }])])])
    assert.match(out, /a: \[聊天记录\]/)
    assert.doesNotMatch(out, /deep/)
  })

  it('shows inner messages in the recent group log within a larger budget', () => {
    writeUserConfig('memory: { enable: false }\n')
    config.load()
    clearGroupLogs()
    const { e } = fakeEvent({ group_id: 77201, message_id: 'current' })
    const nodes = Array.from({ length: 40 }, (_, index) => node(`u${index}`, [text(`第${index}条消息内容`)]))
    recordGroupMessage({ ...e, user_id: 999, message_id: 'fwd', message: [forward(nodes)] })
    recordGroupMessage({ ...e, message: [{ type: 'text', text: '看看这个' }] })
    const [line] = recentLines(e, 10, 200)
    assert.match(line, /\[聊天记录 40条\]/)
    assert.match(line, /\n {2}u0: 第0条消息内容/)
    assert.match(line, /条略）/)
  })
})
