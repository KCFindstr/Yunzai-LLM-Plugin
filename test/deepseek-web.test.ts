import { writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config, normalize } from '../src/core/config.ts'
import { searchReady } from '../src/core/setup.ts'
import { fetchPage, registerWebTools } from '../src/tools/web.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'

writeUserConfig('providers:\n  deepseek: { apiKey: "env:DEEPSEEK_TOOL_TEST_KEY" }\n')
process.env.DEEPSEEK_TOOL_TEST_KEY = 'fixture-deepseek-key'
config.load()
registerWebTools()
function context(): ToolCtx {
  return { e: {}, eff: normalize({ tools: { webSearch: { provider: 'deepseek' }, webFetch: { reader: 'deepseek', maxChars: 500, allowPrivateNetwork: true } } }) as any,
    model: { vision: true } as any, isAdmin: false, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}

it('DeepSeek tools reuse the provider key, map search summaries and cap Markdown fetch output', async t => {
  const calls: { url: string; init: any }[] = []
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return Response.json(String(url).endsWith('/search') ? { results: [{ title: 'Result', url: 'https://example.com', summary: 'Detailed summary', snippet: 'Short snippet' }] }
      : { title: 'Page', content: '# Markdown\n' + 'x'.repeat(600) })
  })
  const ctx = context()
  assert.equal(searchReady(ctx.eff), true)
  const tool = registry.get('web_search')!
  const result = await tool.run({ query: 'test query' }, ctx)
  assert.match(String(result), /Detailed summary/)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'test query', count: 5, need_content: false })
  const page = await fetchPage('https://example.com/article', ctx)
  assert.match(String(page), /Page\n\n# Markdown/)
  assert.ok(String(page).length < 550)
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/tools/fetch')
  assert.deepEqual(JSON.parse(calls[1].init.body), { url: 'https://example.com/article' })
  for (const call of calls) assert.equal(call.init.headers.authorization, 'Bearer fixture-deepseek-key')
  await assert.rejects(() => tool.run({ query: 'x'.repeat(129) }, ctx), /128/)
  ctx.eff.tools.webSearch.apiKey = 'override-key'
  await fetchPage('https://example.com/article', ctx)
  assert.equal(calls[2].init.headers.authorization, 'Bearer override-key')
  ctx.eff.tools.webSearch.provider = 'brave'
  await fetchPage('https://example.com/article', ctx)
  assert.equal(calls[3].init.headers.authorization, 'Bearer fixture-deepseek-key')
})

it('DeepSeek reports HTTP errors and validates response shapes', async t => {
  const ctx = context()
  t.mock.method(globalThis, 'fetch', async () => new Response('private upstream body', { status: 401 }))
  await assert.rejects(() => fetchPage('https://example.com', ctx), /DeepSeek fetch HTTP 401/)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: true }))
  await assert.rejects(() => fetchPage('https://example.com', ctx), /invalid response/)
  await assert.rejects(() => registry.get('web_search')!.run({ query: 'test' }, ctx), /invalid response/)
  await assert.rejects(() => fetchPage('https://user:pass@example.com', ctx), /http\(s\)/)
})

it('DeepSeek Fetch retains direct image viewing and blocks private page URLs', async t => {
  const ctx = context()
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    assert.equal(String(url), 'https://example.com/pic.png')
    return new Response(Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64)]), { headers: { 'content-type': 'image/png' } })
  })
  const page = await fetchPage('https://example.com/pic.png', ctx)
  assert.ok(typeof page !== 'string' && page.images?.length)
  ctx.eff.tools.webFetch.allowPrivateNetwork = false
  await assert.rejects(() => fetchPage('http://127.0.0.1/private', ctx))
})
