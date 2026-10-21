const TAG = '[LLM]'

/**
 * YZ_LLM_DEBUG=1 shows this plugin's debug lines (tool results, reply text) at Yunzai's info level, without
 * switching all of Yunzai to log_level: debug.
 */
const verbose = /^(1|true|yes|on)$/i.test(process.env.YZ_LLM_DEBUG ?? '')

function sink(level: string, args: any[]) {
  const l = globalThis.logger
  if (l && typeof l[level] === 'function') return l[level](TAG, ...args)
  if (process.env.YZ_LLM_QUIET) return
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(TAG, ...args)
}

export const log = {
  verbose,
  debug: (...a: any[]) => (verbose ? sink('info', ['[debug]', ...a]) : sink('debug', a)),
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
