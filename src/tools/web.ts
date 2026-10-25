import { detectImageMime, truncate } from '../core/util.ts'
import { registry, type ToolCtx, type ToolOutput } from './registry.ts'
import { assertPublicUrl } from './ssrf.ts'
import { resolveKeys, deepseekToolKey } from '../core/config.ts'
import { searchReady } from '../core/setup.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

interface SearchHit {
  title: string
  url: string
  snippet: string
}

async function deepseekTool(operation: 'search' | 'fetch', body: Record<string, unknown>, ctx: ToolCtx): Promise<any> {
  const key = deepseekToolKey(ctx.eff.tools.webSearch.provider === 'deepseek' ? ctx.eff.tools.webSearch.apiKey : undefined)
  if (!key) throw new Error('未配置 DeepSeek API Key')
  const res = await fetch(`https://api.deepseek.com/v1/tools/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((operation === 'search' ? 20 : ctx.eff.tools.webFetch.timeout || 15) * 1000),
  })
  if (!res.ok) throw new Error(`DeepSeek ${operation} HTTP ${res.status}`)
  const data = await res.json()
  if (operation === 'search' ? !Array.isArray(data?.results) : typeof data?.content !== 'string') {
    throw new Error(`DeepSeek ${operation}: invalid response`)
  }
  return data
}

async function searchExternal(query: string, ctx: ToolCtx): Promise<SearchHit[]> {
  const ws = { ...ctx.eff.tools.webSearch, apiKey: resolveKeys(ctx.eff.tools.webSearch.apiKey)[0] ?? '' }
  const n = Math.min(Math.max(ws.maxResults || 5, 1), 10)
  const timeout = AbortSignal.timeout(20000)
  switch (ws.provider) {
    case 'deepseek': {
      if ([...query].length > 128) throw new Error('DeepSeek 搜索 query 最多 128 个字符')
      const data = await deepseekTool('search', { query, count: n, need_content: false }, ctx)
      return data.results.slice(0, n).map((r: any) => ({ title: r.title, url: r.url, snippet: r.summary || r.snippet }))
    }
    case 'anysearch': {
      // https://github.com/anysearch-ai/anysearch-skill — key optional (anonymous = lower rate limit)
      const res = await fetch('https://api.anysearch.com/v1/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ws.apiKey ? { authorization: `Bearer ${ws.apiKey}` } : {}) },
        body: JSON.stringify({ query, max_results: n }),
        signal: timeout,
      })
      const j: any = await res.json().catch(() => null)
      if (!res.ok || !j || (j.code !== undefined && j.code !== 0)) throw new Error(`AnySearch ${j?.message || `HTTP ${res.status}`}`)
      return (j.data?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content || r.snippet }))
    }
    case 'tavily': {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.apiKey}` },
        body: JSON.stringify({ query, max_results: n, search_depth: 'basic' }),
        signal: timeout,
      })
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
      const j: any = await res.json()
      return (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }))
    }
    case 'brave': {
      const u = new URL('https://api.search.brave.com/res/v1/web/search')
      u.searchParams.set('q', query)
      u.searchParams.set('count', String(n))
      const res = await fetch(u, { headers: { 'x-subscription-token': ws.apiKey, accept: 'application/json' }, signal: timeout })
      if (!res.ok) throw new Error(`Brave HTTP ${res.status}`)
      const j: any = await res.json()
      return (j.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description }))
    }
    case 'searxng': {
      if (!ws.baseUrl) throw new Error('未配置 SearXNG 地址')
      const u = new URL('search', ws.baseUrl.endsWith('/') ? ws.baseUrl : `${ws.baseUrl}/`)
      u.searchParams.set('q', query)
      u.searchParams.set('format', 'json')
      u.searchParams.set('language', 'zh-CN')
      const res = await fetch(u, { signal: timeout })
      if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`)
      const j: any = await res.json()
      return (j.results ?? []).slice(0, n).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }))
    }
    case 'jina': {
      const u = new URL('https://s.jina.ai/')
      u.searchParams.set('q', query)
      const res = await fetch(u, {
        headers: {
          accept: 'application/json',
          'x-respond-with': 'no-content',
          ...(ws.apiKey ? { authorization: `Bearer ${ws.apiKey}` } : {}),
        },
        signal: timeout,
      })
      if (!res.ok) throw new Error(`Jina HTTP ${res.status}`)
      const j: any = await res.json()
      return (j.data ?? []).slice(0, n).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description || r.content }))
    }
    default:
      throw new Error('未配置搜索服务')
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[g.toLowerCase()] ?? m
  })
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '')
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '')
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2]
  if (main && main.length > 500) body = main
  else body = body.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, '')
  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim()
  return { title, text }
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head.subarray(0, 4096).toString('latin1'))?.[1]
  return (fromMeta || 'utf-8').toLowerCase()
}

/** The request never got a response (DNS, connection, TLS, timeout), as opposed to a refused or invalid URL. */
class TransportError extends Error {}

async function fetchPublic(raw: string, ctx: ToolCtx): Promise<Response> {
  const allowPrivate = ctx.eff.tools.webFetch.allowPrivateNetwork
  let url = raw
  for (let hop = 0; hop < 5; hop++) {
    if (!allowPrivate) await assertPublicUrl(url)
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout((ctx.eff.tools.webFetch.timeout || 15) * 1000),
    }).catch((err: any) => {
      const cause = err?.cause
      const detail = [cause?.code, cause?.message].filter(Boolean).join(': ')
      throw new TransportError(detail ? `${err.message} (${detail})` : String(err?.message ?? err), { cause: err })
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).href
      continue
    }
    return res
  }
  throw new Error('重定向次数过多')
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res.body as any) {
    size += c.length
    chunks.push(Buffer.from(c))
    if (size > maxBytes) break
  }
  return Buffer.concat(chunks)
}

/** Image types every provider accepts; larger files are refused rather than sent (Anthropic caps images near 5MB). */
const VIEWABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 3_700_000

/** An image response as an image part for vision models, checked by its bytes rather than the server's content-type. */
async function fetchImage(res: Response, contentType: string): Promise<ToolOutput | string> {
  const buf = await readCapped(res, MAX_IMAGE_BYTES)
  if (buf.length > MAX_IMAGE_BYTES) return `该图片超过 ${MAX_IMAGE_BYTES / 1_000_000}MB，无法查看`
  const mime = detectImageMime(buf)
  if (!mime || !VIEWABLE_IMAGES.has(mime)) return `该链接是 ${contentType} 类型的文件，不是可查看的 png/jpg/gif/webp 图片`
  return {
    content: `已打开图片（${mime}，${Math.ceil(buf.length / 1024)}KB），图片本身随本结果附上，请直接查看。`,
    images: [{ type: 'image', data: buf.toString('base64'), mime, detail: 'auto' }],
  }
}

/**
 * Fetch a link directly (same redirect and private-address checks as direct mode) and return it if it is an image.
 * Anything else, or a transport failure the reader may get past, returns undefined so the reader handles the link.
 */
async function probeImage(url: string, ctx: ToolCtx): Promise<ToolOutput | string | undefined> {
  let res: Response
  try {
    res = await fetchPublic(url, ctx)
  } catch (err) {
    if (err instanceof TransportError) return undefined
    throw err
  }
  const ct = res.headers.get('content-type') ?? ''
  if (res.ok && /image|octet-stream/i.test(ct)) return fetchImage(res, ct)
  await res.body?.cancel().catch(() => {})
  return undefined
}

export async function fetchPage(url: string, ctx: ToolCtx): Promise<ToolOutput | string> {
  const wf = { ...ctx.eff.tools.webFetch, jinaKey: resolveKeys(ctx.eff.tools.webFetch.jinaKey)[0] ?? '' }
  const max = wf.maxChars || 6000
  const vision = ctx.model.vision !== false
  // Readers turn images into text, and only the response says whether a link is an image (extensionless and
  // redirected download links are common): for vision models, try the link directly first.
  if (wf.reader !== 'direct' && vision) {
    const image = await probeImage(url, ctx)
    if (image) return image
  }
  if (wf.reader === 'deepseek') {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || url.length > 8192) {
      throw new Error('DeepSeek Fetch 需要不含用户名和密码的 http(s) 链接（最多 8192 字符）')
    }
    if (!wf.allowPrivateNetwork) await assertPublicUrl(url)
    const page = await deepseekTool('fetch', { url }, ctx)
    return truncate(`${page.title ? `标题: ${page.title}\n\n` : ''}${page.content}`, max)
  }
  if (wf.reader === 'jina') {
    if (!wf.allowPrivateNetwork) await assertPublicUrl(url)
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { accept: 'text/plain', ...(wf.jinaKey ? { authorization: `Bearer ${wf.jinaKey}` } : {}) },
      signal: AbortSignal.timeout((wf.timeout || 15) * 1000 + 10000),
    })
    if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`)
    return truncate(await res.text(), max)
  }
  const res = await fetchPublic(url, ctx)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ct = res.headers.get('content-type') ?? ''
  // octet-stream too: some hosts serve images without a proper type.
  if (vision && /image|octet-stream/i.test(ct)) return fetchImage(res, ct)
  if (/image|video|audio|octet-stream|pdf|zip/i.test(ct)) return `该链接是 ${ct} 类型的文件，无法读取文本内容`
  const buf = await readCapped(res, 3 * 1024 * 1024)
  let text: string
  try {
    text = new TextDecoder(charsetOf(ct, buf)).decode(buf)
  } catch {
    text = buf.toString('utf8')
  }
  if (/html|xml/i.test(ct) || /^\s*</.test(text)) {
    const page = htmlToText(text)
    return truncate(`${page.title ? `标题: ${page.title}\n\n` : ''}${page.text}`, max)
  }
  return truncate(text, max)
}

