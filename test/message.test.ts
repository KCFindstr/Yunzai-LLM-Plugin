import './helpers.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { extractInput } from '../src/chat/message.ts'
import { buildHeader } from '../src/chat/prompt.ts'
import { config } from '../src/core/config.ts'
import { chatImageScope, readImage, imageScope } from '../src/chat/images.ts'
import { recentLines, recordGroupMessage, clearGroupLogs } from '../src/chat/groupLog.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64')
const requests: string[] = []
const server = http.createServer((req, res) => {
  requests.push(req.url ?? '')
  if (req.url?.startsWith('/missing')) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(png)
})
let origin: string
const image = (name: string) => ({ type: 'image', url: `${origin}/${name}` })
const opts = { includeImages: true, includeQuoted: true, maxImages: 1, vision: true }

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
})
beforeEach(() => { requests.length = 0; clearGroupLogs() })
after(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('quoted sender identity', () => {
  it('normalizes wrapped replies and alternate sender identity fields', async () => {
    for (const [index, response] of [
      { sender_id: 'opaque-user', message: [{ type: 'text', text: '引用内容' }] },
      { sender: { uid: 'opaque-user' }, message: [{ type: 'text', text: '引用内容' }] },
      { retcode: 0, data: { message: { sender_id: 'opaque-user', segments: [{ type: 'text', data: { text: '引用内容' } }] } } },
    ].entries()) {
      const input = await extractInput({ self_id: 'bot', user_id: 'current', reply_id: `wrapped-${index}`, getReply: async () => response }, { ...opts, includeImages: false })
      assert.equal(input.quoted!.senderId, 'opaque-user')
      assert.equal(input.quoted!.text, '引用内容')
      assert.match(buildHeader({ self_id: 'bot', user_id: 'current' }, config.effective(), input, false).sent, /平台ID opaque-user/)
    }
  })
  it('keeps the quoted sender from source metadata when the fetched payload omits it or fetching fails', async () => {
    for (const getReply of [async () => ({ message: [{ type: 'text', text: '引用内容' }] }), async () => { throw Error('unavailable') }]) {
      const e = { self_id: 'bot', user_id: 'current', reply_id: 'source', source: { user_id: 'original', message: [{ type: 'text', text: '引用内容' }] }, getReply }
      const input = await extractInput(e, { ...opts, includeImages: false })
      assert.equal(input.quoted!.senderId, 'original')
      assert.match(buildHeader(e, config.effective(), input, false).stored, /平台ID original/)
    }
    const input = await extractInput({ self_id: 'bot', user_id: 'current', message: [{ type: 'reply', data: { id: 'ref', user_id: 'original' } }] }, { ...opts, includeImages: false })
    assert.equal(input.quoted!.senderId, 'original')
  })
  it('recovers missing sender IDs by exact message ID in the same bot and group only', async () => {
    const original: any = { self_id: 10000, group_id: 42500, user_id: 42501, message_id: 'original-image', sender: { nickname: '原发言人' }, message: [image('quoted')] }
    recordGroupMessage(original)
    await original._llmImageCapture
    const e = { self_id: 10000, group_id: 42500, user_id: 42502, reply_id: 'original-image', getReply: async () => ({ message: [image('quoted')] }) }
    const input = await extractInput(e, { ...opts, includeImages: false })
    assert.equal(input.quoted!.senderId, '42501')
    assert.match(buildHeader(e, config.effective(), input, false).sent, /【引用 原发言人\(平台ID 42501\)】/)
    for (const other of [{ ...e, group_id: 42503 }, { ...e, self_id: 10001 }]) {
      delete (other as any)._llmQuoted
      delete (other as any)._llmQuoting
      assert.equal((await extractInput(other, { ...opts, includeImages: false })).quoted!.senderId, undefined)
    }
  })
  it('labels quoted images inside the quote and recovers an unattributed sender from identical image bytes', async () => {
    const original: any = { self_id: 10000, group_id: 42510, user_id: 42511, message_id: 'posted', sender: { nickname: '会长' }, message: [image('poster')] }
    recordGroupMessage(original)
    await original._llmImageCapture
    // the platform's quote index does not map to the original message ID and carries no author
    const e = { self_id: 10000, group_id: 42510, user_id: 42511, reply_id: 'ref-idx-7', getReply: async () => ({ message: [image('poster')] }) }
    const input = await extractInput(e, opts)
    assert.equal(input.quoted!.senderId, '42511')
    assert.equal(input.quotedImageStart, 0)
    const path = input.savedImages![0].path
    const header = buildHeader(e, config.effective(), input, false)
    for (const value of [header.sent, header.stored]) assert.ok(value.includes(`【引用 会长(平台ID 42511)】[图片1:${path}]\n【消息｜`), value)
    // the same image from a second person leaves the author unknown
    const reposted: any = { ...original, user_id: 42512, message_id: 'reposted', _llmImageCapture: undefined }
    recordGroupMessage(reposted)
    await reposted._llmImageCapture
    await new Promise(resolve => setImmediate(resolve))
    const again = await extractInput({ ...e, _llmQuoted: undefined, _llmQuoting: undefined }, opts)
    assert.equal(again.quoted!.senderId, undefined)
    assert.match(buildHeader(e, config.effective(), again, false).sent, /【引用｜发送者ID未知】\[图片1:/)
  })
  it('preserves the quoted sender ID in both the sent and stored prompt, even for duplicate names', async () => {
    for (const userId of [42001, 42002]) {
      const e = { self_id: 10000, user_id: 20001, reply_id: 'original', getReply: async () => ({ sender: { user_id: userId, nickname: '同名群友' }, message: [{ type: 'text', text: '引用内容' }] }) }
      const input = await extractInput(e, { ...opts, includeImages: false })
      assert.equal(input.quoted!.senderId, String(userId))
      const header = buildHeader(e, config.effective(), input, false)
      for (const value of [header.sent, header.stored, header.context.quote]) assert.match(value, new RegExp(`【引用 同名群友\\(平台ID ${userId}\\)】引用内容`))
    }
  })
  it('includes the bot ID on bot quotes and does not invent an ID or bot identity when unknown', async () => {
    const e = { self_id: 10000, user_id: 20001, reply_id: 'original', getReply: async () => ({ user_id: 10000, message: [{ type: 'text', text: '之前的回答' }] }) }
    const input = await extractInput(e, { ...opts, includeImages: false })
    assert.equal(input.quoted!.fromBot, true)
    assert.match(buildHeader(e, config.effective(), input, false).sent, /【引用 你\(平台ID 10000\)】之前的回答/)
    const unknown = await extractInput({ reply_id: 'original', getReply: async () => ({ message: [] }) }, { ...opts, includeImages: false })
    assert.equal(unknown.quoted!.senderId, undefined)
    assert.equal(unknown.quoted!.fromBot, false)
    const header = buildHeader({ user_id: 20001 }, config.effective(), unknown, false)
    assert.match(header.sent, /【引用｜发送者ID未知】/)
    assert.doesNotMatch(header.sent, /引用某人|引用.*平台ID 20001/)
  })
})

describe('image input budget', () => {
  it('counts successful loads, not failed URLs, toward the image limit', async () => {
    const input = await extractInput({ message: [image('missing'), image('valid'), image('unneeded')] }, opts)
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid', '/unneeded'])
    assert.equal(input.savedImages?.length, 2)
    assert.equal(input.text, '[图片][图片][图片]')
  })

  it('fills the remaining budget from quoted images and does not retry duplicate URLs', async () => {
    const input = await extractInput({ message: [image('missing')], reply_id: 'quoted', getReply: async () => ({
      sender: { user_id: 42 }, message: [image('missing'), image('valid')],
    }) }, opts)
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid'])
  })

  it('retains placeholders and stores originals when vision is disabled', async () => {
    const failed = await extractInput({ message: [image('missing')] }, opts)
    assert.equal(failed.text, '[图片]')
    assert.deepEqual(failed.images, [])
    requests.length = 0
    const disabled = await extractInput({ message: [image('valid')] }, { ...opts, vision: false })
    assert.equal(disabled.text, '[图片]')
    assert.deepEqual(disabled.images, [])
    assert.deepEqual(requests, ['/valid'])
  })

  it('floors a fractional image limit without stalling the download loop', async () => {
    const input = await extractInput({ message: [image('missing'), image('valid'), image('unneeded')] }, { ...opts, maxImages: 1.5 })
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid', '/unneeded'])
  })
})

it('persists passive group images without a bot call and preserves complete paths in history', async () => {
  const e: any = { self_id: 10000, group_id: 42500, user_id: 42501, message_id: 'passive-store', sender: { nickname: 'Observer' }, message: [image('unused')] }
  recordGroupMessage(e)
  const stored = await e._llmImageCapture
  assert.equal(stored.savedImages.length, 1)
  const saved = stored.savedImages[0]
  assert.equal(readImage(saved.path, chatImageScope(e)).part.data, png.toString('base64'))
  const lines = recentLines({ ...e, message_id: 'later-message' }, 5, 12)
  assert.ok(lines.join('\n').includes(saved.path))
})

it('fetches the quote on the raw event, before the loader attaches getReply, without caching an empty result', async () => {
  const reply = { message: [image('raw-quote')] }
  const e: any = { self_id: 10000, group_id: 42700, user_id: 42701, message_id: 'raw', message: [{ type: 'reply', id: 'ref' }, { type: 'text', text: '这个' }],
    group: { getMsg: async (id: string) => (id === 'ref' ? reply : undefined) } }
  recordGroupMessage(e)
  const input = await extractInput(e, opts)
  assert.equal(input.quoted!.text, '[图片]')
  assert.equal(input.savedImages!.length, 1)
  assert.match(buildHeader(e, config.effective(), input, false).sent, /【引用｜发送者ID未知】\[图片1:/)
})

it('labels quoted images in recent group lines and recovers their sender from identical bytes', async () => {
  const base = { self_id: 10000, group_id: 42800, sender: { nickname: '会长' } }
  const original: any = { ...base, user_id: 42801, message_id: 'img', message: [image('recent-quote')] }
  recordGroupMessage(original)
  await original._llmImageCapture
  const reply: any = { ...base, user_id: 42802, sender: { nickname: '岛风风' }, message_id: 'q', message: [{ type: 'reply', id: 'REFIDX_x' }, { type: 'text', text: '这个' }],
    group: { getMsg: async () => ({ message: [image('recent-quote')] }) } }
  recordGroupMessage(reply)
  let line = ''
  for (let i = 0; i < 50 && !line.includes('[图片1:'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    line = recentLines({ ...base, message_id: 'later' }, 5, 100).at(-1) ?? ''
  }
  assert.match(line, /岛风风\(平台ID 42802\): 【引用 会长\(平台ID 42801\)】\[图片1:[^\]]+\]\n这个$/)
})

it('shows quoted messages in recent group lines within the per-message budget', async () => {
  const base = { self_id: 10000, group_id: 42600, user_id: 42601, sender: { nickname: '会长' } }
  recordGroupMessage({ ...base, message_id: 'recent', message: [{ type: 'text', text: '最近说的话' }] })
  recordGroupMessage({ ...base, message_id: 'reply-recent', message: [{ type: 'reply', id: 'recent' }, { type: 'text', text: '接上' }] })
  let fetched = 0
  const old: any = { ...base, message_id: 'reply-old', reply_id: 'gone', message: [{ type: 'reply', id: 'gone' }, { type: 'text', text: '哈基米内置的保护吧' }],
    getReply: async () => { fetched++; return { sender: { user_id: 42602, nickname: '妹弓' }, message: [{ type: 'text', text: '很久以前的一句话'.repeat(10) }] } } }
  recordGroupMessage(old)
  const quoted = await extractInput(old, { ...opts, includeImages: false })
  assert.equal(fetched, 1, 'group log and reply path share one lookup')
  assert.match(quoted.quoted!.text, /很久以前/)
  const lines = recentLines({ ...base, message_id: 'later' }, 5, 50)
  assert.match(lines[1], /: 【引用 会长\(平台ID 42601\)】最近说的话\n接上$/)
  assert.match(lines[2], /: 【引用 妹弓\(平台ID 42602\)】(很久以前[^\n]*…)\n哈基米内置的保护吧$/)
  const [, quotedText] = /】([^\n]*)\n/.exec(lines[2])!
  assert.ok(quotedText.length + '哈基米内置的保护吧'.length <= 50)
})

it('saves images even when they are not supplied to a vision model', async () => {
  const event = { self_id: 'bot', user_id: 'owner', message: [image('not-used-by-vision')] }
  const input = await extractInput(event, { ...opts, maxImages: 0, vision: false })
  assert.equal(input.images.length, 0)
  assert.equal(input.savedImages?.length, 1)
  assert.equal(readImage(input.savedImages![0].path, chatImageScope(event)).part.data, png.toString('base64'))
})
