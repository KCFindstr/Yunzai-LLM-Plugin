import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { DATA_DIR, PLUGIN_DIR } from '../core/paths.ts'
import { routes, type Reply } from './api.ts'

/**
 * Built-in management UI: a JSON API under /api plus the static single-page app in <plugin>/web.
 * Login is one shared password (config `web.password`, or generated once into data/web-auth.json);
 * sessions are an HttpOnly SameSite=Strict cookie. State-changing requests also need the
 * X-Requested-With header, which a cross-site form or image can't send.
 */

const WEB_DIR = path.join(PLUGIN_DIR, 'web')
const AUTH_FILE = path.join(DATA_DIR, 'web-auth.json')
const COOKIE = 'yzllm_session'
const SESSION_MS = 7 * 86400_000
const MAX_BODY = 4 * 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
}

let server: http.Server | undefined
let bound = ''
/** token -> { expiry, password fingerprint at login } */
const sessions = new Map<string, { until: number; pw: string }>()
const failures = new Map<string, { n: number; until: number }>()

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** The configured password, or a generated one persisted in data/web-auth.json. */
export function webPassword(): { password: string; generated: boolean } {
  const configured = config.get().web.password
  if (configured) return { password: configured, generated: false }
  try {
    const saved = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    if (typeof saved?.password === 'string' && saved.password) return { password: saved.password, generated: true }
  } catch {}
  const password = crypto.randomBytes(9).toString('base64url')
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ password }), { mode: 0o600 })
  return { password, generated: true }
}

function cookieToken(req: http.IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return v.join('=')
  }
  return undefined
}

function authed(req: http.IncomingMessage): boolean {
  const token = cookieToken(req)
  const s = token && sessions.get(token)
  if (!s) return false
  // a password change logs everyone out
  if (s.until < Date.now() || s.pw !== sha(webPassword().password)) {
    sessions.delete(token!)
    return false
  }
  return true
}

function send(res: http.ServerResponse, status: number, body: any, headers: Record<string, string> = {}) {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers })
    return res.end(body)
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error(`请求过大（上限 ${Math.round(limit / 1048576)} MB）`), { status: 413 })
    chunks.push(c)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求不是合法 JSON'), { status: 400 })
  }
}

function serveStatic(res: http.ServerResponse, urlPath: string) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '')
  const file = path.resolve(WEB_DIR, rel)
  if (!file.startsWith(path.resolve(WEB_DIR) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // unknown non-asset paths fall back to the app (client-side routes)
    if (path.extname(rel)) return send(res, 404, { error: 'not found' })
    return serveStatic(res, '/')
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  })
  fs.createReadStream(file).pipe(res)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = req.method ?? 'GET'
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname)

  if (method !== 'GET' && req.headers['x-requested-with'] !== 'yzllm') return send(res, 403, { error: '缺少请求头' })
  const ip = req.socket.remoteAddress ?? ''

  if (url.pathname === '/api/login' && method === 'POST') {
    const f = failures.get(ip)
    if (f && f.until > Date.now()) return send(res, 429, { error: `尝试次数过多，请 ${Math.ceil((f.until - Date.now()) / 1000)} 秒后再试` })
    const body = await readBody(req)
    const expected = Buffer.from(sha(webPassword().password))
    const given = Buffer.from(sha(String(body.password ?? '')))
    if (!crypto.timingSafeEqual(expected, given)) {
      const n = (f?.n ?? 0) + 1
      failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 * Math.min(30, n - 4) : 0 })
      log.warn(`网页面板登录失败（${ip}）`)
      return send(res, 401, { error: '密码错误' })
    }
    failures.delete(ip)
    const token = crypto.randomBytes(24).toString('base64url')
    sessions.set(token, { until: Date.now() + SESSION_MS, pw: sha(webPassword().password) })
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` })
  }
  if (url.pathname === '/api/logout' && method === 'POST') {
    const token = cookieToken(req)
    if (token) sessions.delete(token)
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
  }
  if (!authed(req)) return send(res, 401, { error: '未登录' })

  for (const r of routes) {
    if (r.method !== method) continue
    const m = r.pattern.exec(url.pathname)
    if (!m) continue
    const params = (m.slice(1) as string[]).map(decodeURIComponent)
    const body = method === 'GET' ? {} : await readBody(req, r.maxBody)
    const out: Reply = await r.run({ params, query: url.searchParams, body })
    if (out && typeof out === 'object' && 'raw' in out && Buffer.isBuffer((out as any).raw))
      return send(res, 200, (out as any).raw, { 'content-type': (out as any).type, 'x-content-type-options': 'nosniff' })
    return send(res, 200, out ?? { ok: true })
  }
  return send(res, 404, { error: '没有这个接口' })
}

/** Start, restart (host/port changed) or stop the server to match config. Safe to call repeatedly. */
export function startWeb() {
  const w = config.get().web
  const want = w.enable ? `${w.host}:${w.port}` : ''
  if (want === bound) return
  stopWeb()
  if (!want) return
  const { password, generated } = webPassword()
  const s = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err?.status ?? 500
      if (status >= 500) log.error('网页面板请求出错', err)
      if (!res.headersSent) send(res, status, { error: err?.message ?? String(err) })
      else res.end()
    })
  })
  s.on('error', (err: any) => {
    log.error(`网页面板启动失败（${want}）：${err?.code === 'EADDRINUSE' ? '端口已被占用，可修改 web.port' : err?.message}`)
    if (server === s) {
      server = undefined
      bound = ''
    }
  })
  s.listen(w.port, w.host, () => {
    const shown = w.host === '0.0.0.0' || w.host === '::' ? '127.0.0.1' : w.host
    log.mark(`网页管理面板：http://${shown}:${w.port}${generated ? `  初始密码：${password}（可在 web.password 修改）` : ''}`)
    if (generated && !['127.0.0.1', 'localhost', '::1'].includes(w.host)) log.warn('网页面板对外监听但使用自动生成的密码，建议设置 web.password')
  })
  s.unref()
  server = s
  bound = want
}

export function stopWeb() {
  server?.close()
  server?.closeAllConnections?.()
  server = undefined
  bound = ''
}
