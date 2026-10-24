import { readLocalImage } from '../tools/imageFiles.ts'
import { registry } from '../tools/registry.ts'
import { addStickersFrom } from './add.ts'
import { listStickers } from './store.ts'

export function registerStickerTools() {
  registry.register({
    name: 'add_sticker',
    source: 'builtin',
    description:
      '添加并保存表情包到机器人的表情库。当用户要求添加、保存、收藏表情包或图片时调用，用 path 明确指定要保存的图片。' +
      '你能看到这张图时，把下面五项都按图片内容填好（用户指定的名称/用途优先）；看不到或不确定的项留空，系统会用视觉模型补全。',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: '要保存的图片的确切本地路径' },
        name: { type: 'string', description: '2-6个字的简短名称，口语化、能概括这个表情（如“狗头保命”“猫猫震惊”）；用户指定了就用用户的' },
        desc: { type: 'string', description: '画面内容与情绪，20字以内' },
        use: { type: 'string', description: '适合在什么聊天场景发，20字以内' },
        tags: { type: 'array', items: { type: 'string' }, description: '3到6个情绪/场景标签' },
        text: { type: 'string', description: '图中的文字，没有就留空' },
      },
    },
    available: ctx => ctx.eff.sticker.enable,
    async run(args, ctx) {
      if (!ctx.isAdmin) {
        return {
          content: '权限不足：当前只有机器人管理员有权限向表情包库添加或保存表情包。请礼貌告知对方需要管理员权限。',
          isError: true,
        }
      }
      // whatever the model read from the image; empty fields are filled by the vision indexer
      const hint = { name: args.name, desc: args.desc, use: args.use, tags: args.tags, text: args.text }
      if (typeof args.path !== 'string' || !args.path.trim()) return { content: '请提供要保存的图片 path', isError: true }
      const { part } = await readLocalImage(args.path, ctx)
      const res = await addStickersFrom(ctx.e, hint, { reply: false, images: [{ buf: Buffer.from(part.data!, 'base64') }] })
      return `表情包已处理完成：\n${res.lines.join('\n')}\n请在最终回复中简短口语化地告知用户已保存成功（可以提及保存的表情名称）。`
    },
  })

  registry.register({
    name: 'list_stickers', budgetExempt: true,
    source: 'builtin',
    description: '查看或搜索机器人表情库中已保存的表情包列表。当用户询问机器人有哪些表情包或搜索特定表情时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '可选，搜索关键词（按名称、标签或描述搜索）。留空则列出最近保存的表情。',
        },
      },
    },
    available: ctx => ctx.eff.sticker.enable,
    async run(args) {
      const items = listStickers()
      if (!items.length) return '当前表情库为空，还没有保存任何表情包。'
      const q = typeof args.query === 'string' ? args.query.trim() : ''
      let matched = items
      if (q) {
        matched = items.filter(
          s => s.name.includes(q) || s.desc.includes(q) || s.tags.some(t => t.includes(q)),
        )
        if (!matched.length) return `未找到与“${q}”相关的表情包。当前表情库共有 ${items.length} 个表情。`
      }
      const top = matched.slice(-20).reverse()
      const lines = top.map(
        s => `- 「${s.name}」${s.desc ? `：${s.desc}` : ''}${s.tags.length ? ` [${s.tags.slice(0, 3).join('/')}]` : ''}`,
      )
      return `表情库中找到 ${matched.length} 个表情（显示最近 ${top.length} 个）：\n${lines.join('\n')}`
    },
  })
}
