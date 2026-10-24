import { fetchBuffer, truncate } from '../core/util.ts'
import { indexSticker, stickerIncomplete } from './indexer.ts'
import { addImageSticker, addMfaceSticker, uniqueName, updateSticker, type Sticker, type StickerMeta } from './store.ts'

/** What the caller already knows about the sticker (an admin's command, or a chat model that can see it). */
export type StickerHint = Omit<StickerMeta, 'addedBy'>

/** Trim a hint and drop empty fields so "" never overwrites anything. */
function cleanHint(hint?: StickerHint): StickerHint | undefined {
  if (!hint) return undefined
  const str = (v: any, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const tags = (Array.isArray(hint.tags) ? hint.tags : typeof hint.tags === 'string' ? String(hint.tags).split(/[,，、\s]+/) : [])
    .map(t => String(t).trim()).filter(Boolean).slice(0, 8)
  const out: StickerHint = { name: str(hint.name, 20), desc: str(hint.desc, 40), use: str(hint.use, 40), tags: tags.length ? tags : undefined, text: str(hint.text, 60) }
  return Object.values(out).some(v => v !== undefined) ? out : undefined
}

export interface AddStickersResult {
  total: number
  added: Sticker[]
  dup: Sticker[]
  lines: string[]
}

export async function collectImages(e: any): Promise<{ images: { buf: Buffer }[]; mfaces: any[] }> {
  const segs: any[] = [...(e.message ?? [])]
  const urls = new Set<string>()

  // Also gather URLs directly attached to e (e.g. Yunzai e.img)
  if (Array.isArray(e.img)) {
    for (const u of e.img) if (typeof u === 'string' && u) urls.add(u)
  }

  // Quoted message
  if (e.reply_id) {
    if (typeof e.getReply === 'function') {
      try {
        const r = await e.getReply()
        if (r) {
          segs.push(...(r.message ?? []))
          if (Array.isArray(r.img)) {
            for (const u of r.img) if (typeof u === 'string' && u) urls.add(u)
          }
        }
      } catch {}
    }
    // Also check cached quoted info if available
    if (e._llmQuoted?.imageUrls) {
      for (const u of e._llmQuoted.imageUrls) if (typeof u === 'string' && u) urls.add(u)
    }
  }

  const images: { buf: Buffer }[] = []
  const mfaces: any[] = []

  for (const s of segs) {
    if (s?.type === 'mface' && s.emoji_id) {
      mfaces.push(s)
    } else if (s?.type === 'image') {
      const u = s.url || (typeof s.file === 'string' && /^https?:\/\//.test(s.file) ? s.file : undefined)
      if (u) urls.add(u)
    }
  }

  for (const url of urls) {
    const buf = await fetchBuffer(url, { maxBytes: 10 * 1024 * 1024 })
    if (buf) images.push({ buf })
  }

  return { images, mfaces }
}

/** Add + index stickers from the current message; reports in a single reply if opts.reply is true. */
export async function addStickersFrom(
  e: any,
  rawHint?: StickerHint,
  { reply = true, images: explicitImages }: { reply?: boolean; images?: { buf: Buffer }[] } = {},
): Promise<AddStickersResult> {
  const hint = cleanHint(rawHint)
  const { images, mfaces } = explicitImages ? { images: explicitImages, mfaces: [] } : await collectImages(e)
  const added: Sticker[] = []
  const dup: Sticker[] = []
  for (const img of images) {
    const [s, isNew] = addImageSticker(img.buf, { addedBy: String(e.user_id), ...hint })
    ;(isNew ? added : dup).push(s)
  }
  for (const m of mfaces) {
    const preview = m.url ? await fetchBuffer(m.url, { maxBytes: 5 * 1024 * 1024 }) : undefined
    const [s, isNew] = addMfaceSticker(
      { emoji_id: m.emoji_id, emoji_package_id: m.emoji_package_id, key: m.key, summary: m.summary },
      preview,
      String(e.user_id),
    )
    // updateSticker mutates the stored object, so `s` reflects the hint afterwards
    if (isNew && hint)
      updateSticker(s.id, { ...hint, ...(hint.name ? { name: uniqueName(hint.name, s.id) } : {}), ...(hint.name && hint.desc ? { indexed: true } : {}) })
    ;(isNew ? added : dup).push(s)
  }
  const total = added.length + dup.length
  if (!total) return { total: 0, added: [], dup: [], lines: [] }

  const lines: string[] = []
  for (const s of added) {
    // everything already given (e.g. by a chat model that saw the image): no extra vision call
    if (s.indexed && !stickerIncomplete(s)) {
      lines.push(`✅ ${s.id}「${s.name}」${s.desc}`)
      continue
    }
    // anything given (name, description, …) is kept; vision fills only what is still empty
    const mode = hint ? 'fill' : 'full'
    try {
      const r = await indexSticker(s, { hint: hint?.name, userId: String(e.user_id), mode })
      lines.push(`✅ ${r.id}「${r.name}」${r.desc}`)
    } catch (err: any) {
      lines.push(hint?.name && hint?.desc
        ? `✅ ${s.id}「${s.name}」（适用场景/标签暂未补全：${truncate(err.message, 40)}）`
        : `⚠️ ${s.id} 已保存但识别失败：${truncate(err.message, 60)}（可用 #llm重命名表情 手动命名）`)
    }
  }
  for (const s of dup) lines.push(`↩️ ${s.id}「${s.name}」已存在`)
  if (reply && lines.length) {
    await e.reply(lines.join('\n'))
  }
  return { total, added, dup, lines }
}
