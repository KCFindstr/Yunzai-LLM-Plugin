import { mockServer, TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { chat, usesServerState } from '../src/llm/index.ts'
import type { ChatParams } from '../src/llm/types.ts'
import { vertexRequest, vertexToken } from '../src/llm/vertexAuth.ts'
import { configProblems, modelSuggestions } from '../cli/schema.mjs'
import { liveModels } from '../src/web/upstreamModels.ts'
import { resolvePrice } from '../src/billing/pricing.ts'

function params(baseUrl: string): ChatParams {
  return {
    provider: { type: 'vertex', project: 'test-project', location: 'global', baseUrl, apiKey: 'mock-oauth', maxRetries: 0 },
    model: { id: 'carbon', provider: 'vertex', model: 'gemini-4-carbon', vision: true },
    system: '# System\nKeep literal \\*.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image', data: 'AAAA', mime: 'image/png' }] }],
    tools: [{ name: 'weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, additionalProperties: false } }],
    thinking: 'low', maxTokens: 512,
  }
}

it('Vertex uses project-scoped generateContent and OAuth; preserves signed native parts across a tool round trip', async () => {
  const signed = { role: 'model', parts: [
    { text: 'Visible summary', thought: true, thoughtSignature: 'opaque-thought' },
    { functionCall: { name: 'weather', args: { city: 'LA' } }, thoughtSignature: 'opaque-signature' },
    { functionCall: { name: 'weather', args: { city: 'NY' } } },
  ] }
  const server = await mockServer((_req, n) => [200, { candidates: [{ content: n === 1 ? signed : { role: 'model', parts: [{ text: 'Done' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 5, cachedContentTokenCount: 60, candidatesTokenCount: 8, thoughtsTokenCount: 12 } }])
  try {
    const p = params(server.url + '/v1/')
    p.state = { previousId: 'must-not-be-sent', skip: 1 }
    const first = await chat(p)
    const req = server.requests[0]
    assert.equal(req.url, '/v1/projects/test-project/locations/global/publishers/google/models/gemini-4-carbon:generateContent')
    assert.equal(req.headers.authorization, 'Bearer mock-oauth')
    assert.equal(req.headers['x-goog-api-key'], undefined)
    assert.deepEqual(req.body.systemInstruction, { parts: [{ text: p.system }] })
    assert.deepEqual(req.body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } })
    assert.deepEqual(req.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'low' })
    assert.equal(req.body.previous_interaction_id, undefined)
    assert.equal(req.body.store, undefined)
    assert.equal(req.body.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties, false)
    assert.equal(first.text, '')
    assert.equal(first.reasoning, 'Visible summary')
    assert.deepEqual(first.toolCalls.map(call => call.args), [{ city: 'LA' }, { city: 'NY' }])
    assert.equal(first.usage.input, 45)
    assert.equal(first.usage.cacheRead, 60)
    assert.equal(first.usage.output, 20)
    assert.equal(first.usage.reasoning, 12)
    const result = await chat({ ...p, messages: [...p.messages,
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls, native: first.native },
      { role: 'tool', results: first.toolCalls.map((tc, i) => ({ id: tc.id, name: tc.name, content: ['Sunny', 'Rainy'][i] })) }] })
    assert.deepEqual(server.requests[1].body.contents[1], signed)
    assert.deepEqual(server.requests[1].body.contents[2].parts.map(part => part.functionResponse), [
      { name: 'weather', response: { output: 'Sunny' } }, { name: 'weather', response: { output: 'Rainy' } },
    ])
    assert.equal(result.text, 'Done')
    assert.equal(usesServerState(p.provider, p.model), false)
  } finally { await server.close() }
})

it('Vertex fails clearly on missing project or blocked output', async () => {
  const server = await mockServer(() => [200, { promptFeedback: { blockReason: 'SAFETY' } }])
  try {
    const p = params(server.url)
    await assert.rejects(chat({ ...p, provider: { ...p.provider, project: '' } }), /project/)
    assert.equal(server.requests.length, 0)
    await assert.rejects(chat(p), /SAFETY/)
  } finally { await server.close() }
})

