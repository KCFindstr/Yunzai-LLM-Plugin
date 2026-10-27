import fs from 'node:fs'
import path from 'node:path'
import { config } from '../core/config.ts'
import { DATA_DIR } from '../core/paths.ts'
import { JsonStore } from '../core/store.ts'
import { log } from '../core/log.ts'
import type { ComputerJob } from '../computer/queue.ts'
import { privateValues, redact } from './privacy.ts'
import { agyHostPaths } from './paths.ts'

export interface AgyEvent {
  seq: number
  at: number
  kind: 'request' | 'context' | 'progress' | 'response' | 'tool' | 'report' | 'reply' | 'error' | 'cancel'
  text: string
  step?: number
  /** CLI step_index: pairs a tool's running and completed records, and a response with its transcript entry. */
  index?: number
  /** The CLI's summarised thinking for a response, read from its local transcript (never raw provider reasoning). */
  thinking?: string
  /** Conversation of the subagent an invoke_subagent call created, viewable on demand. */
  subagent?: string
  model?: string
  tool?: string
  args?: string
  phase?: 'running' | 'completed'
  ms?: number
  inputTokens?: number
  outputTokens?: number
  isError?: boolean
  delivery?: 'sent' | 'failed' | 'none'
}
interface History {
  seq: number; dropped: number; events: AgyEvent[]
  /** CLI conversation of each run, in order; `resolved` once a finished task was matched against their transcripts. */
  conversations?: string[]; resolved?: boolean
}
const ROOT = path.resolve(DATA_DIR, 'agy-history')
const stores = new Map<string, JsonStore<History>>()

function directory(id: string) {
  if (!/^[a-f0-9]{10}$/.test(id)) throw Error('无效的 AGY 任务编号')
  const target = path.resolve(ROOT, id)
  if (!target.startsWith(ROOT + path.sep)) throw Error('无效的 AGY 记录路径')
  return target
}
function storeFor(id: string) {
  const dir = directory(id)
  let store = stores.get(id)
  if (!store) {
    store = new JsonStore<History>(path.join(dir, 'history.json'), { seq: 0, dropped: 0, events: [] })
    stores.set(id, store)
  }
  return store
}

