import crypto from 'node:crypto'

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

export const randInt = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1))
export const randFloat = (min: number, max: number) => min + Math.random() * (max - min)
export const chance = (p: number) => Math.random() < p
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

export const sha1 = (data: string | Buffer) => crypto.createHash('sha1').update(data).digest('hex')

export function truncate(text: string, max: number, suffix = '…'): string {
  if (!text || text.length <= max) return text || ''
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix
}

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/g

/** Rough token estimate good enough for budgeting (CJK ~1 token/char, latin ~4 chars/token). */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 3.6)
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v)
}

/** Deep merge; arrays and scalars from `b` replace those in `a`. */
export function deepMerge<T>(a: T, b: any): T {
  if (!isPlainObject(a) || !isPlainObject(b)) return (b === undefined ? a : b) as T
  const out: Record<string, any> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v
  }
  return out as T
}

export function splitPath(p: string): (string | number)[] {
  return p
    .split('.')
    .filter(Boolean)
    .map(s => (/^\d+$/.test(s) ? Number(s) : s))
}

export function getPath(obj: any, p: string | (string | number)[]): any {
  const parts = Array.isArray(p) ? p : splitPath(p)
  let cur = obj
  for (const k of parts) {
    if (cur == null) return undefined
    cur = cur[k as any]
  }
  return cur
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0分钟'
  const m = Math.ceil(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  return [d && `${d}天`, h && `${h}小时`, (mm || (!d && !h)) && `${mm}分钟`].filter(Boolean).join('')
}

export function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '-'
  if (v === 0) return '$0'
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

const TZ = 'Asia/Shanghai'
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** "2026-10-20 周二 14:03" in Asia/Shanghai regardless of host TZ. */
export function formatNow(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const wdIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')} ${WEEK[wdIdx] ?? ''} ${hour}:${get('minute')}`
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  if (t.length === 1) out.add(t)
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** Dice coefficient over character bigrams; works for Chinese without a tokenizer. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** Serializes async work per key. */
export class KeyedLock {
  private tails = new Map<string, Promise<void>>()
  private waiting = new Map<string, number>()

  pending(key: string): number {
    return this.waiting.get(key) ?? 0
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(r => (release = r))
    const tail = prev.then(() => next)
    this.tails.set(key, tail)
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1)
    try {
      await prev
      return await fn()
    } finally {
      this.waiting.set(key, (this.waiting.get(key) ?? 1) - 1)
      if (!this.waiting.get(key)) this.waiting.delete(key)
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

export class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  max: number
  constructor(max: number) {
    this.max = max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      this.queue.push(resolve)
      this.drain()
    })
    try {
      return await fn()
    } finally {
      this.active--
      this.drain()
    }
  }

  private drain() {
    while (this.queue.length && this.active < Math.max(1, this.max)) {
      this.active++
      this.queue.shift()!()
    }
  }
}

export function detectImageMime(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return undefined
}

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

/** Text extensions read_file returns as text; everything else must be a recognised binary format. */
const TEXT_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain', xml: 'text/xml',
  yaml: 'text/yaml', yml: 'text/yaml', html: 'text/html', htm: 'text/html', srt: 'text/plain', vtt: 'text/plain',
  py: 'text/plain', js: 'text/plain', ts: 'text/plain', sh: 'text/plain', ini: 'text/plain', toml: 'text/plain',
}
const TEXT_MIME_EXT: Record<string, string> = { 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json', 'text/xml': 'xml', 'text/yaml': 'yaml', 'text/html': 'html' }

/**
 * Detect video, audio, PDF and text files from their bytes (a name only picks the text flavour). Images are
 * left to detectImageMime. Formats no model reads (QQ silk voice, mkv, archives…) return undefined.
 */
export function detectFileMime(buf: Buffer, name = ''): string | undefined {
  if (buf.length < 12) return buf.length && isText(buf) ? textMime(name) : undefined
  const ascii = (from: number, to: number) => buf.subarray(from, to).toString('latin1')
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (/^(heic|heix|heim|heis|hevc|mif1|msf1|avif|avis)$/.test(brand)) return undefined
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand.startsWith('3g')) return 'video/3gpp'
    return 'video/mp4'
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
    return buf.subarray(0, 64).includes('webm') ? (/\.(weba|ogg|opus)$/i.test(name) ? 'audio/webm' : 'video/webm') : undefined
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return 'video/x-msvideo'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav'
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && (buf[3] === 0xba || buf[3] === 0xb3)) return 'video/mpeg'
  if (ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2)) return 'audio/mpeg'
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac'
  return isText(buf) ? textMime(name) : undefined
}

function textMime(name: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return ext ? TEXT_EXT[ext] : 'text/plain'
}

/** UTF-8 without control bytes other than whitespace. */
function isText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 65536)
  for (const byte of sample) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length }); return true } catch { return false }
}

export const FILE_EXT: Record<string, string> = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/3gpp': '3gp', 'video/mpeg': 'mpg',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'weba',
  'application/pdf': 'pdf', ...TEXT_MIME_EXT,
}
export const isTextMime = (mime: string) => mime in TEXT_MIME_EXT

/** Download with a hard size cap. Returns undefined on any failure. */
export async function fetchBuffer(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Buffer | undefined> {
  const { maxBytes = 8 * 1024 * 1024, timeoutMs = 15000 } = opts
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: opts.headers })
    if (!res.ok || !res.body) return undefined
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes) return undefined
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of res.body as any) {
      size += chunk.length
      if (size > maxBytes) return undefined
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch {
    return undefined
  }
}

export function safeJsonParse<T = any>(text: string, fallback: T): T {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function maskSecret(s?: string): string {
  if (!s) return '未配置'
  if (s.length <= 10) return '****'
  return `${s.slice(0, 5)}****${s.slice(-4)}`
}

export function stableStringify(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (isPlainObject(v))
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
