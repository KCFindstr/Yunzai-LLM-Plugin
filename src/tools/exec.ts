import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { ExecToolConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { truncate } from '../core/util.ts'
import { MAX_IMAGES_PER_TURN, registry, type ToolCtx } from './registry.ts'

const MAX_CODE = 50_000
/** concurrent sandbox calls across all chats; each one is a cgroup with its own memory cap */
const MAX_CONCURRENT = 2
/** render_html in the sandbox: Chrome start + page load, on top of the runner's own limit */
const RENDER_TIMEOUT = 30

export interface ExecResult {
  exitCode: number | null
  timedOut: boolean
  /** killed early, almost always the memory cap */
  killed: boolean
  durationMs: number
  stdout: string
  stdoutTotal: number
  stderr: string
  stderrTotal: number
  images: { name: string; mime: string; b64: string }[]
  error?: string
}

let running = 0
const waiters: (() => void)[] = []

async function acquire() {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  await new Promise<void>(r => waiters.push(r))
}

function release() {
  const next = waiters.shift()
  if (next) next()
  else running--
}

/** Calls on the same session run one after another (parallel tool calls in one round share the workspace). */
const sessionTails = new Map<string, Promise<unknown>>()

function serialize<T>(session: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!session) return fn()
  const prev = sessionTails.get(session) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  sessionTails.set(session, next)
  next.finally(() => sessionTails.get(session) === next && sessionTails.delete(session)).catch(() => {})
  return next
}