/** Only visible text and tool data: never persist reasoning, binaries, diagnostics or account banners. */
export function agyHistoryText(value: unknown, secrets = privateValues(config.get()), max = 12000): string {
  const hidden = /password|secret|token|cookie|authorization|api.?key|^data$|^native$|reasoning|thinking|signature/i
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, entry) => hidden.test(key) ? '[redacted]' : entry) ?? ''
  return redact(text.replace(/data:[^;,\s]+;base64,[\w+/=]+/gi, '[binary omitted]')
    .replace(/[A-Za-z0-9+/=_-]{512,}/g, '[opaque data omitted]'), secrets).slice(0, max)
}
function cleanEvent(event: AgyEvent): AgyEvent {
  // Whitelist metadata too; never spread arbitrary CLI objects into stored or served records.
  const secrets = privateValues(config.get())
  return {
    seq: event.seq, at: event.at, kind: event.kind, text: agyHistoryText(event.text, secrets, event.kind === 'context' ? 32000 : 12000),
    step: event.step, index: event.index, thinking: event.thinking ? agyHistoryText(event.thinking, secrets) : undefined,
    subagent: event.subagent && CONVERSATION.test(event.subagent) ? event.subagent : undefined, model: event.model ? agyHistoryText(event.model, secrets, 100) : undefined,
    tool: event.tool ? agyHistoryText(event.tool, secrets, 100) : undefined,
    args: event.args ? agyHistoryText(event.args, secrets) : undefined,
    phase: event.phase, ms: event.ms, inputTokens: event.inputTokens, outputTokens: event.outputTokens,
    isError: event.isError, delivery: event.delivery,
  }
}
export function recordAgyEvent(id: string, event: Omit<AgyEvent, 'seq' | 'at'>) {
  try {
    const store = storeFor(id)
    const safe = cleanEvent({ ...event, seq: ++store.data.seq, at: Date.now() })
    store.data.events.push(safe)
    log.debug(`[AGY ${id}] ${safe.kind} ${[
      safe.model ? `model=${safe.model}` : '', safe.step != null ? `step=${safe.step}` : '',
      safe.tool ? `tool=${safe.tool}` : '', safe.phase ? `phase=${safe.phase}` : '',
      safe.inputTokens != null ? `in=${safe.inputTokens} out=${safe.outputTokens ?? 0}` : '',
      safe.delivery ? `delivery=${safe.delivery}` : '',
    ].filter(Boolean).join(' ')} text=${safe.text.slice(0, 4000)}${safe.args ? ` args=${safe.args.slice(0, 4000)}` : ''}`)
    while (store.data.events.length > 500 || Buffer.byteLength(JSON.stringify(store.data)) > 2 * 1024 * 1024) {
      store.data.events.shift()
      store.data.dropped++
    }
    store.save()
  } catch { log.warn('AGY 执行记录保存失败') }
}
/** Fill in fields of already stored events, e.g. thinking that reached the transcript after the stream. */
function patchAgyEvents(id: string, patch: (event: AgyEvent) => Partial<AgyEvent> | undefined) {
  try {
    const store = storeFor(id)
    let dirty = false
    store.data.events = store.data.events.map(event => {
      const update = patch(event)
      if (!update) return event
      dirty = true
      return cleanEvent({ ...event, ...update })
    })
    if (dirty) store.save()
  } catch { log.warn('AGY 执行记录保存失败') }
}
interface TranscriptEntry {
  step_index: number; type?: string; status?: string; created_at?: string; content?: string; thinking?: string
  input_tokens?: number; output_tokens?: number; tool_calls?: { name?: string; args?: Record<string, unknown> }[]; media?: unknown[]
}
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The CLI's own per-conversation transcript: thinking summaries and subagent conversations the stream omits. */
export function readAgyTranscript(conversationId: string, brain = agyHostPaths()[1]): TranscriptEntry[] | undefined {
  if (!CONVERSATION.test(conversationId)) return
  let text: string
  try { text = fs.readFileSync(path.join(brain, conversationId, '.system_generated', 'logs', 'transcript.jsonl'), 'utf8') } catch { return }
  const entries: TranscriptEntry[] = []
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line)
      if (Number.isInteger(entry?.step_index)) entries.push(entry)
    } catch { /* partial last line */ }
  }
  return entries
}
const thinkingOf = (entry: TranscriptEntry) => typeof entry.thinking === 'string' && entry.thinking.trim() ? entry.thinking.trim() : undefined
/** invoke_subagent results name the child conversation; nothing else in the stream links to it. */
function createdSubagent(entry: TranscriptEntry) {
  const id = typeof entry.content === 'string' ? /Created the following subagent:[\s\S]*?"conversationId":\s*"([0-9a-f-]{36})"/i.exec(entry.content)?.[1] : undefined
  return id && CONVERSATION.test(id) ? id.toLowerCase() : undefined
}
const subagentsOf = (entries: TranscriptEntry[]) => entries.map(createdSubagent).filter((id): id is string => Boolean(id))

/** A subagent transcript in the same event shape as the stream-built history, filtered the same way. */
function transcriptEvents(entries: TranscriptEntry[]) {
  const events: AgyEvent[] = [], calls: AgyEvent[] = []
  let task = '', step = 0
  const time = (value: unknown) => typeof value === 'string' && Date.parse(value) || 0
  const argument = (value: unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return value } }
  for (const entry of entries) {
    const at = time(entry.created_at), content = typeof entry.content === 'string' ? entry.content : ''
    if (entry.type === 'SYSTEM_MESSAGE' || entry.type === 'USER_INPUT') {
      // The parent's instructions arrive as a wrapped system message: keep only what it asked for.
      task ||= (/content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/.exec(content)?.[1] ?? content.replace(/<\/?USER_REQUEST>/g, '')).trim()
    } else if (entry.type === 'PLANNER_RESPONSE') {
      step++
      const thinking = thinkingOf(entry)
      if (content.trim() || thinking) events.push({ seq: 0, at, kind: 'response', text: content, thinking, step, index: entry.step_index,
        inputTokens: entry.input_tokens, outputTokens: entry.output_tokens })
      for (const call of entry.tool_calls ?? []) {
        const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([key, value]) => [key, argument(value)]))
        const event: AgyEvent = { seq: 0, at, kind: 'tool', tool: String(call.name ?? 'tool'), args: JSON.stringify(args), text: '正在执行', phase: 'running' }
        events.push(event); calls.push(event)
      }
    } else if (calls.length) {
      // Results follow their response's tool calls in order.
      const event = calls.shift()!
      const [, created, completed, body] = /^Created At: (.*)\nCompleted At: (.*)\n([\s\S]*)$/.exec(content) ?? [, '', '', content]
      const failed = /ERROR|FAIL|CANCEL/i.test(entry.status ?? '')
      Object.assign(event, {
        index: entry.step_index, phase: entry.status === 'DONE' || failed ? 'completed' : 'running', isError: failed,
        text: `${body.trim() || (failed ? '工具执行失败' : '工具调用完成')}${entry.media?.length ? `\n[附带 ${entry.media.length} 个媒体文件]` : ''}`,
        ms: time(completed) && time(created) ? time(completed) - time(created) : undefined, subagent: createdSubagent(entry),
      })
    }
  }
  const last = entries.at(-1)
  return { task, events, running: !(last?.type === 'PLANNER_RESPONSE' && !last.tool_calls?.length) }
}

