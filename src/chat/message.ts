import { detectImageMime, fetchBuffer, truncate } from '../core/util.ts'
import type { ImagePart } from '../llm/types.ts'

/** Max raw bytes per image so base64 stays under common 5MB provider limits. */
const MAX_IMAGE_BYTES = 3_700_000

export interface QuotedMessage {
  fromBot: boolean
  name: string
  text: string
  imageUrls: string[]
}

export interface ExtractedInput {
  text: string
  images: ImagePart[]
  quoted?: QuotedMessage
  /** Raw segments that were images/stickers (for sticker-adding flows). */
  imageSegments: any[]
}

export function isStickerSegment(s: any): boolean {
  return s?.type === 'mface' || (s?.type === 'image' && (s.sub_type == 1 || /表情/.test(s.summary ?? '')))
}

/** Segments -> text for the LLM; bot mentions are dropped, others become @name. */
export function segmentsToText(message: any[], selfId?: any): string {
  let out = ''
  for (const s of message ?? []) {
    switch (s?.type) {
      case 'text':
        out += s.text ?? ''
        break
      case 'at':
        if (String(s.qq) !== String(selfId)) out += s.qq === 'all' ? '@全体成员 ' : `@${s.name || s.qq} `
        break
      case 'image':
        out += isStickerSegment(s) ? '[表情包]' : '[图片]'
        break
      case 'mface':
        out += `[表情:${(s.summary ?? '').replace(/[[\]]/g, '')}]`
        break
      case 'face':
        out += '[表情]'
        break
      case 'record':
        out += '[语音]'
        break
      case 'video':
        out += '[视频]'
        break
      case 'file':
        out += `[文件:${s.name ?? ''}]`
        break
      case 'json':
      case 'xml': {
        let title = ''
        try {
          const d = typeof s.data === 'string' ? JSON.parse(s.data) : s.data
          title = d?.prompt || d?.meta?.detail_1?.desc || d?.meta?.news?.title || ''
        } catch {}
        out += title ? `[卡片:${truncate(String(title), 60)}]` : '[卡片]'
        break
      }
      case 'forward':
        out += '[聊天记录]'
        break
    }
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

export async function loadImage(url: string): Promise<ImagePart | undefined> {
  if (!url || !/^https?:\/\//.test(url)) return undefined
  const buf = await fetchBuffer(url, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 15000 })
  if (!buf) return undefined
  const mime = detectImageMime(buf)
  if (!mime) return undefined
  return { type: 'image', data: buf.toString('base64'), mime }
}

export async function getQuoted(e: any): Promise<QuotedMessage | undefined> {
  if (e._llmQuoted !== undefined) return e._llmQuoted || undefined
  let q: QuotedMessage | undefined
  try {
    if (e.reply_id && typeof e.getReply === 'function') {
      const r = await e.getReply()
      if (r) {
        const segs = r.message ?? []
        const uid = r.sender?.user_id ?? r.user_id
        q = {
          fromBot: String(uid) === String(e.self_id),
          name: String(r.sender?.card || r.sender?.nickname || uid || '某人'),
          text: segmentsToText(segs, e.self_id),
          imageUrls: segs.filter((s: any) => s?.type === 'image' && s.url).map((s: any) => s.url),
        }
      }
    }
  } catch {}
  e._llmQuoted = q ?? null
  return q
}

export async function extractInput(
  e: any,
  opts: { includeImages: boolean; maxImages: number; includeQuoted: boolean; vision: boolean },
): Promise<ExtractedInput> {
  const message: any[] = e.message ?? []
  const text = segmentsToText(message, e.self_id) || (e.msg ?? '')
  const imageSegments = message.filter(s => s?.type === 'image' || s?.type === 'mface')
  const quoted = opts.includeQuoted ? await getQuoted(e) : undefined

  const images: ImagePart[] = []
  if (opts.includeImages && opts.vision && opts.maxImages > 0) {
    const urls = [
      ...message.filter(s => s?.type === 'image' && s.url).map(s => s.url),
      ...(quoted?.imageUrls ?? []),
    ].slice(0, opts.maxImages)
    const loaded = await Promise.all(urls.map(loadImage))
    for (const img of loaded) if (img) images.push(img)
  }
  return { text, images, quoted, imageSegments }
}
