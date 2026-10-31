import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { registry } from '../src/tools/registry.ts'
import { trackRolloutJob } from '../src/chat/rollouts.ts'
import { getSession } from '../src/chat/session.ts'

for (const protocol of ['gemini', 'openai-responses'] as const) {
  const previous = protocol === 'gemini' ? 'previous_interaction_id' : 'previous_response_id'
  it(`${protocol}: isolates rollouts, retains tool continuation and recovers from an expired in-rollout ID`, async () => {
    let calls = 0
    const server = await mockServer(() => {
      const n = ++calls
      if (n === 2) return [404, { error: { message: 'interaction not found' } }]
      const tool = n === 1
      return [200, protocol === 'gemini'
        ? { id: `id-${n}`, status: 'completed', steps: tool
          ? [{ type: 'function_call', id: 'call-1', name: 'rollout_probe', arguments: {} }]
          : [{ type: 'model_output', content: [{ type: 'text', text: 'answer' }] }], usage: {} }
        : { id: `id-${n}`, output: tool
          ? [{ type: 'function_call', call_id: 'call-1', name: 'rollout_probe', arguments: '{}' }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }], usage: {} }]
    })
    registry.register({ name: 'rollout_probe', description: 'probe', parameters: {}, run: async () => 'private-tool-result' })
    try {
      writeUserConfig(`providers:\n  mock: { type: ${protocol}, baseUrl: '${server.url}', apiKey: test, serverState: true, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, thinking: off }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, groupContext: 0 }\nmemory: { enable: false }\n`)
      config.load()
      const e = fakeEvent().e, convKey = `rollout-boundary-${protocol}`
      // Legacy persisted state cannot be inherited by a new rollout.
      getSession(convKey, 180).state = { key: 'old', previousId: 'legacy-id', len: 0 }
      const request = () => ({ e, convKey, eff: config.effective(), isAdmin: true, input: { text: 'hello', images: [], imageSegments: [] } })
      const first = await runTurn({ ...request(), proactive: true })
      assert.equal(first.kind, 'reply')
      assert.equal(server.requests[0].body[previous], undefined)
      assert.equal(server.requests[1].body[previous], 'id-1', 'tool steps reuse this rollout only')
      assert.equal(server.requests[1].body.input.length, 1)
      assert.equal(server.requests[2].body[previous], undefined, 'expired state retries with full tool transcript')
      assert.match(JSON.stringify(server.requests[2].body.input), /private-tool-result/)
      assert.notEqual(server.requests[2].body.input.length, 1)
      trackRolloutJob(first.rolloutId, 'same-rollout-job')
      const callback = await runTurn({ ...request(), rolloutId: first.rolloutId, asyncResult: { kind: 'agy', id: 'same-rollout-job' } })
      assert.equal(callback.rolloutId, first.rolloutId)
      assert.equal(server.requests[3].body[previous], 'id-3', 'same-rollout callback may continue')
      assert.equal(server.requests[3].body.input.length, 1)
      const next = await runTurn(request())
      assert.notEqual(next.rolloutId, first.rolloutId)
      assert.equal(server.requests[4].body[previous], undefined)
      assert.doesNotMatch(JSON.stringify(server.requests[4].body.input), /private-tool-result|只回复 \[skip\]/)
      assert.match(JSON.stringify(server.requests[4].body.input), /answer/, 'explicit conversation history remains')
    } finally { registry.unregisterWhere(tool => tool.name === 'rollout_probe'); await server.close() }
  })
}
