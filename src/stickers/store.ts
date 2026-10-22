import fs from 'node:fs'
import path from 'node:path'
import { STICKER_DIR } from '../core/paths.ts'
import { JsonStore } from '../core/store.ts'
import { detectImageMime, MIME_EXT, sha1, similarity } from '../core/util.ts'

export interface MfaceData {
  emoji_id: string
  emoji_package_id: string | number
  key?: string
  summary?: string
}

export interface Sticker {
  id: string
  hash: string
  /** file name inside STICKER_DIR (preview for mface) */
  file?: string
  mime?: string
  kind: 'image' | 'mface'
  mface?: MfaceData
  name: string
  desc: string
  use: string
  tags: string[]
  text?: string
  indexed: boolean
  addedBy?: string
  addedAt: number
  uses: number
}

const store = new JsonStore<{ v: 1; items: Sticker[] }>(path.join(STICKER_DIR, 'index.json'), { v: 1, items: [] }, 1000)
export let stickerVersion = 0

function changed() {
  stickerVersion++
  store.save()
}

export function listStickers(): Sticker[] {
  return store.data.items
}

export function stickerFile(s: Sticker): string | undefined {
  return s.file ? path.join(STICKER_DIR, s.file) : undefined
}

function uniqueId(hash: string): string {
  const ids = new Set(store.data.items.map(s => s.id))
  for (let n = 5; n <= hash.length; n++) if (!ids.has(hash.slice(0, n))) return hash.slice(0, n)
  return hash
}

export function uniqueName(name: string, selfId?: string): string {
  const taken = new Set(store.data.items.filter(s => s.id !== selfId).map(s => s.name))
  let out = name.trim().slice(0, 12) || '表情'
  for (let i = 2; taken.has(out); i++) out = `${name.trim().slice(0, 10)}${i}`
  return out
}

/** Add an image sticker; returns [sticker, isNew]. Dedupes by content hash. */
export interface StickerMeta { addedBy?: string; name?: string; desc?: string; use?: string; tags?: string[]; text?: string }

export function addImageSticker(buf: Buffer, meta: StickerMeta = {}): [Sticker, boolean] {
  const hash = sha1(buf)
  const existing = store.data.items.find(s => s.hash === hash)
  if (existing) return [existing, false]
  const mime = detectImageMime(buf) ?? 'image/png'
  fs.mkdirSync(STICKER_DIR, { recursive: true })
  const file = `${hash.slice(0, 16)}.${MIME_EXT[mime] ?? 'img'}`
  fs.writeFileSync(path.join(STICKER_DIR, file), buf)
  const s: Sticker = {
    id: uniqueId(hash),
    hash,
    file,
    mime,
    kind: 'image',
    name: uniqueName(meta.name || '未命名'),
    desc: meta.desc ?? '',
    use: meta.use ?? '',
    tags: meta.tags ?? [],
    ...(meta.text ? { text: meta.text } : {}),
    indexed: Boolean(meta.name && meta.desc),
    addedBy: meta.addedBy,
    addedAt: Date.now(),
    uses: 0,
  }
  store.data.items.push(s)
  changed()
  return [s, true]
}

/** Add a QQ market face (mface); preview image (if downloadable) is stored for indexing. */
export function addMfaceSticker(m: MfaceData, preview?: Buffer, addedBy?: string): [Sticker, boolean] {
  const hash = sha1(`mface:${m.emoji_package_id}:${m.emoji_id}`)
  const existing = store.data.items.find(s => s.hash === hash)
  if (existing) return [existing, false]
  let file: string | undefined
  let mime: string | undefined
  if (preview) {
    mime = detectImageMime(preview) ?? 'image/png'
    fs.mkdirSync(STICKER_DIR, { recursive: true })
    file = `${hash.slice(0, 16)}.${MIME_EXT[mime] ?? 'img'}`
    fs.writeFileSync(path.join(STICKER_DIR, file), preview)
  }
  const summary = (m.summary ?? '').replace(/[[\]]/g, '')
  const s: Sticker = {
    id: uniqueId(hash),
    hash,
    file,
    mime,
    kind: 'mface',
    mface: m,
    name: uniqueName(summary || '商城表情'),
    desc: summary,
    use: '',
    tags: [],
    indexed: false,
    addedBy,
    addedAt: Date.now(),
    uses: 0,
  }
  store.data.items.push(s)
  changed()
  return [s, true]
}

export function updateSticker(id: string, patch: Partial<Sticker>) {
  const s = store.data.items.find(x => x.id === id)
  if (!s) return
  Object.assign(s, patch)
  changed()
}

export function findSticker(key: string): Sticker | undefined {
  const k = key.trim()
  return store.data.items.find(s => s.id === k) ?? store.data.items.find(s => s.name === k)
}

export function removeSticker(key: string): Sticker | undefined {
  const s = findSticker(key)
  if (!s) return undefined
  store.data.items = store.data.items.filter(x => x !== s)
  const f = stickerFile(s)
  if (f && !store.data.items.some(x => x.file === s.file)) {
    fs.rmSync(f, { force: true })
    // scaled copies made for sending (<name>.s240.png)
    const base = path.parse(f).name
    for (const x of fs.readdirSync(path.dirname(f))) if (x.startsWith(`${base}.s`)) fs.rmSync(path.join(path.dirname(f), x), { force: true })
  }
  changed()
  return s
}

export function markUsed(s: Sticker) {
  s.uses++
  store.save()
}

/** Best sticker for an LLM-written name/mood: exact name > name contains > tag > fuzzy desc. */
export function resolveSticker(query: string): Sticker | undefined {
  const q = query.trim()
  if (!q) return undefined
  const items = store.data.items.filter(s => s.indexed || s.name !== '未命名')
  const exact = items.find(s => s.name === q)
  if (exact) return exact
  const contains = items.filter(s => s.name.includes(q) || q.includes(s.name))
  if (contains.length) return contains[Math.floor(Math.random() * contains.length)]
  const tagged = items.filter(s => s.tags.some(t => t === q || t.includes(q) || q.includes(t)))
  if (tagged.length) return tagged[Math.floor(Math.random() * tagged.length)]
  let best: Sticker | undefined
  let bestScore = 0.35
  for (const s of items) {
    const score = Math.max(similarity(q, s.desc), similarity(q, s.use), similarity(q, s.tags.join(' ')))
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  return best
}
