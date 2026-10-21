import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchStickerAddIntent } from '../src/stickers/add.ts'
import { registry } from '../src/tools/registry.ts'
import { registerStickerTools } from '../src/stickers/tool.ts'
import { addImageSticker, listStickers } from '../src/stickers/store.ts'

registerStickerTools()

describe('sticker intent parser', () => {
  it('parses standard add intent', () => {
    const res = matchStickerAddIntent('加一下这个表情')
    assert.ok(res?.matched)
  })

  it('strips [图片] and [表情包] segment tags without treating them as sticker name', () => {
    const res1 = matchStickerAddIntent('加一下这个表情 [表情包]')
    assert.ok(res1?.matched)
    assert.equal(res1.name, undefined)

    const res2 = matchStickerAddIntent('[图片] 帮我保存一下这个表情')
    assert.ok(res2?.matched)
    assert.equal(res2.name, undefined)

    const res3 = matchStickerAddIntent('把这个表情存一下 叫开心猫猫 [图片]')
    assert.ok(res3?.matched)
    assert.equal(res3.name, '开心猫猫')
  })

  it('ignores non-add queries', () => {
    assert.equal(matchStickerAddIntent('发个表情包来看看'), null)
    assert.equal(matchStickerAddIntent('今天天气真好'), null)
  })
})

describe('sticker tool registry', () => {
  it('has add_sticker and list_stickers registered', () => {
    const addTool = registry.get('add_sticker')
    assert.ok(addTool, 'add_sticker is registered in registry')
    assert.equal(addTool.source, 'builtin')

    const listTool = registry.get('list_stickers')
    assert.ok(listTool, 'list_stickers is registered in registry')
  })

  it('add_sticker checks admin permission', async () => {
    const addTool = registry.get('add_sticker')!
    const mockCtx: any = {
      isAdmin: false,
      e: { user_id: '12345', message: [] },
      eff: { sticker: { enable: true } },
    }
    const res = await addTool.run({}, mockCtx)
    assert.ok(typeof res === 'object' && res.isError)
    assert.match((res as any).content, /权限不足/)
  })

  it('add_sticker detects missing image', async () => {
    const addTool = registry.get('add_sticker')!
    const mockCtx: any = {
      isAdmin: true,
      e: { user_id: '12345', message: [{ type: 'text', text: '存一下' }] },
      eff: { sticker: { enable: true } },
    }
    const res = await addTool.run({}, mockCtx)
    assert.ok(typeof res === 'object' && res.isError)
    assert.match((res as any).content, /未在当前消息或引用的消息中找到任何图片/)
  })

  it('list_stickers returns saved stickers', async () => {
    const listTool = registry.get('list_stickers')!
    const res = await listTool.run({}, {} as any)
    assert.ok(typeof res === 'string')
  })
})
