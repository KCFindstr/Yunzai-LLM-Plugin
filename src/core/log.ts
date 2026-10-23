const TAG = '[LLM]'

/**
 * YZ_LLM_DEBUG=1 shows this plugin's debug lines (tool results, reply text) at Yunzai's info level, without
 * switching all of Yunzai to log_level: debug.
 */
const verbose = /^(1|true|yes|on)$/i.test(process.env.YZ_LLM_DEBUG ?? '')

export interface LogLine { seq: number; at: number; level: string; text: string }

/** Recent lines for the web console (debug lines only when verbose, matching what Yunzai itself shows). */
const recent: LogLine[] = []
let seq = 0

function remember(level: string, args: any[]) {
  const text = args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ')
  recent.push({ seq: ++seq, at: Date.now(), level, text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text })
  if (recent.length > 1000) recent.splice(0, recent.length - 1000)
}

export function recentLogs(after = 0, level?: string, query = ''): LogLine[] {
  const search = query.trim().toLowerCase()
  return recent.filter(line => line.seq > after && (!level || line.level === level) && (!search || line.text.toLowerCase().includes(search)))
}

function sink(level: string, args: any[], recordedLevel = level) {
  if (level !== 'debug' || verbose) remember(recordedLevel, args)
  const l = globalThis.logger
  if (l && typeof l[level] === 'function') return l[level](TAG, ...args)
  if (process.env.YZ_LLM_QUIET) return
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(TAG, ...args)
}

export const log = {
  verbose,
  debug: (...a: any[]) => (verbose ? sink('info', ['[debug]', ...a], 'debug') : sink('debug', a)),
  info: (...a: any[]) => sink('info', a),
  mark: (...a: any[]) => sink('mark', a),
  warn: (...a: any[]) => sink('warn', a),
  error: (...a: any[]) => sink('error', a),
}

/** One-line, length-capped rendering of a value for logs. */
export function brief(v: unknown, max = 160): string {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…(${s.length}字)` : s
}
