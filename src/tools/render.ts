import { scopeForImages } from './images.ts'
import { renderHtmlPages } from '../render/browser.ts'
import { readLocalImage } from './imageFiles.ts'
import type { ToolCtx } from './registry.ts'
import { registry } from './registry.ts'
import { saveImage, imageLabel } from '../chat/images.ts'

const MAX_HTML = 200_000

// Shown where a referenced local image cannot be read: the page still renders, with a visible gap.
const BROKEN_IMAGE = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 5h18v14H3z"/><path d="M3 15l5-5 4 4"/><path d="M14 12l2-2 5 5"/><path d="M13 5l-2 4 3 2-2 4 2 4"/></svg>',
).toString('base64')

/**
 * Inline local image references so the bot's own browser can render them without file access. Each reference goes
 * through readLocalImage (this chat's image store, AGY output or this reply's workspace); unreadable ones become a
 * broken-image icon instead of failing the whole render.
 */
export async function inlineLocalImages(html: string, ctx: ToolCtx): Promise<{ html: string; broken: string[] }> {
  const cache = new Map<string, string>()
  const broken: string[] = []
  const local = (value: string) => !/^(?:https?:|data:|#|\/\/)/i.test(value)
  const resource = /(?:\b(?:src|poster|background)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))|url\(\s*(?:(["'])(.*?)\4|([^\s)]+))\s*\))/gi
  for (const match of html.matchAll(resource)) {
    const file = match[2] ?? match[3] ?? match[5] ?? match[6]
    if (!file || !local(file) || cache.has(file)) continue
    try {
      const { part } = await readLocalImage(file, ctx)
      cache.set(file, 'data:' + part.mime + ';base64,' + part.data)
    } catch {
      cache.set(file, BROKEN_IMAGE)
      broken.push(file)
    }
  }
  return {
    broken,
    html: html.replace(resource, (match, _q, quoted, bare, _cssq, cssquoted, cssbare) => {
      const data = cache.get(quoted ?? bare ?? cssquoted ?? cssbare)
      if (!data) return match
      return /^url\(/i.test(match) ? 'url("' + data + '")' : match.slice(0, match.indexOf('=') + 1) + '"' + data + '"'
    }),
  }
}

export function registerRenderTool() {
  registry.register({
    name: 'render_html',
    source: 'builtin',
    description:
      '把图片明显更好读的内容用 HTML 排版成图片并返回保存路径：表格、多维对比、复杂结构或需要版式的内容。对方可能要复制的内容（代码、命令、配置、链接、原文）和普通长文直接发文字，不要用它。' +
      '只写 <body> 里的内容即可（已带好中文字体和基础样式，也可以自带 <style>）；不能用 JavaScript；图片可以用公网 https 链接、data: URI，或本地图片（当前对话 /work/attachments/…、AGY 输出 /work/agy/<会话>/out/… 或本次回复代码目录中的文件）。' +
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
      const cfg = ctx.eff.tools.renderHtml
      const opts = { width: Number(args.width) || cfg.width, maxHeight: cfg.maxHeight, allowNetwork: cfg.allowNetwork }
      const page = await inlineLocalImages(html, ctx)
      const images = await renderHtmlPages(page.html, opts)
      const saved = images.map(buffer => saveImage(scopeForImages(ctx), { type: 'image', data: buffer.toString('base64') }))
      ;(ctx.turn.imageRefs ??= []).push(...saved)
      const missing = page.broken.length ? `\n以下图片无法读取，已显示为损坏图标：${page.broken.join('、')}` : ''
      return `已渲染为${images.length}张图片：\n` + saved.map(imageLabel).join('\n') + missing
    },
  })
}
