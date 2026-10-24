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
    description: '按图片的本地路径读取原图，作为原生图片加入视觉上下文；不会发送给用户。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    available: ctx => ctx.model.vision !== false,
    async run(args, ctx) {
      const { image, part } = await readLocalImage(args.path, ctx)
      const refs = currentImages(ctx)
      if (!refs.some(ref => ref.path === image.path)) refs.push(image)
      return { content: imageLabel(image), images: [part] }
    },
  })
}
