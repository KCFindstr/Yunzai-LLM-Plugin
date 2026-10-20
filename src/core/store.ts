import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.ts'
import { log } from './log.ts'

const stores = new Set<JsonStore<any>>()

/** Small JSON file store with debounced atomic writes. Good for KB–MB sized state. */
export class JsonStore<T> {
  readonly file: string
  data: T
  private timer?: NodeJS.Timeout
  private delay: number

  constructor(name: string, initial: T, delayMs = 3000) {
    this.file = path.isAbsolute(name) ? name : path.join(DATA_DIR, name)
    this.delay = delayMs
    this.data = initial
    try {
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err: any) {
      log.warn(`读取 ${this.file} 失败，使用空数据: ${err.message}`)
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {}
    }
    stores.add(this)
  }

  save() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delay)
    this.timer.unref?.()
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data))
      fs.renameSync(tmp, this.file)
    } catch (err: any) {
      log.error(`写入 ${this.file} 失败: ${err.message}`)
    }
  }
}

export function flushAllStores() {
  for (const s of stores) s.flush()
}
