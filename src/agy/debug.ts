import { log } from '../core/log.ts'
import { agyHistoryText } from './history.ts'

/** Buffer complete lines before redaction so credentials split across pipe chunks cannot leak. */
export function agyDiagnosticLogger(id: string, stream: 'stdout' | 'stderr', secrets: string[]) {
  let pending = '', dropping = false, privateKey = false
  const emit = (line: string) => {
    if (/-----BEGIN [\w ]*PRIVATE KEY-----/.test(line)) privateKey = true
    if (privateKey) {
      if (/-----END [\w ]*PRIVATE KEY-----/.test(line)) privateKey = false
      return
    }
    if (!line.trim()) return
    if (line.length > 16000) line = '[long diagnostic omitted]'
    line = line.replace(/https?:\/\/[^\s<>"']+/gi, url => /oauth|[?&](?:state|code_challenge|code)=/i.test(url) ? '[sign-in URL omitted]' : url)
    let value: unknown = line
    try { value = JSON.parse(line) } catch { /* ordinary CLI diagnostic */ }
    if (value && typeof value === 'object' && /thinking|reasoning/i.test(String((value as any).step_update?.step_type ?? ''))) return
    log.debug(`[AGY ${id}] ${stream}: ${agyHistoryText(value, secrets, 4000)}`)
  }
  return {
    write(chunk: string) {
      pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (!dropping) emit(line)
        dropping = false
      }
      if (pending.length > 16000) { pending = ''; dropping = true }
    },
    flush() {
      if (!dropping) emit(pending)
      pending = ''; dropping = false
    },
  }
}
