import { fakeEvent, mockServer, setEmbedding, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

let reply = '重新整理后的原神配队与周末猫展约定。'
let finish = 'stop'
let embedFailure = false
let duringGeneration: (() => void) | undefined
let duringEmbedding: (() => void) | undefined
const server = await mockServer(request => {
  if (request.url.endsWith('/embeddings') || request.url.endsWith('/contextualizedembeddings')) {
    duringEmbedding?.()
    if (embedFailure) return [500, { error: { message: 'embedding unavailable' } }]
    const vector = (text: string) => [text.includes('猫') ? 1 : 0, text.includes('原神') ? 1 : 0, 0.1]
    if (request.body.inputs) return [200, { data: request.body.inputs.map((texts: string[], index: number) => ({ index, data: texts.map((text, i) => ({ index: i, embedding: vector(text) })) })) }]
    return [200, { data: request.body.input.map((text: string, index: number) => ({ index, embedding: vector(text) })) }]
  }
  duringGeneration?.()
  if (request.url.endsWith('/interactions')) return [200, { id: 'next-response', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: reply }] }], usage: { total_output_tokens: 23, total_thought_tokens: 673 } }]
  return [200, { choices: [{ message: { content: reply }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]
})
after(server.close)
writeUserConfig(`providers:
  mock: { type: openai, baseUrl: '${server.url}', apiKey: test, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: default-upstream, thinking: off }
  - { id: selected, provider: mock, model: chosen-upstream, thinking: low }
defaultModel: main
utilityModel: main
memory:
  embedding: { enable: true, type: openai, baseUrl: '${server.url}', apiKey: embedding-test, model: test-vector }
`)
const { config, normalize } = await import('../src/core/config.ts')
const { routes } = await import('../src/web/api.ts')
const { allVectors, appendTurn, archiveChatter, archiveInfo, clearSession, dayInfo, getSession, indexArchive, peekSession, setDayDigest, sessionsMissingVectors, staleDay, updateArchiveEntry } = await import('../src/chat/session.ts')
const { digestDay, maintainArchive } = await import('../src/chat/archiveJobs.ts')
const { compactSession, runTurn } = await import('../src/chat/agent.ts')
const { vectorizeHistory } = await import('../src/chat/history.ts')
const { addDays, localDay } = await import('../src/chat/dates.ts')
const { totals } = await import('../src/billing/ledger.ts')

const key = '10000:g19981', base = `/api/sessions/${key}`, yesterday = addDays(localDay(), -1)
const call = async (method: string, url: string, body: any = {}) => {
  const route = routes.find(r => r.method === method && r.pattern.test(url))
  assert.ok(route, `${method} ${url}`)
  return route.run({ params: route.pattern.exec(url)!.slice(1).map(decodeURIComponent), query: new URLSearchParams(), body })
}
function seed() {
  clearSession(key)
  appendTurn(key, { role: 'user', content: [{ type: 'text', text: '周末看猫展' }] }, { role: 'assistant', content: '好，一起去' })
  const s = peekSession(key)!
  s.summary = '之前的滚动摘要'
  s.state = { key: 'provider', previousId: 'old', len: 2 }
  s.archive = [
    { id: 'episode', day: yesterday, at: Date.now() - 86400000, text: '讨论原神配队', sourceText: '原文：岛风问原神配队，雪风建议双火。' },
    { id: 'neighbour', day: yesterday, at: Date.now() - 86400000, text: '周末约好看猫展' },
  ]
  s.days = [{ id: 'digest', day: yesterday, at: Date.now(), text: '旧的每日概要', sources: ['episode', 'neighbour'] }]
  return s
}
beforeEach(() => {
  config.load()
  reply = '重新整理后的原神配队与周末猫展约定。'
  finish = 'stop'; embedFailure = false; duringGeneration = undefined; duringEmbedding = undefined
  server.requests.length = 0
  seed()
})

describe('history configuration and generation budgets', () => {
  it('defaults to 8192, validates the web setting, and supports group overrides', async () => {
    assert.equal(config.get().chat.summaryMaxTokens, 8192)
    assert.equal(normalize({ chat: { summaryMaxTokens: 'bad' } }).chat.summaryMaxTokens, 8192)
    const schema = (await call('GET', '/api/config')).schema.fields.chat.fields.summaryMaxTokens
    assert.equal(schema.min, 64)
    await assert.rejects(() => call('PUT', '/api/config', { path: 'chat.summaryMaxTokens', value: 0 }))
    await call('PUT', '/api/config', { path: 'chat.summaryMaxTokens', value: 12000 })
    assert.equal(config.get().chat.summaryMaxTokens, 12000)
    await call('PUT', '/api/config', { path: 'groups.19981.chat.summaryMaxTokens', value: 4096 })
    assert.equal((await call('GET', base)).summaryMaxTokens, 4096)
    config.delete('groups.19981.chat.summaryMaxTokens')
    config.delete('chat.summaryMaxTokens')
  })

  it('uses the configured budget for automatic daily, chatter and rolling summaries', async () => {
    config.set('chat.summaryMaxTokens', 10000)
    try {
      peekSession(key)!.days = []
      assert.equal(await digestDay(key, {}), true)
      assert.equal(server.requests.at(-1)!.body.max_tokens, 10000)
      const chatterKey = '10000:g19982'
      clearSession(chatterKey)
      archiveChatter(chatterKey, localDay(), '岛风：周末看猫展', Date.now())
      await maintainArchive(chatterKey)
      assert.ok(server.requests.some(r => String(r.body.messages?.[0]?.content).includes('普通群聊记录') && r.body.max_tokens === 10000))
      reply = '片段：岛风聊了猫\n摘要：岛风喜欢猫'
      appendTurn(key, { role: 'user', content: [{ type: 'text', text: '再聊猫' }] }, { role: 'assistant', content: '好' })
      await compactSession(key, { ...config.effective(), chat: { ...config.effective().chat, historyMaxTurns: 1 } }, {})
      assert.ok(server.requests.some(r => String(r.body.messages?.[0]?.content).includes('严格按两段输出') && r.body.max_tokens === 10000))
    } finally { config.delete('chat.summaryMaxTokens') }
  })
})

describe('history edits and regeneration', () => {
  it('edits a daily digest and replaces its vector without losing source coverage', async () => {
    await indexArchive(key)
    const result = await call('PUT', `${base}/archive/digest`, { text: '修正为猫展安排', previousText: '旧的每日概要' })
    assert.equal(result.vectorStatus, 'ready')
    assert.equal(dayInfo(key)[0].text, '修正为猫展安排')
    assert.deepEqual(dayInfo(key)[0].sources, ['episode', 'neighbour'])
    assert.ok(dayInfo(key)[0].vector)
    assert.equal(staleDay(key), undefined)
    assert.equal(allVectors(key).find(v => v.id === 'digest')!.text, '修正为猫展安排')
  })

  it('edits an episode, finalizes raw text, re-embeds it and marks the derived digest for refresh', async () => {
    peekSession(key)!.archive![0].raw = true
    await indexArchive(key)
    const result = await call('PUT', `${base}/archive/episode`, { text: '改约周日看猫展' })
    assert.equal(result.vectorStatus, 'ready')
    assert.equal(archiveInfo(key)[0].raw, undefined)
    assert.ok(archiveInfo(key)[0].vector)
    assert.equal(staleDay(key)?.day, yesterday)
    assert.match(allVectors(key).find(v => v.id === 'episode')!.text, /周日/)
  })

  it('regenerates a daily digest with the selected model and vectors the resulting text', async () => {
    const result = await call('POST', `${base}/archive/digest/regenerate`, { model: 'selected' })
    const request = server.requests.find(r => r.url.endsWith('/chat/completions'))!
    assert.equal(request.body.model, 'chosen-upstream')
    assert.equal(request.body.max_tokens, 8192)
    assert.match(JSON.stringify(request.body.messages[1].content), /讨论原神配队/)
    assert.equal(result.model, 'selected')
    assert.equal(result.vectorStatus, 'ready')
    assert.equal(dayInfo(key)[0].text, reply)
    assert.ok(dayInfo(key)[0].vector)
  })

  it('regenerates an archive from its retained original text', async () => {
    await call('POST', `${base}/archive/episode/regenerate`, { model: 'main' })
    const request = server.requests.find(r => r.url.endsWith('/chat/completions'))!
    assert.match(JSON.stringify(request.body.messages[1].content), /雪风建议双火/)
    assert.equal(archiveInfo(key)[0].text, reply)
    assert.ok(archiveInfo(key)[0].vector)
  })

  it('refuses to rewrite a legacy summary without original source text', async () => {
    const entry = peekSession(key)!.archive![0]
    delete entry.sourceText
    entry.text = '【群聊】2026-10-24，🐶会长(平台ID 2)、岛'
    const original = entry.text
    assert.equal(archiveInfo(key)[0].sourceAvailable, false)
    await assert.rejects(() => call('POST', `${base}/archive/episode/regenerate`, { model: 'main' }), /没有保留聊天原文/)
    assert.equal(archiveInfo(key)[0].text, original)
    assert.equal(server.requests.length, 0)
  })

  it('preserves raw text before a manual edit so subsequent regeneration still has originals', async () => {
    const entry = peekSession(key)!.archive![0]
    delete entry.sourceText
    entry.raw = true
    entry.text = '原始对话：周日看猫展，下午两点见。'
    await call('PUT', `${base}/archive/episode`, { text: '手动修改的摘要' })
    assert.equal(archiveInfo(key)[0].sourceAvailable, true)
    assert.equal(archiveInfo(key)[0].sourceText, '原始对话：周日看猫展，下午两点见。')
    await call('POST', `${base}/archive/episode/regenerate`, { model: 'main' })
    const request = server.requests.find(r => r.url.endsWith('/chat/completions'))!
    assert.match(JSON.stringify(request.body.messages[1].content), /下午两点见/)
  })

  it('edits and regenerates rolling context, clearing stale provider conversation state', async () => {
    await call('PUT', `${base}/summary`, { text: '修正的摘要' })
    assert.equal(peekSession(key)!.summary, '修正的摘要')
    assert.equal(peekSession(key)!.state, undefined)
    await call('POST', `${base}/summary/regenerate`, { model: 'selected' })
    assert.equal(peekSession(key)!.summary, reply)
    const s = peekSession(key)!
    s.state = { key: 'provider', previousId: 'stale', len: 2 }
    await call('PUT', `${base}/messages/0`, { text: '改为周日看猫', previousText: '周末看猫展' })
    assert.deepEqual(s.messages[0], { role: 'user', content: [{ type: 'text', text: '改为周日看猫' }] })
    assert.equal(s.state, undefined)
    await call('PUT', `${base}/messages/1`, { text: '同意周日' })
    assert.deepEqual(s.messages[1], { role: 'assistant', content: '同意周日' })
  })

  it('rejects stale edits, invalid text, missing entries and unknown models', async () => {
    for (const body of [{ text: '猫', previousText: 'stale' }, { text: '' }, { text: 1 }, { text: 'x'.repeat(20001) }])
      await assert.rejects(() => call('PUT', `${base}/archive/episode`, body))
    await assert.rejects(() => call('PUT', `${base}/messages/0`, { text: '猫', previousText: 'stale' }), { status: 409 })
    await assert.rejects(() => call('PUT', `${base}/summary`, { text: '猫', previousText: 'stale' }), { status: 409 })
    await assert.rejects(() => call('PUT', `${base}/messages/NaN`, { text: '猫' }), { status: 404 })
    await assert.rejects(() => call('POST', `${base}/archive/digest/regenerate`, { model: 'missing' }))
    await assert.rejects(() => call('POST', `${base}/archive/missing/regenerate`, { model: 'main' }), { status: 404 })
    assert.equal(server.requests.length, 0)
  })

  it('does not pretend to regenerate a daily digest whose sources have expired', async () => {
    peekSession(key)!.archive = []
    await assert.rejects(() => call('POST', `${base}/archive/digest/regenerate`), /源档案已不再保留/)
    assert.equal(peekSession(key)!.days![0].text, '旧的每日概要')
  })

  it('rejects token-limited or empty responses without settling sources or overwriting the old summary', async () => {
    for (const content of ['概要：\n1.', '', '只有开头']) {
      reply = content; finish = content === '只有开头' ? 'length' : 'stop'
      await assert.rejects(() => call('POST', `${base}/archive/digest/regenerate`), /完整|上限/)
      assert.equal(peekSession(key)!.days![0].text, '旧的每日概要')
    }
    peekSession(key)!.days = []
    await assert.rejects(() => digestDay(key, {}), /上限/)
    assert.ok(staleDay(key))
  })

  it('detects the observed Gemini reasoning-budget exhaustion and still bills that call', async () => {
    config.set('chat.summaryMaxTokens', 700)
    config.get().providers.mock.type = 'gemini'
    const before = totals().main?.calls ?? 0
    try {
      await assert.rejects(() => call('POST', `${base}/archive/digest/regenerate`), /输出上限/)
      assert.equal(peekSession(key)!.days![0].text, '旧的每日概要')
      assert.equal(totals().main.calls, before + 1)
    } finally { config.delete('chat.summaryMaxTokens') }
  })

  it('keeps a concurrent edit or reset instead of overwriting it with an old generation', async () => {
    duringGeneration = () => updateArchiveEntry(key, 'digest', '用户刚刚保存的新内容')
    await assert.rejects(() => call('POST', `${base}/archive/digest/regenerate`), { status: 409 })
    assert.equal(peekSession(key)!.days![0].text, '用户刚刚保存的新内容')
    duringGeneration = () => { clearSession(key); getSession(key, 180) }
    await assert.rejects(() => call('POST', `${base}/summary/regenerate`), { status: 409 })
    assert.equal(peekSession(key)!.summary, undefined)
  })

  it('does not restore old provider state when a context edit happens during an active reply', async () => {
    config.get().providers.mock.type = 'gemini'
    const eff = config.effective()
    const run = () => runTurn({
      e: fakeEvent({ group_id: 19981 }).e,
      eff: { ...eff, chat: { ...eff.chat, thinking: 'off' }, tools: { ...eff.tools, enable: false } },
      input: { text: '你好', images: [], imageSegments: [] }, isAdmin: true, convKey: key,
    })
    assert.equal((await run()).kind, 'reply')
    assert.ok(peekSession(key)!.state, 'unchanged context can retain provider state')
    duringGeneration = () => { void call('PUT', `${base}/messages/0`, { text: '在生成期间修正的上下文' }) }
    assert.equal((await run()).kind, 'reply')
    assert.equal(peekSession(key)!.state, undefined)
  })
})

describe('history vector refresh safety', () => {
  it('preserves edits and queues vectors for retry when the embedding service fails', async () => {
    await indexArchive(key)
    embedFailure = true
    const result = await call('PUT', `${base}/archive/episode`, { text: '已修正为猫展' })
    assert.equal(result.vectorStatus, 'pending')
    assert.equal(archiveInfo(key)[0].text, '已修正为猫展')
    assert.equal(archiveInfo(key)[0].vector, false)
    assert.ok(sessionsMissingVectors().includes(key))
    embedFailure = false
    assert.equal((await vectorizeHistory(key)).vectorStatus, 'ready')
  })

  it('does not attach an embedding of old text when an edit happens during indexing', async () => {
    duringEmbedding = () => updateArchiveEntry(key, 'episode', '生成向量期间的新猫展安排')
    await indexArchive(key)
    assert.equal(archiveInfo(key)[0].vector, false)
    duringEmbedding = undefined
    await indexArchive(key)
    assert.ok(archiveInfo(key)[0].vector)
  })

  it('re-embeds contextual neighbours when an archive fragment changes', async () => {
    setEmbedding(config, { type: 'voyage', model: 'voyage-context-test' })
    await indexArchive(key)
    server.requests.length = 0
    await call('PUT', `${base}/archive/episode`, { text: '改约猫展' })
    const request = server.requests.find(r => r.url.endsWith('/contextualizedembeddings'))!
    assert.deepEqual(request.body.inputs, [['改约猫展', '周末约好看猫展']])
    assert.ok(archiveInfo(key).every(a => a.vector))
  })

  it('saves edits without a configured embedding key and reports that vectors are disabled', async () => {
    setEmbedding(config, { apiKey: '' })
    assert.equal((await call('PUT', `${base}/archive/digest`, { text: '手动修正' })).vectorStatus, 'disabled')
    assert.equal(dayInfo(key)[0].text, '手动修正')
  })
})