it('Vertex is usable without a Gemini API key and lists Carbon without querying Developer models', async () => {
  const p = { type: 'vertex' as const, project: 'test-project' }
  assert.equal(config.hasKey(p), true)
  assert.equal(config.hasKey({ ...p, project: '' }), false)
  assert.ok(modelSuggestions(p).includes('gemini-4-carbon'))
  const price = resolvePrice({ id: 'carbon', provider: 'vertex', model: 'gemini-4-carbon' })
  assert.equal(price?.input, 2)
  assert.equal(price?.output, 10)
  assert.equal(price?.cacheRead, 0.1)
  assert.ok((await liveModels('vertex', p, 'chat')).models.includes('gemini-4-carbon'))
  const c = { ...config.get(), providers: { vertex: p }, models: [{ id: 'carbon', provider: 'vertex', model: 'gemini-4-carbon' }], defaultModel: 'carbon', fallbackModels: [], utilityModel: '', visionModel: '' }
  assert.ok(!configProblems(c).some(problem => /Key|project|没有任何可用/.test(problem)))
})

it('gcloud token acquisition is shared, cached, and refreshed after a 401 without storing tokens in config', async t => {
  const file = path.join(TMP, process.platform === 'win32' ? 'fake gcloud.cmd' : 'fake-gcloud')
  const calls = path.join(TMP, 'gcloud-calls.txt')
  fs.writeFileSync(file, process.platform === 'win32'
    ? `@echo off\r\necho called>>"${calls}"\r\necho mock-refreshed-token\r\n`
    : `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\nprintf 'mock-refreshed-token\\n'\n`)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o700)
  const server = await mockServer((_req, n) => n === 1 ? [401, { error: { message: 'Expired token' } }] : [200, { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] } }] }])
  try {
    const realFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', (url, init) => {
      assert.match(String(url), /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\//)
      return realFetch(server.url, init)
    })
    const provider = { ...params('https://aiplatform.googleapis.com').provider, apiKey: '', gcloudPath: file }
    assert.deepEqual(await Promise.all([vertexToken(provider), vertexToken(provider)]), ['mock-refreshed-token', 'mock-refreshed-token'])
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).length, 1)
    const result = await chat({ ...params(server.url), provider })
    assert.equal(result.text, 'OK')
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).length, 2)
    assert.equal(provider.apiKey, '')
    assert.ok(server.requests.every(req => req.headers.authorization === 'Bearer mock-refreshed-token'))
  } finally { await server.close() }
})

it('automatic host credentials never reach a custom, impersonated, or insecure endpoint', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not make a request') })
  const provider = { type: 'vertex' as const, gcloudPath: path.join(TMP, 'must-not-run-gcloud') }
  for (const url of ['https://example.invalid/v1', 'https://aiplatform.googleapis.com.example.invalid/v1',
    'http://aiplatform.googleapis.com/v1', 'https://aiplatform.googleapis.com:8443/v1', 'https://user@aiplatform.googleapis.com/v1']) {
    await assert.rejects(vertexRequest(provider, url, {}), /Google 官方 Vertex AI HTTPS/)
  }
  assert.equal(fetch.mock.callCount(), 0)
})

it('service-account impersonation is explicit and token caches are isolated by identity', async () => {
  const file = path.join(TMP, process.platform === 'win32' ? 'identity gcloud.cmd' : 'identity-gcloud')
  const calls = path.join(TMP, 'identity-calls.txt')
  fs.writeFileSync(file, process.platform === 'win32'
    ? `@echo off\r\necho %*>>"${calls}"\r\necho mock-identity-token\r\n`
    : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf 'mock-identity-token\\n'\n`)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o700)
  const a = { type: 'vertex' as const, gcloudPath: file, serviceAccount: 'bot-a@test-project.iam.gserviceaccount.com' }
  const b = { ...a, serviceAccount: 'bot-b@test-project.iam.gserviceaccount.com' }
  await vertexToken(a)
  await vertexToken(b)
  await vertexToken(a)
  const lines = fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes(`--impersonate-service-account=${a.serviceAccount}`))
  assert.ok(lines[1].includes(`--impersonate-service-account=${b.serviceAccount}`))
  await assert.rejects(vertexToken({ ...a, serviceAccount: `${a.serviceAccount} & echo invalid` }), /serviceAccount/)
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).length, 2)
})

it('gcloud failures never include captured credential output in the error', async () => {
  await assert.rejects(vertexToken({ type: 'vertex', gcloudPath: path.join(TMP, 'missing-gcloud') }), error => {
    assert.match(String(error), /gcloud auth login/)
    assert.doesNotMatch(String(error), /stdout|stderr|Command failed/)
    return true
  })
})