export function registerWebTools() {
  registry.register({
    name: 'web_search',
    source: 'builtin',
    description:
      '搜索互联网获取实时信息（新闻、游戏版本/活动/卡池、攻略、百科等）。当问题涉及近期事件或你不确定的事实时使用。返回标题、链接和摘要；需要细节时再用 web_fetch 打开链接。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词，简洁明确' } },
      required: ['query'],
    },
    available: ctx => {
      const ws = ctx.eff.tools.webSearch
      return ws.provider !== 'native' && searchReady(ctx.eff, ctx.model)
    },
    limit: ctx => `最多调用 ${ctx.eff.tools.webSearch.maxPerTurn ?? 3} 次`,
    remaining: ctx => `剩余 ${Math.max(0, (ctx.eff.tools.webSearch.maxPerTurn ?? 3) - ctx.turn.searches)} 次`,
    async run(args, ctx) {
      const q = String(args.query ?? '').trim()
      if (!q) return { content: '缺少 query 参数，请提供搜索关键词', isError: true }
      const maxSearches = ctx.eff.tools.webSearch.maxPerTurn ?? 3
      if (ctx.turn.searches >= maxSearches) return { content: `本轮搜索次数已达上限（最多 ${maxSearches} 次），请根据已有信息回答`, isError: true }
      ctx.turn.searches++
      const hits = await searchExternal(q, ctx)
      if (!hits.length) return '没有搜索到结果'
      return hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${truncate((h.snippet ?? '').replace(/\s+/g, ' '), 300)}`).join('\n\n')
    },
  })

  registry.register({
    name: 'web_fetch',
    source: 'builtin',
    description: '打开一个网页链接并读取正文文本（自动截断）。用于查看用户发来的链接或搜索结果里的页面详情。若链接是图片（png/jpg/gif/webp）且你能看图，会把图片本身交给你查看。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整的 http(s) 链接' } },
      required: ['url'],
    },
    available: ctx => ctx.eff.tools.webFetch.enable,
    limit: ctx => `最多调用 ${ctx.eff.tools.webFetch.maxPerTurn ?? 3} 次`,
    remaining: ctx => `剩余 ${Math.max(0, (ctx.eff.tools.webFetch.maxPerTurn ?? 3) - ctx.turn.fetches)} 次`,
    async run(args, ctx) {
      const url = String(args.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { content: '请提供完整的 http(s) 链接', isError: true }
      const maxFetches = ctx.eff.tools.webFetch.maxPerTurn ?? 3
      if (ctx.turn.fetches >= maxFetches) return { content: `本轮打开网页次数已达上限（最多 ${maxFetches} 次）`, isError: true }
      ctx.turn.fetches++
      try {
        return await fetchPage(url, ctx)
      } catch (err: any) {
        return { content: `打开网页失败：${err?.message ?? err}`, isError: true }
      }
    },
  })
}
