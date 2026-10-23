import { log } from '../core/log.ts'
import { getYunzaiRenderer } from '../core/yunzai.ts'
import { assertPublicUrl } from '../tools/ssrf.ts'
import { imageSize } from 'image-size'

let ownBrowser: Promise<any> | undefined

/** Prefer the bot's own Chromium (Yunzai puppeteer renderer); launch a private one only outside Yunzai. */
async function getBrowser(): Promise<any> {
  try {
    const r = await getYunzaiRenderer()
    if (typeof r?.browserInit === 'function') {
      const b = await r.browserInit()
      if (b) return b
    }
  } catch (err: any) {
    log.debug(`Yunzai 渲染器不可用，改用独立浏览器: ${err?.message ?? err}`)
  }
  ownBrowser ??= (async () => {
    const puppeteer = (await import('puppeteer')).default
    return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox'] })
  })().catch(err => {
    ownBrowser = undefined
    throw err
  })
  return ownBrowser
}

export async function closeOwnBrowser() {
  const b = await ownBrowser?.catch(() => undefined)
  ownBrowser = undefined
  await b?.close?.().catch(() => {})
}

/** Validate both raster headers and a real browser decode; keep the original bytes for delivery. */
export async function decodeRasterImage(buffer: Buffer, mime: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const size = imageSize(buffer)
  if (!size.width || !size.height || size.width > 16384 || size.height > 16384 || size.width * size.height > 40_000_000) throw new Error('图片尺寸超出上限')
  signal?.throwIfAborted()
  const browser = await getBrowser()
  const page = await browser.newPage()
  const abort = () => { void page.close().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    await page.setRequestInterception(true)
    page.on('request', (request: any) => request.url().startsWith('data:') || request.url() === 'about:blank' ? request.continue().catch(() => {}) : request.abort().catch(() => {}))
    const decoded = await page.evaluate(async (src: string) => {
      const image = new Image()
      image.src = src
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    }, `data:${mime};base64,${buffer.toString('base64')}`)
    if (!decoded.width || !decoded.height) throw new Error('图片无法解码')
    return decoded
  } finally { signal?.removeEventListener('abort', abort); await page.close().catch(() => {}) }
}

export interface RenderOptions {
  width?: number
  maxHeight?: number
  scale?: number
  /** allow http(s) requests to public hosts (images, fonts, css); private/LAN addresses are always blocked */
  allowNetwork?: boolean
  transparent?: boolean
  timeoutMs?: number
  fit?: boolean
}

