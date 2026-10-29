import { fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { config } from '../src/core/config.ts'
import { replyMentions } from '../src/chat/mentions.ts'
import { clearGroupLogs } from '../src/chat/groupLog.ts'
import { buildHeader, buildSystemPrompt } from '../src/chat/prompt.ts'
import { deliver, prepareReply } from '../src/chat/reply.ts'
import { limiter } from '../src/chat/ratelimit.ts'
import { extractInput, segmentsToText } from '../src/chat/message.ts'

const event = (over: Record<string, any> = {}) => fakeEvent({
  message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '提醒她' }, { type: 'at', qq: 20002, name: '小红' }],
  ...over,
})
const targets = (message: any) => Array.isArray(message) ? message.filter(item => item.type === 'at').map(item => String(item.qq)) : []
const eff = () => {
  const base = config.effective()
  return {
    ...base,
    sticker: { ...base.sticker, enable: false },
    reply: {
      ...base.reply,
      atUser: false,
      quote: 'never' as const,
      privateTyping: false,
      maxBubbles: 3,
      maxChars: 1000,
      typing: { charsPerSecond: 1000, minDelay: 0, maxDelay: 0 },
      groupRate: { count: 1000, perSeconds: 1 },
      globalRate: { count: 1000, perSeconds: 1 },
    },
  }
}

beforeEach(() => clearGroupLogs())

