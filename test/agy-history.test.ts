import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { agyHistory, agyHistoryText, agyJobView, agySubagentHistory, observeAgyJob, pruneAgyHistory, recordAgyEvent, resolveAgyHistory } from '../src/agy/history.ts'
import { flushAllStores } from '../src/core/store.ts'
import type { ComputerJob } from '../src/computer/queue.ts'

describe('AGY execution records', () => {
  it('aggregates visible streaming turns and tool calls, tracks usage, and excludes reasoning and diagnostics', () => {
    const job: ComputerJob = { id: 'a123456789', owner: 'private-owner', task: 'Find the original image', status: 'running', createdAt: 1, updatedAt: 1, modelId: 'gemini-3.8-flash-medium' }
    let changed = 0
    const observe = observeAgyJob(job, () => changed++)
    observe({ event: 'request_context', prompt: 'Path mapping: /work/attachments/<rest> = C:\\Users\\Alice\\images; /work/agy/a123456789/out/<rest> = out/<rest>', launch: { sandbox: true, turbo: true } })
    observe({ event: 'init', init: {} })
    observe({ event: 'diagnostic', text: 'PRIVATE_DIAGNOSTICS' })
    observe({ event: 'step_update', step_update: { step_index: 0, step_type: 'agent_thinking', state: 'DONE', text: 'PRIVATE_REASONING' } })
    observe({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Opened ' } })
    observe({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'the page', usage: { input_tokens: 100, output_tokens: 12 }, duration_seconds: 0.4 } })
    observe({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { file: 'image.png', token: 'PRIVATE_TOKEN', reasoning: 'PRIVATE_REASONING', data: 'PRIVATE_BINARY' } } } })
    assert.match(job.progress!, /read_file/)
    const done = { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'Result alice@example.com C:\\Users\\Alice\\private.txt', parameters: { file: 'image.png' } } } }
    observe(done); observe(done)
    observe({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 150, output_tokens: 20, cache_read_tokens: 50 } } })
    observe({ event: 'runtime_exit', success: false, detail: 'CLI exit=1; status=SUCCESS; output=100', error: 'shutdown failure' })
    const history = agyHistory(job.id)
    assert.match(history.events.find(event => event.kind === 'context')!.text, /Path mapping: \/work\/attachments/)
    assert.match(history.events.find(event => event.kind === 'context')!.text, /\/work\/agy\/a123456789\/out/)
    assert.equal(history.events.filter(event => event.kind === 'response').length, 1)
    assert.equal(history.events.find(event => event.kind === 'response')?.text, 'Opened the page')
    assert.equal(history.events.filter(event => event.kind === 'tool').length, 2)
    assert.equal(job.steps, 1); assert.equal(job.inputTokens, 150); assert.equal(job.outputTokens, 20); assert.equal(job.cacheReadTokens, 50)
    assert.ok(changed > 0)
    assert.ok(history.events.some(event => event.kind === 'error' && event.text.includes('status=SUCCESS') && event.text.includes('shutdown failure')))
    flushAllStores()
    const raw = fs.readFileSync(path.join(TMP, 'data/agy-history', job.id, 'history.json'), 'utf8')
    for (const value of ['PRIVATE_DIAGNOSTICS', 'PRIVATE_REASONING', 'PRIVATE_TOKEN', 'PRIVATE_BINARY', 'alice@example.com', 'Alice', 'private-owner']) assert.ok(!raw.includes(value), value)
  })

  it('keeps every tool call apart by step index and attaches transcript thinking, even when it is written late', () => {
    const brain = path.join(TMP, 'agy-brain'), conversation = '2dddd061-92de-40ea-ac21-180b036cc9ed'
    const logs = path.join(brain, conversation, '.system_generated', 'logs')
    fs.mkdirSync(logs, { recursive: true })
    const transcript = (entries: object[]) => fs.writeFileSync(path.join(logs, 'transcript.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const job: ComputerJob = { id: 'd123456789', owner: 'owner', task: 'Echo', status: 'running', createdAt: 1, updatedAt: 1 }
    const observe = observeAgyJob(job, () => {}, brain)
    const step = (step_update: object) => observe({ event: 'step_update', step_update })
    observe({ event: 'init', conversation_id: conversation, init: {} })
    step({ step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Running two', usage: { thinking_tokens: 9 } })
    for (const [index, command] of [[2, 'echo one'], [3, 'echo two']] as const) {
      step({ step_index: index, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: command } } })
      step({ step_index: index, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { parameters: { CommandLine: command }, output: command.slice(5) } })
    }
    transcript([{ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Running two', thinking: 'Plan both echoes in parallel' }])
    step({ step_index: 4, step_type: 'agent_response', state: 'DONE', text_delta: '' })
    transcript([{ step_index: 1, thinking: 'Plan both echoes in parallel' }, { step_index: 4, thinking: 'Check C:\\Users\\Alice\\out' }])
    observe({ event: 'runtime_exit', success: true, detail: 'CLI exit=0' })
    const { events } = agyHistory(job.id)
    assert.deepEqual(events.filter(event => event.kind === 'tool').map(event => [event.index, event.phase]), [[2, 'running'], [2, 'completed'], [3, 'running'], [3, 'completed']])
    const responses = events.filter(event => event.kind === 'response')
    assert.equal(responses[0].thinking, 'Plan both echoes in parallel')
    assert.ok(responses[1].thinking && !responses[1].thinking.includes('Alice'))
  })

  it('links subagents an invoke_subagent call created and serves their transcript as filtered events', () => {
    const brain = path.join(TMP, 'agy-brain-sub')
    const parent = '91c98198-c040-4b29-b0e6-d0f711ad9998', child = '544970de-818e-48c3-9763-d2a85df34d1c', grandchild = 'aec1f07e-bf9d-4605-aec4-953631e6aab8'
    const write = (conversation: string, entries: object[]) => {
      const logs = path.join(brain, conversation, '.system_generated', 'logs')
      fs.mkdirSync(logs, { recursive: true })
      fs.writeFileSync(path.join(logs, 'transcript.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    }
    const created = (id: string) => `Created At: 2026-10-27T13:19:14-07:00\nCompleted At: 2026-10-27T13:19:14-07:00\nCreated the following subagent:\n{\n  "conversationId":  "${id}"\n}`
    write(parent, [
      { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'invoke_subagent', args: { Role: '"Image Generator"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: created(child) },
    ])
    write(child, [
      { step_index: 0, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] sender=x content=Draw alice@example.com a cat\n</SYSTEM_MESSAGE>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-10-27T20:19:14Z', thinking: 'Sketch first', output_tokens: 20,
        tool_calls: [{ name: 'generate_image', args: { Prompt: '"cat"' } }, { name: 'invoke_subagent', args: { Role: '"Checker"' } }] },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-10-27T13:19:30-07:00\nCompleted At: 2026-10-27T13:19:43-07:00\nGenerated image is saved', media: [{}] },
      { step_index: 3, type: 'GENERIC', status: 'DONE', content: created(grandchild) },
      { step_index: 4, type: 'PLANNER_RESPONSE', content: 'Image sent to the caller.' },
    ])
    write(grandchild, [{ step_index: 0, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"dir"' } }] }])
    const job: ComputerJob = { id: 'e123456789', owner: 'owner', task: 'Draw', status: 'running', createdAt: 1, updatedAt: 1 }
    const observe = observeAgyJob(job, () => {}, brain)
    observe({ event: 'init', conversation_id: parent, init: {} })
    observe({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'invoke_subagent', tool_info: { parameters: { Role: 'Image Generator' } } } })
    observe({ event: 'runtime_exit', success: true, detail: 'CLI exit=0' })
    const launch = agyHistory(job.id).events.find(event => event.tool === 'invoke_subagent')!
    assert.equal(launch.subagent, child); assert.equal(launch.phase, 'completed')

    const view = agySubagentHistory(job.id, child, brain)!
    assert.match(view.task, /^Draw .+ a cat$/)
    assert.ok(!view.task.includes('alice@example.com'))
    assert.equal(view.running, false)
    const tools = view.events.filter(event => event.kind === 'tool')
    assert.deepEqual(tools.map(event => [event.tool, event.phase, event.ms]), [['generate_image', 'completed', 13000], ['invoke_subagent', 'completed', 0]])
    assert.match(tools[0].text, /Generated image is saved\n\[附带 1 个媒体文件\]/)
    assert.equal(JSON.parse(tools[0].args!).Prompt, 'cat')
    assert.equal(tools[1].subagent, grandchild)
    assert.deepEqual(view.events.filter(event => event.kind === 'response').map(event => [event.thinking, event.text]), [['Sketch first', ''], [undefined, 'Image sent to the caller.']])
    // Nested subagents are reachable through the job's own records; anything else is not.
    assert.equal(agySubagentHistory(job.id, grandchild, brain)?.running, true)
    assert.equal(agySubagentHistory(job.id, '00000000-0000-0000-0000-000000000000', brain), undefined)
    assert.equal(agySubagentHistory('d123456789', child, brain), undefined)
    assert.equal(agySubagentHistory(job.id, '../' + child, brain), undefined)
  })

  it('backfills finished tasks recorded before step indexes and conversations were kept', () => {
    const brain = path.join(TMP, 'agy-brain-legacy')
    const shared = 'eeb85de2-f1a6-4d8c-899b-0365a2dd6e4a', child = 'fada0218-0000-4000-8000-000000000001', earlierChild = 'cffef441-0000-4000-8000-000000000001'
    const logs = path.join(brain, shared, '.system_generated', 'logs')
    fs.mkdirSync(logs, { recursive: true })
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute)).toISOString()
    const created = (id: string) => `Created At: x\nCompleted At: x\nCreated the following subagent:\n{\n  "conversationId":  "${id}"\n}`
    // An older CLI continued one conversation across two tasks; the stream also missed this task's final turn.
    fs.writeFileSync(path.join(logs, 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', created_at: at(0), content: 'Task: Earlier task' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: at(0), tool_calls: [{ name: 'invoke_subagent' }] },
      { step_index: 2, type: 'GENERIC', created_at: at(1), content: created(earlierChild) },
      { step_index: 3, type: 'USER_INPUT', created_at: at(16), content: 'Task: Draw Rurino' },
      { step_index: 4, type: 'PLANNER_RESPONSE', created_at: at(16), thinking: 'Delegate the drawing', tool_calls: [{ name: 'invoke_subagent' }] },
      { step_index: 5, type: 'GENERIC', created_at: at(16), content: created(child) },
      { step_index: 6, type: 'PLANNER_RESPONSE', created_at: at(17), thinking: 'Check the file', tool_calls: [{ name: 'run_command' }] },
      { step_index: 7, type: 'GENERIC', created_at: at(17), content: 'ok' },
      { step_index: 8, type: 'PLANNER_RESPONSE', created_at: at(18), thinking: 'Unreported final turn' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const id = 'f123456789'
    for (const event of [
      { kind: 'context', text: 'prompt' }, { kind: 'response', text: '', step: 1 },
      { kind: 'tool', tool: 'invoke_subagent', phase: 'running', text: '正在执行' },
      { kind: 'response', text: '', step: 2 }, { kind: 'tool', tool: 'run_command', phase: 'running', text: '正在执行' },
      { kind: 'tool', tool: 'run_command', phase: 'completed', text: 'ok' },
    ] as const) recordAgyEvent(id, event)
    const job: ComputerJob = { id, owner: 'owner', task: 'Draw Rurino', status: 'running', createdAt: Date.parse(at(16)), updatedAt: Date.parse(at(18)) }
    resolveAgyHistory(job, brain)
    assert.equal(agyHistory(id).events.find(event => event.tool === 'invoke_subagent')?.phase, 'running', 'active tasks are left alone')
    job.status = 'completed'
    resolveAgyHistory(job, brain)
    const { events } = agyHistory(id)
    const launch = events.find(event => event.tool === 'invoke_subagent')!
    assert.equal(launch.subagent, child); assert.equal(launch.phase, 'completed')
    assert.deepEqual(events.filter(event => event.kind === 'response').map(event => event.thinking), ['Delegate the drawing', 'Check the file'])
  })

  it('exposes a filtered job summary without owner identities, file paths or unknown fields', () => {
    const job = { id: 'b123456789', owner: 'private-owner', task: 'Find alice@example.com', report: 'password=private-password', inputImages: [{ name: 'private-path' }], status: 'completed', createdAt: 1, updatedAt: 2, arbitraryPrivateField: 'private-extra' } as any
    const view = agyJobView(job)
    assert.equal(view.inputImageCount, 1)
    assert.ok(!('owner' in view)); assert.ok(!('inputImages' in view))
    const serialized = JSON.stringify(view)
    for (const value of ['alice@example.com', 'private-password', 'private-owner', 'private-path', 'private-extra']) assert.ok(!serialized.includes(value))
    assert.equal(agyHistoryText({ data: 'secret-binary', reasoning: 'secret-reasoning', token: 'secret-token', visible: 'safe' }).includes('secret-'), false)
    assert.throws(() => agyHistory('../config'), /无效/)
  })

  it('bounds retained records and disposes evicted stores without recreating them on flush', () => {
    const id = 'c123456789'
    for (let i = 0; i < 520; i++) recordAgyEvent(id, { kind: 'response', text: 'visible text '.repeat(950), step: i + 1 })
    const history = agyHistory(id)
    assert.ok(history.dropped > 0)
    assert.equal(history.events.at(-1)?.step, 520)
    assert.ok(history.events.length <= 500)
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 2 * 1024 * 1024)
    flushAllStores()
    recordAgyEvent(id, { kind: 'reply', text: 'pending write', delivery: 'sent' })
    pruneAgyHistory(new Set(['a123456789']))
    flushAllStores()
    assert.equal(fs.existsSync(path.join(TMP, 'data/agy-history', id)), false)
    assert.equal(fs.existsSync(path.join(TMP, 'data/agy-history/a123456789/history.json')), true)
  })
})
