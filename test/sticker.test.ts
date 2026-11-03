import { TMP } from './helpers.ts' // must be first: isolates config/data dirs (never touch the real sticker store)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const { registry } = await import('../src/tools/registry.ts')
const { registerStickerTools } = await import('../src/stickers/tool.ts')
const { addImageSticker, listStickers, removeSticker, resolveSticker, stickerFile } = await import('../src/stickers/store.ts')
const { extractStickerMarkers, sendSticker, stickerPromptLines } = await import('../src/stickers/picker.ts')

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

  it('does not count wrapped adapter failures as successful sends', async () => {
    const [s] = addImageSticker(Buffer.concat([PNG, Buffer.from('delivery')]), { name: '发送测试' })
    const cfg = { sendAs: 'sticker' as const, maxSendSize: 240 }
    try {
      for (const result of [false, { error: [Error('QQBot delivery failed')] }, { status: 'failed', retcode: -1 }]) {
        assert.equal(await sendSticker({ reply: async () => result }, s, cfg), false)
        assert.equal(s.uses, 0)
      }
      assert.equal(await sendSticker({ reply: async () => ({ message_id: 1, error: [] }) }, s, cfg), true)
      assert.equal(s.uses, 1)
    } finally { removeSticker(s.id) }
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
    assert.match(res.content, /请提供要保存的图片 path/)
  })

  it('list_stickers queries across all fields: name, desc, use, tags, text', async () => {
    for (const s of listStickers()) removeSticker(s.id)
    const [s] = addImageSticker(Buffer.concat([PNG, Buffer.from('query_all_fields')]), {
      name: '智械危机',
      desc: 'Q版猫猫握拳笑',
      use: '投喂时装凶卖萌',
      tags: ['哈基米', '傲娇'],
      text: '等智械危机了我放你一马',
    })
    try {
      const tool = registry.get('list_stickers')!
      // query by name
      const byName = String(await tool.run({ query: '智械' }, {} as any))
      assert.match(byName, /智械危机/)
      // query by desc
      const byDesc = String(await tool.run({ query: '握拳笑' }, {} as any))
      assert.match(byDesc, /智械危机/)
      // query by use
      const byUse = String(await tool.run({ query: '装凶卖萌' }, {} as any))
      assert.match(byUse, /智械危机/)
      assert.match(byUse, /\[场景: 投喂时装凶卖萌\]/)
      // query by tags
      const byTag = String(await tool.run({ query: '傲娇' }, {} as any))
      assert.match(byTag, /智械危机/)
      // query by text
      const byText = String(await tool.run({ query: '放你一马' }, {} as any))
      assert.match(byText, /智械危机/)
      assert.match(byText, /\[文字: 等智械危机了我放你一马\]/)
      // query not found
      const notFound = String(await tool.run({ query: '绝对不存在的关键词123' }, {} as any))
      assert.match(notFound, /未找到与“绝对不存在的关键词123”相关的表情包/)
    } finally {
      removeSticker(s.id)
    }
  })

  it('resolves stickers using name, tags, text, use, desc and fuzzy similarity', () => {
    const [s] = addImageSticker(Buffer.concat([PNG, Buffer.from('robot_crisis')]), {
      name: '智械危机放你一马',
      desc: 'Q版哈基米握拳笑',
      use: '群友发好玩的时装凶卖萌',
      tags: ['哈基米', '傲娇威胁'],
      text: '等智械危机了我放你一马',
    })
    try {
      assert.equal(resolveSticker('智械危机放你一马')?.id, s.id)
      assert.equal(resolveSticker('等智械危机了我放你一马')?.id, s.id)
      assert.equal(resolveSticker('智械危机')?.id, s.id)
      assert.equal(resolveSticker('傲娇威胁')?.id, s.id)
      assert.equal(resolveSticker('放你一马')?.id, s.id)
      assert.equal(resolveSticker('装凶卖萌')?.id, s.id)
      assert.equal(resolveSticker('握拳笑')?.id, s.id)
      const [eng] = addImageSticker(Buffer.concat([PNG, Buffer.from('english_test')]), {
        name: 'CoolCat',
        desc: 'Cat with sunglasses',
        use: 'When feeling confident',
        tags: ['Swag', 'AI'],
        text: 'NO PROBLEM',
      })
      try {
        assert.equal(resolveSticker('coolcat')?.id, eng.id)
        assert.equal(resolveSticker('no problem')?.id, eng.id)
        assert.equal(resolveSticker('swag')?.id, eng.id)
        assert.equal(resolveSticker('confident')?.id, eng.id)
        assert.equal(resolveSticker('sunglasses')?.id, eng.id)
      } finally {
        removeSticker(eng.id)
      }
    } finally {
      removeSticker(s.id)
    }
  })

  it('list_stickers reports an empty library', async () => {
    for (const s of listStickers()) removeSticker(s.id)
    assert.match(String(await registry.get('list_stickers')!.run({}, {} as any)), /为空/)
  })
})


it('add_sticker saves only the explicit path, independently of current context images', async () => {
  const { chatImageScope, saveImage } = await import('../src/chat/images.ts')
  const e = { self_id: 'bot', user_id: '1', message: [{ type: 'image', url: 'https://must-not-fetch.invalid/image.png' }], getReply: () => { throw Error('must not collect context') } }
  const selected = saveImage(chatImageScope(e), { type: 'image', data: PNG.toString('base64') })
  const result: any = await registry.get('add_sticker')!.run({ path: selected.path, name: '指定图片', desc: '指定的图', use: '表示开心', tags: ['开心', '猫', '可爱'], text: '' }, {
    isAdmin: true, e, eff: { sticker: { enable: true } }, turn: { images: [] },
  } as any)
  assert.ok(!result.isError, result.content)
  const saved = listStickers().find(sticker => sticker.name === '指定图片')!
  assert.ok(saved)
  assert.deepEqual(fs.readFileSync(stickerFile(saved)!), PNG)
  removeSticker(saved.id)
  const required = registry.get('add_sticker')!.parameters.required
  assert.ok(required.includes('path'))
})
