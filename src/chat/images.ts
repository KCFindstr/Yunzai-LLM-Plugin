import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/paths.ts'
import { detectImageMime, MIME_EXT, sha1 } from '../core/util.ts'
import type { ImagePart } from '../llm/types.ts'

export interface SavedImage { path: string; name: string; mime: string; bytes: number; at: number }
export const imageLabel = (image: Pick<SavedImage, 'path'>, index = 0) => `[图片${index + 1}:${image.path}]`
export const IMAGE_TTL_MS = 30 * 86400_000
export const MAX_IMAGE_BYTES = 5_242_880
export const IMAGE_STORE_ROOT = path.join(DATA_DIR, 'images')
const ROOT = IMAGE_STORE_ROOT
const NAME = /^image-(?:[a-f0-9]{40}|[1-8]-[a-f0-9]{12})\.(png|jpg|gif|webp|bmp)$/
export const imageScope = (conversation: string) => sha1(conversation).slice(0, 10)
function directory(scope: string) {
  if (!/^[a-f0-9]{10}$/.test(scope)) throw Error('无效的图片来源标识')
  return path.join(ROOT, scope)
}
export function listImages(scope: string): SavedImage[] {
  const dir = directory(scope)
  let entries: SavedImage[] = []
  try { entries = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) } catch { return [] }
  if (!Array.isArray(entries)) return []
  return entries.filter(image => NAME.test(image.name) && image.path === `/work/attachments/${scope}/${image.name}` && image.at > Date.now() - IMAGE_TTL_MS)
}
export function saveImage(scope: string, part: ImagePart): SavedImage {
  if (!part.data || part.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw Error('图片数据缺失或超过大小上限')
  const buffer = Buffer.from(part.data, 'base64'), mime = detectImageMime(buffer)
  if (!mime || buffer.length > MAX_IMAGE_BYTES) throw Error('图片格式不支持或超过大小上限')
  const name = `image-${sha1(buffer)}.${MIME_EXT[mime]}`
  const image = { name, path: `/work/attachments/${scope}/${name}`, mime, bytes: buffer.length, at: Date.now() }
  const dir = directory(scope)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), buffer)
  const entries = [...listImages(scope).filter(item => item.path !== image.path), image]
  const temporary = path.join(dir, 'index.tmp')
  fs.writeFileSync(temporary, JSON.stringify(entries))
  fs.renameSync(temporary, path.join(dir, 'index.json'))
  return image
}
/** One store folder per chat (a group or a private chat), whatever the session scope: group-log images are group-wide. */
export const chatImageScope = (e: any) => imageScope(e.group_id ? `${e.self_id}:g${e.group_id}` : `${e.self_id}:p${e.user_id}`)

/**
 * Read a stored image for a tool. `scope` is the current chat's folder: paths from other chats are refused, so a
 * conversation can never pull another chat's images into its context or replies.
 */
export function readImage(sandboxPath: unknown, scope: string): { image: SavedImage; part: ImagePart } {
  if (storedImageScope(sandboxPath) !== scope) throw Error('只能使用当前对话图片库（/work/attachments/当前会话）中的图片，请使用对话图片标注中的确切路径')
  return readStoredImage(sandboxPath)
}

function storedImageScope(sandboxPath: unknown): string | undefined {
  return typeof sandboxPath === 'string' ? /^\/work\/attachments\/([a-f0-9]{10})\/image-(?:[a-f0-9]{40}|[1-8]-[a-f0-9]{12})\.(?:png|jpg|gif|webp|bmp)$/.exec(sandboxPath)?.[1] : undefined
}

/** Unscoped read for references the bot itself recorded (e.g. a queued job's own attachments). */
export function readStoredImage(sandboxPath: unknown): { image: SavedImage; part: ImagePart } {
  const scope = storedImageScope(sandboxPath)
  const image = scope ? listImages(scope).find(item => item.path === sandboxPath) : undefined
  if (!image) throw Error('图片路径不可用或图片已过期，请使用对话图片标注中的确切路径，或请用户重新附图')
  const file = path.join(directory(scope!), image.name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.bytes || stat.size > MAX_IMAGE_BYTES) throw Error('图片文件无效')
  const buffer = fs.readFileSync(file)
  const hash = sha1(buffer), extension = MIME_EXT[image.mime]
  const legacyIndex = /^image-([1-8])-/.exec(image.name)?.[1]
  const validName = image.name === `image-${hash}.${extension}` || (legacyIndex && image.name === `image-${legacyIndex}-${hash.slice(0, 12)}.${extension}`)
  if (buffer.length !== image.bytes || detectImageMime(buffer) !== image.mime || !validName) throw Error('图片文件已损坏')
  return { image, part: { type: 'image', data: buffer.toString('base64'), mime: image.mime } }
}

/** TTL belongs to the global store; clearing/expiring chats never removes these files. */
export function truncateImageText(text: string, limit: number): string {
  const labels = text.match(/\[图片\d+:\/work\/attachments\/[^\]\r\n]+\]/g) ?? []
  const body = text.replace(/\[图片\d+:\/work\/attachments\/[^\]\r\n]+\]/g, '').trim()
  return [body.length > limit ? body.slice(0, Math.max(0, limit - 1)) + '…' : body, ...labels].filter(Boolean).join('\n')
}

export function pruneImages(now = Date.now()) {
  if (!fs.existsSync(ROOT)) return
  for (const scope of fs.readdirSync(ROOT)) {
    if (!/^[a-f0-9]{10}$/.test(scope)) continue
    try {
      const dir = directory(scope)
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) continue
      let entries: SavedImage[] = []
      try { entries = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) } catch { /* Old orphan files still have mtimes. */ }
      if (!Array.isArray(entries)) entries = []
      const dates = new Map(entries.filter(image => NAME.test(image.name)).map(image => [image.name, image.at]))
      const expired = new Set<string>()
      for (const name of fs.readdirSync(dir)) {
        if (!NAME.test(name)) continue
        const file = path.join(dir, name), stat = fs.lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        if ((dates.get(name) ?? stat.mtimeMs) <= now - IMAGE_TTL_MS) { fs.unlinkSync(file); expired.add(name) }
      }
      if (expired.size) {
        const temporary = path.join(dir, 'index.tmp')
        fs.writeFileSync(temporary, JSON.stringify(entries.filter(image => !expired.has(image.name))))
        fs.renameSync(temporary, path.join(dir, 'index.json'))
      }
    } catch { /* A damaged manifest must not interrupt chat or delete unverified files. */ }
  }
}
