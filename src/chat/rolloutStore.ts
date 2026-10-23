import fs from 'node:fs'
import path from 'node:path'
import { log } from '../core/log.ts'
import { registerFlushable } from '../core/store.ts'
import type { Rollout } from './rollouts.ts'

export type RolloutSummary = Omit<Rollout, 'context' | 'events' | 'seq' | 'reply' | 'thinkingDecision'>
const validId = (id: string) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)

function atomicWrite(file: string, data: unknown) {
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(data))
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}

/** The index contains summaries only; details are loaded by ID and cached in a bounded LRU. */
export class RolloutFileStore {
  private index = new Map<string, RolloutSummary>()
  private cache = new Map<string, Rollout>()
  private dirty = new Set<string>()
  private removed = new Set<string>()
  private timer?: NodeJS.Timeout
  private unregister: () => unknown
  readonly indexFile: string
  readonly directory: string
  private journalFile: string
  private summarize: (rollout: Rollout) => RolloutSummary

  constructor(directory: string, summarize: (rollout: Rollout) => RolloutSummary) {
    this.directory = directory
    this.summarize = summarize
    this.indexFile = path.join(directory, 'index.json')
    this.journalFile = path.join(directory, 'pending.json')
    if (fs.existsSync(this.indexFile)) {
      const index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (index?.v !== 2 || !Array.isArray(index.rollouts)) throw new Error('执行记录索引无效，原始文件已保留')
      for (const entry of index.rollouts) if (validId(entry.id)) this.index.set(entry.id, entry)
    } else if (fs.existsSync(directory)) {
      // Recover a missing index from the authoritative detail files.
      for (const file of fs.readdirSync(directory)) {
        const id = file.replace(/\.json$/, '')
        if (!validId(id) || file !== `${id}.json`) continue
        const rollout = this.read(id)
        if (rollout) this.index.set(id, summarize(rollout))
      }
      atomicWrite(this.indexFile, this.snapshot())
    }
    if (fs.existsSync(this.journalFile)) {
      const pending = JSON.parse(fs.readFileSync(this.journalFile, 'utf8'))
      if (!Array.isArray(pending?.updated) || !Array.isArray(pending?.removed)) throw new Error('执行记录恢复日志无效，文件已保留')
      for (const id of pending.updated) {
        if (!validId(id)) continue
        const rollout = this.read(id)
        if (rollout) this.index.set(id, summarize(rollout))
      }
      for (const id of pending.removed) if (validId(id)) this.index.delete(id)
      atomicWrite(this.indexFile, this.snapshot())
      for (const id of pending.removed) if (validId(id)) fs.rmSync(this.file(id), { force: true })
      fs.unlinkSync(this.journalFile)
    }
    this.index = new Map([...this.index].sort((a, b) => a[1].createdAt - b[1].createdAt))
    this.unregister = registerFlushable(this)
  }

  private file(id: string) { return path.join(this.directory, `${id}.json`) }
  private snapshot() { return { v: 2, rollouts: [...this.index.values()] } }
  private read(id: string): Rollout | undefined {
    try {
      const rollout = JSON.parse(fs.readFileSync(this.file(id), 'utf8'))
      if (rollout?.id === id && Array.isArray(rollout.events)) return rollout
      log.warn(`执行记录 ${id} 格式无效，文件已保留`)
    } catch (error: any) { log.warn(`读取执行记录 ${id} 失败：${error.message}`) }
  }
  private trimCache() {
    for (const id of this.cache.keys()) {
      if (this.cache.size <= 64) break
      if (!this.dirty.has(id)) this.cache.delete(id)
    }
  }
  list() { return [...this.index.values()] }
  get(id: string) {
    if (!validId(id) || !this.index.has(id)) return
    const rollout = this.cache.get(id) ?? this.read(id)
    if (rollout) {
      this.cache.delete(id)
      this.cache.set(id, rollout)
      this.trimCache()
    }
    return rollout
  }
  put(rollout: Rollout) {
    this.index.set(rollout.id, this.summarize(rollout))
    this.cache.set(rollout.id, rollout)
    this.dirty.add(rollout.id)
    this.removed.delete(rollout.id)
    this.schedule()
  }
  remove(id: string) {
    this.index.delete(id)
    this.cache.delete(id)
    this.dirty.delete(id)
    this.removed.add(id)
    this.schedule()
  }
  private schedule() {
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 3000)
      this.timer.unref()
    }
  }
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty.size && !this.removed.size) return
    try {
      atomicWrite(this.journalFile, { updated: [...this.dirty], removed: [...this.removed] })
      for (const id of this.dirty) atomicWrite(this.file(id), this.cache.get(id))
      atomicWrite(this.indexFile, this.snapshot())
      for (const id of this.removed) fs.rmSync(this.file(id), { force: true })
      fs.rmSync(this.journalFile, { force: true })
      this.dirty.clear()
      this.removed.clear()
      this.trimCache()
    } catch (error: any) {
      log.error(`保存执行记录失败：${error.message}`)
      this.schedule()
    }
  }
  dispose() {
    this.flush()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.unregister()
  }
}
