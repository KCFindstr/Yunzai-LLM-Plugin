import { renderHtml } from '../render/browser.ts'
import { registry } from './registry.ts'

const MAX_HTML = 200_000
const MAX_IMAGES_PER_TURN = 2

export function registerRenderTool() {
  registry.register({
    name: 'render_html',
    source: 'builtin',
    description:
      '把一段 HTML 渲染成图片，随回复一起发送。适合文字排版表达不清的内容：多列大表、多维对比、攻略卡片、时间线、特别长的整理等；普通的长回答直接用文字。' +
      '只写 <body> 里的内容即可（已带好中文字体和基础样式，也可以自带 <style>）；不能用 JavaScript；图片只能用公网 https 链接或 data: URI。' +
      '调用后在文字回复里只说一两句概括，不要把图片里的内容再重复一遍。普通闲聊不要用。',
    parameters: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'HTML 内容（片段或完整文档）' },
        width: { type: 'integer', description: '可选，页面宽度像素，默认 720；表格较宽时可用 900~1100' },
      },
      required: ['html'],
    },
    available: ctx => ctx.eff.tools.renderHtml.enable,
    async run(args, ctx) {
      const html = String(args.html ?? '')
      if (!html.trim()) return { content: '缺少 html', isError: true }
      if (html.length > MAX_HTML) return { content: `HTML 太长（${html.length} 字符），请精简到 ${MAX_HTML} 以内`, isError: true }
      if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) return { content: `每次回复最多渲染 ${MAX_IMAGES_PER_TURN} 张图片`, isError: true }
      const cfg = ctx.eff.tools.renderHtml
      const png = await renderHtml(html, {
        width: Number(args.width) || cfg.width,
        maxHeight: cfg.maxHeight,
        allowNetwork: cfg.allowNetwork,
      })
      ctx.turn.images.push(png)
      return `已渲染为图片（${Math.round(png.length / 1024)}KB），会在你的文字回复之后发送。文字部分简短概括即可。`
    },
  })
}
