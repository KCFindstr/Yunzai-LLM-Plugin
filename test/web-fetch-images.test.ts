import './helpers.ts'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { htmlToText, registerWebTools } from '../src/tools/web.ts'
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
  '/gallery/page': ['text/html', '<main><p>Chart gallery</p><a href="./full.png"><img src="../pic.png" alt="Score chart"></a><video poster="../pic.png"><source src="./movie.mp4" type="video/mp4"></video><a href="/details?a=1&amp;b=2">Details</a></main>'],
}
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/gallery/page' })
    return res.end()
  }
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

it('preserves usable page and media links relative to the final redirected page', async () => {
  const r = await fetchVia('/redirect')
  assert.match(r.content, /Chart gallery/)
  for (const path of ['/pic.png', '/gallery/full.png', '/gallery/movie.mp4', '/details?a=1&b=2']) {
    assert.ok(r.content.includes(base + path), path)
  }
  assert.match(r.content, /Score chart/)
  assert.match(r.content, /poster/)
  assert.equal(r.images, undefined, 'embedded media is discoverable but not automatically downloaded')
})

it('preserves lazy, responsive, audio and player media while dropping executable URLs and hidden content', () => {
  const { text } = htmlToText(`<head><script>secret</script></head>
    <img src="placeholder.gif" data-src="/original.webp" alt="Original">
    <img srcset="/small.png 1x, /large.png 2x">
    <audio src='/song.mp3'></audio><iframe src="//player.example/embed/123"></iframe>
    <a href=/article>Article</a><a href="javascript:alert(1)">Unsafe</a>
    <img src="data:image/png;base64,secret"><img src="file:///private">
    <script><img src="https://hidden.example/secret"></script>`, 'https://example.com/gallery/')
  for (const url of ['https://example.com/original.webp', 'https://example.com/large.png', 'https://example.com/song.mp3', 'https://player.example/embed/123', 'https://example.com/article']) {
    assert.ok(text.includes(url), url)
  }
  assert.doesNotMatch(text, /placeholder|javascript:|data:image|file:|secret|hidden\.example/)
})

it('prefers article content over surrounding main navigation so media stays inside the output budget', () => {
  const { text } = htmlToText(`<main><div>${'Repository menu '.repeat(500)}</div>
    <article><p>${'Article text '.repeat(50)}</p><img src="/chart.png"></article></main>`, 'https://example.com/repo')
  assert.doesNotMatch(text, /Repository menu/)
  assert.ok(text.slice(0, 1000).includes('https://example.com/chart.png'))
})
