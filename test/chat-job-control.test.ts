import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { setupRuntime } from '../src/core/setup.ts'
import { runTurn } from '../src/chat/agent.ts'
import { hasPendingJobs, rolloutHistory } from '../src/chat/rollouts.ts'
import { sessionKey } from '../src/chat/session.ts'
import { agyQueue, registerAgyTool } from '../src/tools/agy.ts'
import { computerQueue, registerComputerTool } from '../src/tools/computer.ts'

registerAgyTool()
registerComputerTool()

for (const protocol of ['gemini', 'openai-responses'] as const) for (const tool of ['agy', 'computer_task'] as const) {
  it(`${protocol}: a fresh chat rollout can inspect and cancel its running ${tool} job without an ID`, async t => {
    // Mock setup probes and queue workers: no CLI work, WSL or desktop actions run.
    t.mock.method(setupRuntime, 'exec', async (file: string) => ({ stdout: file === 'wsl.exe' ? '[true,true]' : '--sandbox --dangerously-skip-permissions', stderr: '' }))
    let calls = 0, notifications = 0, aborted = false
    const server = await mockServer(() => {
      const n = ++calls
      const action = n === 1 ? 'start' : n === 3 ? 'status' : n === 5 || n === 7 ? 'cancel' : undefined
      const args = action === 'start' ? { action, task: 'Long operation' } : { action }
      return [200, protocol === 'gemini'
        ? { id: `job-${n}`, status: 'completed', steps: action
          ? [{ type: 'function_call', id: `call-${n}`, name: tool, arguments: args }]
          : [{ type: 'model_output', content: [{ type: 'text', text: 'acknowledged' }] }], usage: {} }
        : { id: `job-${n}`, output: action
          ? [{ type: 'function_call', call_id: `call-${n}`, name: tool, arguments: JSON.stringify(args) }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'acknowledged' }] }], usage: {} }]
    })
    const queue = tool === 'agy' ? agyQueue : computerQueue
    let job: (typeof queue.jobs)[number] | undefined
    try {
      writeUserConfig(`providers:\n  mock: { type: ${protocol}, baseUrl: '${server.url}', apiKey: test, serverState: true, maxRetries: 0 }\nmodels:\n  - { id: main, provider: mock, model: fake, vision: true, thinking: off }\ndefaultModel: main\nfallbackModels: []\nchat: { thinking: off, summarize: false, groupContext: 0 }\nmemory: { enable: false }\ntools:\n  exec: { enable: false }\n  agy: { enable: true, access: all, executable: '${process.execPath.replaceAll('\\', '/')}' }\n  computer: { enable: true, access: all, distro: rollout-control-test }\n`)
      config.load()
      const e = fakeEvent().e, eff = config.effective(e.group_id)
      const request = (text: string, event = e) => ({ e: event, eff, convKey: sessionKey(event, eff.chat.sessionScope), isAdmin: true, input: { text, images: [], imageSegments: [] } })
      const started = await runTurn(request('开始任务'))
      assert.equal(started.kind, 'reply')
      job = queue.jobs.find(entry => entry.rolloutId === started.rolloutId)!
      assert.ok(job, 'the model created a real queue entry')
      assert.equal(job.status, 'queued')
      assert.equal(hasPendingJobs(started.rolloutId!), true)
      // Replace the actual deferred worker with a controlled in-memory operation.
      queue.activate(job, async (_entry, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ report: 'cancelled worker' }) }, { once: true })
      }), async () => { notifications++ })
      assert.equal(job.status, 'running')
      const status = await runTurn(request('进度怎么样'))
      assert.notEqual(status.rolloutId, started.rolloutId)
      assert.match(JSON.stringify(server.requests[3].body.input), /\\?"status\\?":\\?"running/)
      const other = { ...e, user_id: 99999 }
      await runTurn(request('取消任务', other))
      assert.equal(job.status, 'running', 'a different user cannot control this job')
      assert.match(JSON.stringify(server.requests[5].body.input), /未找到/)
      const cancelled = await runTurn(request('取消刚才的任务'))
      assert.notEqual(cancelled.rolloutId, started.rolloutId)
      assert.equal(job.status, 'cancelled')
      assert.equal(aborted, true)
      assert.equal(hasPendingJobs(started.rolloutId!), false)
      assert.equal(rolloutHistory(started.rolloutId!)!.status, 'interrupted')
      const previous = protocol === 'gemini' ? 'previous_interaction_id' : 'previous_response_id'
      for (const index of [0, 2, 4, 6]) assert.equal(server.requests[index].body[previous], undefined, 'user control messages start fresh')
      for (const index of [1, 3, 5, 7]) assert.equal(server.requests[index].body[previous], `job-${index}`, 'tool steps still continue within their rollout')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(notifications, 0, 'a cancelled worker never invokes its completion callback')
    } finally { if (job) queue.cancel(job); await new Promise(resolve => setImmediate(resolve)); await server.close() }
  })
}
