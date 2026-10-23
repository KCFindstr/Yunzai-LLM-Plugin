import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/paths.ts'
import { detectImageMime, sha1 } from '../core/util.ts'
import { log } from '../core/log.ts'
import { JsonStore } from '../core/store.ts'
import { agyHistoryText } from '../agy/history.ts'
import type { ThinkingLevel } from '../core/configTypes.ts'
import type { JudgeResponse, ThinkingDecision } from './thinking.ts'
import type { ImagePart, Msg, ToolSpec } from '../llm/types.ts'
import { parseRolloutJson } from '../../web/js/rollout-data.js'

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
  images?: { id: string; mime: string; bytes: number }[]
  omittedImages?: number
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
export const ROLLOUT_RETENTION_MS = 30 * 86400_000
const IMAGE_ROOT = path.join(DATA_DIR, 'rollout-images')
const imageDirectory = (id: string) => /^[a-f0-9]{16}$/.test(id) ? path.join(IMAGE_ROOT, id) : undefined

function pruneExpired() {
  const cutoff = Date.now() - ROLLOUT_RETENTION_MS
  const expired = store.data.rollouts.filter(r => !active(r) && r.updatedAt < cutoff)
  if (!expired.length) return
  const ids = new Set(expired.map(r => r.id))
  store.data.rollouts = store.data.rollouts.filter(r => !ids.has(r.id))
  for (const id of ids) {
    const directory = imageDirectory(id)
    if (directory) try { fs.rmSync(directory, { recursive: true, force: true }) } catch (error: any) { log.warn(`清理执行图片失败：${error.message}`) }
  }
  store.save()
}

// A process restart cannot resume an in-flight main-model request.
for (const rollout of store.data.rollouts) {
  if (active(rollout)) { rollout.status = 'interrupted'; store.save() }
}
pruneExpired()
setInterval(pruneExpired, 3600_000).unref()

/** Keep local raster bytes only; never fetch arbitrary image URLs during history recording. */
export function recordRolloutImages(id: string, images: ImagePart[] = []) {
  const rollout = store.data.rollouts.find(r => r.id === id), directory = imageDirectory(id)
  const saved: NonNullable<RolloutEvent['images']> = []
  if (!rollout || !directory) return saved
  const existing = new Map(rollout.events.flatMap(e => e.images ?? []).map(image => [image.id, image.bytes]))
  for (const image of images) {
    if (!image.data || image.data.length > 14 * 1024 * 1024) continue
    const buffer = Buffer.from(image.data, 'base64'), mime = detectImageMime(buffer), hash = sha1(buffer)
    if (!mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) || buffer.length > 10 * 1024 * 1024) continue
    if (!existing.has(hash) && (existing.size >= 64 || [...existing.values()].reduce((a, b) => a + b, 0) + buffer.length > 64 * 1024 * 1024)) continue
    try {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, `${hash}.image`), buffer)
      saved.push({ id: hash, mime, bytes: buffer.length }); existing.set(hash, buffer.length)
    } catch (error: any) { log.warn(`保存执行图片失败：${error.message}`) }
  }
  return saved
}

export function readRolloutImage(id: string, imageId: string) {
  pruneExpired()
  const directory = imageDirectory(id)
  if (!directory || !/^[a-f0-9]{40}$/.test(imageId)) return
  const image = store.data.rollouts.find(r => r.id === id)?.events.flatMap(e => e.images ?? []).find(i => i.id === imageId)
  if (!image) return
  try {
    const raw = fs.readFileSync(path.join(directory, `${imageId}.image`))
    if (raw.length === image.bytes && sha1(raw) === image.id && detectImageMime(raw) === image.mime) return { raw, type: image.mime }
  } catch {}
}

function cleanEvent(event: RolloutEvent): RolloutEvent {
  return {
    seq: event.seq, at: event.at, kind: event.kind, text: agyHistoryText(event.text),
    step: event.step, tool: event.tool && agyHistoryText(event.tool, undefined, 100),
    callId: event.callId && agyHistoryText(event.callId, undefined, 100),
    args: event.args && agyHistoryText(event.args), phase: event.phase, ms: event.ms,
    inputTokens: event.inputTokens, outputTokens: event.outputTokens, isError: event.isError, thinking: event.thinking,
    images: event.images, omittedImages: event.omittedImages,
  }
}
function cleanJudgeResponse(judge: JudgeResponse): string {
  const response = parseRolloutJson(judge.response)
  const answer = response?.answers?.kind
  if (!answer || typeof answer !== 'object') return agyHistoryText(judge.response)
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const probability = (value: unknown) => { const n = number(value); return n != null && n <= 1 ? n : undefined }
  const probabilities = answer.probabilities
  const score = (name: string) => {
    const entry = Array.isArray(probabilities) ? probabilities.find((p: any) => (p?.choice ?? p?.name) === name) : probabilities?.[name]
    return probability(entry && typeof entry === 'object' ? entry.probability ?? entry.score ?? entry.prob : entry)
  }
  // Redact text before serialization. Known numeric metrics must stay numeric JSON tokens.
  return JSON.stringify({
    model: agyHistoryText(typeof response.model === 'string' ? response.model : judge.model, undefined, 100),
    answers: { kind: {
      choice: typeof answer.choice === 'string' ? agyHistoryText(answer.choice, undefined, 100) : undefined,
      confidence: probability(answer.confidence),
      probabilities: Object.fromEntries(['casual', 'question', 'complex'].map(name => [name, score(name)]).filter(([, value]) => value != null)),
    } },
    usage: { input_tokens: number(judge.inputTokens) ?? number(response.usage?.input_tokens), output_tokens: number(judge.outputTokens) ?? number(response.usage?.output_tokens) },
    cost: number(judge.cost) ?? number(response.cost),
  }, null, 2)
}
function cleanThinking(decision: ThinkingDecision): ThinkingDecision {
  return {
    setting: decision.setting, level: decision.level, source: decision.source, kind: decision.kind, ms: decision.ms,
    fallbackReason: decision.fallbackReason && agyHistoryText(decision.fallbackReason),
    judge: decision.judge ? {
      kind: decision.judge.kind, model: agyHistoryText(decision.judge.model, undefined, 100),
      response: cleanJudgeResponse(decision.judge), inputTokens: decision.judge.inputTokens,
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
  pruneExpired()
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
  pruneExpired()
  return store.data.rollouts.filter(rollout => !conv || rollout.conv === conv).slice().reverse().map(summary)
}
export function rolloutHistory(id: string) {
  pruneExpired()
  const rollout = store.data.rollouts.find(entry => entry.id === id)
  return rollout ? { ...summary(rollout), context: rollout.context && cleanContext(rollout.context), events: rollout.events.map(cleanEvent) } : undefined
}