/** Only conversations this job's own records (or its subagents', a few levels deep) created can be read. */
export function agySubagentHistory(id: string, conversationId: string, brain = agyHostPaths()[1]) {
  const target = conversationId.toLowerCase()
  let level = [...new Set(storeFor(id).data.events.map(event => event.subagent).filter((child): child is string => Boolean(child)))]
  const seen = new Set<string>()
  for (let depth = 0; depth < 4 && level.length && !level.includes(target); depth++) {
    level.forEach(child => seen.add(child))
    level = [...new Set(level.flatMap(child => subagentsOf(readAgyTranscript(child, brain) ?? [])))].filter(child => !seen.has(child))
  }
  if (!level.includes(target)) return
  const entries = readAgyTranscript(target, brain)
  if (!entries) return
  const secrets = privateValues(config.get())
  const view = transcriptEvents(entries)
  const events = view.events.slice(-500).map((event, index) => cleanEvent({ ...event, seq: index + 1 }))
  return { task: agyHistoryText(view.task, secrets, 16000), running: view.running, events, dropped: Math.max(0, view.events.length - 500) }
}
/** Remember which CLI conversation a run used, so a finished task can be matched to its transcript later. */
function noteConversation(id: string, conversationId: string) {
  if (!CONVERSATION.test(conversationId)) return
  try {
    const store = storeFor(id)
    store.data.conversations = [...store.data.conversations ?? [], conversationId.toLowerCase()]
    store.save()
  } catch { log.warn('AGY 执行记录保存失败') }
}
/** Tasks recorded before conversations were noted: find the transcripts whose prompt carried this task in its time window. */
function findConversations(job: ComputerJob, brain: string) {
  let dirs: string[]
  try { dirs = fs.readdirSync(brain).filter(dir => CONVERSATION.test(dir)) } catch { return [] }
  const from = job.createdAt - 60000, to = (job.updatedAt ?? Date.now()) + 60000
  // Not only the first entry: older CLI versions continued one conversation across tasks.
  return dirs.map(dir => ({ dir, prompt: readAgyTranscript(dir, brain)?.find(entry => {
    const at = Date.parse(entry.created_at ?? '')
    return entry.type === 'USER_INPUT' && at >= from && at <= to && entry.content?.includes(`Task: ${job.task}`)
  }) }))
    .filter(({ prompt }) => prompt).sort((a, b) => Date.parse(a.prompt!.created_at!) - Date.parse(b.prompt!.created_at!))
    .map(({ dir }) => dir.toLowerCase())
}
/**
 * Once a task has finished, fill in thinking and subagent links the live run missed: transcript lag at exit, or
 * records made before either was tracked (those lack step indexes, so they pair by order, only when counts agree).
 */
