import fs from 'node:fs'
import path from 'node:path'
import { chatImageScope, readFile, readImage, saveFile, saveImage, MAX_FILE_BYTES, MAX_IMAGE_BYTES, type SavedFile } from '../chat/images.ts'
import { peekSession, sessionKey } from '../chat/session.ts'
import { agyOutputFile, agyWorkspace } from '../agy/paths.ts'
import { readSandboxFile, readSandboxImage } from './exec.ts'
import type { ToolCtx } from './registry.ts'

/**
 * Resolve an image path a tool was given. Readable places are this chat's folder of the image store
 * (/work/attachments/<scope>/...), AGY session outputs and this reply's run_code workspace. Host paths,
 * file: URLs and other chats' folders are refused, so a chat cannot read or send arbitrary files from the bot's machine.
 */
export async function readLocalImage(value: unknown, ctx: ToolCtx): Promise<ReturnType<typeof readImage>> {
  if (typeof value !== 'string' || !value.trim()) throw Error('请提供图片路径')
  const file = value.trim()
  const scope = ctx.turn.imageScope ?? chatImageScope(ctx.e)
  if (file.startsWith('/work/attachments/')) return readImage(file, scope)
  if (file.startsWith('/work/agy/')) {
    const session = peekSession(sessionKey(ctx.e, ctx.eff.chat.sessionScope))?.agy
    if (!session) throw Error('当前对话没有 AGY 输出目录')
    const target = agyOutputFile(file, session.workspaceId)
    const root = fs.realpathSync(path.join(agyWorkspace(session.workspaceId), 'out'))
    const actual = fs.realpathSync(target), relative = path.relative(root, actual)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('无效的 AGY 输出路径')
    const stat = fs.statSync(actual)
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw Error('图片文件无效或超过大小上限')
    const image = saveImage(scope, { type: 'image', data: fs.readFileSync(actual).toString('base64') })
    ;(ctx.turn.imageRefs ??= []).push(image)
    return readImage(image.path, scope)
  }
  const workspace = file.startsWith('/work/') || (!file.startsWith('/') && !/^[a-z][\w+.-]*:/i.test(file) && !file.startsWith('\\'))
  if (!workspace) throw Error('只能读取当前对话图片库、AGY 输出（/work/agy/…/out/…）或本次回复代码工作目录中的图片')
  if (!ctx.turn.sandboxSession) throw Error('本次回复没有代码工作目录；请使用对话图片标注中的 /work/attachments 路径')
  // The runner confines the read to this reply's workspace (realpath checked, symlinks cannot escape it).
  const data = (await readSandboxImage(ctx, file)).b64
  const image = saveImage(scope, { type: 'image', data })
  const refs = ctx.turn.imageRefs ??= []
  if (!refs.some(ref => ref.path === image.path)) refs.push(image)
  return readImage(image.path, scope)
}

/**
 * read_file's resolver: the same three places as readLocalImage, for any format the store accepts. Files from AGY
 * outputs and the code workspace are copied into the chat's store first, so later turns can read them by label.
 */
export async function readLocalFile(value: unknown, ctx: ToolCtx): Promise<ReturnType<typeof readFile>> {
  if (typeof value !== 'string' || !value.trim()) throw Error('请提供文件路径')
  const file = value.trim()
  const scope = ctx.turn.imageScope ?? chatImageScope(ctx.e)
  if (file.startsWith('/work/attachments/')) return readFile(file, scope)
  let saved: SavedFile
  if (file.startsWith('/work/agy/')) {
    const session = peekSession(sessionKey(ctx.e, ctx.eff.chat.sessionScope))?.agy
    if (!session) throw Error('当前对话没有 AGY 输出目录')
    const target = agyOutputFile(file, session.workspaceId)
    const root = fs.realpathSync(path.join(agyWorkspace(session.workspaceId), 'out'))
    const actual = fs.realpathSync(target), relative = path.relative(root, actual)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('无效的 AGY 输出路径')
    const stat = fs.statSync(actual)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('文件无效或超过大小上限')
    saved = saveFile(scope, fs.readFileSync(actual), path.basename(actual))
  } else {
    const workspace = file.startsWith('/work/') || (!file.startsWith('/') && !/^[a-z][\w+.-]*:/i.test(file) && !file.startsWith('\\'))
    if (!workspace) throw Error('只能读取当前对话附件库、AGY 输出（/work/agy/…/out/…）或本次回复代码工作目录中的文件')
    if (!ctx.turn.sandboxSession) throw Error('本次回复没有代码工作目录；请使用对话附件标注中的 /work/attachments 路径')
    const { name, data } = await readSandboxFile(ctx, file)
    saved = saveFile(scope, data, name)
  }
  if (saved.mime.startsWith('image/')) {
    const refs = ctx.turn.imageRefs ??= []
    if (!refs.some(ref => ref.path === saved.path)) refs.push(saved)
  }
  return readFile(saved.path, scope)
}
