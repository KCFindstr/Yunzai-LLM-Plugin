import { TMP, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { chatImageScope, imageScope, listImages, readImage, pruneImages, IMAGE_TTL_MS, saveImage } from '../src/chat/images.ts'
import { clearSession, peekSession, sessionKey } from '../src/chat/session.ts'
import { currentImages, registerImageTools } from '../src/tools/images.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'
import { runTurn } from '../src/chat/agent.ts'

const part = { type: 'image' as const, mime: 'image/png', data: Buffer.from('89504e470d0a1a0a01020000', 'hex').toString('base64') }
const secondPart = { ...part, data: Buffer.concat([Buffer.from(part.data, 'base64'), Buffer.from([2])]).toString('base64') }
registerImageTools()

it('reads saved image bytes into vision context on a later chat turn', async () => {
  let file = ''
  const server = await mockServer(request => {
    const messages = JSON.stringify(request.body.messages)
    assert.ok(!request.body.tools.some((tool: any) => tool.function.name === 'list_images'))
    assert.ok(messages.includes('附图以 [图片N:路径] 标注'))
    file ||= messages.match(/\/work\/attachments\/[a-f0-9]{10}\/image-[a-f0-9]{40}\.png/)![0]
    if (request.body.messages.some((message: any) => message.role === 'tool')) {
      assert.ok(messages.includes(`data:image/png;base64,${part.data}`))
      return [200, { choices: [{ message: { role: 'assistant', content: 'I can see the saved image.' }, finish_reason: 'stop' }] }]
    }
    if (messages.includes('Read the earlier image')) return [200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] }, finish_reason: 'tool_calls' }] }]
    const current = request.body.messages.findLast((message: any) => message.role === 'user').content
    assert.equal(current[1].text, '[图片1:' + file + ']')
    assert.ok(current[2].image_url.url.endsWith(part.data))
    assert.match(current[3].text, /^\[图片2:\/work\/attachments\//)
    assert.ok(current[4].image_url.url.endsWith(secondPart.data))
    return [200, { choices: [{ message: { role: 'assistant', content: 'Saved.' }, finish_reason: 'stop' }] }]
  })
  try {
    writeUserConfig(`providers:\n  mock:\n    type: openai\n    baseUrl: ${server.url}\n    apiKey: fake\nmodels:\n  - id: test\n    provider: mock\n    model: vision\n    vision: true\n    thinking: off\ndefaultModel: test\n`)
    config.load()
    const { e } = fakeEvent(), eff = config.effective(), convKey = sessionKey(e, eff.chat.sessionScope)
    eff.chat.summarize = false
    eff.chat.thinking = 'off'
    config.set('memory.enable', false)
    const first = await runTurn({ e, eff, convKey, isAdmin: true, input: { text: 'Save this image', images: [part, secondPart], imageSegments: [] } })
    assert.equal(first.kind, 'reply')
    const history = JSON.stringify(peekSession(convKey)?.messages)
    assert.ok(history.includes('[图片1:' + file + ']'))
    assert.match(history, /\[图片2:\/work\/attachments\//)
    assert.ok(!history.includes(part.data))
    const second = await runTurn({ e, eff, convKey, isAdmin: true, input: { text: 'Read the earlier image', images: [], imageSegments: [] } })
    assert.equal(second.kind, 'reply')
    assert.equal(server.requests.length, 3)
    clearSession(convKey)
    assert.equal(listImages(chatImageScope(e)).length, 2)
  } finally { await server.close() }
})

it('reads earlier images of the same chat without a staging step, but never other chats or host files', async () => {
  const { e } = fakeEvent()
  const ctx: ToolCtx = { e, eff: config.effective(), isAdmin: true, model: { vision: true } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [], inputImages: [part] } }
  const saved = currentImages(ctx)[0]
  assert.ok(saved.path.startsWith(`/work/attachments/${chatImageScope(e)}/`))
  ctx.turn.inputImages = []
  ctx.turn.imageRefs = []
  assert.throws(() => readImage(1, chatImageScope(e)), /当前对话/)
  const other = saveImage(imageScope('other conversation'), part)
  const hostFile = path.join(TMP, 'host-image.png')
  fs.writeFileSync(hostFile, Buffer.from(part.data, 'base64'))
  const read = registry.get('read_file')!
  const slashed = hostFile.replaceAll('\\', '/')
  for (const forbidden of [other.path, hostFile, slashed, 'file:///' + slashed, 'C:/Windows/win.ini', 'relative/without-workspace.png']) {
    const { results } = await registry.execute([{ id: 'x', name: 'read_file', args: { path: forbidden } }], ctx, [read])
    assert.equal(results[0].isError, true, forbidden)
    assert.equal(results[0].images, undefined, forbidden)
  }
  const { results } = await registry.execute([{ id: 'r', name: 'read_file', args: { path: saved.path } }], ctx, [read])
  assert.equal(results[0].images?.[0].data, part.data)
  assert.deepEqual(ctx.turn.images, [])
  assert.equal(currentImages(ctx)[0].path, saved.path)
})

it('prunes images only by TTL, independently of clearing or expiring chats', () => {
  const conv = 'ttl-independent', scope = imageScope(conv), saved = saveImage(scope, part)
  const file = path.join(TMP, 'data/images', scope, saved.name)
  clearSession(conv)
  assert.equal(readImage(saved.path, scope).part.data, part.data)
  const index = path.join(TMP, 'data/images', scope, 'index.json')
  fs.writeFileSync(index, JSON.stringify([{ ...saved, at: Date.now() - IMAGE_TTL_MS - 1 }]))
  assert.ok(fs.existsSync(file))
  pruneImages()
  assert.ok(!fs.existsSync(file))
  assert.throws(() => readImage(saved.path, scope), /不可用/)
})
