import { chatImageScope, saveImage, type SavedImage } from './images.ts'
import { detectImageMime, fetchBuffer, truncate } from '../core/util.ts'
import type { ImagePart } from '../llm/types.ts'
import { knownName } from './roster.ts'
import { cachedMessageSender, imageSender } from './groupLog.ts'

/** Max raw bytes per image so base64 stays under common 5MB provider limits. */
const MAX_IMAGE_BYTES = 3_700_000

export interface QuotedMessage {
  senderId?: string
  fromBot: boolean
  name: string
  text: string
  imageUrls: string[]
  /** the quoted message is a chat record; its inner messages are already individually limited */
  forward?: boolean
}

export interface ExtractedInput {
  text: string
  images: ImagePart[]
  savedImages?: SavedImage[]
  quoted?: QuotedMessage
  /** Index in `savedImages` where the quoted message's images begin; they are labelled inside the quote. */
  quotedImageStart?: number
  /** Raw segments that were images/stickers (for sticker-adding flows). */
  imageSegments: any[]
}

/** `【引用 名字(平台ID x)】`, shared by the current message and the recent group chat lines. */
export function quoteLabel(q: Pick<QuotedMessage, 'senderId' | 'fromBot' | 'name'>): string {
  if (!q.senderId) return `【引用｜发送者ID未知${q.name !== '某人' ? `｜${q.name}` : ''}】`
  return `【引用 ${q.fromBot ? '你' : q.name}(平台ID ${q.senderId})】`
}

/** Put saved image labels where the quote's image placeholders were; any left over go at the end. */
export function quoteBody(text: string, labels: string[]): string {
  const rest = [...labels]
  const body = text.replace(/\[(?:图片|表情包)\]/g, placeholder => rest.shift() ?? placeholder)
  return [body === '[非文本消息]' && labels.length ? '' : body, ...rest].filter(Boolean).join(' ')
}

export function isStickerSegment(s: any): boolean {
  return s?.type === 'mface' || (s?.type === 'image' && (s.sub_type == 1 || /表情/.test(s.summary ?? '')))
}

export interface ForwardLimits {
  /** characters per inner message */
  perNode: number
  /** inner messages shown before the rest are summarized as a count */
  nodes: number
}

export const FORWARD_LIMITS: ForwardLimits = { perNode: 200, nodes: 60 }
/** Images captured from inside a forward, so a long chat record cannot flood the vision input. */
const MAX_FORWARD_IMAGES = 4

/** Inner messages of a forward (合并转发) segment, when the adapter delivered them inline as `content`. */
export function forwardNodes(s: any): { name: string; message: any[] }[] {
  const content = s?.content ?? s?.data?.content
  if (!Array.isArray(content)) return []
  return content.map((node: any) => {
    const d = node?.type === 'node' ? node.data ?? node : node
    const raw = d?.message ?? d?.content ?? []
    const message = Array.isArray(raw) ? raw.map((segment: any) => ({ ...segment, ...segment?.data })) : [{ type: 'text', text: String(raw) }]
    return { name: String(d?.sender?.card || d?.sender?.nickname || d?.nickname || d?.name || '某人'), message }
  })
}

/** One line per inner message, each cut to its own budget so one long message cannot crowd out the rest. */
export function forwardLines(s: any, selfId?: any, limits: ForwardLimits = FORWARD_LIMITS): string[] {
  const nodes = forwardNodes(s)
  const lines = nodes.slice(0, limits.nodes)
    .map(node => `${node.name}: ${truncate(segmentsToText(node.message, selfId, true).replace(/\s+/g, ' ') || '[非文本消息]', limits.perNode)}`)
  if (nodes.length > limits.nodes) lines.push(`（其余 ${nodes.length - limits.nodes} 条略）`)
  return lines
}

export const hasForward = (message: any[]) => (message ?? []).some(s => s?.type === 'forward' && forwardNodes(s).length)

function forwardImageUrls(message: any[]): string[] {
  return (message ?? []).filter(s => s?.type === 'forward').flatMap(forwardNodes).flatMap(node => node.message)
    .filter(s => !isStickerSegment(s)).map(imageUrl).filter((url): url is string => Boolean(url)).slice(0, MAX_FORWARD_IMAGES)
}

