import { renderHtml } from './browser.ts'

export const LONG_RESPONSE_CHARS = 600

export function isLongResponse(text: string): boolean {
  return text.length > LONG_RESPONSE_CHARS || text.split('\n').length >= 14
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function blocks(text: string, literal: boolean): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let inCode = false
  const body = lines.map(line => {
    if (!literal && /^```/.test(line)) {
      inCode = !inCode
      return inCode ? '<pre><code>' : '</code></pre>'
    }
    if (inCode) return escapeHtml(line) + '\n'
    const heading = /^【([^】]+)】(.*)$/.exec(line) ?? (!literal ? /^#{1,6}\s+(.+)$/.exec(line) : null)
    if (heading) return `<h2>${escapeHtml(heading[1])}</h2>${heading[2] ? `<p>${escapeHtml(heading[2])}</p>` : ''}`
    if (!line.trim()) return '<div class="space"></div>'
    let content = escapeHtml(line)
    if (!literal) content = content.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    if (literal && /^\s*(?:例：)?#llm/.test(line)) return `<div class="command">${content}</div>`
    if (/^\s*[-*•]\s+/.test(line)) return `<p class="item"><span>✦</span>${content.replace(/^\s*[-*•]\s+/, '')}</p>`
    return `<p>${content}</p>`
  }).join('')
  return body + (inCode ? '</code></pre>' : '')
}

export function responsePages(sections: string[], title = '聊天手记', literal = false, single = false): string[] {
  const chunks: string[] = []
  let chunk = ''
  let rows = 0
  let fenced = false
  for (const section of sections) {
    for (const original of section.replace(/\r\n?/g, '\n').split('\n')) {
      const pieces = original.match(/.{1,600}/gu) ?? ['']
      for (const line of pieces) {
        const needed = Math.max(1, Math.ceil(line.length / 34))
        if (!single && rows + needed > 44 && chunk) {
          chunks.push(chunk + (fenced ? '\n```' : ''))
          chunk = fenced ? '```\n' : ''
          rows = 0
        }
        chunk += (chunk ? '\n' : '') + line
        rows += needed
        if (!literal && /^```/.test(line)) fenced = !fenced
      }
    }
    chunk += '\n'
    rows++
  }
  if (chunk.trim()) chunks.push(chunk + (fenced ? '\n```' : ''))
  const columns = single && (sections.length > 3 || sections.join('').length > 2500)
  return chunks.map((part, index) => `<style>
body{background:#eee8f6;padding:26px;color:#363047;font-size:18px;line-height:1.75}
.sheet{background:#fffdfd;border:2px solid #d9c8e7;border-radius:20px;overflow:hidden;box-shadow:5px 6px 0 #dcd0e9}
header{padding:20px 26px;background:#f2def0;border-bottom:2px solid #dfc9e5;display:flex;justify-content:space-between;gap:20px;align-items:center}
header b{font-size:23px}header small{color:#846c94;white-space:nowrap}main{padding:20px 28px}
h2{font-size:21px;color:#79518e;border-left:5px solid #b9dcd1;padding:4px 12px;margin:16px 0 10px;background:#f5eff9}
p{margin:4px 0;white-space:pre-wrap}.space{height:10px}.command{font:15px/1.7 "Cascadia Code","Microsoft YaHei",monospace;white-space:pre-wrap;background:#f3eef8;border:1px solid #e3d8ed;border-radius:9px;padding:9px 13px;margin:7px 0}
.item{display:flex;gap:10px}.item span{color:#c08bb6}code{background:#f1e9f7;color:#794d86}pre{white-space:pre-wrap;overflow-wrap:anywhere}
footer{padding:9px 26px 16px;text-align:right;color:#a08caf;font-size:12px}
${single ? 'body{font-size:16px;line-height:1.6;padding:20px}main{padding:16px 22px}.command{font-size:14px;padding:6px 10px;margin:5px 0}h2{font-size:19px;margin:12px 0 8px}.panel{break-inside:avoid;margin-bottom:14px}.media{display:block;max-width:100%;max-height:1200px;margin:12px auto}.space{height:7px}' : ''}
${columns ? 'main{columns:2;column-gap:24px}' : ''}
${single && sections.length === 1 ? '.panel{break-inside:auto}' : ''}
</style><article class="sheet"><header><b>${escapeHtml(title)}</b><small>✦ CHAT NOTES</small></header><main>${single ? sections.map(section => `<section class="panel">${blocks(section, literal)}</section>`).join('') : blocks(part, literal)}</main>${single ? '' : `<footer>${index + 1} / ${chunks.length}</footer>`}</article>`)
}

export async function renderCommandResponse(sections: string[], title?: string, media: string[] = []): Promise<Buffer> {
  const columns = sections.length > 3 || sections.join('').length > 2500
  const html = responsePages(sections, title, true, true)[0] ?? responsePages(['（无内容）'], title, true, true)[0]
  const withMedia = html.replace('</main>', media.map(url => `<img class="media" src="${escapeHtml(url)}">`).join('') + '</main>')
  return renderHtml(withMedia, { width: columns ? 1280 : 760, maxHeight: 16000, scale: 0.75, allowNetwork: media.some(url => /^https?:/i.test(url)), fit: true })
}
