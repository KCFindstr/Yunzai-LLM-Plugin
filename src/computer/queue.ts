import { randomBytes } from 'node:crypto'

export type JobStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
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
  steps?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  deliveryError?: boolean
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

  constructor(jobs: ComputerJob[], changed: () => void = () => {}) {
    this.jobs = jobs
    this.changed = changed
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
        result = { report: `电脑任务未完成：${String(error?.message ?? error).slice(0, 300)}` }
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
