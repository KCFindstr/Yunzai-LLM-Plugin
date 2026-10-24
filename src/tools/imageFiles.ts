import { chatImageScope, readImage, saveImage } from '../chat/images.ts'
import { readSandboxImage } from './exec.ts'
import type { ToolCtx } from './registry.ts'

/**
 * Resolve an image path a tool was given. Only two places are readable: this chat's folder of the image store
 * (/work/attachments/<scope>/...) and this reply's run_code workspace (/work/... or a relative path). Host paths,
 * file: URLs and other chats' folders are refused, so a chat cannot read or send arbitrary files from the bot's machine.
 */
export async function readLocalImage(value: unknown, ctx: ToolCtx): Promise<ReturnType<typeof readImage>> {
  if (typeof value !== 'string' || !value.trim()) throw Error('请提供图片路径')
  const file = value.trim()
  const scope = ctx.turn.imageScope ?? chatImageScope(ctx.e)
  if (file.startsWith('/work/attachments/')) return readImage(file, scope)
  const workspace = file.startsWith('/work/') || (!file.startsWith('/') && !/^[a-z][\w+.-]*:/i.test(file) && !file.startsWith('\\'))
  if (!workspace) throw Error('只能读取当前对话图片库（/work/attachments/…）或本次回复代码工作目录（/work/…）中的图片')
  if (!ctx.turn.sandboxSession) throw Error('本次回复没有代码工作目录；请使用对话图片标注中的 /work/attachments 路径')
  // The runner confines the read to this reply's workspace (realpath checked, symlinks cannot escape it).
  const data = (await readSandboxImage(ctx, file)).b64
  const image = saveImage(scope, { type: 'image', data })
  const refs = ctx.turn.imageRefs ??= []
  if (!refs.some(ref => ref.path === image.path)) refs.push(image)
  return readImage(image.path, scope)
}
