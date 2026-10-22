import { mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, describe, it } from 'node:test'

// judge model answers by keyword so the test controls the label; 'slow' sleeps past the timeout
const llm = await mockServer(async req => {
  const msg = String(req.body.messages.at(-1).content?.[0]?.text ?? req.body.messages.at(-1).content)
  if (msg.includes('slow')) await new Promise(r => setTimeout(r, 1500))
  if (msg.includes('broken')) return [500, { error: { message: 'boom' } }]
  const label = msg.includes('配队') ? 'complex' : msg.includes('几号') ? ' question\n' : 'casual'
  return [200, { choices: [{ message: { role: 'assistant', content: label }, finish_reason: 'stop' }], usage: { prompt_tokens: 180, completion_tokens: 1 } }]
})
const s1 = await mockServer(() => [200, { model: 'kev-latest', answers: { kind: { type: 'choice', choice: 'complex', confidence: 0.8, probabilities: {} } } }])
after(() => Promise.all([llm.close(), s1.close()]))

writeUserConfig(`
providers:
  judge: { type: openai, baseUrl: ${llm.url}, apiKey: k, maxRetries: 0 }
models:
  - { id: judge, provider: judge, model: tiny-judge, pricing: { input: 0.1, output: 0.4 } }
defaultModel: judge
pricing: { sources: [] }
chat:
  thinkingJudge: { mode: model, timeoutMs: 400 }
`)

const { config } = await import('../src/core/config.ts')
const { classifyMessage, judgeMessage, resolveThinking } = await import('../src/chat/thinking.ts')
const q = { userId: 1, groupId: 2, isAdmin: false }

describe('keyword heuristic', () => {
  it('classifies chit-chat, questions and complex requests', () => {
    assert.equal(classifyMessage('哈哈哈'), 'casual')
    assert.equal(classifyMessage('今天吃什么'), 'question')
    assert.equal(classifyMessage('帮我对比一下胡桃和雷电将军谁更适合深渊'), 'complex')
    assert.equal(classifyMessage('', { images: 1 }), 'question')
  })
})

