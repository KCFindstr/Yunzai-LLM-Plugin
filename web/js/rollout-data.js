/** Read legacy redacted JSON without evaluating text or changing placeholders inside strings. */
export function parseRolloutJson(text) {
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { /* older filtering could replace part of a decimal */ }
  const repaired = text.replace(/"(?:\\.|[^"\\])*"|[+\d.eE-]*\[private number\][+\d.eE-]*/g,
    token => token.startsWith('"') ? token : 'null')
  try { return JSON.parse(repaired) } catch { return undefined }
}
