import { TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const port = await new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port
    s.close(() => resolve(p))
  })
})
writeUserConfig(`models:\n  - { id: main, provider: openai, model: fake }\nweb: { port: ${port}, password: hunter2-test }\n`)
fs.mkdirSync(path.join(TMP, 'web'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'web', 'index.html'), '<!doctype html><title>panel</title>')
fs.writeFileSync(path.join(TMP, 'config', 'secret.txt'), 'do-not-serve')

const { config } = await import('../src/core/config.ts')
const { startWeb, stopWeb } = await import('../src/web/server.ts')
const { appendTurn, clearSession, truncateIfNeeded } = await import('../src/chat/session.ts')

const base = `http://127.0.0.1:${port}`
let cookie = ''
const call = (method: string, p: string, body?: any, headers: Record<string, string> = {}) =>
  fetch(base + p, {
    method,
    headers: { 'x-requested-with': 'yzllm', 'content-type': 'application/json', cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

before(async () => {
  config.load()
  startWeb()
  for (let i = 0; i < 50; i++) {
    if (await fetch(base).then(() => true, () => false)) break
    await new Promise(r => setTimeout(r, 20))
  }
})
after(() => stopWeb())

describe('web panel', () => {
  it('requires login, rejects a wrong password and sets an HttpOnly session cookie', async () => {
    assert.equal((await call('GET', '/api/overview')).status, 401)
    assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401)
    const res = await call('POST', '/api/login', { password: 'hunter2-test' })
    assert.equal(res.status, 200)
    const set = res.headers.get('set-cookie') ?? ''
    assert.match(set, /HttpOnly/)
    assert.match(set, /SameSite=Strict/)
    cookie = set.split(';')[0]
    assert.equal((await call('GET', '/api/overview')).status, 200)
  })

  it('refuses state changes without the custom header (cross-site requests)', async () => {
    const res = await fetch(`${base}/api/config`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'enable', value: false }) })
    assert.equal(res.status, 403)
    assert.equal(config.get().enable, true)
  })

  it('validates config writes with the shared schema and masks secrets on read', async () => {
    assert.equal((await call('PUT', '/api/config', { path: 'memory.embedding.minScore', value: 0.4 })).status, 200)
    assert.equal(config.get().memory.embedding.minScore, 0.4)
    const bad = await call('PUT', '/api/config', { path: 'memory.embedding.minScore', value: 3 })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /不能大于 1/)
    assert.equal((await call('PUT', '/api/config', { path: 'nope.x', value: 1 })).status, 400)

    assert.equal((await call('PUT', '/api/config', { path: 'providers.openai.apiKey', value: 'sk-test-abcdefghijklmnop' })).status, 200)
    const data = await (await call('GET', '/api/config')).json()
    assert.equal(data.effective.providers.openai.apiKey.set, true)
    assert.ok(!JSON.stringify(data.effective).includes('sk-test-abcdefghijklmnop'))
    assert.equal(data.schema.fields.web.t, 'obj')
    assert.ok(data.overridden.includes('memory.embedding.minScore'))
  })

  it('validates raw YAML against the config being written', async () => {
    const bad = await call('PUT', '/api/config/raw', { text: 'defaultModel: missing\n' })
    assert.equal(bad.status, 400)
    const ok = await call('PUT', '/api/config/raw', { text: `models:\n  - { id: other, provider: openai, model: fake }\ndefaultModel: other\nweb: { port: ${port}, password: hunter2-test }\n` })
    assert.equal(ok.status, 200)
    assert.equal(config.defaultModelId(), 'other')
  })

  it('lists sessions with archive details and edits memory', async () => {
    const key = '10000:p77001'
    clearSession(key)
    for (const text of ['第一件事', '第二件事']) {
      appendTurn(key, { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: '好' })
      truncateIfNeeded(key, { ...config.effective().chat, historyMaxTurns: 1 })
    }
    const list = await (await call('GET', '/api/sessions')).json()
    assert.ok(list.some((s: any) => s.key === key && s.archive === 1 && s.kind === 'private'))
    const detail = await (await call('GET', `/api/sessions/${encodeURIComponent(key)}`)).json()
    assert.equal(detail.archive[0].vector, false)
    assert.match(detail.archive[0].text, /第一件事/)

    const added = await (await call('POST', '/api/memory/user/77001', { text: '喜欢橘猫' })).json()
    assert.equal((await call('PUT', `/api/memory/user/77001/${added.id}`, { text: '喜欢三花猫' })).status, 200)
    const mem = await (await call('GET', '/api/memory')).json()
    assert.equal(mem.users.find((u: any) => u.key === '77001').entries[0].text, '喜欢三花猫')
  })

  it('uploads, dedupes, edits and deletes stickers', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
    const first = await (await call('POST', '/api/stickers', { data: `data:image/png;base64,${png}`, index: false })).json()
    assert.equal(first.isNew, true)
    assert.equal(first.sticker.indexed, false)
    const again = await (await call('POST', '/api/stickers', { data: png, index: false })).json()
    assert.equal(again.isNew, false)
    assert.equal(again.sticker.id, first.sticker.id)

    const bad = await call('POST', '/api/stickers', { data: Buffer.from('not an image at all').toString('base64') })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /不支持的图片格式/)

    const id = first.sticker.id
    assert.equal((await call('PUT', `/api/stickers/${id}`, { name: '红点', desc: '一个红色像素', tags: '测试、红色, 像素' })).status, 200)
    const s = (await (await call('GET', '/api/stickers')).json()).find((x: any) => x.id === id)
    assert.deepEqual([s.name, s.indexed, s.tags], ['红点', true, ['测试', '红色', '像素']])
    assert.equal(s.mface, undefined)

    const img = await call('GET', `/api/stickers/${id}/image`)
    assert.equal(img.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from(png, 'base64'))

    assert.equal((await call('DELETE', `/api/stickers/${id}`)).status, 200)
    assert.equal((await call('GET', `/api/stickers/${id}/image`)).status, 404)
  })

  it('reports an empty vector space without an embedding key', async () => {
    const v = await (await call('GET', '/api/vectors')).json()
    assert.equal(v.ready, false)
    assert.deepEqual(v.points, [])
  })

  it('serves the app but never files outside the web directory', async () => {
    assert.match(await (await fetch(`${base}/`)).text(), /panel/)
    // client-side routes fall back to the app
    assert.match(await (await fetch(`${base}/conversations`)).text(), /panel/)
    for (const p of ['/../config/secret.txt', '/%2e%2e/config/secret.txt', '/..%2fconfig%2fsecret.txt'])
      assert.doesNotMatch(await (await fetch(base + p)).text(), /do-not-serve/)
  })

  it('protects AGY history and cancellation, filters private data, and rejects unknown jobs', async () => {
    const { agyQueue } = await import('../src/tools/agy.ts')
    const { recordAgyEvent } = await import('../src/agy/history.ts')
    const job = agyQueue.submit('private-owner', 'Search image for alice@example.com', 5)
    job.report = 'Found a source. password=private-password'
    job.progress = '正在搜索'
    recordAgyEvent(job.id, { kind: 'tool', tool: 'read_file', text: 'Read alice@example.com at C:\\Users\\Alice\\private.txt' })
    recordAgyEvent(job.id, { kind: 'reply', text: 'Found the source', delivery: 'sent' })
    const url = `/api/agy/${job.id}`
    assert.equal((await fetch(base + '/api/agy')).status, 401)
    assert.equal((await fetch(base + url + '/history')).status, 401)
    const list = await (await call('GET', '/api/agy')).json()
    assert.equal(list[0].id, job.id)
    assert.equal(list[0].progress, '正在搜索')
    assert.ok(!('owner' in list[0]))
    const history = await (await call('GET', url + '/history')).json()
    assert.equal(history.events[1].delivery, 'sent')
    for (const text of [JSON.stringify(list), JSON.stringify(history)]) for (const value of ['alice@example.com', 'private-password', 'private-owner', 'Alice']) assert.ok(!text.includes(value))
    const noHeader = await fetch(base + url + '/cancel', { method: 'POST', headers: { cookie } })
    assert.equal(noHeader.status, 403)
    assert.equal(job.status, 'queued')
    assert.equal((await call('POST', url + '/cancel')).status, 200)
    assert.equal(job.status, 'cancelled'); assert.equal(job.progress, undefined)
    assert.equal((await (await call('GET', url + '/history')).json()).events.at(-1).kind, 'cancel')
    assert.equal((await call('POST', url + '/cancel')).status, 200)
    assert.equal((await call('GET', '/api/agy/0000000000/history')).status, 404)
    assert.equal((await call('GET', '/api/agy/..%2fconfig/history')).status, 404)
    assert.equal((await call('POST', '/api/agy/0000000000/cancel')).status, 404)
  })

  it('logs out', async () => {
    assert.equal((await call('POST', '/api/logout')).status, 200)
    assert.equal((await call('GET', '/api/overview')).status, 401)
  })
})