/** Segments -> text for the LLM, preserving mention identities and their positions. */
export function segmentsToText(message: any[], selfId?: any, nested = false): string {
  let out = ''
  for (const s of message ?? []) {
    switch (s?.type) {
      case 'text':
        out += s.text ?? ''
        break
      case 'at':
        if (s.qq != null) {
          const isSelf = String(s.qq) === String(selfId)
          out += `[at:${isSelf ? 'you' : s.qq}]${!isSelf && s.name ? `(${s.name})` : ''} `
        }
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
      case 'forward': {
        // A forward inside a forward stays a placeholder; one level of chat record is enough context.
        const lines = nested ? [] : forwardLines(s, selfId)
        out += lines.length ? `\n【聊天记录 ${forwardNodes(s).length}条】\n${lines.join('\n')}\n【聊天记录结束】\n` : '[聊天记录]'
        break
      }
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

function imageUrl(segment: any): string | undefined {
  if (!['image', 'mface'].includes(segment?.type)) return undefined
  return [segment.url, segment.file].find(value => typeof value === 'string' && /^https?:\/\//.test(value))
}

/** The group log and the reply path both ask for the quote; share one lookup per event. */
export function getQuoted(e: any): Promise<QuotedMessage | undefined> {
  if (e._llmQuoted !== undefined) return Promise.resolve(e._llmQuoted || undefined)
  return e._llmQuoting ??= resolveQuoted(e)
}

async function resolveQuoted(e: any): Promise<QuotedMessage | undefined> {
  const reply = (e.message ?? []).find((segment: any) => segment?.type === 'reply')
  const metadata = reply?.data ?? reply
  const replyId = e.reply_id ?? metadata?.id ?? metadata?.message_id ?? e.source?.message_id
  let response: any
  // The group log sees the raw event before the loader attaches getReply, so fall back to the same lookup.
  const target = e.group?.getMsg ? e.group : e.friend?.getMsg ? e.friend : undefined
  const fetchReply = typeof e.getReply === 'function' ? () => e.getReply() : target ? () => target.getMsg(replyId) : undefined
  if (replyId != null && fetchReply) {
    try { response = await fetchReply() } catch { /* Source metadata and the exact group-log entry may still identify it. */ }
  }
  // OneBot returns the message directly; other adapters return {data:{message:{sender_id,segments}}}.
  const envelope = response?.data && typeof response.data === 'object' ? response.data : response
  const body = envelope?.message && !Array.isArray(envelope.message) && typeof envelope.message === 'object' ? envelope.message : envelope
  const identity = (message: any): string | undefined => {
    for (const value of [message?.sender?.user_id, message?.user_id, message?.sender_id, message?.sender?.id,
      message?.sender?.uin, message?.sender?.qq, message?.sender?.uid, message?.sender_uin, message?.sender_uid]) {
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim() && !['0', 'undefined', 'null'].includes(String(value))) return String(value).trim()
    }
  }
  const uid = identity(body) ?? identity(envelope) ?? identity(response) ?? identity(e.source) ?? identity(metadata)
    ?? cachedMessageSender(e, replyId)
  let q: QuotedMessage | undefined
  if (body || e.source || reply || uid) {
    const raw = body?.message ?? body?.segments ?? e.source?.message ?? []
    const segs = Array.isArray(raw) ? raw.map((segment: any) => ({ ...segment, ...segment?.data })) : typeof raw === 'string' ? [{ type: 'text', text: raw }] : []
    const sender = body?.sender ?? envelope?.sender ?? e.source?.sender
    q = {
      senderId: uid,
      fromBot: uid != null && e.self_id != null && uid === String(e.self_id),
      name: (uid && knownName(e, uid)) || String(sender?.card || sender?.nickname || sender?.name || uid || '某人'),
      text: segmentsToText(segs, e.self_id),
      imageUrls: [...segs.map(imageUrl), ...forwardImageUrls(segs)].filter((url: string | undefined): url is string => Boolean(url)),
      forward: hasForward(segs) || undefined,
    }
  }
  e._llmQuoted = q ?? null
  return q
}

/** Persist every successfully loaded image, even if vision or a tool never uses it. */
export async function captureImageSegments(message: any[], scope: string) {
  const urls = [...new Set([...message.map(imageUrl), ...forwardImageUrls(message)].filter((url): url is string => Boolean(url)))]
  const parts: ImagePart[] = [], savedImages: SavedImage[] = []
  for (let offset = 0; offset < urls.length; offset += 4) {
    const loaded = await Promise.all(urls.slice(offset, offset + 4).map(loadImage))
    for (const part of loaded) if (part) { parts.push(part); savedImages.push(saveImage(scope, part)) }
  }
  return { parts, savedImages }
}

export async function extractInput(
  e: any,
  opts: { includeImages: boolean; maxImages: number; includeQuoted: boolean; vision: boolean },
): Promise<ExtractedInput> {
  const message: any[] = e.message ?? []
  const text = segmentsToText(message, e.self_id) || (e.msg ?? '')
  const imageSegments = message.filter(s => s?.type === 'image' || s?.type === 'mface')
  const quoted = opts.includeQuoted ? await getQuoted(e) : undefined

  const scope = chatImageScope(e)
  const stored = opts.includeImages ? await (e._llmImageCapture ?? captureImageSegments(message, scope)) : { parts: [], savedImages: [] }
  const currentUrls = new Set(message.map(imageUrl))
  const quotes = opts.includeImages && quoted?.imageUrls.length ? await captureImageSegments(quoted.imageUrls.filter(url => !currentUrls.has(url)).map(url => ({ type: 'image', url })), scope) : { parts: [], savedImages: [] }
  const savedImages: SavedImage[] = [], parts: ImagePart[] = []
  for (const batch of [stored, quotes]) for (const [index, image] of batch.savedImages.entries()) {
    savedImages.push(image); parts.push(batch.parts[index])
  }
  if (quoted && !quoted.senderId) {
    const uid = imageSender(e, quotes.savedImages.map(image => image.path))
    if (uid) Object.assign(quoted, { senderId: uid, fromBot: false, name: knownName(e, uid) || quoted.name })
  }
  const images = opts.vision ? parts.slice(0, Math.max(0, Math.floor(opts.maxImages))) : []
  return { text, images, savedImages, quoted, quotedImageStart: quoted ? stored.savedImages.length : undefined, imageSegments }
}
