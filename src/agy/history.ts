import fs from 'node:fs'
import path from 'node:path'
import { config } from '../core/config.ts'
import { DATA_DIR } from '../core/paths.ts'
import { JsonStore } from '../core/store.ts'
import { log } from '../core/log.ts'
import type { ComputerJob } from '../computer/queue.ts'
import { privateValues, redact } from './privacy.ts'

export interface AgyEvent {
  seq: number
  at: number
  kind: 'request' | 'context' | 'progress' | 'response' | 'tool' | 'report' | 'reply' | 'error' | 'cancel'
  text: string
  step?: number
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
interface History { seq: number; dropped: number; events: AgyEvent[] }
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
    step: event.step, model: event.model ? agyHistoryText(event.model, secrets, 100) : undefined,
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

/** Aggregate streaming text into visible turns; ignore provider-native reasoning and stderr entirely. */
export function observeAgyJob(job: ComputerJob, changed: () => void) {
  const texts = new Map<number, string>()
  const finished = new Set<string>()
  const progress = (text: string) => { job.progress = text; job.updatedAt = Date.now(); changed() }
  const count = (value: any) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  return (event: any) => {
    if (event.event === 'request_context') {
      recordAgyEvent(job.id, { kind: 'context', text: event.prompt, args: agyHistoryText(event.launch) })
      return
    }
    if (event.event === 'init') {
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
      recordAgyEvent(job.id, { kind: 'response', text, step: job.steps, model: job.modelId,
        ms: count(step.duration_seconds * 1000), inputTokens: count(step.usage?.input_tokens), outputTokens: count(step.usage?.output_tokens) })
    } else if (step.step_type === 'tool') {
      const tool = String(step.tool_name ?? step.tool_info?.name ?? 'tool')
      const done = ['DONE', 'ERROR', 'FAILED'].includes(step.state)
      if (!done && step.state !== 'ACTIVE') return
      const activeKey = `${key}:active`
      if (!done && finished.has(activeKey)) return
      finished.add(done ? key : activeKey)
      progress(done ? '工具已返回，继续处理' : `${agyHistoryText(tool, undefined, 100)} 执行中`)
      const isError = step.state !== 'DONE' && done
      recordAgyEvent(job.id, { kind: 'tool', text: done ? agyHistoryText(step.tool_info?.output ?? step.tool_info?.error ?? step.error ?? (isError ? '工具执行失败' : '工具调用完成')) : '正在执行',
        tool, args: agyHistoryText(step.tool_info?.parameters), phase: done ? 'completed' : 'running', isError,
        ms: count(step.duration_seconds * 1000) })
    }
  }
}