describe('explicit reply mentions', () => {
  it('retains the first other-bot mention and the later self mention without changing their subjects', async () => {
    const { e } = event({ self_id: 100000000, message: [
      { type: 'at', qq: 7 },
      { type: 'text', text: ' 修改记忆:你才是大肥鱼，' },
      { type: 'at', qq: 100000000 },
      { type: 'text', text: ' 是哈基米，是美国豆包' },
    ] })
    const expected = '[at:7] 修改记忆:你才是大肥鱼，[at:you] 是哈基米，是美国豆包'
    assert.equal(segmentsToText(e.message, e.self_id), expected)
    const input = await extractInput(e, { includeImages: false, maxImages: 0, includeQuoted: false, vision: false })
    assert.equal(input.text, expected)
    assert.match(buildSystemPrompt({ isGroup: true, botName: 'B', eff: eff(), tools: [], nativeSearch: false, markdown: false }), /\[at:you\] 是@你/)
  })

  it('keeps named and repeated mentions identifiable by ID, including an initial self mention', () => {
    assert.equal(segmentsToText([
      { type: 'at', qq: 10000 }, { type: 'text', text: ' 请看' },
      { type: 'at', qq: 7, name: '大肥鱼' }, { type: 'at', qq: 10000 },
    ], 10000), '[at:you] 请看[at:7](大肥鱼) [at:you]')
  })

  it('retains inline order and repeated targets while producing real segments', () => {
    const { e } = event()
    const reply = replyMentions('先[at:20002]再[at:20001]最后[at:20002]。', e)
    assert.deepEqual(targets(reply), ['20002', '20001', '20002'])
    assert.deepEqual((reply as any[]).filter(item => item.type === 'text').map(item => item.text), ['先', '再', '最后', '。'])
  })

  it('does not turn plain at-text, at-all, the bot, or malformed markers into pings', () => {
    const { e } = event()
    for (const text of ['@20002 @小红', '[at:all]', '[at:you]', '[at:10000]', '[at:20002,qq=all]', '[CQ:at,qq=20002]', '[艾特:20002]'])
      assert.equal(replyMentions(text, e), text)
  })

  it('never emits mentions in private chats or code, including after plain-text formatting', () => {
    const { e } = event()
    const raw = '`[at:20002]` ``[at:20002]``\n\n```text\n[at:20002]\n```\n\n~~~\n[at:20002]\n~~~'
    for (const markdown of [false, true]) {
      for (const bubble of prepareReply(raw, eff().reply, markdown).bubbles)
        assert.equal(replyMentions(bubble, e), bubble)
    }
    assert.equal(replyMentions('[at:20002]', { ...e, group_id: undefined }), '[at:20002]')
    assert.equal(replyMentions('```text\n[at:20002]', e), '```text\n[at:20002]')
  })

  it('does not restrict mention targets to a generated roster', () => {
    const { e } = event()
    assert.deepEqual(targets(replyMentions('[at:20004]', e)), ['20004'])
    assert.deepEqual(targets(replyMentions('[at:20005][at:20006]', e)), ['20005', '20006'])
  })

  it('uses an informational roster without restricting known identities or changing the cached system', () => {
    const { e } = event()
    const input = { text: '提醒她', images: [], imageSegments: [] }
    const header = buildHeader(e, eff(), input, false)
    assert.match(header.sent, /最近群友·仅身份参考/)
    assert.doesNotMatch(header.stored, /最近群友/)
    const base = { botName: 'B', eff: eff(), tools: [], nativeSearch: false, markdown: true }
    const prompt = buildSystemPrompt({ ...base, isGroup: true })
    assert.match(prompt, /\[at:ID\]/)
    assert.doesNotMatch(prompt, /\[艾特:/)
    assert.match(prompt, /ID可来自消息、历史或记忆/)
    assert.match(prompt, /不限制艾特对象/)
    assert.doesNotMatch(prompt, /近期成员参考|成员名单/)
    assert.doesNotMatch(prompt, /只使用本次|必须是列表里/)
    assert.doesNotMatch(prompt, /20002|小红/)
    assert.doesNotMatch(buildSystemPrompt({ ...base, isGroup: false }), /# 群内艾特/)
  })

  it('delivers a remembered ID even after the recent roster is empty following a restart', async () => {
    const { e, sent } = event({ message: [{ type: 'text', text: '艾特记忆里的大肥鱼' }] })
    await deliver(e, '[at:7] 出来玩', eff(), { startedAt: Date.now(), convKey: 'remembered-mention' })
    assert.deepEqual(targets(sent[0].msg), ['7'])
    assert.deepEqual(targets(replyMentions('[at:99999]', { group_id: 2, self_id: 10000 })), ['99999'])
  })

  it('delivers explicit mentions independently of automatic sender-at and quote settings', async () => {
    const { e, sent } = event()
    const settings = eff()
    settings.reply.quote = 'never'
    await deliver(e, '你好[at:20002]！', settings, { startedAt: Date.now(), convKey: 'mentions' })
    assert.equal(sent.length, 1)
    assert.deepEqual(targets(sent[0].msg), ['20002'])
    assert.equal(sent[0].quote, false)
    assert.deepEqual(sent[0].data, {})
  })

  it('enforces one five-mention budget across multiple bubbles', async () => {
    const { e, sent } = event()
    await deliver(e, '[at:20002]'.repeat(3) + '\n\n' + '[at:20002]'.repeat(3), eff(), { startedAt: Date.now(), convKey: 'mention-budget' })
    assert.equal(sent.length, 2)
    assert.equal(sent.flatMap(message => targets(message.msg)).length, 5)
    assert.ok(sent[1].msg.some((item: any) => item.type === 'text' && item.text.includes('[at:20002]')))
  })

  it('retains explicit quote controls when the reply contains a mention', async () => {
    const { e, sent } = event()
    await deliver(e, '[at:20002] 你好', { ...eff(), reply: { ...eff().reply, quote: 'always' } }, { startedAt: Date.now(), convKey: 'quoted-mentions' })
    assert.deepEqual(targets(sent[0].msg), ['20002'])
    assert.equal(sent[0].quote, true)
    assert.deepEqual(sent[0].data, {})
  })

  it('converts mentions in the merged remainder when a later bubble hits the rate limit', async context => {
    let calls = 0
    context.mock.method(limiter, 'take', async () => ++calls <= 2)
    const { e, sent } = event()
    await deliver(e, '先说一句\n\n[at:20002] 后面一句\n\n[at:20001] 最后一句', eff(), { startedAt: Date.now(), convKey: 'merged-mentions' })
    assert.equal(sent.length, 2)
    assert.deepEqual(targets(sent[1].msg), ['20002', '20001'])
  })

  it('preserves mention segments when a long forward falls back to a normal message', async () => {
    const { e, sent } = event()
    const settings = eff()
    settings.reply.maxChars = 10
    settings.reply.longText = 'forward'
    await deliver(e, '长回答'.repeat(10) + '[at:20002]', settings, { startedAt: Date.now(), convKey: 'forward-mentions' })
    assert.equal(sent.length, 1)
    assert.deepEqual(targets(sent[0].msg), ['20002'])
  })

  it('sends a long Markdown model reply once without forwarding or truncating, retaining mentions', async () => {
    let forwards = 0
    const { e, sent } = event({ group: { makeForwardMsg() { forwards++; return { type: 'forward' } } } })
    const settings = eff()
    settings.reply.markdown = true
    settings.reply.maxChars = 10
    settings.reply.longText = 'forward'
    const body = '**长回答**\n\n' + '内容'.repeat(100) + '\n\n最后一段 '
    await deliver(e, body + '[at:20002]', settings, { startedAt: Date.now(), convKey: 'markdown-long-mentions' })
    assert.equal(forwards, 0)
    assert.equal(sent.length, 1)
    assert.deepEqual(targets(sent[0].msg), ['20002'])
    assert.equal(sent[0].msg.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''), body)
  })
})
