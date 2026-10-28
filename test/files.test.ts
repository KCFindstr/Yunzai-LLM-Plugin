import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import http from 'node:http'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { detectFileMime } from '../src/core/util.ts'
import { chatImageScope, imageScope, readFile, saveFile } from '../src/chat/images.ts'
import { captureMedia, extractInput, mediaRefs, quoteBody } from '../src/chat/message.ts'
import { sessionKey } from '../src/chat/session.ts'
import { registerImageTools } from '../src/tools/images.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'
import { runTurn } from '../src/chat/agent.ts'

registerImageTools()
const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(64, 7)])
const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')

it('recognises video, audio, PDF and text by content, and refuses formats no model reads', () => {
  assert.equal(detectFileMime(mp4), 'video/mp4')
  assert.equal(detectFileMime(Buffer.from('000000186674797068656963000000006d696631', 'hex')), undefined, 'HEIC is not a video')
  assert.equal(detectFileMime(pdf), 'application/pdf')
  assert.equal(detectFileMime(Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(8)])), 'audio/wav')
  assert.equal(detectFileMime(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16, 1)])), 'audio/mpeg')
  assert.equal(detectFileMime(Buffer.from('名字,分数\n小明,90\n'), 'scores.csv'), 'text/csv')
  assert.equal(detectFileMime(Buffer.from('plain words here\n')), 'text/plain')
  assert.equal(detectFileMime(Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.from([0, 1, 2, 3, 0xff, 0xfe])])), undefined, 'QQ silk voice')
  assert.equal(detectFileMime(Buffer.from('plain words'), 'tool.exe'), undefined)
})

