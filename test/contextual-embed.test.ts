import { mockServer, setEmbedding, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

// fake Voyage: /contextualizedembeddings returns one vector per chunk; /embeddings for the old model
const concepts = [/猫/, /原神|配队/, /显卡|驱动/, /周六|周末/]
const vec = (t: string) => [...concepts.map(re => (re.test(t) ? 1 : 0)), 0.1]
const server = await mockServer(async req => {
  if (req.url.endsWith('/contextualizedembeddings')) {
    const data = req.body.inputs.map((chunks: string[], index: number) => ({ object: 'list', index, data: chunks.map((t, i) => ({ object: 'embedding', index: i, embedding: vec(t) })) }))
    return [200, { object: 'list', data, model: req.body.model, usage: { total_tokens: 5 } }]
  }
  return [200, { data: req.body.input.map((t: string, index: number) => ({ index, embedding: vec(t) })), usage: { total_tokens: 1 } }]
})
after(server.close)
writeUserConfig(`memory:\n  embedding: { enable: true, type: voyage, baseUrl: '${server.url}', apiKey: test-key, model: voyage-4-lite, dimensions: 512, minScore: 0.5 }\n`)

const { config } = await import('../src/core/config.ts')
config.load()
const { embed, embedGroups, embeddingContextual } = await import('../src/memory/embed.ts')
const { appendTurn, clearSession, indexArchive, peekSession, recallSession, reindexAll, sessionsMissingVectors, truncateIfNeeded } = await import('../src/chat/session.ts')

const useModel = (model: string) => setEmbedding(config, { model })
const calls = (path: string) => server.requests.filter(r => r.url.endsWith(path))
const DAY = 86400_000

/** Archive with entries on two different days. */
function seed(key: string) {
  clearSession(key)
  for (const text of ['昨天聊原神配队', '昨天聊了猫', '今天问显卡驱动', '现在']) {
    appendTurn(key, { role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: '好' })
  }
  peekSession(key)!.turnTimes = [Date.now() - DAY, Date.now() - DAY, Date.now(), Date.now()]
  truncateIfNeeded(key, { ...config.effective().chat, historyMaxTurns: 1 })
  // one archive entry per turn (as summaries would be), so a day has several chunks
  const s = peekSession(key)!
  s.archive = s.archive!.flatMap(a => a.text.split('\n').filter(l => l.startsWith('对方')).map((text, i) => ({ id: `${a.id}-${i}`, at: a.at, day: a.day, text })))
}

beforeEach(() => { server.requests.length = 0; useModel('voyage-4-lite') })

describe('contextualized embeddings (voyage-context-*)', () => {
  it('uses /contextualizedembeddings for voyage-context models, one inner list per document', async () => {
    useModel('voyage-context-4')
    assert.equal(embeddingContextual(), true)
    const groups = await embedGroups([['猫一', '猫二'], ['显卡']], 'document')
    assert.deepEqual(groups.map(g => g.length), [2, 1])
    const body = calls('/contextualizedembeddings')[0].body
    assert.deepEqual(body.inputs, [['猫一', '猫二'], ['显卡']])
    assert.deepEqual([body.model, body.input_type, body.output_dimension], ['voyage-context-4', 'document', 512])
    // a query is a single-chunk input
    const [qv] = await embed(['猫在哪'], 'query')
    assert.equal(qv.length, 5)
    assert.deepEqual(calls('/contextualizedembeddings')[1].body.inputs, [['猫在哪']])
    assert.equal(calls('/embeddings').length, 0)
  })

  it('embeds a day of archive entries together, and redoes the whole day when it gains an entry', async () => {
    useModel('voyage-context-4')
    const key = '10000:p91001'
    seed(key)
    await indexArchive(key)
    const days = calls('/contextualizedembeddings')[0].body.inputs as string[][]
    assert.deepEqual(days.map(d => d.length).sort(), [1, 2]) // yesterday's two entries form one document
    server.requests.length = 0
    peekSession(key)!.archive!.push({ id: 'late', at: Date.now() - DAY, day: peekSession(key)!.archive![0].day, text: '对方：昨天晚上又聊周末' })
    await indexArchive(key)
    assert.deepEqual(calls('/contextualizedembeddings')[0].body.inputs.map((d: string[]) => d.length), [3])
  })

  it('migrates every session after a model switch and never scores against the old model', async () => {
    const key = '10000:p91002'
    seed(key)
    await indexArchive(key) // old model: voyage-4-lite via /embeddings
    assert.ok(calls('/embeddings').length)
    useModel('voyage-context-4')
    assert.ok(sessionsMissingVectors().includes(key))
    // stale vectors are ignored, not mixed in: with the API failing, recall falls back to keywords
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('offline') }) as any
    try {
      assert.deepEqual(await recallSession(key, '周末那个约定'), [])
    } finally {
      globalThis.fetch = realFetch
    }
    const r = await reindexAll()
    assert.ok(r.sessions >= 1)
    assert.equal(sessionsMissingVectors().includes(key), false)
    assert.match((await recallSession(key, '猫猫')).join('\n'), /猫/)
  })
})

describe('contextualized request size', () => {
  it('splits a document over the per-request budget into parts and keeps one vector per chunk in order', async () => {
    useModel('voyage-context-4')
    const big = Array.from({ length: 6 }, (_, i) => `${i % 2 ? '猫' : '显卡'}${'字'.repeat(6000)}`)
    const [vecs, small] = await embedGroups([big, ['周末']], 'document')
    assert.equal(vecs.length, 6)
    assert.equal(small.length, 1)
    // chunk order survives the split: odd chunks mention 猫, even ones 显卡
    assert.ok(vecs.every((v, i) => (i % 2 ? v[0] > 0 : v[2] > 0)))
    for (const call of calls('/contextualizedembeddings')) {
      const chars = (call.body.inputs as string[][]).flat().join('').length
      assert.ok(chars <= 20_000, `request of ${chars} chars`)
    }
  })
})
