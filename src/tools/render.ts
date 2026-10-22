import { log } from '../core/log.ts'
import { renderHtml, wrapHtml } from '../render/browser.ts'
import { renderInSandbox, sandboxEnabled, turnSession } from './exec.ts'
import { MAX_IMAGES_PER_TURN, registry } from './registry.ts'

const MAX_HTML = 200_000

export function registerRenderTool() {
  registry.register({
    name: 'render_html',
    source: 'builtin',
    description:
      '把一段 HTML 渲染成图片，随回复一起发送。适合文字排版表达不清的内容：多列大表、多维对比、攻略卡片、时间线、特别长的整理等；普通的长回答直接用文字。' +
      '只写 <body> 里的内容即可（已带好中文字体和基础样式，也可以自带 <style>）；不能用 JavaScript；图片可以用公网 https 链接、data: URI，或本次回复里 run_code 保存的文件（相对路径，如 img/logo.png、out/chart.png）。' +
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
    limit: () => `最多 ${MAX_IMAGES_PER_TURN} 张图片，与 run_code 生成的图片合计`,
    async run(args, ctx) {
      const html = String(args.html ?? '')
      if (!html.trim()) return { content: '缺少 html', isError: true }
      if (html.length > MAX_HTML) return { content: `HTML 太长（${html.length} 字符），请精简到 ${MAX_HTML} 以内`, isError: true }
      if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) return { content: `每次回复最多渲染 ${MAX_IMAGES_PER_TURN} 张图片`, isError: true }
      const cfg = ctx.eff.tools.renderHtml
      const opts = { width: Number(args.width) || cfg.width, maxHeight: cfg.maxHeight, allowNetwork: cfg.allowNetwork }
      let png: Buffer | undefined
      // with run_code on, render in the same sandbox so the page can use files the code downloaded or generated
      if (sandboxEnabled(ctx)) {
        try {
          png = await renderInSandbox(wrapHtml(html), ctx.eff.tools.exec, { ...opts, session: turnSession(ctx), signal: ctx.signal })
        } catch (err: any) {
          log.warn(`沙盒渲染失败，改用机器人自带的浏览器（本地文件引用会失效）: ${err?.message ?? err}`)
        }
      }
      png ??= await renderHtml(html, opts)
      ctx.turn.images.push(png)
      return `已渲染为图片（${Math.round(png.length / 1024)}KB），会在你的文字回复之后发送。文字部分简短概括即可。`
    },
  })
}
