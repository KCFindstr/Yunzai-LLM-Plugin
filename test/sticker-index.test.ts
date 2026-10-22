import { mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

// mock vision model: replies are queued per test; the first may deliberately leave fields out
let replies: any[] = []
let calls = 0
const server = await mockServer(async () => {
  calls++
  const content = JSON.stringify(replies.shift() ?? { name: '兜底', desc: '兜底', use: '兜底', tags: ['兜底'], text: '' })
  return [200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]
})
after(server.close)
writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: mock, maxRetries: 0 }\nmodels:\n  - { id: eye, provider: mock, model: fake, thinking: off }\ndefaultModel: eye\n`)

const { config } = await import('../src/core/config.ts')
config.load()
const { addImageSticker, findSticker, removeSticker } = await import('../src/stickers/store.ts')
const { indexSticker, stickerIncomplete } = await import('../src/stickers/indexer.ts')

const png = (n: number) => {
  // distinct 1x1 PNGs (the store dedupes by content hash): vary a trailing byte after IEND
  const base = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
  return Buffer.concat([base, Buffer.from([n])])
}
const full = { name: '猫猫同意', desc: '举牌的猫', use: '表示同意时', tags: ['猫', '同意', '可爱'], text: 'OK' }

beforeEach(() => { replies = []; calls = 0 })

describe('sticker recognition', () => {
  it('full mode replaces everything with the model reading', async () => {
    const [s] = addImageSticker(png(1))
    replies = [full]
    const r = await indexSticker(s)
    assert.deepEqual([r.name, r.use, r.tags, r.text], ['猫猫同意', '表示同意时', ['猫', '同意', '可爱'], 'OK'])
    assert.equal(stickerIncomplete(findSticker(s.id)!), false)
    removeSticker(s.id)
  })

  it('fill mode keeps a hand-given name and description and fills only the empty fields', async () => {
    const [s] = addImageSticker(png(2), { name: '你其实是', desc: '白发少女指着对方' })
    assert.equal(s.indexed, true)
    assert.equal(stickerIncomplete(s), true)
    replies = [{ ...full, name: '别的名字', desc: '别的描述' }]
    const r = await indexSticker(s, { mode: 'fill' })
    assert.deepEqual([r.name, r.desc, r.use, r.tags.length, r.text], ['你其实是', '白发少女指着对方', '表示同意时', 3, 'OK'])
    assert.equal(stickerIncomplete(findSticker(s.id)!), false)
    removeSticker(s.id)
  })

  it('asks again when usage or tags come back empty', async () => {
    const [s] = addImageSticker(png(3))
    replies = [{ name: '半截', desc: '只有一半', use: '', tags: [] }, full]
    const r = await indexSticker(s)
    assert.equal(calls, 2)
    assert.equal(r.use, '表示同意时')
    removeSticker(s.id)
  })

  it('dry run returns the suggestion without saving it', async () => {
    const [s] = addImageSticker(png(4), { name: '原名', desc: '原描述' })
    replies = [full]
    const r = await indexSticker(s, { mode: 'fill', dryRun: true })
    assert.equal(r.use, '表示同意时')
    assert.equal(findSticker(s.id)!.use, '')
    removeSticker(s.id)
  })
})

describe('adding stickers with what the chat model saw', async () => {
  const http = await import('node:http')
  const { addStickersFrom } = await import('../src/stickers/add.ts')
  // serves distinct tiny PNGs at /<n>
  const imgServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png(100 + Number(req.url!.slice(1))))
  })
  await new Promise<void>(r => imgServer.listen(0, '127.0.0.1', r))
  after(() => imgServer.close())
  const event = (n: number) => ({ user_id: 1, img: [`http://127.0.0.1:${(imgServer.address() as any).port}/${n}`], message: [] })

  it('saves all five fields the model filled in, without another vision call', async () => {
    const r = await addStickersFrom(event(1), { name: '狗头保命', desc: '戴墨镜的狗头', use: '说完骚话保命', tags: ['狗头', '保命', '搞笑'], text: '' }, { reply: false })
    assert.equal(calls, 0)
    const s = findSticker(r.added[0].id)!
    assert.deepEqual([s.name, s.use, s.tags, s.indexed], ['狗头保命', '说完骚话保命', ['狗头', '保命', '搞笑'], true])
    removeSticker(s.id)
  })

  it('keeps what the model gave and lets vision fill the rest (tags as a string are split too)', async () => {
    replies = [{ ...full, name: '另一个名字' }]
    const r = await addStickersFrom(event(2), { name: '猫猫无语', desc: '翻白眼的猫', tags: '无语、白眼' as any }, { reply: false })
    assert.equal(calls, 1)
    const s = findSticker(r.added[0].id)!
    assert.deepEqual([s.name, s.desc, s.use, s.tags], ['猫猫无语', '翻白眼的猫', '表示同意时', ['无语', '白眼']])
    removeSticker(s.id)
  })

  it('without any hint runs a full recognition', async () => {
    replies = [full]
    const r = await addStickersFrom(event(3), {}, { reply: false })
    assert.equal(findSticker(r.added[0].id)!.name, '猫猫同意')
    removeSticker(r.added[0].id)
  })
})
