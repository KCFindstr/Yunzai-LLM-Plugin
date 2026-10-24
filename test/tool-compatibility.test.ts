import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { degradedFeatures, runTurn } from '../src/chat/agent.ts'
import { registerSendImageTool } from '../src/tools/sendImage.ts'
import { registry } from '../src/tools/registry.ts'

registerSendImageTool()
function configure(url: string, id: string) {
  writeUserConfig(`providers:\n  mock: { type: gemini, baseUrl: '${url}', apiKey: fake, maxRetries: 0 }\nmodels:\n  - { id: ${id}, provider: mock, model: fake, serverState: false, thinking: off }\ndefaultModel: ${id}\nfallbackModels: []\nchat: { thinking: off, summarize: false }\nmemory: { enable: false }\ntools: { webSearch: { enable: false } }\n`)
  config.load()
  return { e: fakeEvent().e, eff: config.effective(), input: { text: '检查工具配置', images: [], imageSegments: [] }, isAdmin: true, convKey: `compat:${id}` }
}
const reply = { steps: [{ type: 'model_output', content: [{ type: 'text', text: '工具可用' }] }] }

it('sends a Gemini-compatible flat send_image schema and validates mutually exclusive arguments at runtime', async () => {
  const server = await mockServer(request => {
    const tool = request.body.tools.find((entry: any) => entry.name === 'send_image')
    assert.ok(tool)
    // The provider rejected required-only oneOf branches as undeclared properties.
    for (const branch of tool.parameters.oneOf ?? []) for (const key of branch.required ?? []) {
      if (!branch.properties?.[key]) return [400, { error: { message: `Invalid schema in function tool 'send_image' parameters: specifies required field '${key}' which is not defined` } }]
    }
    assert.equal(tool.parameters.properties.path.type, 'string')
    assert.equal(tool.parameters.properties.url.type, 'string')
    return [200, reply]
  })
  try {
    const req = configure(server.url, 'flat-tools')
    assert.equal((await runTurn(req)).kind, 'reply')
    assert.equal(server.requests.length, 1)
    assert.deepEqual(degradedFeatures('flat-tools'), [])
    const ctx: any = { eff: req.eff, turn: { images: [] } }
    const tool = registry.get('send_image')!
    assert.equal((await tool.run({}, ctx) as any).isError, true)
    assert.equal((await tool.run({ path: '/work/attachments/example.png', url: 'https://example.com/image.png' }, ctx) as any).isError, true)
  } finally { await server.close() }
})

it('does not disable or cache tools after a provider reports an invalid function schema', async () => {
  const message = "Invalid schema in function tool 'send_image' parameters: specifies required field 'path' which is not defined"
  const server = await mockServer((_request, n) => n === 1 ? [400, { error: { message } }] : [200, reply])
  try {
    const req = configure(server.url, 'schema-rejection')
    const rejected = await runTurn(req)
    assert.equal(rejected.kind, 'error')
    if (rejected.kind === 'error') assert.match(rejected.message, /Invalid schema/)
    assert.equal(server.requests.length, 1)
    assert.deepEqual(degradedFeatures('schema-rejection'), [])
    assert.equal((await runTurn(req)).kind, 'reply')
    assert.ok(server.requests[1].body.tools.some((tool: any) => tool.name === 'send_image'))
  } finally { await server.close() }
})

it('still retries without tools when the provider explicitly rejects tool calling', async () => {
  const server = await mockServer((_request, n) => n === 1 ? [400, { error: { message: 'tools are not supported by this model' } }] : [200, reply])
  try {
    assert.equal((await runTurn(configure(server.url, 'unsupported-tools'))).kind, 'reply')
    assert.equal(server.requests.length, 2)
    assert.equal(server.requests[1].body.tools, undefined)
    assert.deepEqual(degradedFeatures('unsupported-tools'), ['tools'])
  } finally { await server.close() }
})