const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{padding:28px 30px;background:#fbfaf7;color:#1f2328;font:16px/1.7 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif;word-break:break-word}
h1,h2,h3{line-height:1.35;margin:.2em 0 .5em}
h1{font-size:24px}h2{font-size:20px}h3{font-size:17px}
p{margin:.5em 0}
ul,ol{padding-left:1.4em;margin:.4em 0}
table{border-collapse:collapse;width:100%;margin:.6em 0;font-size:14px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f0eee8}
code{font-family:"Cascadia Code",Consolas,monospace;background:#efede7;padding:1px 5px;border-radius:4px;font-size:.92em}
pre{background:#272822;color:#f8f8f2;padding:12px 14px;border-radius:8px;overflow:hidden;white-space:pre-wrap;font-size:13px}
pre code{background:none;padding:0;color:inherit}
blockquote{margin:.6em 0;padding:.2em 1em;border-left:4px solid #d0c8b8;color:#555}
img{max-width:100%}
`

/** Wrap a fragment in a full document with a no-script CSP and readable default styles. */
export function wrapHtml(html: string, opts: { transparent?: boolean } = {}): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'">`
  const bg = opts.transparent ? '<style>html,body{background:transparent!important}</style>' : ''
  if (/<html[\s>]/i.test(html)) {
    // full document: still force the CSP in (into <head>, or right after <html> when there is none)
    return /<head[\s>]/i.test(html) ? html.replace(/<head[^>]*>/i, m => `${m}${csp}`) : html.replace(/<html[^>]*>/i, m => `${m}<head>${csp}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${BASE_CSS}</style>${bg}</head><body>${html}</body></html>`
}

/**
 * Render HTML to a PNG. Scripts are disabled (JS off + CSP); network requests are limited to public http(s)
 * hosts (or blocked entirely), so the page can't probe the LAN. Height is capped.
 */
export async function renderHtml(html: string, opts: RenderOptions = {}): Promise<Buffer> {
  return (await renderDocument(html, opts, false))[0]
}

export async function renderHtmlPages(html: string, opts: RenderOptions = {}): Promise<Buffer[]> {
  return renderDocument(html, opts, true)
}

async function renderDocument(html: string, opts: RenderOptions, paginate: boolean): Promise<Buffer[]> {
  const width = Math.min(Math.max(opts.width ?? 720, 200), 1600)
  const maxHeight = Math.min(Math.max(opts.maxHeight ?? 6000, 100), 16000)
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setJavaScriptEnabled(false)
    await page.setViewport({ width, height: 400, deviceScaleFactor: opts.scale ?? 2 })
    await page.setRequestInterception(true)
    page.on('request', async (req: any) => {
      const url: string = req.url()
      if (url.startsWith('data:') || url === 'about:blank') return req.continue().catch(() => {})
      if (!opts.allowNetwork || !/^https?:/i.test(url)) return req.abort().catch(() => {})
      try {
        await assertPublicUrl(url)
        await req.continue()
      } catch {
        await req.abort().catch(() => {})
      }
    })
    await page.setContent(wrapHtml(html, { transparent: opts.transparent }), { waitUntil: 'load', timeout: opts.timeoutMs ?? 15000 })
    const cdp = await page.createCDPSession()
    let metrics = await cdp.send('Page.getLayoutMetrics')
    let size = metrics.cssContentSize ?? metrics.contentSize
    if (opts.fit) size.height = Math.max(1, await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)))
    let zoom = 1
    for (let attempt = 0; opts.fit && size?.height > maxHeight && attempt < 5; attempt++) {
      zoom *= maxHeight / size.height * 0.95
      await page.addStyleTag({ content: `body{zoom:${zoom}!important}` })
      metrics = await cdp.send('Page.getLayoutMetrics')
      size = metrics.cssContentSize ?? metrics.contentSize
      size.height = Math.max(1, await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height)))
    }
    if (opts.fit && size?.height > maxHeight) throw new Error('内容过多，无法完整排入一张图片')
    const totalHeight = Math.ceil(size?.height ?? 400)
    const height = Math.min(totalHeight, maxHeight)
    const shotWidth = Math.min(Math.ceil(size?.width ?? width), width)
    const pages = paginate ? Math.ceil(totalHeight / maxHeight) : 1
    if (pages > 12) throw new Error('内容超过12页，请分批排版')
    const images: Buffer[] = []
    for (let index = 0; index < pages; index++) {
      images.push(Buffer.from(await page.screenshot({
        type: 'png', omitBackground: Boolean(opts.transparent),
        clip: { x: 0, y: index * maxHeight, width: shotWidth, height: paginate ? Math.min(maxHeight, totalHeight - index * maxHeight) : height },
        captureBeyondViewport: true,
      })))
    }
    return images
  } finally {
    await page.close().catch(() => {})
  }
}

/** Scale an image down so its longer side is at most `max` px (transparent PNG). */
export async function downscaleImage(buf: Buffer, mime: string, max: number): Promise<Buffer> {
  const src = `data:${mime};base64,${buf.toString('base64')}`
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}img{display:block;max-width:${max}px;max-height:${max}px}</style></head><body><img src="${src}"></body></html>`
  return renderHtml(html, { width: max, maxHeight: max, scale: 1, transparent: true })
}
