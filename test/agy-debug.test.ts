import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { agyDiagnosticLogger } from '../src/agy/debug.ts'
import { observeAgyJob, recordAgyEvent } from '../src/agy/history.ts'

it('logs visible AGY outputs and tool data, filtering secrets, binaries, hidden reasoning and split diagnostics', () => {
  const previous = globalThis.logger
  const records: string[] = []
  globalThis.logger = { info: (...args: any[]) => records.push(args.join(' ')), debug: (...args: any[]) => records.push(args.join(' ')) } as any
  try {
    const job = { id: '112233aabb', owner: '', task: '', createdAt: 0, updatedAt: 0, status: 'running' as const, modelId: 'gemini-3.8-flash-medium' }
    const observe = observeAgyJob(job, () => {})
    observe({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Visible AGY response' } })
    observe({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { password: 'private-tool-password' }, output: 'Tool result alice@example.com' } } })
    observe({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_thinking', state: 'DONE', text_delta: 'private-reasoning' } })
    recordAgyEvent(job.id, { kind: 'report', text: 'Final AGY output' })
    const diagnostics = agyDiagnosticLogger(job.id, 'stderr', ['private-config-secret'])
    diagnostics.write('Authentication required\nprivate-config-')
    diagnostics.write('secret alice@example.com\nhttps://accounts.google.com/o/oauth2/auth?state=private-state\n')
    diagnostics.write('-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\n')
    diagnostics.write(JSON.stringify({ step_update: { step_type: 'agent_thinking', text: 'private-reasoning' } }) + '\n')
    diagnostics.write('x'.repeat(17000)); diagnostics.write('private-tail\n')
    diagnostics.write('Unterminated diagnostic password=private-password')
    diagnostics.flush()
  } finally { globalThis.logger = previous }
  const output = records.join('\n')
  for (const visible of ['[AGY 112233aabb]', 'Visible AGY response', 'read_file', 'Tool result', 'Final AGY output', 'Authentication required', 'Unterminated diagnostic']) assert.ok(output.includes(visible), visible)
  for (const hidden of ['private-tool-password', 'alice@example.com', 'private-reasoning', 'private-config-secret', 'private-state', 'private-key-body', 'private-tail', 'private-password']) assert.ok(!output.includes(hidden), hidden)
})
