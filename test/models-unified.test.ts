import { mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

// one server for every kind of model: chat, embeddings, System One, and the provider's model list
const server = await mockServer(req => {
  if (req.method === 'GET' && req.url === '/v1/models') return [200, { data: [{ id: 'fresh-model-2027' }, { id: 'text-embedding-9' }, { id: 'tts-1' }] }]
  if (req.url === '/v1/embeddings') return [200, { data: req.body.input.map((_: string, index: number) => ({ index, embedding: [0.6, 0.8, 0] })) }]
  if (req.url === '/v1/systemone') return [200, { model: 'jev-latest', answers: { answer: { choice: 'question', probabilities: { casual: 0.1, question: 0.8, complex: 0.1 } } } }]
  const system = String(req.body.messages?.[0]?.content ?? '')
  const content = /消息分类器/.test(system) ? 'complex' : /主动接话/.test(system) ? '30' : 'OK'
  return [200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]
})
after(() => server.close())

writeUserConfig(`
providers:
  mock: { type: openai, baseUrl: '${server.url}/v1', apiKey: k, maxRetries: 0 }
  so: { type: systemone, baseUrl: '${server.url}/v1', apiKey: sk }
  vec: { type: openai, baseUrl: '${server.url}/v1', apiKey: vk }
models:
  - { id: main, provider: mock, model: big, thinking: auto, autoThinking: { casual: minimal, complex: high } }
  - { id: fixed, provider: mock, model: big, thinking: low }
embeddingModels:
  - { id: vec3, provider: vec, model: text-embedding-9, dimensions: 256 }
systemoneModels:
  - { id: jev, provider: so, model: jev-latest }
defaultModel: main
utilityModel: main
fallbackModels: []
pricing: { sources: [] }
memory: { embedding: { enable: true, model: vec3 } }
autoThinking: { judge: main }
`)

const { config } = await import('../src/core/config.ts')
const { configNotices, configProblems, effectiveThinking, modelDefaults } = await import('../cli/schema.mjs')
const { utilityChat } = await import('../src/chat/utility.ts')
const { embeddingReady, embeddingTag } = await import('../src/memory/embed.ts')
const { openaiResponses } = await import('../src/llm/openaiResponses.ts')
const { routes } = await import('../src/web/api.ts')

const route = (method: string, path: string) => {
  const r = routes.find(x => x.method === method && x.pattern.test(path))!
  const params = (path.match(r.pattern) ?? []).slice(1)
  return (body: any = {}, query = '') => r.run({ params, query: new URLSearchParams(query), body })
}

describe('background calls on an auto-thinking model', () => {
  it('run at the level of the first category, and the config page says so', async () => {
    await utilityChat({ candidates: ['main'], system: 's', user: [{ type: 'text', text: 'u' }], quotaCtx: { isAdmin: true } })
    assert.equal(server.requests.at(-1)!.body.reasoning_effort, 'minimal')
    await utilityChat({ candidates: ['fixed'], system: 's', user: [{ type: 'text', text: 'u' }], quotaCtx: { isAdmin: true } })
    assert.equal(server.requests.at(-1)!.body.reasoning_effort, 'low')
    const notices = configNotices(config.get())
    assert.equal(notices.length, 1)
    assert.deepEqual(notices[0].paths, ['utilityModel', 'models.0'])
    assert.match(notices[0].text, /后台任务模型.*main.*auto.*「casual」.*minimal.*同一个上游模型 big/)
  })
})

describe('unified providers and models', () => {
  it('embeddings come from an embedding model on a provider; the vector space tag is unchanged in form', () => {
    assert.equal(embeddingReady(), true)
    assert.equal(embeddingTag(), 'openai:text-embedding-9:256')
  })

  it('flags models on the wrong kind of provider and duplicate ids', () => {
    const c = structuredClone(config.get())
    c.models.push({ id: 'jev', provider: 'so', model: 'x' })
    const problems = configProblems(c)
    assert.ok(problems.some((p: string) => /聊天模型 jev 的提供商 so（systemone）不能提供聊天模型/.test(p)))
    assert.ok(problems.some((p: string) => /模型别名 jev .*重复/.test(p)))
  })

  it('tests every kind of model from the web API', async () => {
    const chat = await route('POST', '/api/models/main/test')({}, 'kind=chat')
    assert.equal(chat.ok, true)
    const vec = await route('POST', '/api/models/vec3/test')({}, 'kind=embedding')
    assert.deepEqual([vec.ok, vec.text], [true, '3 维向量'])
    assert.equal(server.requests.at(-1)!.headers.authorization, 'Bearer vk')
    const so = await route('POST', '/api/models/jev/test')({}, 'kind=systemone')
    assert.equal(so.ok, true)
    await assert.rejects(Promise.resolve().then(() => route('POST', '/api/models/vec3/test')({}, 'kind=chat')), /没有这个模型/)
  })

  it('offers the provider’s own model list in the model dropdown', async () => {
    const chat = await route('GET', '/api/providers/mock/models')({}, '')
    assert.deepEqual(chat.models, ['fresh-model-2027'])
    const emb = await route('GET', '/api/providers/vec/models')({}, 'kind=embedding')
    assert.deepEqual(emb.models, ['text-embedding-9'])
    const so = await route('GET', '/api/providers/so/models')({}, '')
    assert.deepEqual(so.models, ['jev-latest'])
  })

  it('knows DeepSeek capabilities and effective thinking levels', () => {
    assert.deepEqual(modelDefaults('deepseek-flash'), { vision: true, toolUse: true, nativeSearch: false })
    assert.deepEqual(modelDefaults('deepseek-v4-pro'), { vision: false, toolUse: true, nativeSearch: true })
    const ds = effectiveThinking({ type: 'openai-responses', baseUrl: 'https://api.deepseek.com' })
    assert.deepEqual([ds.minimal, ds.medium, ds.xhigh, ds.max], ['low', 'high', 'high', 'max'])
    const defaults = config.get()
    assert.equal(defaults.providers.deepseek.type, 'openai-responses', 'DeepSeek defaults to the Responses API')
  })
})

describe('DeepSeek on the Responses API', () => {
  it('turns thinking off with effort none and counts the searches it reports', async t => {
    let body: any
    t.mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '查到了' }] }], usage: { input_tokens: 10, output_tokens: 2, server_tool_use: { tool_search: 2 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const provider = { type: 'openai-responses' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'k', maxRetries: 0 }
    const model = { id: 'ds', provider: 'deepseek', model: 'deepseek-v4-pro' }
    const res = await openaiResponses.chat({ model, provider, system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [], nativeSearch: true, thinking: 'off', maxTokens: 100, temperature: null })
    assert.deepEqual(body.reasoning, { effort: 'none' })
    assert.deepEqual(body.tools, [{ type: 'web_search' }])
    assert.equal(res.usage.webSearches, 2)
    await openaiResponses.chat({ model, provider, system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], tools: [], nativeSearch: false, thinking: 'high', maxTokens: 100, temperature: null })
    assert.equal(body.reasoning.effort, 'high')
  })
})

