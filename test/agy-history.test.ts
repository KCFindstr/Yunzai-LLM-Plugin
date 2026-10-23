import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { agyHistory, agyHistoryText, agyJobView, observeAgyJob, pruneAgyHistory, recordAgyEvent } from '../src/agy/history.ts'
import { flushAllStores } from '../src/core/store.ts'
import type { ComputerJob } from '../src/computer/queue.ts'

describe('AGY execution records', () => {
  it('aggregates visible streaming turns and tool calls, tracks usage, and excludes reasoning and diagnostics', () => {
    const job: ComputerJob = { id: 'a123456789', owner: 'private-owner', task: 'Find the original image', status: 'running', createdAt: 1, updatedAt: 1, modelId: 'gemini-3.8-flash-medium' }
    let changed = 0
    const observe = observeAgyJob(job, () => changed++)
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
    const history = agyHistory(job.id)
    assert.equal(history.events.filter(event => event.kind === 'response').length, 1)
    assert.equal(history.events.find(event => event.kind === 'response')?.text, 'Opened the page')
    assert.equal(history.events.filter(event => event.kind === 'tool').length, 2)
    assert.equal(job.steps, 1); assert.equal(job.inputTokens, 150); assert.equal(job.outputTokens, 20); assert.equal(job.cacheReadTokens, 50)
    assert.ok(changed > 0)
    flushAllStores()
    const raw = fs.readFileSync(path.join(TMP, 'data/agy-history', job.id, 'history.json'), 'utf8')
    for (const value of ['PRIVATE_DIAGNOSTICS', 'PRIVATE_REASONING', 'PRIVATE_TOKEN', 'PRIVATE_BINARY', 'alice@example.com', 'Alice', 'private-owner']) assert.ok(!raw.includes(value), value)
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
