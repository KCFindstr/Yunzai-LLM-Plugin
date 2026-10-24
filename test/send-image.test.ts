import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import { saveImage, imageScope } from '../src/chat/images.ts'
import { scopeForImages } from '../src/tools/images.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, it } from 'node:test'
import { config, normalize } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { closeOwnBrowser } from '../src/render/browser.ts'
import { MAX_IMAGES_PER_TURN, registry, type ToolCtx } from '../src/tools/registry.ts'
import { downloadPublicImage, MAX_SENT_IMAGE_BYTES, registerSendImageTool } from '../src/tools/sendImage.ts'
import { resolvePublicUrl } from '../src/tools/ssrf.ts'
import { recentRollouts, rolloutHistory } from '../src/chat/rollouts.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
let hits = 0
const server = http.createServer((req, res) => {
  hits++
  if (req.url === '/redirect') { res.writeHead(302, { location: '/image' }); res.end(); return }
  if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); return }
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return }
  if (req.url === '/too-big') { res.writeHead(200, { 'content-length': MAX_SENT_IMAGE_BYTES + 1 }); res.end(); return }
  if (req.url === '/stream') { res.writeHead(200); res.end(Buffer.alloc(MAX_SENT_IMAGE_BYTES + 1)); return }
  if (req.url === '/missing') { res.writeHead(404); res.end(); return }
  if (req.url === '/fake.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html>not an image</html>'); return }
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  res.end(req.url === '/broken' ? PNG.subarray(0, 33) : PNG)
})
let base: string
// Production always resolves public DNS; the test resolver pins only this fixture host to its local server.
const resolveFixture: typeof resolvePublicUrl = async raw => {
  const url = new URL(raw)
  return url.hostname === 'image-fixture.test' ? { url, addresses: [{ address: '127.0.0.1', family: 4 }] } : resolvePublicUrl(raw)
}
const downloadFixture: typeof downloadPublicImage = (url, signal) => downloadPublicImage(url, signal, resolveFixture)
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://image-fixture.test:${(server.address() as any).port}`
  registerSendImageTool(downloadFixture)
})
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await closeOwnBrowser() })
function context(): ToolCtx {
  return { e: {}, eff: normalize({ tools: { enable: true, webFetch: { enable: true } } }) as any, isAdmin: false, model: { id: 'blind', provider: 'test', model: 'test', vision: false }, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}
async function send(path: string, ctx = context()) {
  return (await registry.execute([{ id: 'image', name: 'send_image', args: { url: base + path } }], ctx, [registry.get('send_image')!])).results[0]
}

it('downloads, decodes and queues original image bytes including untyped responses and public redirects', async () => {
  for (const path of ['/image', '/redirect']) {
    const ctx = context(), result = await send(path, ctx)
    assert.equal(result.isError, undefined, result.content)
    assert.deepEqual(ctx.turn.images, [PNG])
    assert.equal(result.images?.[0].mime, 'image/png')
    assert.match(result.remaining, /剩余 1 次.*余量 1 张/)
  }
})

it('rejects webpages, forged/truncated images, oversize streams and server errors without queueing anything', async () => {
  for (const path of ['/fake.png', '/broken', '/too-big', '/stream', '/missing']) {
    const ctx = context(), result = await send(path, ctx)
    assert.equal(result.isError, true, path)
    assert.equal(ctx.turn.images.length, 0)
    assert.equal(result.images, undefined)
    assert.equal(ctx.turn.imageRequests, 1)
  }
})

it('blocks private destinations, credentials and private redirects and caps redirect hops', async () => {
  const timeout = () => AbortSignal.timeout(3000)
  for (const raw of ['http://127.0.0.1/image', 'http://192.168.0.174/image', 'file:///tmp/a.png', 'https://user:password@example.com/image']) {
    await assert.rejects(downloadPublicImage(raw, timeout()))
  }
  await assert.rejects(downloadFixture(base + '/private', timeout()), /内网/)
  const before = hits
  await assert.rejects(downloadFixture(base + '/loop', timeout()), /重定向/)
  assert.equal(hits - before, 5)
})

it('enforces attempts and shared reply image slots, including parallel image calls', async () => {
  const ctx = context()
  await send('/fake.png', ctx); await send('/fake.png', ctx)
  const before = hits
  assert.equal((await send('/image', ctx)).isError, true)
  assert.equal(hits, before)
  const full = context(); full.turn.images = Array(MAX_IMAGES_PER_TURN).fill(PNG)
  const fullResult = await send('/image', full)
  assert.equal(fullResult.isError, true)
  assert.match(fullResult.remaining, /共享图片余量 0 张/)
  assert.equal(hits, before)
  const parallel = context(); parallel.turn.images.push(PNG)
  const results = await registry.execute([1, 2].map(id => ({ id: String(id), name: 'send_image', args: { url: base + '/image' } })), parallel, [registry.get('send_image')!])
  assert.equal(parallel.turn.images.length, MAX_IMAGES_PER_TURN)
  assert.equal(results.results.filter(result => !result.isError).length, 1)
  assert.ok(results.results.every(result => /剩余 0 次.*余量 0 张/.test(result.remaining)))
  const disabled = context(); disabled.eff.tools.webFetch.enable = false
  assert.ok(registry.forTurn(disabled).some(tool => tool.name === 'send_image'))
})

it('sends tool allowance notes to the actual model and carries a validated URL image into its final reply and rollout', async () => {
  const modelServer = await mockServer((_request, n) => [200, {
    choices: [{ message: n === 1 ? { content: '', tool_calls: [{ id: 'image-call', type: 'function', function: { name: 'send_image', arguments: JSON.stringify({ url: base + '/image' }) } }] } : { content: '这张图给你看看' }, finish_reason: n === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 },
  }])
  writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${modelServer.url}', apiKey: test-key, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, vision: false }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, maxToolRounds: 2 }\nmemory: { enable: false }\ntools: { sendImage: { maxPerTurn: 3 } }\n`)
  config.load()
  try {
    const outcome = await runTurn({ e: fakeEvent().e, eff: config.effective(), input: { text: '发这张图', images: [], imageSegments: [] }, isAdmin: true, convKey: 'url-image-test' })
    assert.equal(outcome.kind, 'reply')
    if (outcome.kind !== 'reply') return
    assert.deepEqual(outcome.images, [PNG])
    const result = modelServer.requests[1].body.messages.find(message => message.role === 'tool')
    assert.match(result.content, /【工具余量】send_image：剩余 2 次.*共享图片余量 1 张；全局剩余 20 次（辅助工具不占）；剩余工具轮次 1/)
    const event = rolloutHistory(recentRollouts('url-image-test')[0].id)!.events.find(event => event.callId === 'image-call' && event.phase === 'completed')!
    assert.equal(event.images?.length, 1)
  } finally { await modelServer.close() }
})

it('sends saved image paths of the current chat without network access, never another chat\'s', async () => {
  const ctx = context(), saved = saveImage(scopeForImages(ctx), { type: 'image', data: PNG.toString('base64') })
  const before = hits
  const tool = registry.get('send_image')!
  const result = await tool.run({ path: saved.path }, ctx) as any
  assert.equal(result.isError, undefined, result.content)
  assert.deepEqual(ctx.turn.images, [PNG])
  assert.equal(hits, before)
  const foreign = saveImage(imageScope('different-chat'), { type: 'image', data: PNG.toString('base64') })
  const other = context(), refused = await tool.run({ path: foreign.path }, other) as any
  assert.equal(refused.isError, true)
  assert.match(refused.content, /当前对话/)
  assert.deepEqual(other.turn.images, [])
})
