import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/paths.ts'
import { JsonStore } from '../core/store.ts'
import { log } from '../core/log.ts'
import { detectImageMime, sha1 } from '../core/util.ts'

export interface ComputerScreenshot { id: string; mime: string; bytes: number }
export interface ComputerEvent {
  seq: number
  at: number
  kind: 'request' | 'response' | 'tool' | 'report' | 'reply' | 'error'
  text: string
  step?: number
  model?: string
  ms?: number
  cost?: number
  inputTokens?: number
  outputTokens?: number
  tools?: { name: string; args: string }[]
  tool?: string
  args?: string
  isError?: boolean
  hasScreenshot?: boolean
  images?: ComputerScreenshot[]
  imageCount?: number
  delivery?: 'sent' | 'failed' | 'none'
}
interface History { seq: number; dropped: number; events: ComputerEvent[]; images: ComputerScreenshot[] }
const stores = new Map<string, JsonStore<History>>()
const ROOT = path.join(DATA_DIR, 'computer-history')
const MAX_HISTORY_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_IMAGES_BYTES = 32 * 1024 * 1024

function directory(id: string) {
  if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('无效的电脑任务编号')
  return path.join(ROOT, id)
}
function storeFor(id: string) {
  directory(id)
  let store = stores.get(id)
  if (!store) {
    store = new JsonStore<History>(path.join(directory(id), 'history.json'), { seq: 0, dropped: 0, events: [], images: [] })
    stores.set(id, store)
  }
  return store
}

/** Keep visible text, excluding credentials, binary payloads, and provider-native reasoning. */
export function historyText(value: unknown, max = 8000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, entry) =>
    /password|secret|token|cookie|authorization|api.?key|^data$|^native$|reasoning|signature/i.test(key) ? '[redacted]' : entry) ?? ''
  return text.replace(/Bearer\s+[^\s"\\]+|sk-[\w-]{8,}/gi, '[redacted]')
    .replace(/((?:password|secret|token|api.?key|cookie)\s*[=:]\s*)[^\s,;"\\]+/gi, '$1[redacted]')
    .replace(/data:image\/[^;,]+;base64,[\w+/=]+/gi, '[image data omitted]').slice(0, max)
}

export function recordComputerEvent(id: string, event: Omit<ComputerEvent, 'seq' | 'at'>) {
  try {
    const store = storeFor(id)
    store.data.events.push({ ...event, text: historyText(event.text), seq: ++store.data.seq, at: Date.now() })
    while (store.data.events.length > 1000 || Buffer.byteLength(JSON.stringify(store.data)) > MAX_HISTORY_BYTES) {
      store.data.events.shift()
      store.data.dropped++
    }
    store.save()
  } catch (error: any) { log.warn(`电脑任务记录保存失败：${error?.message}`) }
}

/** Only explicitly shared candidates and images selected for the final reply are retained. */
export function saveComputerScreenshot(id: string, buffer: Buffer): ComputerScreenshot | undefined {
  try {
    const mime = detectImageMime(buffer)
    if (!mime || buffer.length > MAX_IMAGE_BYTES) return
    const store = storeFor(id)
    const hash = sha1(buffer)
    const existing = store.data.images.find(image => image.id === hash)
    if (existing) return existing
    if (store.data.images.length >= 64 || store.data.images.reduce((total, image) => total + image.bytes, 0) + buffer.length > MAX_IMAGES_BYTES) return
    fs.mkdirSync(directory(id), { recursive: true })
    fs.writeFileSync(path.join(directory(id), `${hash}.image`), buffer)
    const image = { id: hash, mime, bytes: buffer.length }
    store.data.images.push(image)
    store.save()
    return image
  } catch (error: any) { log.warn(`电脑任务截图保存失败：${error?.message}`); return }
}

export function computerHistory(id: string) {
  const { events, dropped } = storeFor(id).data
  return { events, dropped }
}

export function readComputerScreenshot(id: string, imageId: string) {
  directory(id)
  if (!/^[a-f0-9]{40}$/.test(imageId)) return
  const image = storeFor(id).data.images.find(image => image.id === imageId)
  if (!image) return
  try {
    const buffer = fs.readFileSync(path.join(directory(id), `${imageId}.image`))
    if (buffer.length !== image.bytes || detectImageMime(buffer) !== image.mime || sha1(buffer) !== imageId) return
    return { raw: buffer, type: image.mime }
  } catch { return }
}

/** Match history retention to the queue's retained jobs; never walk arbitrary paths. */
export function pruneComputerHistory(ids: Set<string>) {
  for (const entry of new Set([...stores.keys(), ...(fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [])])) {
    if (!/^[a-f0-9]{10}$/.test(entry) || ids.has(entry)) continue
    stores.get(entry)?.dispose()
    stores.delete(entry)
    fs.rmSync(directory(entry), { recursive: true, force: true })
  }
}
