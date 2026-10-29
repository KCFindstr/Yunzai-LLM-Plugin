import { mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, describe, it } from 'node:test'

// judge model answers by keyword in the message under evaluation; 'slow' sleeps past the timeout
const lastMessage = (text: string) => text.slice(text.lastIndexOf('【待评估的消息】'))
const llm = await mockServer(async req => {
  const msg = lastMessage(String(req.body.messages.at(-1).content?.[0]?.text ?? req.body.messages.at(-1).content))
  if (msg.includes('slow')) await new Promise(r => setTimeout(r, 1500))
  if (msg.includes('broken')) return [500, { error: { message: 'boom' } }]
  const label = msg.includes('配队') ? 'complex' : msg.includes('几号') ? ' question\n' : msg.includes('nonsense') ? '不知道' : msg.includes('作文') ? 'essay' : 'casual'
  return [200, { choices: [{ message: { role: 'assistant', content: label }, finish_reason: 'stop' }], usage: { prompt_tokens: 180, completion_tokens: 1 } }]
})
const s1 = await mockServer(() => [200, { model: 'kev-latest', answers: { answer: { type: 'choice', choice: 'complex', confidence: 0.8, probabilities: {} } } }])
after(() => Promise.all([llm.close(), s1.close()]))

writeUserConfig(`
providers:
  judge: { type: openai, baseUrl: ${llm.url}, apiKey: k, maxRetries: 0 }
  kev: { type: systemone, baseUrl: '${s1.url}/v1', apiKey: sk }
models:
  - { id: judge, provider: judge, model: tiny-judge, pricing: { input: 0.1, output: 0.4 } }
  - { id: main, provider: judge, model: big, thinking: auto, autoThinking: { casual: 'off', complex: max } }
systemoneModels:
  - { id: kev, provider: kev, model: kev-latest }
defaultModel: judge
pricing: { sources: [] }
autoThinking:
  judge: judge
  timeoutMs: 400
`)

const { config } = await import('../src/core/config.ts')
const { judgeMessage, judgePrompt, resolveThinkingDecision } = await import('../src/chat/thinking.ts')
const { renderTranscript, botLine } = await import('../src/chat/judge.ts')
const q = { userId: 1, groupId: 2, isAdmin: false }
const msg = (text: string, extra: Record<string, any> = {}) => ({ heading: '【消息｜10-29 12:00｜群「测试群」｜发言人 岛风(平台ID 1)】', text, ...extra })
const cfg = (over: Record<string, any> = {}) => ({ ...config.get().autoThinking, ...over })

