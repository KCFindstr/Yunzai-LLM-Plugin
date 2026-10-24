import { readLocalImage } from './imageFiles.ts'
import http from 'node:http'
import https from 'node:https'
import { detectImageMime } from '../core/util.ts'
import { decodeRasterImage } from '../render/browser.ts'
import { resolvePublicUrl } from './ssrf.ts'
import { MAX_IMAGES_PER_TURN, helperToolLimit, registry } from './registry.ts'

export const MAX_SENT_IMAGE_BYTES = 5 * 1024 * 1024
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
    name: 'send_image', budgetExempt: true, source: 'builtin',
    description: '将已保存 path 或公网直链 url 图片加入最终回复，发送原图而非网址。支持 PNG/JPEG/GIF/WebP；会下载并验证真实图片，拒绝网页、损坏图片及内网地址。仅在确实要给用户看图时调用；成功后图片随最终文字回复发送，不要声称已经送达。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '图片路径（本对话图片标注中的 /work/attachments 路径，或本次回复代码工作目录中的文件）；与 url 二选一' }, url: { type: 'string', description: '公开服务器上图片的完整 http(s) 直链，不是网页链接；与 path 二选一' } }, additionalProperties: false },
    limit: ctx => `最多请求 ${helperToolLimit(ctx, 'send_image')} 次，最多附加 ${MAX_IMAGES_PER_TURN} 张回复图片`,
    remaining: ctx => `共享图片余量 ${Math.max(0, MAX_IMAGES_PER_TURN - ctx.turn.images.length)} 张`,
    async run(args, ctx) {
      if ((ctx.turn.imageRequests ?? 0) >= helperToolLimit(ctx, 'send_image')) return { content: '本轮图片请求次数已用完', isError: true }
      if (ctx.turn.images.length >= MAX_IMAGES_PER_TURN) return { content: '本轮回复图片额度已用完', isError: true }
      if ((args.path !== undefined && args.url !== undefined) || (args.path === undefined && (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url.trim())))) return { content: '请提供图片 path 或完整的 http(s) 图片 url，且只能提供其中一个', isError: true }
      ctx.turn.imageRequests = (ctx.turn.imageRequests ?? 0) + 1
      try {
        if (args.url !== undefined && !ctx.eff.tools.webFetch.enable) throw new Error('公网图片下载未启用；可使用已保存的图片 path')
        const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(ctx.signal ? [ctx.signal] : [])])
        const buffer = args.path !== undefined ? Buffer.from((await readLocalImage(args.path, ctx)).part.data!, 'base64') : await download(args.url.trim(), signal)
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
