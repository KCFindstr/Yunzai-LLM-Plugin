import './helpers.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { registerWebTools } from '../src/tools/web.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64, 1)])
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(64, 1)])
const routes: Record<string, [string, Buffer | string]> = {
  '/pic.png': ['image/png', PNG],
  '/untyped': ['application/octet-stream', PNG],
  '/fake.png': ['image/png', '<html>not an image</html>'],
  '/pic.bmp': ['image/bmp', BMP],
  '/huge.png': ['image/png', Buffer.concat([PNG, Buffer.alloc(3_800_000)])],
  '/page': ['text/html', '<html><title>T</title><body><p>正文内容</p></body></html>'],
}
const server = http.createServer((req, res) => {
  const [type, body] = routes[req.url ?? ''] ?? ['text/plain', 'missing']
  res.writeHead(routes[req.url ?? ''] ? 200 : 404, { 'content-type': type })
  res.end(body)
})
let base = ''
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
  registerWebTools()
})
after(() => new Promise<void>(r => server.close(() => r())))

function context(vision = true): ToolCtx {
  return { e: {}, eff: normalize({ tools: { webFetch: { enable: true, allowPrivateNetwork: true, maxPerTurn: 10 } } }) as any,
    isAdmin: false, model: { vision } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}

async function fetchVia(path: string, ctx = context()) {
  const [result] = (await registry.execute([{ id: 'c1', name: 'web_fetch', args: { url: base + path } }], ctx, [registry.get('web_fetch')!])).results
  return result!
}

it('returns an image link as an image part for vision models, and says so in the text', async () => {
  const r = await fetchVia('/pic.png')
  assert.equal(r.isError, undefined)
  assert.match(r.content, /image\/png/)
  assert.deepEqual(r.images, [{ type: 'image', data: PNG.toString('base64'), mime: 'image/png', detail: 'auto' }])
})

it('sniffs untyped images and rejects files that only claim to be images', async () => {
  assert.equal((await fetchVia('/untyped')).images?.[0]?.mime, 'image/png')
  for (const path of ['/fake.png', '/pic.bmp', '/huge.png']) {
    const r = await fetchVia(path)
    assert.equal(r.images, undefined, path)
  }
  assert.match((await fetchVia('/huge.png')).content, /超过/)
})

it('keeps text pages and non-vision models text-only', async () => {
  const page = await fetchVia('/page')
  assert.match(page.content, /正文内容/)
  assert.equal(page.images, undefined)
  const blind = await fetchVia('/pic.png', context(false))
  assert.equal(blind.images, undefined)
  assert.match(blind.content, /无法读取文本内容/)
})

it('hints the image behaviour in the tool description', () => {
  assert.match(registry.get('web_fetch')!.description, /图片/)
})
