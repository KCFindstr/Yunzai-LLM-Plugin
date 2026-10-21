import { fetchBuffer, truncate } from '../core/util.ts'
import { indexSticker } from './indexer.ts'
import { addImageSticker, addMfaceSticker, type Sticker } from './store.ts'

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
  hint?: { name?: string; desc?: string },
  { reply = true }: { reply?: boolean } = {},
): Promise<AddStickersResult> {
  const { images, mfaces } = await collectImages(e)
  const added: Sticker[] = []
  const dup: Sticker[] = []
  for (const img of images) {
    const [s, isNew] = addImageSticker(img.buf, { addedBy: String(e.user_id), name: hint?.name, desc: hint?.desc })
    ;(isNew ? added : dup).push(s)
  }
  for (const m of mfaces) {
    const preview = m.url ? await fetchBuffer(m.url, { maxBytes: 5 * 1024 * 1024 }) : undefined
    const [s, isNew] = addMfaceSticker(
      { emoji_id: m.emoji_id, emoji_package_id: m.emoji_package_id, key: m.key, summary: m.summary },
      preview,
      String(e.user_id),
    )
    ;(isNew ? added : dup).push(s)
  }
  const total = added.length + dup.length
  if (!total) return { total: 0, added: [], dup: [], lines: [] }

  const lines: string[] = []
  for (const s of added) {
    if (hint?.name && hint?.desc) {
      lines.push(`✅ ${s.id}「${s.name}」`)
      continue
    }
    try {
      const r = await indexSticker(s, { hint: hint?.name, userId: String(e.user_id) })
      lines.push(`✅ ${r.id}「${r.name}」${r.desc}`)
    } catch (err: any) {
      lines.push(`⚠️ ${s.id} 已保存但识别失败：${truncate(err.message, 60)}（可用 #llm重命名表情 手动命名）`)
    }
  }
  for (const s of dup) lines.push(`↩️ ${s.id}「${s.name}」已存在`)
  if (reply && lines.length) {
    await e.reply(lines.join('\n'))
  }
  return { total, added, dup, lines }
}