describe('judge playgrounds', () => {
  it('auto thinking: category, the chosen model’s level, and the exact prompt', async () => {
    const r = await route('POST', '/api/playground/thinking')({ recent: '岛风: 推荐个配队\n雪风: 同问', sender: '岛风', message: '那第二个呢', model: 'main', botName: '天津风' })
    assert.deepEqual([r.kind, r.level, r.source], ['complex', 'high', 'model'])
    assert.match(r.prompt.system, /消息分类器/)
    assert.match(r.prompt.user, /「天津风」/)
    assert.match(r.prompt.user, /1\. \[.*\] 岛风: 推荐个配队/)
    assert.ok(r.prompt.user.trimEnd().endsWith('那第二个呢'))
    const so = await route('POST', '/api/playground/thinking')({ message: '几号', judge: 'jev', model: 'main' })
    assert.deepEqual([so.kind, so.source, so.level], ['question', 'systemone', 'medium'])
  })

  it('proactive: score against the threshold for a given time since the bot spoke', async () => {
    const never = await route('POST', '/api/playground/proactive')({ recent: '岛风: 周末去哪', message: '天津风去不去', judge: 'main', sinceLast: null })
    assert.deepEqual([never.score, never.threshold, never.reply], [0.3, 0.6, false])
    const so = await route('POST', '/api/playground/proactive')({ message: '天津风去不去', judge: 'jev', sinceLast: 0 })
    assert.equal(so.source, 'systemone')
    assert.equal(so.threshold, 0.95)
  })
})
