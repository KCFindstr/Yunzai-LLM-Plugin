import os from 'node:os'

/** Apply before worker input, persistence, main-model input, and final delivery. Never log raw worker data. */
export function privateValues(config: unknown): string[] {
  const values: string[] = []
  function visit(value: any, key = '') {
    if (typeof value === 'string' && /key|secret|password|token|authorization/i.test(key) && value.length >= 6 && !value.startsWith('env:')) values.push(value)
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k)
  }
  visit(config)
  for (const [key, value] of Object.entries(process.env)) if (/key|secret|password|token|authorization/i.test(key) && value && value.length >= 6) values.push(value)
  return [...new Set([...values, os.homedir(), os.hostname(), os.userInfo().username].filter(v => v.length >= 3))]
}

export function redact(text: string, secrets: string[] = []): string {
  let result = String(text)
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    for (const value of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) result = result.split(value).join('[redacted]')
  }
  return result
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[\w.+/=-]+/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/\b(?:sk-|AIza|ghp_|gho_|AKIA|ya29\.)[\w.-]{15,}/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s<>"'`，。；]+/g, '[private path]')
    .replace(/\/(?:home|Users|root|mnt|var\/lib)\/[^\s<>"'`，。；]+/g, '[private path]')
    .replace(/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, '[private address]')
    .replace(/([?&](?:key|api_?key|token|password|auth|authorization|secret|signature|session|code)=)[^&#\s)]+/gi, '$1[redacted]')
    .replace(/["']?\b(?:password|api[_ -]?key|secret|access[_ -]?token|refresh[_ -]?token|session[_ -]?id|cookie|sid)["']?\s*[:=]\s*["']?[^\s,;"']+["']?/gi, '[redacted]')
    .replace(/(?<!\w)(?:\+?\d[ -]?){9,16}(?!\w)/g, (value, offset, text) =>
      // Public artwork IDs are evidence identifiers, not personal phone/account numbers.
      /https?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/$/i.test(text.slice(0, offset)) ? value : '[private number]')
}
