import { TMP } from './helpers.ts' // must be first: isolates config/data dirs (never touch the real sticker store)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const { registry } = await import('../src/tools/registry.ts')
const { registerStickerTools } = await import('../src/stickers/tool.ts')
const { addImageSticker, listStickers, removeSticker, stickerFile } = await import('../src/stickers/store.ts')
const { extractStickerMarkers, stickerPromptLines } = await import('../src/stickers/picker.ts')

registerStickerTools()

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('sticker store & prompt', () => {
  it('uses the isolated data dir', () => {
    const [s] = addImageSticker(PNG, { name: '测试' })
    assert.ok(stickerFile(s)!.startsWith(TMP), 'sticker files go to the temp dir')
    removeSticker(s.id)
  })

  it('lists stickers named by an admin even when auto-recognition failed', () => {
    const [named] = addImageSticker(Buffer.concat([PNG, Buffer.from('a')]), { name: '开心猫猫' })
    const [anon] = addImageSticker(Buffer.concat([PNG, Buffer.from('b')]))
    assert.equal(named.indexed, false)
    const lines = stickerPromptLines(50)
    assert.ok(lines.some(l => l.startsWith('- 开心猫猫')), 'named but unrecognised sticker is listed')
    assert.ok(!lines.some(l => l.includes('未命名')), 'unnamed + unrecognised sticker is not listed')
    removeSticker(named.id)
    removeSticker(anon.id)
  })

  it('removing a sticker also removes its cached send copy', () => {
    const [s] = addImageSticker(Buffer.concat([PNG, Buffer.from('c')]), { name: '缓存测试' })
    const f = stickerFile(s)!
    const copy = path.join(path.dirname(f), `${path.parse(f).name}.s240.png`)
    fs.writeFileSync(copy, PNG)
    removeSticker(s.id)
    assert.ok(!fs.existsSync(f) && !fs.existsSync(copy))
  })

  it('extracts markers in ASCII and full-width brackets', () => {
    assert.deepEqual(extractStickerMarkers('好耶 [表情:狗头]').names, ['狗头'])
    assert.deepEqual(extractStickerMarkers('（表情：开心）好').names, ['开心'])
    assert.equal(extractStickerMarkers('（表情：开心）好').text, '好')
  })
})

describe('sticker tools', () => {
  it('registers add_sticker and list_stickers', () => {
    assert.equal(registry.get('add_sticker')?.source, 'builtin')
    assert.ok(registry.get('list_stickers'))
  })

  it('add_sticker refuses non-admins', async () => {
    const res: any = await registry.get('add_sticker')!.run({}, { isAdmin: false, e: { user_id: '1', message: [] }, eff: { sticker: { enable: true } } } as any)
    assert.ok(res.isError)
    assert.match(res.content, /权限不足/)
  })

  it('add_sticker reports a missing image', async () => {
    const res: any = await registry.get('add_sticker')!.run({}, { isAdmin: true, e: { user_id: '1', message: [{ type: 'text', text: '存一下' }] }, eff: { sticker: { enable: true } } } as any)
    assert.ok(res.isError)
    assert.match(res.content, /未在当前消息或引用的消息中找到任何图片/)
  })

  it('list_stickers reports an empty library', async () => {
    for (const s of listStickers()) removeSticker(s.id)
    assert.match(String(await registry.get('list_stickers')!.run({}, {} as any)), /为空/)
  })
})
