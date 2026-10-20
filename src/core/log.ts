const TAG = '[LLM]'

function sink(level: string, args: any[]) {
  const l = globalThis.logger
  if (l && typeof l[level] === 'function') return l[level](TAG, ...args)
  if (process.env.YZ_LLM_QUIET) return
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(TAG, ...args)
}

export const log = {
  debug: (...a: any[]) => sink('debug', a),
  info: (...a: any[]) => sink('info', a),
  mark: (...a: any[]) => sink('mark', a),
  warn: (...a: any[]) => sink('warn', a),
  error: (...a: any[]) => sink('error', a),
}
