import { randomBytes } from 'node:crypto'
import { JsonStore } from '../core/store.ts'
import { agyHistoryText } from '../agy/history.ts'
import type { ThinkingLevel } from '../core/configTypes.ts'
import type { ThinkingDecision } from './thinking.ts'
import type { Msg, ToolSpec } from '../llm/types.ts'

export interface RolloutContext {
  system: string
  tools: { name: string; description: string; parameters: string }[]
  messages: { role: Msg['role']; text: string; imageCount?: number }[]
  nativeSearch: boolean
  omittedMessages: number
  omittedTools: number
  truncated: boolean
}

export interface RolloutEvent {
  seq: number
  at: number
  kind: 'request' | 'progress' | 'thinking' | 'response' | 'tool' | 'reply' | 'error'
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
  thinking?: ThinkingLevel
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
  thinking?: ThinkingLevel
  thinkingDecision?: ThinkingDecision
  context?: RolloutContext
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
    inputTokens: event.inputTokens, outputTokens: event.outputTokens, isError: event.isError, thinking: event.thinking,
  }
}
function cleanThinking(decision: ThinkingDecision): ThinkingDecision {
  return {
    setting: decision.setting, level: decision.level, source: decision.source, kind: decision.kind, ms: decision.ms,
    fallbackReason: decision.fallbackReason && agyHistoryText(decision.fallbackReason),
    judge: decision.judge ? {
      kind: decision.judge.kind, model: agyHistoryText(decision.judge.model, undefined, 100),
      response: agyHistoryText(decision.judge.response), inputTokens: decision.judge.inputTokens,
      outputTokens: decision.judge.outputTokens, cost: decision.judge.cost,
    } : undefined,
  }
}
function cleanContext(context: RolloutContext): RolloutContext {
  return {
    system: agyHistoryText(context.system, undefined, 16000),
    tools: context.tools.map(tool => ({ name: agyHistoryText(tool.name, undefined, 100), description: agyHistoryText(tool.description, undefined, 1200), parameters: agyHistoryText(tool.parameters, undefined, 3000) })),
    messages: context.messages.map(message => ({ role: message.role, text: agyHistoryText(message.text, undefined, 6000), imageCount: message.imageCount })),
    nativeSearch: context.nativeSearch, omittedMessages: context.omittedMessages, omittedTools: context.omittedTools, truncated: context.truncated,
  }
}

/** The logical initial request, without image bytes, provider-native state, or transport credentials. */
export function recordRolloutContext(id: string, request: { system: string; tools: ToolSpec[]; messages: Msg[]; nativeSearch: boolean }) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  if (!rollout) return
  let truncated = false
  const text = (value: unknown, max: number) => {
    const safe = agyHistoryText(value, undefined, max + 1)
    if (safe.length > max) truncated = true
    return safe.slice(0, max)
  }
  const messages = request.messages.slice(-40).map(message => {
    if (message.role === 'user') return { role: message.role, text: text(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), 6000), imageCount: message.content.filter(part => part.type === 'image').length }
    if (message.role === 'tool') return { role: message.role, text: text(message.results.map(result => `${result.name}: ${result.content}`).join('\n'), 6000) }
    return { role: message.role, text: text([message.content, ...(message.toolCalls ?? []).map(call => `${call.name}: ${agyHistoryText(call.args)}`)].filter(Boolean).join('\n'), 6000) }
  })
  const context: RolloutContext = {
    system: text(request.system, 16000),
    tools: request.tools.slice(0, 100).map(tool => ({ name: text(tool.name, 100), description: text(tool.description, 1200), parameters: text(tool.parameters, 3000) })),
    messages, nativeSearch: request.nativeSearch, omittedMessages: Math.max(0, request.messages.length - 40), omittedTools: Math.max(0, request.tools.length - 100), truncated: false,
  }
  const tooLarge = () => Buffer.byteLength(JSON.stringify(context)) > 128 * 1024
  while (tooLarge() && context.messages.length > 1) { context.messages.shift(); context.omittedMessages++ }
  if (tooLarge()) {
    truncated = true
    context.system = context.system.slice(0, 8000)
    context.tools = context.tools.map(tool => ({ name: tool.name, description: tool.description.slice(0, 120), parameters: tool.parameters.slice(0, 80) }))
    context.messages = context.messages.map(message => ({ ...message, text: message.text.slice(0, 2000) }))
  }
  context.truncated = truncated || context.omittedMessages > 0 || context.omittedTools > 0
  rollout.context = context
  rollout.updatedAt = Date.now()
  save()
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
export function updateRollout(id: string, patch: Partial<Pick<Rollout, 'status' | 'model' | 'thinking' | 'thinkingDecision' | 'steps' | 'cost' | 'tokens' | 'reply'>>) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  if (!rollout) return
  Object.assign(rollout, patch, { updatedAt: Date.now() })
  if (patch.model) rollout.model = agyHistoryText(patch.model, undefined, 100)
  if (patch.reply) rollout.reply = agyHistoryText(patch.reply)
  if (patch.thinkingDecision) rollout.thinkingDecision = cleanThinking(patch.thinkingDecision)
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
function summary({ events, seq, dropped, context, ...rollout }: Rollout) {
  return { ...rollout, input: agyHistoryText(rollout.input), reply: rollout.reply && agyHistoryText(rollout.reply),
    model: rollout.model && agyHistoryText(rollout.model, undefined, 100),
    thinkingDecision: rollout.thinkingDecision && cleanThinking(rollout.thinkingDecision),
    ms: active(rollout) ? Date.now() - rollout.createdAt : rollout.ms, dropped }
}
/** Summaries only: polling the list never transfers every tool result. */
export function recentRollouts(conv?: string) {
  return store.data.rollouts.filter(rollout => !conv || rollout.conv === conv).slice().reverse().map(summary)
}
export function rolloutHistory(id: string) {
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  return rollout ? { ...summary(rollout), context: rollout.context && cleanContext(rollout.context), events: rollout.events.map(cleanEvent) } : undefined
}
