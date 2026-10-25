import { randomBytes } from 'node:crypto'
import type { ComputerInputImage } from './attachments.ts'

export type JobStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** Longest task / follow-up text a chat turn may hand to a background job. */
export const MAX_TASK_CHARS = 12000
export const MAX_RESPONSE_CHARS = 6000

export interface ComputerJob {
  id: string
  owner: string
  task: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  report?: string
  response?: string
  progress?: string
  requesterText?: string
  /** Metadata only; original bytes live in the plugin's computer-inputs directory. */
  inputImages?: ComputerInputImage[]
  /** AGY workspace is stable per chat session; job IDs remain unique per operation. */
  agyWorkspaceId?: string
  /** Rollout of the turn that started or last resumed this job; it receives the result turn. */
  rolloutId?: string
  /** Background results that led to the turn which started this job (0 = started by a user message). */
  chainDepth?: number
  steps?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  deliveryError?: boolean
  modelId?: string
  costUsd?: number
}

export interface JobResult {
  report: string
  waiting?: boolean
  images?: Buffer[]
}

export class ComputerQueue {
  readonly jobs: ComputerJob[]
  private changed: () => void
  private pending: string[] = []
  private active?: { id: string; controller: AbortController }
  private runners = new Map<string, (job: ComputerJob, signal: AbortSignal) => Promise<JobResult>>()
  private notifiers = new Map<string, (job: ComputerJob, result: JobResult) => Promise<void>>()
  private stopped = false
  private cancelled: (job: ComputerJob) => void

  /** `cancelled` runs for every cancellation: a cancelled job is never reported back. */
  constructor(jobs: ComputerJob[], changed: () => void = () => {}, cancelled: (job: ComputerJob) => void = () => {}) {
    this.jobs = jobs
    this.changed = changed
    this.cancelled = cancelled
    for (const job of jobs) if (job.status === 'running' || job.status === 'queued') job.status = 'interrupted'
    changed()
  }

  get(id: string, owner: string): ComputerJob | undefined {
    return this.jobs.find(job => job.id === id && job.owner === owner)
  }

  submit(owner: string, task: string, maxQueue: number): ComputerJob {
    const live = this.jobs.filter(job => job.status === 'queued' || job.status === 'running')
    if (live.length >= maxQueue) throw new Error('电脑任务队列已满，请稍后再试')
    if (this.jobs.filter(job => job.status === 'waiting').length >= 32) throw new Error('等待回复的电脑任务过多，请先处理已有任务')
    if (live.filter(job => job.owner === owner).length >= 2) throw new Error('你已有两个电脑任务在排队或执行')
    const job: ComputerJob = { id: randomBytes(5).toString('hex'), owner, task, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() }
    this.jobs.push(job)
    while (this.jobs.length > 100) {
      const index = this.jobs.findIndex(entry => !['queued', 'running', 'waiting'].includes(entry.status))
      if (index < 0) break
      this.jobs.splice(index, 1)
    }
    this.changed()
    return job
  }

  activate(job: ComputerJob, run: (job: ComputerJob, signal: AbortSignal) => Promise<JobResult>, notify: (job: ComputerJob, result: JobResult) => Promise<void>) {
    if (this.stopped || job.status !== 'queued' || this.runners.has(job.id)) return
    this.runners.set(job.id, run)
    this.notifiers.set(job.id, notify)
    this.pending.push(job.id)
    void this.pump()
  }

  resume(job: ComputerJob, response: string, maxQueue: number) {
    if (!['waiting', 'failed', 'interrupted'].includes(job.status)) throw new Error('该任务不在等待回复或可恢复状态')
    if (this.jobs.filter(entry => ['queued', 'running'].includes(entry.status)).length >= maxQueue) throw new Error('电脑任务队列已满')
    job.response = response
    job.status = 'queued'
    job.updatedAt = Date.now()
    this.changed()
  }

  cancel(job: ComputerJob) {
    if (!['queued', 'running', 'waiting'].includes(job.status)) return
    job.status = 'cancelled'
    job.updatedAt = Date.now()
    if (this.active?.id === job.id) this.active.controller.abort()
    this.changed()
    this.cancelled(job)
  }

  stop() {
    this.stopped = true
    this.active?.controller.abort()
    for (const job of this.jobs) if (['queued', 'running'].includes(job.status)) job.status = 'interrupted'
    this.changed()
  }

  touch() { this.changed() }

  private async pump() {
    if (this.active || this.stopped) return
    const id = this.pending.shift()
    if (!id) return
    const job = this.jobs.find(entry => entry.id === id)!
    const run = this.runners.get(id)!
    const notify = this.notifiers.get(id)!
    const controller = new AbortController()
    this.active = { id, controller }
    try {
      if (job.status !== 'queued') return
      job.status = 'running'
      this.changed()
      let result: JobResult
      try {
        result = await run(job, controller.signal)
        if (job.status as JobStatus === 'cancelled' || this.stopped) return
        job.status = result.waiting ? 'waiting' : 'completed'
      } catch (error: any) {
        if (job.status as JobStatus === 'cancelled' || this.stopped) return
        job.status = 'failed'
        result = { report: typeof error?.report === 'string' ? error.report.slice(0, 20000) : `电脑任务未完成：${String(error?.message ?? error).slice(0, 300)}` }
      }
      job.report = result.report
      job.updatedAt = Date.now()
      this.changed()
      try { await notify(job, result) } catch { job.deliveryError = true; this.changed() }
    } finally {
      this.runners.delete(id)
      this.notifiers.delete(id)
      this.active = undefined
      void this.pump()
    }
  }
}
