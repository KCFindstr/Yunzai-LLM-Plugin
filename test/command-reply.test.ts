import { fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { commandEvent, commandForward, commandMarkdown, flushCommand } from '../src/commands/reply.ts'
import type { ReplySection } from '../src/core/configTypes.ts'
import { config } from '../src/core/config.ts'
import { LLMAdmin } from '../src/apps/admin.ts'
import { closeOwnBrowser, renderHtml } from '../src/render/browser.ts'
import { responsePages, isLongResponse } from '../src/render/response.ts'
import { deliver } from '../src/chat/reply.ts'
import * as help from '../src/help.ts'

const settings = (markdown: ReplySection['markdown']) => ({ markdown }) as ReplySection
const isImage = (message: any) => message?.type === 'image' && Buffer.isBuffer(message.file) && message.file.readUInt32BE(0) === 0x89504e47
after(closeOwnBrowser)

describe('command reply formatting', () => {
  it('accepts short and arbitrarily long numeric group IDs in admin commands', async () => {
    config.set('reply.markdown', false)
    for (const id of ['1', '2', '0001', '123456789012345678901234567890']) {
      const text = `#llm关闭 ${id}`
      const { e, sent } = fakeEvent({ isMaster: true, msg: text, message: [{ type: 'text', text }] })
      const admin = new LLMAdmin()
      admin.e = e
      await admin.dispatch()
      assert.equal(config.get().groups[id]?.enable, false)
      assert.match(String(sent.at(-1)?.msg), new RegExp(`群 ${id} 已关闭`))
    }
  })

  it('preserves literal command syntax and dollar prices in short Markdown replies', () => {
    assert.match(commandMarkdown('【价格】\n#llm设置 <路径>\n$1/$2'), /` #llm设置 <路径> `/)
    assert.match(commandMarkdown('$1/$2'), /` \$1 `\/` \$2 `/)
  })

  it('keeps short plain replies unchanged and preserves event binding', async () => {
    const original = { reply(text: string) { assert.equal(this, original); return text } }
    assert.equal(await commandEvent(original, settings(false)).reply('$1'), '$1')
  })

  it('formats only text while preserving segments and arguments', async () => {
    const image = { type: 'image', file: Buffer.from('image') }
    const calls: any[] = []
    const original = { group_id: 1, reply(...args: any[]) { assert.equal(this, original); calls.push(args); return 123 } }
    const message = ['$1', image, { type: 'text', data: { text: '#llm帮助' } }]
    assert.equal(await commandEvent(original, settings(true)).reply(message, true, { at: false }), 123)
    assert.deepEqual(calls, [[['` $1 `', image, { type: 'text', data: { text: '- ` #llm帮助 `' } }], true, { at: false }]])
    assert.equal(message[0], '$1')
  })

  it('uses auto mode only in QQBot groups and forces short DM replies to plain text', async () => {
    const qq = { group_id: 1, adapter_name: 'QQBot', reply: (text: string) => text }
    assert.equal(await commandEvent(qq, settings('auto')).reply('$1'), '` $1 `')
    const dm = { adapter_name: 'QQBot', message_type: 'private', reply: (text: string) => text }
    assert.equal(await commandEvent(dm, settings(true)).reply('$1'), '$1')
  })

  it('builds escaped, paginated templates without treating command syntax as Markdown', () => {
    const sections = [help.USER_HELP, help.ADMIN_HELP_BASIC, help.ADMIN_HELP_MODEL, help.ADMIN_HELP_BILLING, help.ADMIN_HELP_PERSONA, help.ADMIN_HELP_STICKER, help.ADMIN_HELP_TOOLS]
    const pages = responsePages(sections, '天津风', true)
    const html = pages.join('\n')
    assert.ok(pages.length > 1)
    assert.match(html, /class="command"/)
    assert.match(html, /#llm帮助/)
    assert.match(html, /管理 · 工具 \/ 技能 \/ 指令/)
    assert.match(responsePages(['$1/$2 #hash <script>evil</script> & x'], 'title', true)[0], /\$1\/\$2 #hash &lt;script&gt;evil&lt;\/script&gt; &amp; x/)
    const long = responsePages(['独白'.repeat(3000)], '故事')
    assert.ok(long.length > 1, 'unstructured text is paginated too')
    assert.equal(long.join('').match(/独白/g)?.length, 3000, 'no lost tail')
    assert.equal(isLongResponse('x'.repeat(601)), true)
    assert.equal(isLongResponse(Array(14).fill('line').join('\n')), true)
  })

  it('renders actual admin help as HTML pictures, never forwarding or sending a long Markdown blob', async () => {
    config.set('reply.markdown', true)
    let forwarded = 0
    const { e, sent } = fakeEvent({ isMaster: true, msg: '#llm帮助', group: { makeForwardMsg() { forwarded++; throw Error('must not forward') } } })
    const admin = new LLMAdmin()
    admin.e = e
    await admin.dispatch()
    assert.equal(sent.length, 1)
    assert.ok(sent.every(item => isImage(item.msg)))
    assert.ok(sent[0].msg.file.readUInt32BE(16) <= 960, 'command images are rendered at half the previous dimensions')
    assert.equal(forwarded, 0)
    e.msg = '#llm不存在'
    await admin.dispatch()
    assert.equal(sent.length, 2)
    assert.equal(typeof sent.at(-1)!.msg, 'string', 'short command responses stay text')
    assert.ok(!isImage(sent.at(-1)!.msg))
  })

  it('renders long DM and OneBot built-in responses as images too', async () => {
    const { e, sent } = fakeEvent({ group_id: undefined, message_type: 'private' })
    const wrapped = commandEvent(e, settings(true))
    await wrapped.reply('长说明'.repeat(250))
    assert.ok(sent.length >= 1 && sent.every(item => isImage(item.msg)))
    sent.length = 0
    await commandForward(commandEvent(e, settings(false)), ['【帮助】\n#llm帮助', '【价格】\n$1/$2'])
    assert.ok(sent.every(item => isImage(item.msg)))
    sent.length = 0
    const originalImage = { type: 'image', file: Buffer.from('original') }
    await wrapped.reply([{ type: 'text', data: { text: '长段落'.repeat(250) } }, originalImage])
    assert.ok(Array.isArray(sent[0].msg))
    assert.ok(isImage(sent[0].msg[0]))
    assert.equal(sent[0].msg.at(-1), originalImage)
  })

  it('sends long model text as copyable text, not an image, keeping explicit mentions', async () => {
    const { e, sent } = fakeEvent()
    const eff = config.effective()
    eff.sticker.enable = false
    eff.reply.markdown = true
    eff.reply.typing = { charsPerSecond: 1000, minDelay: 0, maxDelay: 0 }
    eff.reply.groupRate = { count: 100, perSeconds: 1 }
    eff.reply.globalRate = { count: 100, perSeconds: 1 }
    await deliver(e, '```bash\n' + 'echo 故事\n'.repeat(120) + '```[at:20002]', eff, { startedAt: Date.now(), convKey: 'long-text' })
    assert.ok(sent.length > 0)
    const segments = sent.flatMap(item => Array.isArray(item.msg) ? item.msg : [item.msg])
    assert.ok(!segments.some(isImage), 'not auto-rendered')
    const text = segments.map(part => typeof part === 'string' ? part : part.type === 'text' ? part.text ?? part.data?.text ?? '' : '').join('')
    assert.equal(text.match(/echo 故事/g)?.length, 120, 'full text kept')
    assert.equal(segments.filter(part => part?.type === 'at').length, 1)
    assert.equal(segments.find(part => part?.type === 'at').qq, '20002')
  })

  it('merges all text and image replies from one command before sending exactly one image', async () => {
    const { e, sent } = fakeEvent()
    const wrapped = commandEvent(e, settings(false), true)
    await wrapped.reply('正在处理…')
    await commandForward(wrapped, [help.USER_HELP, help.ADMIN_HELP_BASIC])
    const preview = await renderHtml('<p>预览图</p>', { width: 240, scale: 1 })
    await wrapped.reply({ type: 'image', file: preview })
    await wrapped.reply('处理完成')
    assert.equal(sent.length, 0, 'no intermediate output')
    await flushCommand(wrapped)
    assert.equal(sent.length, 1)
    assert.ok(isImage(sent[0].msg))
    await flushCommand(wrapped)
    assert.equal(sent.length, 1, 'flush is idempotent')
  })

  it('keeps all help sections in one compact document without pagination or clipping', () => {
    const sections = [help.USER_HELP, help.ADMIN_HELP_BASIC, help.ADMIN_HELP_MODEL, help.ADMIN_HELP_BILLING, help.ADMIN_HELP_PERSONA, help.ADMIN_HELP_STICKER, help.ADMIN_HELP_TOOLS]
    const pages = responsePages(sections, '天津风', true, true)
    assert.equal(pages.length, 1)
    for (const section of sections) assert.ok(pages[0].includes(/^【([^】]+)】/m.exec(section)![1]))
    assert.match(pages[0], /columns:2/)
    assert.doesNotMatch(pages[0], /<footer>1 \/ /)
  })

  it('fits a tall document into one image rather than cropping the overflow', async () => {
    const image = await renderHtml('<div style="height:2400px">开头</div><p>结尾</p>', { width: 400, maxHeight: 800, scale: 1, fit: true })
    assert.ok(image.readUInt32BE(20) <= 800)
  })
})
