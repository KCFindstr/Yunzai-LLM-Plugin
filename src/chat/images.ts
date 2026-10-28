import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../core/paths.ts'
import { detectFileMime, detectImageMime, FILE_EXT, MIME_EXT, sha1 } from '../core/util.ts'
import { fileKind, type FilePart, type ImagePart } from '../llm/types.ts'

/** A stored attachment: an image, or a video/audio/document/text file (`file-<sha1>.<ext>`). */
export interface SavedImage { path: string; name: string; mime: string; bytes: number; at: number }
export type SavedFile = SavedImage
export const imageLabel = (image: Pick<SavedImage, 'path'> & { mime?: string }, index = 0) => `[${image.mime ? fileKind(image.mime) : '图片'}${index + 1}:${image.path}]`
/** Matches every attachment label, whatever its kind. */
export const ATTACHMENT_LABEL = /\[(?:图片|视频|音频|文件)\d+:\/work\/attachments\/[^\]\r\n]+\]/g
export const IMAGE_TTL_MS = 30 * 86400_000
export const MAX_IMAGE_BYTES = 5_242_880
/** Videos and documents: Gemini takes up to 100 MB inline per request (50 MB for PDFs). */
export const MAX_FILE_BYTES = 40 * 1024 * 1024
export const IMAGE_STORE_ROOT = path.join(DATA_DIR, 'images')
const ROOT = IMAGE_STORE_ROOT
const FILE_EXTS = [...new Set(Object.values(FILE_EXT))].join('|')
const NAME = new RegExp(`^(?:image-(?:[a-f0-9]{40}|[1-8]-[a-f0-9]{12})\\.(?:png|jpg|gif|webp|bmp)|file-[a-f0-9]{40}\\.(?:${FILE_EXTS}))$`)
const FILE_PATH = new RegExp(`^/work/attachments/([a-f0-9]{10})/file-[a-f0-9]{40}\\.(?:${FILE_EXTS})$`)
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
/** Store any readable attachment: images go through saveImage, other formats must be known to detectFileMime. */
export function saveFile(scope: string, buffer: Buffer, nameHint = ''): SavedFile {
  if (detectImageMime(buffer)) return saveImage(scope, { type: 'image', data: buffer.toString('base64') })
  const mime = detectFileMime(buffer, nameHint)
  if (!mime) throw Error('文件格式不支持（可读取图片、视频、音频、PDF 和文本文件）')
  if (buffer.length > MAX_FILE_BYTES) throw Error(`文件超过 ${MAX_FILE_BYTES / 1048576} MB 上限`)
  const name = `file-${sha1(buffer)}.${FILE_EXT[mime]}`
  const file = { name, path: `/work/attachments/${scope}/${name}`, mime, bytes: buffer.length, at: Date.now() }
  const dir = directory(scope)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), buffer)
  const entries = [...listImages(scope).filter(item => item.path !== file.path), file]
  const temporary = path.join(dir, 'index.tmp')
  fs.writeFileSync(temporary, JSON.stringify(entries))
  fs.renameSync(temporary, path.join(dir, 'index.json'))
  return file
}

/** Read any stored attachment of the current chat: images as image parts, everything else as file parts. */
export function readFile(sandboxPath: unknown, scope: string): { file: SavedFile; part: ImagePart | FilePart } {
  if (storedImageScope(sandboxPath)) {
    const { image, part } = readImage(sandboxPath, scope)
    return { file: image, part }
  }
  const owner = typeof sandboxPath === 'string' ? FILE_PATH.exec(sandboxPath)?.[1] : undefined
  if (!owner) throw Error('文件路径不可用，请使用对话附件标注中的确切 /work/attachments 路径')
  if (owner !== scope) throw Error('只能读取当前对话附件库（/work/attachments/当前会话）中的文件')
  const file = listImages(scope).find(item => item.path === sandboxPath)
  if (!file) throw Error('文件已过期或不存在，请让用户重新发送')
  const target = path.join(directory(scope), file.name)
  const stat = fs.lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.size > MAX_FILE_BYTES) throw Error('文件无效')
  const buffer = fs.readFileSync(target)
  if (file.name !== `file-${sha1(buffer)}.${FILE_EXT[file.mime]}` || detectFileMime(buffer, file.name) !== file.mime) throw Error('文件已损坏')
  return { file, part: { type: 'file', data: buffer.toString('base64'), mime: file.mime } }
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
  const labels = text.match(ATTACHMENT_LABEL) ?? []
  const body = text.replace(ATTACHMENT_LABEL, '').trim()
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