export function resolveAgyHistory(job: ComputerJob, brain = agyHostPaths()[1]) {
  if (['queued', 'running', 'waiting'].includes(job.status)) return
  const store = storeFor(job.id)
  if (store.data.resolved) return
  try {
    const conversations = store.data.conversations?.length ? store.data.conversations : findConversations(job, brain)
    // Each run starts with the prompt it was given; tasks older than that record are a single run.
    const runs: AgyEvent[][] = []
    for (const event of store.data.events) {
      if (event.kind === 'context') runs.push([])
      else runs.at(-1)?.push(event)
    }
    if (!runs.length) runs.push(store.data.events)
    if (conversations.length !== runs.length) return
    const updates = new Map<number, Partial<AgyEvent>>()
    runs.forEach((run, i) => {
      const entries = readAgyTranscript(conversations[i], brain) ?? []
      const byIndex = new Map(entries.map(entry => [entry.step_index, entry]))
      // Older CLI versions could continue one conversation across tasks; order-based pairing only uses this task's turns.
      const from = job.createdAt - 60000, to = (job.updatedAt ?? Date.now()) + 60000
      const own = entries.filter(entry => { const at = Date.parse(entry.created_at ?? ''); return !(at < from || at > to) })
      const pair = (events: AgyEvent[], ordered: TranscriptEntry[], update: (entry: TranscriptEntry, event: AgyEvent) => Partial<AgyEvent> | undefined) => {
        // Order says nothing once the oldest records were dropped.
        const legacy = i === 0 && store.data.dropped ? [] : events.filter(event => event.index == null)
        events.forEach(event => {
          const entry = event.index != null ? byIndex.get(event.index) : legacy.length === ordered.length && legacy.includes(event) ? ordered[legacy.indexOf(event)] : undefined
          const change = entry && update(entry, event)
          if (change) updates.set(event.seq, change)
        })
      }
      // Legacy responses carry no step index, and the stream can miss a turn the transcript has (e.g. the last one).
      // Align each with the next transcript response that issued the same tool calls; all must align, or none are used.
      const aligned = new Map<AgyEvent, TranscriptEntry>()
      if (!(i === 0 && store.data.dropped)) {
        const responses = own.filter(entry => entry.type === 'PLANNER_RESPONSE')
        const issued = (from: number) => {
          const names: string[] = [], open: string[] = []
          for (const event of run.slice(from + 1)) {
            if (event.kind === 'response') break
            if (event.kind !== 'tool') continue
            const tool = event.tool ?? ''
            if (event.phase === 'running') { names.push(tool); open.push(tool) }
            else if (open.includes(tool)) open.splice(open.lastIndexOf(tool), 1)
            else names.push(tool)
          }
          return names.join(',')
        }
        let next = 0
        for (const [position, event] of run.entries()) {
          if (event.kind !== 'response' || event.index != null) continue
          const calls = issued(position)
          while (next < responses.length && (responses[next].tool_calls ?? []).map(call => call.name).join(',') !== calls) next++
          if (next === responses.length) { aligned.clear(); break }
          aligned.set(event, responses[next++])
        }
      }
      for (const event of run) {
        if (event.kind !== 'response' || event.thinking) continue
        const entry = event.index != null ? byIndex.get(event.index) : aligned.get(event)
        const thinking = entry && thinkingOf(entry)
        if (thinking) updates.set(event.seq, { thinking })
      }
      // A legacy call has a running record and sometimes a completed one; pair the running ones.
      pair(run.filter(event => event.tool === 'invoke_subagent' && !event.subagent && (event.index != null || event.phase === 'running')),
        own.filter(entry => createdSubagent(entry)), (entry, event) => {
          const subagent = createdSubagent(entry)
          return subagent ? { subagent, ...event.phase === 'running' ? { phase: 'completed' as const, text: '已创建子代理' } : {} } : undefined
        })
    })
    if (updates.size) patchAgyEvents(job.id, event => updates.get(event.seq))
  } finally {
    store.data.resolved = true
    store.save()
  }
}
export function agyHistory(id: string) {
  const { events, dropped } = storeFor(id).data
  return { events: events.map(cleanEvent), dropped }
}
export function agyJobView(job: ComputerJob) {
  const secrets = privateValues(config.get())
  const text = (value: string | undefined) => value ? agyHistoryText(value, secrets, 16000) : undefined
  return {
    id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
    task: text(job.task), requesterText: text(job.requesterText), report: text(job.report), progress: text(job.progress),
    steps: job.steps, modelId: text(job.modelId), inputTokens: job.inputTokens, outputTokens: job.outputTokens,
    cacheReadTokens: job.cacheReadTokens, inputImageCount: job.inputImages?.length ?? 0, deliveryError: job.deliveryError,
  }
}
export function pruneAgyHistory(ids: Set<string>) {
  for (const id of new Set([...stores.keys(), ...(fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])])) {
    if (!/^[a-f0-9]{10}$/.test(id) || ids.has(id)) continue
    const target = directory(id)
    stores.get(id)?.dispose()
    stores.delete(id)
    fs.rmSync(target, { recursive: true, force: true })
  }
}

