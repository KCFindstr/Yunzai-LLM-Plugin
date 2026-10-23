import { randomBytes } from 'node:crypto'
import { JsonStore } from '../core/store.ts'
import { agyHistoryText } from '../agy/history.ts'

export interface RolloutEvent {
  seq: number
  at: number
  kind: 'request' | 'progress' | 'response' | 'tool' | 'reply' | 'error'
  text: string
  step?: number
  tool?: string
  callId?: string
  args?: string
  phase?: 'running' | 'completed' | 'skipped'
  ms?: number
  inputTokens?: number
  outputTokens?: number
  isError?: boolean
}
export interface Rollout {
  id: string
  conv: string
  createdAt: number
  updatedAt: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted'
  source: 'chat' | 'agy' | 'computer'
  jobId?: string
  input: string
  reply?: string
  model?: string
  steps: number
  cost: number
  ms: number
  inputImageCount: number
  tokens?: { input: number; output: number; cacheRead: number; inputIncomplete?: boolean }
  seq: number
  dropped: number
  events: RolloutEvent[]
}
const store = new JsonStore<{ v: 1; rollouts: Rollout[] }>('rollouts.json', { v: 1, rollouts: [] })
const active = (rollout: Pick<Rollout, 'status'>) => ['queued', 'running'].includes(rollout.status)

// A process restart cannot resume an in-flight main-model request.
for (const rollout of store.data.rollouts) {
  if (active(rollout)) { rollout.status = 'interrupted'; store.save() }
}

function cleanEvent(event: RolloutEvent): RolloutEvent {
  return {
    seq: event.seq, at: event.at, kind: event.kind, text: agyHistoryText(event.text),
    step: event.step, tool: event.tool && agyHistoryText(event.tool, undefined, 100),
    callId: event.callId && agyHistoryText(event.callId, undefined, 100),
    args: event.args && agyHistoryText(event.args), phase: event.phase, ms: event.ms,
    inputTokens: event.inputTokens, outputTokens: event.outputTokens, isError: event.isError,
  }
}
function save() {
  // Keep running turns even when a burst pushes completed history over its retention limit.
  while (store.data.rollouts.length > 300 || Buffer.byteLength(JSON.stringify(store.data)) > 8 * 1024 * 1024) {
    const index = store.data.rollouts.findIndex(rollout => !active(rollout))
    if (index < 0) break
    store.data.rollouts.splice(index, 1)
  }
  store.save()
}
export function startRollout(input: Pick<Rollout, 'conv' | 'input' | 'inputImageCount' | 'source' | 'jobId'>): string {
  const id = randomBytes(8).toString('hex'), now = Date.now()
  store.data.rollouts.push({ ...input, input: agyHistoryText(input.input), id, createdAt: now, updatedAt: now,
    status: 'queued', steps: 0, cost: 0, ms: 0, seq: 0, dropped: 0, events: [] })
  recordRolloutEvent(id, { kind: 'request', text: input.input })
  return id
}
export function updateRollout(id: string, patch: Partial<Pick<Rollout, 'status' | 'model' | 'steps' | 'cost' | 'tokens' | 'reply'>>) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  if (!rollout) return
  Object.assign(rollout, patch, { updatedAt: Date.now() })
  if (patch.model) rollout.model = agyHistoryText(patch.model, undefined, 100)
  if (patch.reply) rollout.reply = agyHistoryText(patch.reply)
  rollout.ms = rollout.updatedAt - rollout.createdAt
  save()
}
export function recordRolloutEvent(id: string, event: Omit<RolloutEvent, 'seq' | 'at'>) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  if (!rollout) return
  rollout.events.push(cleanEvent({ ...event, seq: ++rollout.seq, at: Date.now() }))
  while (rollout.events.length > 500 || Buffer.byteLength(JSON.stringify(rollout.events)) > 256 * 1024) {
    rollout.events.shift()
    rollout.dropped++
  }
  rollout.updatedAt = Date.now()
  rollout.ms = rollout.updatedAt - rollout.createdAt
  save()
}
function summary({ events, seq, dropped, ...rollout }: Rollout) {
  return { ...rollout, input: agyHistoryText(rollout.input), reply: rollout.reply && agyHistoryText(rollout.reply),
    model: rollout.model && agyHistoryText(rollout.model, undefined, 100),
    ms: active(rollout) ? Date.now() - rollout.createdAt : rollout.ms, dropped }
}
/** Summaries only: polling the list never transfers every tool result. */
export function recentRollouts(conv?: string) {
  return store.data.rollouts.filter(rollout => !conv || rollout.conv === conv).slice().reverse().map(summary)
}
export function rolloutHistory(id: string) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  return rollout ? { ...summary(rollout), events: rollout.events.map(cleanEvent) } : undefined
}
