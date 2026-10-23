import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { registerGoogleLensTool } from '../src/tools/googleLens.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'

function context(): ToolCtx {
  return { e: {}, eff: normalize({ tools: { googleLens: { enable: true } } }) as any, isAdmin: true, model: {} as any,
    turn: { commands: 0, searches: 0, fetches: 0, images: [], inputImages: [
      { type: 'image', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a01020000', 'hex').toString('base64') },
      { type: 'image', mime: 'image/png', data: Buffer.from('89504e470d0a1a0a03040000', 'hex').toString('base64') },
    ] } }
}

it('uploads only the selected context image directly and filters browser data before returning evidence', async () => {
  const calls: any[] = []
  registerGoogleLensTool(async (_distro, request) => {
    calls.push(request)
    if (request.op === 'stage') return { ok: true }
    return { status: 'ok', uploaded: true, results: [{ title: 'Artwork alice@example.com', url: 'https://example.org/art?token=private' }],
      description: 'Displayed character description alice@example.com',
      ai_overview: { text: 'Google-generated summary alice@example.com', sources: ['https://example.org/source?token=private'] },
      image: { data: 'PRIVATE_SCREENSHOT' }, cookies: 'PRIVATE_COOKIES' }
  })
  const ctx = context(), result = await registry.get('google_lens')!.run({ image_index: 2 }, ctx) as any
  assert.equal(result.isError, false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].files.length, 1)
  assert.equal(calls[0].files[0].data, ctx.turn.inputImages![1].data)
  assert.equal(calls[1].job, calls[0].job)
  assert.equal(calls[1].path, calls[0].files[0].name)
  assert.equal(ctx.turn.afterReply, undefined)
  assert.deepEqual(ctx.turn.images, [])
  assert.ok(result.content.includes('https://example.org/art'))
  const output = JSON.parse(result.content)
  assert.match(output.description.text, /Displayed character/)
  assert.equal(output.ai_overview.generated_by_google_ai, true)
  assert.equal(output.ai_overview.source, 'Google AI Overview')
  assert.equal(output.ai_overview.sources.length, 1)
  for (const value of ['alice@example.com', 'PRIVATE_SCREENSHOT', 'PRIVATE_COOKIES', 'token=private']) assert.ok(!result.content.includes(value))
})

it('enforces access, valid context images and reply limits before crossing the VM boundary', async () => {
  let calls = 0
  registerGoogleLensTool(async () => { calls++; return { ok: true, status: 'ok', uploaded: true, results: [] } })
  const tool = registry.get('google_lens')!, ctx = context()
  ctx.isAdmin = false
  assert.equal((await tool.run({}, ctx) as any).isError, true)
  ctx.isAdmin = true
  assert.equal((await tool.run({ image_index: 99 }, ctx) as any).isError, true)
  ctx.turn.inputImages = []
  assert.equal((await tool.run({}, ctx) as any).isError, true)
  assert.equal(calls, 0)
  const limited = context(); limited.turn.lensSearches = 2
  assert.equal((await tool.run({}, limited) as any).isError, true)
  const worker = context(); worker.turn.asyncResult = { kind: 'agy', id: 'aabbccddee' }
  assert.equal((await tool.run({}, worker) as any).isError, true)
  assert.equal(calls, 0)
  assert.equal(normalize({}).tools.googleLens.enable, false)
  assert.equal(normalize({ tools: { googleLens: { distro: '../bad' } } }).tools.googleLens.distro, 'yunzai-sandbox')
})

it('reports Google verification blocks without claiming a successful image search', async () => {
  registerGoogleLensTool(async (_distro, request) => request.op === 'stage' ? { ok: true } : { status: 'blocked', error: 'Complete verification in the VM browser' })
  const result = await registry.get('google_lens')!.run({}, context()) as any
  assert.equal(result.isError, true)
  const output = JSON.parse(result.content)
  assert.equal(output.status, 'blocked'); assert.equal(output.uploaded, false)
  assert.equal(output.description, null); assert.equal(output.ai_overview, null)
  assert.deepEqual(output.results, [])
})