/** Aggregate streaming text into visible turns with their transcript thinking summaries; ignore stderr entirely. */
export function observeAgyJob(job: ComputerJob, changed: () => void, brain?: string) {
  const texts = new Map<number, string>()
  const finished = new Set<string>()
  // Responses and subagent launches the transcript has not described yet; retried on later responses and at exit.
  const pendingThinking = new Set<number>(), pendingSubagents = new Set<number>()
  let conversationId = ''
  const fillFromTranscript = () => {
    if (!(pendingThinking.size || pendingSubagents.size) || !conversationId) return
    const entries = new Map((readAgyTranscript(conversationId, brain) ?? []).map(entry => [entry.step_index, entry]))
    const thinking = new Map<number, string>(), subagents = new Map<number, string>()
    for (const index of pendingThinking) {
      const text = entries.get(index) && thinkingOf(entries.get(index)!)
      if (text) { thinking.set(index, text); pendingThinking.delete(index) }
    }
    for (const index of pendingSubagents) {
      const child = entries.get(index) && createdSubagent(entries.get(index)!)
      if (child) { subagents.set(index, child); pendingSubagents.delete(index) }
    }
    if (!thinking.size && !subagents.size) return
    patchAgyEvents(job.id, event => event.index == null ? undefined
      : event.kind === 'response' && thinking.has(event.index) && !event.thinking ? { thinking: thinking.get(event.index) }
      // The stream never reports invoke_subagent finishing; the transcript records its launch result.
      : event.kind === 'tool' && subagents.has(event.index) ? { subagent: subagents.get(event.index), ...event.phase === 'running' ? { phase: 'completed', text: '已创建子代理' } : {} }
      : undefined)
  }
  const progress = (text: string) => { job.progress = text; job.updatedAt = Date.now(); changed() }
  const count = (value: any) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  return (event: any) => {
    if (event.event === 'request_context') {
      recordAgyEvent(job.id, { kind: 'context', text: event.prompt, args: agyHistoryText(event.launch) })
      return
    }
    if (event.event === 'init') {
      if (typeof event.conversation_id === 'string') {
        conversationId = event.conversation_id
        noteConversation(job.id, conversationId)
      }
      progress('模型已启动')
      recordAgyEvent(job.id, { kind: 'progress', text: '模型已启动', model: job.modelId })
      return
    }
    if (event.event === 'result') {
      recordAgyEvent(job.id, { kind: 'progress', text: `CLI 终态：${String(event.result?.status ?? 'unknown')}${event.result?.error ? `\n${agyHistoryText(event.result.error)}` : ''}` })
      const usage = event.result?.usage
      if (usage) {
        job.inputTokens = count(usage.input_tokens)
        job.outputTokens = count(usage.output_tokens)
        job.cacheReadTokens = count(usage.cache_read_tokens)
      }
      progress(event.result?.status === 'SUCCESS' ? '执行已结束，正在整理对话回复' : '执行未完成，正在整理结果')
      return
    }
    if (event.event === 'runtime_exit') {
      fillFromTranscript()
      recordAgyEvent(job.id, { kind: event.success ? 'progress' : 'error', text: `${event.detail}${event.error ? `\n${event.error}` : ''}`, isError: !event.success })
      return
    }
    if (event.event !== 'step_update') return
    const step = event.step_update
    if (!step || !Number.isInteger(step.step_index) || step.step_index < 0) return
    const index = step.step_index
    const key = `${index}:${step.step_type}`
    if (finished.has(key)) return
    if (step.step_type === 'agent_response') {
      const delta = typeof step.text_delta === 'string' ? step.text_delta : ''
      if (delta) texts.set(index, ((texts.get(index) ?? '') + delta).slice(0, 12000))
      if (step.state !== 'DONE') return
      finished.add(key)
      const text = typeof step.text === 'string' ? step.text : texts.get(index) ?? ''
      texts.delete(index)
      job.steps = (job.steps ?? 0) + 1
      progress(`已完成 ${job.steps} 轮处理`)
      recordAgyEvent(job.id, { kind: 'response', text, step: job.steps, index, model: job.modelId,
        ms: count(step.duration_seconds * 1000), inputTokens: count(step.usage?.input_tokens), outputTokens: count(step.usage?.output_tokens) })
      pendingThinking.add(index)
      fillFromTranscript()
    } else if (step.step_type === 'tool') {
      const tool = String(step.tool_name ?? step.tool_info?.name ?? 'tool')
      const done = ['DONE', 'ERROR', 'FAILED'].includes(step.state)
      if (!done && step.state !== 'ACTIVE') return
      const activeKey = `${key}:active`
      if (!done && finished.has(activeKey)) return
      finished.add(done ? key : activeKey)
      if (tool === 'invoke_subagent') pendingSubagents.add(index)
      progress(done ? '工具已返回，继续处理' : `${agyHistoryText(tool, undefined, 100)} 执行中`)
      const isError = step.state !== 'DONE' && done
      recordAgyEvent(job.id, { kind: 'tool', text: done ? agyHistoryText(step.tool_info?.output ?? step.tool_info?.error ?? step.error ?? (isError ? '工具执行失败' : '工具调用完成')) : '正在执行',
        tool, index, args: agyHistoryText(step.tool_info?.parameters), phase: done ? 'completed' : 'running', isError,
        ms: count(step.duration_seconds * 1000) })
    }
  }
}
