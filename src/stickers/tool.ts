import { registry } from '../tools/registry.ts'
import { addStickersFrom } from './add.ts'
import { listStickers } from './store.ts'

export function registerStickerTools() {
  registry.register({
    name: 'add_sticker',
    source: 'builtin',
    description:
      '添加并保存表情包到机器人的表情库。当用户要求添加、保存、收藏表情包或图片时调用（支持本消息附带的图片/表情，或回复/引用的图片消息）。' +
      '用户如果指定了名称或使用场景可填入 name/desc，未指定则留空，系统会自动进行视觉识别命名。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '可选，表情包名称/关键词（如“开心猫猫”、“流泪黄豆”）。若用户未指定则留空。',
        },
        desc: {
          type: 'string',
          description: '可选，表情包含义或使用场景说明。',
        },
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
      const hint = args.name ? { name: String(args.name).trim(), desc: args.desc ? String(args.desc).trim() : undefined } : undefined
      const res = await addStickersFrom(ctx.e, hint, { reply: false })
      if (!res.total) {
        return {
          content: '未在当前消息或引用的消息中找到任何图片或表情。请提示用户：需要附带图片，或引用/回复一张图片消息再进行保存。',
          isError: true,
        }
      }
      return `表情包已处理完成：\n${res.lines.join('\n')}\n请在最终回复中简短口语化地告知用户已保存成功（可以提及保存的表情名称）。`
    },
  })

  registry.register({
    name: 'list_stickers',
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
