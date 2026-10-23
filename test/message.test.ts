import './helpers.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'
import { extractInput } from '../src/chat/message.ts'
import { buildHeader } from '../src/chat/prompt.ts'
import { config } from '../src/core/config.ts'

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
beforeEach(() => { requests.length = 0 })
after(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('quoted sender identity', () => {
  it('preserves the quoted sender ID in both the sent and stored prompt, even for duplicate names', async () => {
    for (const userId of [42001, 42002]) {
      const e = { self_id: 10000, user_id: 20001, reply_id: 'original', getReply: async () => ({ sender: { user_id: userId, nickname: '同名群友' }, message: [{ type: 'text', text: '引用内容' }] }) }
      const input = await extractInput(e, { ...opts, includeImages: false })
      assert.equal(input.quoted!.senderId, String(userId))
      const header = buildHeader(e, config.effective(), input, false)
      for (const value of [header.sent, header.stored, header.context.quote]) assert.match(value, new RegExp(`引用同名群友\\(平台ID ${userId}\\) 的消息`))
    }
  })
  it('includes the bot ID on bot quotes and does not invent an ID or bot identity when unknown', async () => {
    const e = { self_id: 10000, user_id: 20001, reply_id: 'original', getReply: async () => ({ user_id: 10000, message: [{ type: 'text', text: '之前的回答' }] }) }
    const input = await extractInput(e, { ...opts, includeImages: false })
    assert.equal(input.quoted!.fromBot, true)
    assert.match(buildHeader(e, config.effective(), input, false).sent, /引用你\(平台ID 10000\)之前发的消息/)
    const unknown = await extractInput({ reply_id: 'original', getReply: async () => ({ message: [] }) }, { ...opts, includeImages: false })
    assert.equal(unknown.quoted!.senderId, undefined)
    assert.equal(unknown.quoted!.fromBot, false)
  })
})

describe('image input budget', () => {
  it('counts successful loads, not failed URLs, toward the image limit', async () => {
    const input = await extractInput({ message: [image('missing'), image('valid'), image('unneeded')] }, opts)
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid'])
    assert.equal(input.text, '[图片][图片][图片]')
  })

  it('fills the remaining budget from quoted images and does not retry duplicate URLs', async () => {
    const input = await extractInput({ message: [image('missing')], reply_id: 'quoted', getReply: async () => ({
      sender: { user_id: 42 }, message: [image('missing'), image('valid')],
    }) }, opts)
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid'])
  })

  it('retains placeholders when all downloads fail or vision is disabled', async () => {
    const failed = await extractInput({ message: [image('missing')] }, opts)
    assert.equal(failed.text, '[图片]')
    assert.deepEqual(failed.images, [])
    requests.length = 0
    const disabled = await extractInput({ message: [image('valid')] }, { ...opts, vision: false })
    assert.equal(disabled.text, '[图片]')
    assert.deepEqual(disabled.images, [])
    assert.deepEqual(requests, [])
  })

  it('floors a fractional image limit without stalling the download loop', async () => {
    const input = await extractInput({ message: [image('missing'), image('valid'), image('unneeded')] }, { ...opts, maxImages: 1.5 })
    assert.equal(input.images.length, 1)
    assert.deepEqual(requests, ['/missing', '/valid'])
  })
})
