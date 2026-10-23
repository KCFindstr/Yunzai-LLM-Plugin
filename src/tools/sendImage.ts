import http from 'node:http'
import https from 'node:https'
import { detectImageMime } from '../core/util.ts'
import { decodeRasterImage } from '../render/browser.ts'
import { resolvePublicUrl } from './ssrf.ts'
import { MAX_IMAGES_PER_TURN, registry } from './registry.ts'

export const MAX_SENT_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_REQUESTS = 2
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Validate every redirect, pin DNS to the checked addresses, and bound the decoded response bytes. */
export async function downloadPublicImage(raw: string, signal: AbortSignal, resolve = resolvePublicUrl): Promise<Buffer> {
  let target = raw
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(target)
    if (parsed.username || parsed.password) throw new Error('图片 URL 不能包含登录凭证')
    const { url, addresses } = await resolve(target)
    signal.throwIfAborted()
    const result = await new Promise<{ redirect?: string; buffer?: Buffer }>((accept, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        signal,
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'user-agent': 'Yunzai-LLM/2.0' },
        lookup: ((_host, options, callback: any) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)) as any,
      }, response => {
        response.on('error', reject)
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.destroy()
          accept({ redirect: new URL(response.headers.location, url).href }); return
        }
        if (response.statusCode !== 200) { response.destroy(); reject(new Error(`图片服务器 HTTP ${response.statusCode}`)); return }
        if (Number(response.headers['content-length']) > MAX_SENT_IMAGE_BYTES) { response.destroy(); reject(new Error('图片超过 5 MiB 上限')); return }
        const encoding = response.headers['content-encoding']
        if (encoding && encoding !== 'identity') { response.destroy(); reject(new Error('图片服务器返回不支持的压缩传输')); return }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_SENT_IMAGE_BYTES) { response.destroy(); reject(new Error('图片超过 5 MiB 上限')); return }
          chunks.push(chunk)
        })
        response.on('end', () => accept({ buffer: Buffer.concat(chunks) }))
      })
      request.on('error', reject)
    })
    if (result.buffer) return result.buffer
    target = result.redirect!
  }
  throw new Error('图片重定向次数过多')
}

export function registerSendImageTool(download = downloadPublicImage) {
  registry.register({
    name: 'send_image', source: 'builtin',
    description: '将公网直链图片加入最终回复，发送原图而非网址。支持 PNG/JPEG/GIF/WebP；会下载并验证真实图片，拒绝网页、损坏图片及内网地址。仅在确实要给用户看图时调用；成功后图片随最终文字回复发送，不要声称已经送达。',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '公开服务器上图片的完整 http(s) 直链，不是网页链接' } }, required: ['url'], additionalProperties: false },
    available: ctx => ctx.eff.tools.webFetch.enable,
    limit: () => `最多请求 ${MAX_REQUESTS} 次，与 render_html/run_code 共用 ${MAX_IMAGES_PER_TURN} 张回复图片额度`,
    remaining: ctx => `剩余 ${Math.max(0, Math.min(MAX_REQUESTS - (ctx.turn.imageRequests ?? 0), MAX_IMAGES_PER_TURN - ctx.turn.images.length))} 次；共享图片余量 ${Math.max(0, MAX_IMAGES_PER_TURN - ctx.turn.images.length)} 张`,
    async run(args, ctx) {
      if ((ctx.turn.imageRequests ?? 0) >= MAX_REQUESTS) return { content: '本轮图片请求次数已用完', isError: true }
      if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) return { content: '本轮回复图片额度已用完', isError: true }
      if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url.trim())) return { content: '需要完整的 http(s) 图片 URL', isError: true }
      ctx.turn.imageRequests = (ctx.turn.imageRequests ?? 0) + 1
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(ctx.signal ? [ctx.signal] : [])])
        const buffer = await download(args.url.trim(), signal)
        if (buffer.length > MAX_SENT_IMAGE_BYTES) throw new Error('图片超过 5 MiB 上限')
        const mime = detectImageMime(buffer)
        if (!mime || !TYPES.has(mime)) throw new Error('链接内容不是支持的 PNG/JPEG/GIF/WebP 图片')
        const size = await decodeRasterImage(buffer, mime, signal)
        signal.throwIfAborted()
        // Other parallel tools may have used the shared image allowance while downloading.
        if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) throw new Error('本轮回复图片额度已用完')
        ctx.turn.images.push(buffer)
        return { content: `图片验证通过（${size.width}×${size.height}，${mime}），已加入最终回复，稍后与文字一起发送。`, images: [{ type: 'image', data: buffer.toString('base64'), mime }] }
      } catch (error: any) { return { content: `未加入图片：${error.message}`, isError: true } }
    },
  })
}