describe('thinking judge', () => {
  it('asks the judge model for one of the configured categories, with thinking off', async () => {
    const j = await judgeMessage(msg('胡桃和行秋怎么配队'), q, cfg())
    assert.deepEqual([j.kind, j.source], ['complex', 'model'])
    assert.equal(j.judge?.model, 'judge')
    const body = llm.requests.at(-1)!.body
    assert.equal(body.model, 'tiny-judge')
    assert.equal(body.max_tokens, 16)
    assert.equal(body.temperature, 0)
    assert.equal(body.reasoning_effort, undefined)
    assert.match(body.messages[0].content, /消息分类器/)
    for (const k of config.get().autoThinking.categories) assert.ok(body.messages[0].content.includes(`${k.name}：${k.description}`), k.name)
    assert.match(body.messages[0].content, /只评估【待评估的消息】这一条/)
    assert.equal((await judgeMessage(msg('中秋节是几号'), q, cfg())).kind, 'question', 'tolerates whitespace around the label')
  })

  it('sends the bot, recent history and group chat, with the message to evaluate last', async () => {
    await judgeMessage(msg('那第二个呢', {
      bot: botLine('天津风', 10000),
      history: ['【消息｜10-29 11:59｜群「测试群」｜发言人 岛风(平台ID 1)】推荐两个配队', '你：一是国家队，二是雷九万班'],
      recent: ['1. [10-29 11:58] 雪风(平台ID 2): 今晚打深渊'],
    }), q, cfg())
    const user = llm.requests.at(-1)!.body.messages.at(-1).content
    const text = typeof user === 'string' ? user : user[0].text
    assert.match(text, /^【机器人】.*「天津风」\(平台ID 10000\).*\[at:you\] 表示@它/)
    assert.ok(text.indexOf('【最近对话·仅供理解语境】') < text.indexOf('你：一是国家队'))
    assert.ok(text.indexOf('【最近群聊·仅供理解语境】') < text.indexOf('今晚打深渊'))
    assert.ok(text.trimEnd().endsWith('【待评估的消息】\n【消息｜10-29 12:00｜群「测试群」｜发言人 岛风(平台ID 1)】\n那第二个呢'))
  })

  it('every message goes to the judge: no keyword, length or image shortcuts', async () => {
    const n = llm.requests.length
    assert.deepEqual([(await judgeMessage(msg('哈哈'), q, cfg())).source, (await judgeMessage(msg(''), q, cfg())).source], ['model', 'model'])
    // a picture does not force a category: that rule lives in the category descriptions
    assert.equal((await judgeMessage(msg('哈哈[图片]', { images: 1 }), q, cfg())).kind, 'casual')
    assert.equal(llm.requests.length, n + 3)
    assert.match(config.get().autoThinking.categories[1].description, /图片/)
  })

  it('falls back to the first category on timeout, error or an unusable answer', async () => {
    const slow = await judgeMessage(msg('slow 为什么天是蓝的'), q, cfg())
    assert.deepEqual([slow.kind, slow.source], ['casual', 'fallback'])
    assert.ok(slow.ms < 1200, `gave up after the timeout (${slow.ms}ms)`)
    assert.equal((await judgeMessage(msg('broken 今天吃什么'), q, cfg())).source, 'fallback')
    const odd = await judgeMessage(msg('nonsense'), q, cfg())
    assert.deepEqual([odd.kind, odd.source], ['casual', 'fallback'])
    assert.match(odd.fallbackReason!, /无法解析/)
  })

  it('uses the configured categories, whatever they are', async () => {
    const custom = cfg({ categories: [{ name: 'chat', description: '随便聊' }, { name: 'essay', description: '写作文' }] })
    assert.match(judgePrompt(custom), /只输出一个类别名：chat、essay/)
    assert.equal((await judgeMessage(msg('帮我写篇作文'), q, custom)).kind, 'essay')
    assert.equal((await judgeMessage(msg('broken'), q, custom)).kind, 'chat', 'first category is the fallback')
  })

  it('speaks the System One API when the judge is a System One model', async () => {
    const j = await judgeMessage(msg('随便问问看', { bot: botLine('天津风', 10000) }), q, cfg({ judge: 'kev' }))
    assert.deepEqual([j.kind, j.source], ['complex', 'systemone'])
    const req = s1.requests.at(-1)!
    assert.equal(req.url, '/v1/systemone')
    assert.equal(req.headers.authorization, 'Bearer sk')
    assert.equal(req.body.model, 'kev-latest')
    assert.equal(req.body.questions.answer.type, 'choice')
    assert.match(req.body.questions.answer.instructions, /只评估【待评估的消息】/)
    assert.deepEqual(Object.keys(req.body.questions.answer.criteria), ['casual', 'question', 'complex'])
    assert.match(req.body.state, /「天津风」/)
  })

  it('logs probabilities, input tokens, and pricing for a System One judge', async () => {
    const logs: string[] = []
    const prevLogger = (globalThis as any).logger
    ;(globalThis as any).logger = { debug: (_tag: string, m: string) => logs.push(m), info: () => {}, warn: () => {}, error: () => {} }
    const s2 = await mockServer(() => [200, {
      model: 'jev-latest',
      answers: { answer: { type: 'choice', choice: 'question', confidence: 0.92, probabilities: { casual: 0.05, question: 0.92, complex: 0.03 } } },
      usage: { input_tokens: 120, output_tokens: 5 },
    }])
    try {
      config.set('providers.jev', { type: 'systemone', baseUrl: `${s2.url}/v1`, apiKey: 'sk' })
      config.set('systemoneModels', [{ id: 'kev', provider: 'kev', model: 'kev-latest' }, { id: 'jev', provider: 'jev', model: 'jev-latest' }])
      const j = await judgeMessage(msg('中秋节是几月几号'), q, cfg({ judge: 'jev' }))
      assert.deepEqual([j.kind, j.source], ['question', 'systemone'])
      const response = JSON.parse(j.judge!.response)
      assert.equal(response.model, 'jev-latest')
      assert.equal(response.answers.kind.choice, 'question')
      assert.equal(response.answers.kind.confidence, 0.92)
      assert.deepEqual(response.answers.kind.probabilities, { casual: 0.05, question: 0.92, complex: 0.03 })
      assert.deepEqual(j.judge?.probabilities, { casual: 0.05, question: 0.92, complex: 0.03 })
      assert.equal(j.judge?.inputTokens, 120)
      const debugLog = logs.find(l => l.includes('[systemone jev-latest]'))
      assert.ok(debugLog, `should log [systemone jev-latest], got: ${JSON.stringify(logs)}`)
      assert.ok(debugLog.includes('choice=question'))
      assert.ok(debugLog.includes('conf=0.92'))
      assert.ok(debugLog.includes('casual=0.050 question=0.920 complex=0.030'))
      assert.ok(debugLog.includes('in=120'))
      assert.ok(debugLog.includes('cost=$0.000005'))
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

  it('maps the category through the model’s own levels, then autoThinking.levels', async () => {
    const main = config.getModel('main')
    assert.equal((await resolveThinkingDecision('auto', main, msg('胡桃和行秋怎么配队'), q)).level, 'max', 'model override')
    assert.equal((await resolveThinkingDecision('auto', main, msg('哈哈'), q)).level, 'off', 'model override')
    assert.equal((await resolveThinkingDecision('auto', main, msg('中秋节是几号'), q)).level, 'medium', 'global default level')
    assert.equal((await resolveThinkingDecision('auto', config.getModel('judge'), msg('胡桃和行秋怎么配队'), q)).level, 'high')
    assert.equal(config.fallbackLevel(main), 'off', 'first category')
  })

  it('keeps the decision and fallback reason, and skips the judge for fixed or uniform levels', async () => {
    const main = config.getModel('main')!
    const auto = await resolveThinkingDecision('auto', main, msg('胡桃和行秋怎么配队'), q)
    assert.deepEqual([auto.kind, auto.judge?.response], ['complex', 'complex'])
    const fallback = await resolveThinkingDecision('auto', main, msg('broken 今天吃什么'), q)
    assert.deepEqual([fallback.source, fallback.level], ['fallback', 'off'])
    assert.ok(fallback.fallbackReason)
    const calls = llm.requests.length
    assert.equal((await resolveThinkingDecision('medium', main, msg('帮我写脚本'), q)).source, 'fixed')
    const uniform = await resolveThinkingDecision('auto', { ...main, autoThinking: { casual: 'low', question: 'low', complex: 'low' } }, msg('帮我写脚本'), q)
    assert.deepEqual([uniform.level, uniform.source], ['low', 'uniform'])
    assert.equal(llm.requests.length, calls)
  })

  it('renders the transcript the same way for the playground', () => {
    const text = renderTranscript({ heading: '【消息】', text: '', images: 2 })
    assert.match(text, /（空：只@了你，没有说话）/)
    assert.match(text, /附带 2 张图片或表情/)
  })
})

// The labelled set used to compare judges (see docs/IMPLEMENTATION.md); keep it well-formed.
describe('thinking eval fixture', () => {
  it('is a list of [message, label] pairs over the default categories', () => {
    const data = JSON.parse(fs.readFileSync(new URL('./fixtures/thinking-eval.json', import.meta.url), 'utf8'))
    const names = config.get().autoThinking.categories.map(k => k.name)
    assert.ok(data.length >= 50)
    for (const [t, k] of data) assert.ok(typeof t === 'string' && names.includes(k), t)
  })
})