/** One request to exec/runner.py inside cfg.distro (JSON in, JSON out). */
async function callRunner(cfg: ExecToolConfig, req: Record<string, any>, hardTimeoutSec: number, signal?: AbortSignal): Promise<any> {
  await acquire()
  try {
    return await new Promise<any>((resolve, reject) => {
      const child = spawn('wsl.exe', ['-d', cfg.distro, '-u', 'root', '-e', 'python3', '/opt/llm-sandbox/runner.py'], {
        windowsHide: true,
        signal,
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', d => out.push(d))
      child.stderr.on('data', d => err.push(d))
      // the runner enforces its own time limits; this only guards against a hung WSL
      const timer = setTimeout(() => child.kill(), hardTimeoutSec * 1000)
      child.on('error', e => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', status => {
        clearTimeout(timer)
        const text = Buffer.concat(out).toString('utf8').trim()
        try {
          const res = JSON.parse(text)
          if (res.error) return reject(new Error(res.error))
          resolve(res)
        } catch {
          // wsl.exe prints its own errors in UTF-16
          const msg = (Buffer.concat(err).toString('utf8') || text).replace(/\0/g, '').trim()
          reject(new Error(`沙盒不可用（退出码 ${status}）：${truncate(msg || '无输出', 300)}`))
        }
      })
      child.stdin.end(JSON.stringify(req))
    })
  } finally {
    release()
  }
}

/** Whether this turn may use the sandbox (run_code, and render_html inside it). */
export function sandboxEnabled(ctx: ToolCtx): boolean {
  const c = ctx.eff.tools.exec
  return c.enable && process.platform === 'win32' && (c.access === 'all' || ctx.isAdmin)
}

/**
 * WSL shuts a distro down ~15-30s after its last process exits, which wipes the tmpfs workspaces. While any reply
 * has a live workspace we keep one idle process open in the distro (bounded by sleep, in case we never release it).
 */
const liveSessions = new Set<string>()
let keepalive: ChildProcess | undefined

function holdDistro(cfg: ExecToolConfig, session: string) {
  liveSessions.add(session)
  if (keepalive && keepalive.exitCode === null && !keepalive.killed) return
  keepalive = spawn('wsl.exe', ['-d', cfg.distro, '-u', 'root', '-e', 'sleep', '1800'], { windowsHide: true, stdio: 'ignore' })
  keepalive.on('error', err => log.debug(`沙盒保活进程启动失败: ${err.message}`))
}

function releaseDistro(session: string) {
  liveSessions.delete(session)
  if (!liveSessions.size && keepalive) {
    keepalive.kill()
    keepalive = undefined
  }
}

/** Plugin shutdown: let the distro idle out (workspaces are swept by the runner later). */
export function stopKeepalive() {
  liveSessions.clear()
  keepalive?.kill()
  keepalive = undefined
}

/** This reply's shared workspace id, created on first use. */
export function turnSession(ctx: ToolCtx): string {
  if (!ctx.turn.sandboxSession) {
    ctx.turn.sandboxSession = `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    holdDistro(ctx.eff.tools.exec, ctx.turn.sandboxSession)
  }
  return ctx.turn.sandboxSession
}

/** Delete a reply's workspace (fire-and-forget; the runner also sweeps idle ones after an hour). */
export function cleanupSandbox(cfg: ExecToolConfig, session: string) {
  serialize(session, () => callRunner(cfg, { action: 'cleanup', session }, 20))
    .catch(err => log.debug(`清理沙盒工作目录失败: ${err?.message ?? err}`))
    .finally(() => releaseDistro(session))
}

/** Run code in the WSL sandbox. With a session, /work persists across calls in that session. */
export function runInSandbox(
  lang: string,
  code: string,
  cfg: ExecToolConfig,
  opts: { maxImages?: number; signal?: AbortSignal; session?: string } = {},
): Promise<ExecResult> {
  const req = {
    action: 'run',
    session: opts.session,
    lang,
    code,
    timeout: cfg.timeout,
    memoryMB: cfg.memoryMB,
    diskMB: cfg.diskMB,
    maxOutput: cfg.maxOutput,
    maxImages: opts.maxImages ?? MAX_IMAGES_PER_TURN,
  }
  return serialize(opts.session, () => callRunner(cfg, req, cfg.timeout + 25, opts.signal))
}

/** Render a full HTML document with the sandbox's headless Chrome; relative URLs resolve against /work. */
export async function renderInSandbox(
  html: string,
  cfg: ExecToolConfig,
  opts: { width: number; maxHeight: number; allowNetwork: boolean; session?: string; signal?: AbortSignal },
): Promise<Buffer> {
  const req = { action: 'render', session: opts.session, html, width: opts.width, maxHeight: opts.maxHeight, allowNetwork: opts.allowNetwork, diskMB: cfg.diskMB, timeout: RENDER_TIMEOUT }
  const res: ExecResult = await serialize(opts.session, () => callRunner(cfg, req, RENDER_TIMEOUT + 25, opts.signal))
  const img = res.images?.[0]
  if (!img) throw new Error(`沙盒渲染失败：${truncate((res.stderr || res.stdout || `退出码 ${res.exitCode}`).trim(), 300)}`)
  return Buffer.from(img.b64, 'base64')
}

function clip(text: string, total: number, max: number): string {
  const t = text.slice(0, max)
  return total > Buffer.byteLength(t) ? `${t}\n…（输出已截断，共 ${total} 字节）` : t
}

/** What the model sees: exit status, then stdout/stderr, split between them within maxOutput. */
export function formatExecResult(r: ExecResult, maxOutput: number): string {
  const head = r.timedOut
    ? `运行超时被终止（${(r.durationMs / 1000).toFixed(1)}s）`
    : r.killed
      ? '进程被强制终止（多半是超出内存上限）'
      : `退出码 ${r.exitCode}（${(r.durationMs / 1000).toFixed(1)}s）`
  const parts = [head]
  const errBudget = r.stdout ? Math.floor(maxOutput / 3) : maxOutput
  const stderr = r.stderr ? clip(r.stderr, r.stderrTotal, errBudget) : ''
  if (r.stdout) parts.push(`[stdout]\n${clip(r.stdout, r.stdoutTotal, maxOutput - stderr.length)}`)
  if (stderr) parts.push(`[stderr]\n${stderr}`)
  if (!r.stdout && !r.stderr) parts.push('（没有输出，记得用 print/console.log 打印结果）')
  if (r.images.length) parts.push(`生成的图片 ${r.images.map(i => i.name).join('、')} 会在你的文字回复之后发送。`)
  return parts.join('\n')
}

export function registerExecTool() {
  registry.register({
    name: 'run_code',
    source: 'builtin',
    description:
      '在隔离的 Linux 沙盒里运行代码并返回输出。适合：精确计算、数据处理、统计、画图表、解析网页/接口数据、验证代码片段。' +
      '沙盒可以访问公网（pip/npm 可安装到当前目录，但很慢，尽量用自带的库）。同一次回复里的多次 run_code 和 render_html 共用当前目录（回复结束后清空），可以先下载/生成文件再在 HTML 里用相对路径引用。' +
      'Python 自带 requests、numpy、pandas、matplotlib、bs4；Node 22 可直接用 fetch。' +
      '结果必须 print / console.log 出来；保存到 out/ 目录的图片（png/jpg/gif）会单独随回复发送，只打算放进 HTML 的图片请存到别的目录（如 img/）。' +
      '不要用它做简单心算或闲聊。',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node', 'bash'], description: '语言；node 为 ESM，可用顶层 await' },
        code: { type: 'string', description: '完整代码' },
      },
      required: ['language', 'code'],
    },
    available: sandboxEnabled,
    limit: ctx => `最多运行 ${ctx.eff.tools.exec.maxRunsPerTurn} 次，与 render_html/send_image 共用最多 ${MAX_IMAGES_PER_TURN} 张回复图片`,
    remaining: ctx => `剩余 ${Math.max(0, ctx.eff.tools.exec.maxRunsPerTurn - (ctx.turn.execRuns ?? 0))} 次；共享图片余量 ${Math.max(0, MAX_IMAGES_PER_TURN - ctx.turn.images.length)} 张`,
    async run(args, ctx) {
      const cfg = ctx.eff.tools.exec
      const lang = String(args.language ?? '')
      const code = String(args.code ?? '')
      if (!cfg.languages.includes(lang as any)) return { content: `不支持的语言：${lang}（可用：${cfg.languages.join('、')}）`, isError: true }
      if (!code.trim()) return { content: '缺少 code', isError: true }
      if (code.length > MAX_CODE) return { content: `代码太长（${code.length} 字符）`, isError: true }
      ctx.turn.execRuns = (ctx.turn.execRuns ?? 0) + 1
      if (ctx.turn.execRuns > cfg.maxRunsPerTurn) return { content: `每轮最多运行 ${cfg.maxRunsPerTurn} 次代码`, isError: true }

      const maxImages = Math.max(0, MAX_IMAGES_PER_TURN - ctx.turn.images.length)
      const res = await runInSandbox(lang, code, cfg, { maxImages, signal: ctx.signal, session: turnSession(ctx) })
      for (const img of res.images) ctx.turn.images.push(Buffer.from(img.b64, 'base64'))
      log.info(`run_code ${lang} exit=${res.exitCode}${res.timedOut ? ' timeout' : ''}${res.killed ? ' killed' : ''} ${res.durationMs}ms`)
      return { content: formatExecResult(res, cfg.maxOutput), isError: res.timedOut || res.killed }
    },
  })
}