describe('thinking judge', () => {
  const cfg = () => config.effective().chat.thinkingJudge

  it('asks the judge model with thinking off and a tiny output budget', async () => {
    const j = await judgeMessage({ text: '胡桃和行秋怎么配队' }, cfg(), q)
    assert.deepEqual([j.kind, j.source], ['complex', 'model'])
    const body = llm.requests.at(-1)!.body
    assert.equal(body.model, 'tiny-judge')
    assert.equal(body.max_tokens, 8)
    assert.equal(body.temperature, 0)
    assert.equal(body.reasoning_effort, undefined)
    assert.match(body.messages[0].content, /消息分类器/)
    assert.equal((await judgeMessage({ text: '中秋节是几号' }, cfg(), q)).kind, 'question', 'tolerates whitespace around the label')
  })

  it('skips the judge for obvious cases', async () => {
    const n = llm.requests.length
    assert.equal((await judgeMessage({ text: '哈哈' }, cfg(), q)).source, 'obvious')
    assert.equal((await judgeMessage({ text: '' }, cfg(), q)).kind, 'casual')
    assert.equal((await judgeMessage({ text: 'x'.repeat(400) }, cfg(), q)).kind, 'complex')
    assert.equal(llm.requests.length, n)
  })

  it('falls back to the heuristic on timeout or error', async () => {
    const slow = await judgeMessage({ text: 'slow 为什么天是蓝的' }, cfg(), q)
    assert.equal(slow.source, 'heuristic')
    assert.ok(slow.ms < 1200, `gave up after the timeout (${slow.ms}ms)`)
    assert.equal((await judgeMessage({ text: 'broken 今天吃什么' }, cfg(), q)).source, 'heuristic')
  })

  it('heuristic mode never calls a model', async () => {
    const n = llm.requests.length
    const j = await judgeMessage({ text: '帮我写个脚本' }, { ...cfg(), mode: 'heuristic' }, q)
    assert.deepEqual([j.kind, j.source], ['complex', 'heuristic'])
    assert.equal(llm.requests.length, n)
  })

  it('speaks the System One API (Jev / Kev)', async () => {
    const j = await judgeMessage({ text: '随便问问看' }, { ...cfg(), mode: 'systemone', url: `${s1.url}/v1/systemone`, apiKey: 'sk' }, q)
    assert.deepEqual([j.kind, j.source], ['complex', 'systemone'])
    const req = s1.requests[0]
    assert.equal(req.headers.authorization, 'Bearer sk')
    assert.equal(req.body.model, 'jev-latest')
    assert.equal(req.body.questions.kind.type, 'choice')
    assert.deepEqual(Object.keys(req.body.questions.kind.criteria), ['casual', 'question', 'complex'])
  })

  it('logs probabilities, input tokens, and pricing for systemone judge', async () => {
    const logs: string[] = []
    const prevLogger = (globalThis as any).logger
    ;(globalThis as any).logger = {
      debug: (_tag: string, msg: string) => logs.push(msg),
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const s2 = await mockServer(() => [
      200,
      {
        model: 'jev-latest',
        answers: {
          kind: {
            type: 'choice',
            choice: 'question',
            confidence: 0.92,
            probabilities: { casual: 0.05, question: 0.92, complex: 0.03 },
          },
        },
        usage: { input_tokens: 120, output_tokens: 5 },
      },
    ])
    try {
      const j = await judgeMessage(
        { text: '中秋节是几月几号' },
        { ...cfg(), mode: 'systemone', url: `${s2.url}/v1/systemone`, apiKey: 'sk', systemoneModel: 'jev-latest' },
        q,
      )
      assert.equal(j.kind, 'question')
      assert.equal(j.source, 'systemone')
      const debugLog = logs.find(l => l.includes('[systemone jev-latest]'))
      assert.ok(debugLog, `should log [systemone jev-latest], got: ${JSON.stringify(logs)}`)
      assert.ok(debugLog.includes('choice=question'), 'should include choice')
      assert.ok(debugLog.includes('conf=0.92'), 'should include confidence')
      assert.ok(debugLog.includes('casual=0.050 question=0.920 complex=0.030'), 'should include probabilities')
      assert.ok(debugLog.includes('in=120'), 'should include input tokens')
      assert.ok(debugLog.includes('price=$0.042/M'), 'should include jev price')
      assert.ok(debugLog.includes('cost=$0.000005'), 'should include computed cost')
    } finally {
      ;(globalThis as any).logger = prevLogger
      await s2.close()
    }
  })

  it('resolves default price for jev models', async () => {
    const { resolveModelPrice, resolvePrice, DEFAULT_JEV_PRICE } = await import('../src/billing/pricing.ts')
    for (const name of ['jev', 'jev-latest', 'jev-preview', 'jev-1.0', 'typesafe/jev']) {
      const price = resolveModelPrice(name)
      assert.ok(price, `should resolve price for ${name}`)
      assert.equal(price.input, DEFAULT_JEV_PRICE.input)
      assert.equal(price.output, DEFAULT_JEV_PRICE.output)
      assert.equal(price.source, 'builtin')
    }
    const modelCfgPrice = resolvePrice({ id: 'm', provider: 'typesafe', model: 'jev-preview', pricing: 'auto' })
    assert.ok(modelCfgPrice)
    assert.equal(modelCfgPrice.input, 0.042)
    assert.equal(modelCfgPrice.output, 0)
  })

  it('resolveThinking maps auto through chat.autoThinking and leaves fixed levels alone', async () => {
    const chat = config.effective().chat
    assert.equal(await resolveThinking('auto', chat, { text: '胡桃和行秋怎么配队' }, q), 'high')
    assert.equal(await resolveThinking('auto', chat, { text: '哈哈' }, q), 'low')
    assert.equal(await resolveThinking('medium', chat, { text: '胡桃和行秋怎么配队' }, q), 'medium')
  })
})

// The labelled set used to compare judges (see docs/IMPLEMENTATION.md); keep it well-formed.
describe('thinking eval fixture', () => {
  it('is a list of [message, label] pairs', () => {
    const data = JSON.parse(fs.readFileSync(new URL('./fixtures/thinking-eval.json', import.meta.url), 'utf8'))
    assert.ok(data.length >= 50)
    for (const [t, k] of data) assert.ok(typeof t === 'string' && ['casual', 'question', 'complex'].includes(k), t)
  })
})
