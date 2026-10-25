import { chatImageScope, imageLabel, pruneImages, saveImage, type SavedImage } from '../chat/images.ts'
import { readLocalImage } from './imageFiles.ts'
import { registry, type ToolCtx } from './registry.ts'

export const scopeForImages = (ctx: ToolCtx) => ctx.turn.imageScope ?? chatImageScope(ctx.e)
export function currentImages(ctx: ToolCtx): SavedImage[] {
  return ctx.turn.imageRefs ??= (ctx.turn.inputImages ?? []).map(part => saveImage(scopeForImages(ctx), part))
}
export function registerImageTools() {
  pruneImages()
  setInterval(pruneImages, 3600_000).unref()
  registry.register({
    name: 'read_image', budgetExempt: true, source: 'builtin',
    description: '按本对话图片库、AGY 输出（/work/agy/<会话>/out/...）或本次回复代码目录中的路径读取原图，作为原生图片加入视觉上下文；不会发送给用户。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    available: ctx => ctx.model.vision !== false,
    async run(args, ctx) {
      if (typeof args.path !== 'string' || !args.path.trim()) {
        return { content: '缺少 path 参数，请提供要读取的图片路径', isError: true }
      }
      try {
        const { image, part } = await readLocalImage(args.path.trim(), ctx)
        const refs = currentImages(ctx)
        if (!refs.some(ref => ref.path === image.path)) refs.push(image)
        return { content: imageLabel(image), images: [part] }
      } catch (err: any) {
        return { content: `读取图片失败：${err?.message ?? err}`, isError: true }
      }
    },
  })
}
