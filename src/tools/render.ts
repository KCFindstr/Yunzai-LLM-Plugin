import { log } from '../core/log.ts'
import { renderHtmlPages, wrapHtml } from '../render/browser.ts'
import { renderInSandbox, sandboxEnabled, turnSession } from './exec.ts'
import { MAX_IMAGES_PER_TURN, registry } from './registry.ts'

const MAX_HTML = 200_000

export function registerRenderTool() {
  registry.register({
    name: 'render_html',
    source: 'builtin',
    description:
      '把图片明显更好读的内容用 HTML 排版成图片发送：表格、多维对比、复杂结构或需要版式的内容。对方可能要复制的内容（代码、命令、配置、链接、原文）和普通长文直接发文字，不要用它。' +
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
    limit: () => `最多 ${MAX_IMAGES_PER_TURN} 张图片，与 run_code/send_image 共用`,
    remaining: ctx => `最多剩余 ${Math.max(0, MAX_IMAGES_PER_TURN - ctx.turn.images.length)} 次（共享图片余量，每次至少一张）`,
    async run(args, ctx) {
      const html = String(args.html ?? '')
      if (!html.trim()) return { content: '缺少 html', isError: true }
      if (html.length > MAX_HTML) return { content: `HTML 太长（${html.length} 字符），请精简到 ${MAX_HTML} 以内`, isError: true }
      if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) return { content: `每次回复最多渲染 ${MAX_IMAGES_PER_TURN} 张图片`, isError: true }
      const cfg = ctx.eff.tools.renderHtml
      const opts = { width: Number(args.width) || cfg.width, maxHeight: cfg.maxHeight, allowNetwork: cfg.allowNetwork }
      let png: Buffer | undefined
      // with run_code on, render in the same sandbox so the page can use files the code downloaded or generated
      const localFiles = /(?:src\s*=\s*["']|url\(\s*["']?)(?!https?:|data:|#)[^"'\s)]+/i.test(html)
      if (sandboxEnabled(ctx) && localFiles) {
        try {
          png = await renderInSandbox(wrapHtml(html), ctx.eff.tools.exec, { ...opts, session: turnSession(ctx), signal: ctx.signal })
        } catch (err: any) {
          log.warn(`沙盒渲染失败，改用机器人自带的浏览器（本地文件引用会失效）: ${err?.message ?? err}`)
        }
      }
      if (png && png.readUInt32BE(20) >= opts.maxHeight * 2) return { content: '包含本地文件的页面超出单页高度，请拆分 HTML 后重试，不能裁掉后文。', isError: true }
      const images = png ? [png] : await renderHtmlPages(html, opts)
      ctx.turn.images.push(...images)
      return `已渲染为${images.length}张图片（${Math.round(images.reduce((size, image) => size + image.length, 0) / 1024)}KB），会在你的文字回复之后发送。文字部分简短概括即可。`
    },
  })
}
