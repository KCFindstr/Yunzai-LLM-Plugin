import { spawn } from 'node:child_process'
import type { ExecToolConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { truncate } from '../core/util.ts'
import { registry } from './registry.ts'

const MAX_CODE = 50_000
const MAX_IMAGES_PER_TURN = 2
/** concurrent runs across all chats; each one is a cgroup with its own memory cap */
const MAX_CONCURRENT = 2

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

/** Run code in the WSL sandbox (exec/runner.py inside cfg.distro). */
export async function runInSandbox(
  lang: string,
  code: string,
  cfg: ExecToolConfig,
  opts: { maxImages?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  await acquire()
  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('wsl.exe', ['-d', cfg.distro, '-u', 'root', '-e', 'python3', '/opt/llm-sandbox/runner.py'], {
        windowsHide: true,
        signal: opts.signal,
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', d => out.push(d))
      child.stderr.on('data', d => err.push(d))
      // the runner enforces cfg.timeout itself; this only guards against a hung WSL
      const timer = setTimeout(() => child.kill(), (cfg.timeout + 25) * 1000)
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
      child.stdin.end(
        JSON.stringify({
          lang,
          code,
          timeout: cfg.timeout,
          memoryMB: cfg.memoryMB,
          diskMB: cfg.diskMB,
          maxOutput: cfg.maxOutput,
          maxImages: opts.maxImages ?? MAX_IMAGES_PER_TURN,
        }),
      )
    })
  } finally {
    release()
  }
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
      '沙盒可以访问公网（pip/npm 可安装到当前目录，但很慢，尽量用自带的库），每次运行都是全新环境，不保留任何文件。' +
      'Python 自带 requests、numpy、pandas、matplotlib、bs4；Node 22 可直接用 fetch。' +
      '结果必须 print / console.log 出来；把图片（png/jpg/gif）保存到 out/ 目录（如 plt.savefig("out/chart.png")）会随回复发送。' +
      '不要用它做简单心算或闲聊。',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node', 'bash'], description: '语言；node 为 ESM，可用顶层 await' },
        code: { type: 'string', description: '完整代码' },
      },
      required: ['language', 'code'],
    },
    available: ctx => {
      const c = ctx.eff.tools.exec
      return c.enable && process.platform === 'win32' && (c.access === 'all' || ctx.isAdmin)
    },
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
      const res = await runInSandbox(lang, code, cfg, { maxImages, signal: ctx.signal })
      for (const img of res.images) ctx.turn.images.push(Buffer.from(img.b64, 'base64'))
      log.info(`run_code ${lang} exit=${res.exitCode}${res.timedOut ? ' timeout' : ''}${res.killed ? ' killed' : ''} ${res.durationMs}ms`)
      return { content: formatExecResult(res, cfg.maxOutput), isError: res.timedOut || res.killed }
    },
  })
}