it('stores files per chat and reads them back only from that chat', () => {
  const scope = imageScope('files-scope'), saved = saveFile(scope, mp4, 'clip.mp4')
  assert.match(saved.path, /^\/work\/attachments\/[a-f0-9]{10}\/file-[a-f0-9]{40}\.mp4$/)
  const { file, part } = readFile(saved.path, scope)
  assert.equal(file.mime, 'video/mp4')
  assert.deepEqual(part, { type: 'file', data: mp4.toString('base64'), mime: 'video/mp4' })
  assert.throws(() => readFile(saved.path, imageScope('another chat')), /当前对话/)
  assert.throws(() => saveFile(scope, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /格式不支持/)
})

it('puts video, voice and file labels where the quote had their placeholders', () => {
  assert.equal(quoteBody('看 [视频] 和 [图片]', ['[图片1:/a.png]'], ['[视频1:/b.mp4]']), '看 [视频1:/b.mp4] 和 [图片1:/a.png]')
  assert.equal(quoteBody('[文件:报告.pdf]', [], ['[文件1:/c.pdf]']), '[文件1:/c.pdf]')
  assert.deepEqual(mediaRefs([{ type: 'video', file: 'a.mp4', url: 'https://x/v' }, { type: 'video', url: 'https://x/v' }, { type: 'record', file: 'local.silk' }]),
    [{ url: 'https://x/v', name: 'a.mp4' }])
})

it('downloads message videos into the store and labels them for read_file', async () => {
  const media = http.createServer((req, res) => { res.writeHead(200); res.end(req.url === '/clip' ? mp4 : Buffer.from('#!SILK_V3\0\x01\x02\xff')) })
  await new Promise<void>(resolve => media.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(media.address() as any).port}`
  try {
    const { e } = fakeEvent({ message: [{ type: 'video', file: 'clip.mp4', url: `${base}/clip` }, { type: 'record', url: `${base}/voice` }] })
    const input = await extractInput(e, { includeImages: true, maxImages: 3, includeQuoted: false, vision: true })
    assert.equal(input.text, '[视频][语音]')
    assert.equal(input.files?.length, 1, 'silk voice is not stored')
    assert.equal(input.files![0].mime, 'video/mp4')
    assert.deepEqual(await captureMedia([{ url: `${base}/voice` }], chatImageScope(e)), [])
  } finally { await new Promise(resolve => media.close(resolve)) }
})

function toolCtx(provider: string, e = fakeEvent().e): ToolCtx {
  return { e, eff: config.effective(), isAdmin: true, model: { id: 'm', provider, model: 'm', vision: true } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}

it('read_file passes video natively only to models that accept it, and pages text files', async () => {
  writeUserConfig('providers:\n  gem:\n    type: gemini\n    apiKey: fake\n  plain:\n    type: openai\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: fake\nmodels:\n  - id: m\n    provider: gem\n    model: m\ndefaultModel: m\n')
  config.load()
  const read = registry.get('read_file')!
  const gemini = toolCtx('gem'), scope = chatImageScope(gemini.e)
  const video = saveFile(scope, mp4, 'clip.mp4')
  const ok = (await registry.execute([{ id: 'v', name: 'read_file', args: { path: video.path } }], gemini, [read])).results[0]
  assert.equal(ok.isError, undefined)
  assert.equal(ok.files?.[0].mime, 'video/mp4')
  assert.match(ok.content, /已作为原生视频加入上下文/)
  const refused = (await registry.execute([{ id: 'v', name: 'read_file', args: { path: video.path } }], toolCtx('plain', gemini.e), [read])).results[0]
  assert.equal(refused.isError, true)
  assert.equal(refused.files, undefined)
  assert.match(refused.content, /无法直接读取视频/)
  assert.doesNotMatch(refused.content, /agy|run_code/, 'neither tool is registered in this test')
  const text = saveFile(scope, Buffer.from('x'.repeat(7000)), 'notes.txt')
  const first = (await registry.execute([{ id: 't', name: 'read_file', args: { path: text.path } }], gemini, [read])).results[0]
  assert.match(first.content, /共 7000 字，本次第 0–6000 字；用 offset=6000 继续读/)
  const rest = (await registry.execute([{ id: 't', name: 'read_file', args: { path: text.path, offset: 6000 } }], gemini, [read])).results[0]
  assert.match(rest.content, /本次第 6000–7000 字）\nx{1000}/)
})

it('sends a read video to Gemini as a native video step', async () => {
  let path = ''
  const server = await mockServer(request => {
    const input = JSON.stringify(request.body.input)
    path ||= input.match(/\/work\/attachments\/[a-f0-9]{10}\/file-[a-f0-9]{40}\.mp4/)?.[0] ?? ''
    if (input.includes('"type":"video"')) {
      const video = request.body.input.flatMap((step: any) => step.content ?? []).find((part: any) => part.type === 'video')
      assert.deepEqual(video, { type: 'video', data: mp4.toString('base64'), mime_type: 'video/mp4' })
      return [200, { id: 'i2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '看完了' }] }], usage: {} }]
    }
    assert.ok(path, 'the stored video is labelled in the message')
    return [200, { id: 'i1', status: 'completed', steps: [{ type: 'function_call', id: 'c1', name: 'read_file', arguments: { path } }], usage: {} }]
  })
  try {
    writeUserConfig(`providers:\n  gem:\n    type: gemini\n    baseUrl: ${server.url}\n    apiKey: fake\nmodels:\n  - id: g\n    provider: gem\n    model: g\n    vision: true\n    thinking: off\n    serverState: false\ndefaultModel: g\n`)
    config.load()
    config.set('memory.enable', false)
    const { e } = fakeEvent(), eff = config.effective(), convKey = sessionKey(e, eff.chat.sessionScope)
    eff.chat.summarize = false
    eff.chat.thinking = 'off'
    const files = [saveFile(chatImageScope(e), mp4, 'clip.mp4')]
    const outcome = await runTurn({ e, eff, convKey, isAdmin: true, input: { text: '[视频] 这是什么', images: [], imageSegments: [], files } })
    assert.equal(outcome.kind, 'reply')
    assert.equal(server.requests.length, 2)
  } finally { await server.close() }
})
