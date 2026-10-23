import { Marked } from '../vendor/marked.js'

// A named mention resembles a Markdown link. Recognize it before the normal link tokenizer.
const parser = new Marked({ gfm: true, breaks: true, extensions: [{
  name: 'botMention', level: 'inline', start: text => text.indexOf('[at:'),
  tokenizer(text) {
    const match = /^\[at:([^\]\r\n]+)\](?:\(([^)\r\n]{1,60})\))?/.exec(text)
    if (match) return { type: 'botMention', raw: match[0] }
  },
}] })

const node = (tag, ...children) => {
  const el = document.createElement(tag)
  el.append(...children.flat(Infinity).filter(child => child != null))
  return el
}
const entities = value => String(value ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, name) => {
  if (name[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[name.toLowerCase()] ?? raw
  const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd'
})

/** Display transport mention tokens as identities. Code and raw editors keep the original bytes. */
export function mentionText(value) {
  const text = String(value ?? ''), fragment = document.createDocumentFragment()
  let offset = 0
  for (const match of text.matchAll(/\[at:([^\]\r\n]+)\](?:\(([^)\r\n]{1,60})\))?/g)) {
    fragment.append(text.slice(offset, match.index))
    const id = match[1], label = match[2] || (id === 'you' ? '机器人' : id === 'all' ? '全体成员' : id)
    const chip = node('span', `@${label}`)
    chip.className = 'mention-chip'; chip.dataset.userId = id
    chip.title = id === 'you' ? '当前机器人' : id === 'all' ? '全体成员' : `平台ID ${id}`
    fragment.append(chip); offset = match.index + match[0].length
  }
  fragment.append(text.slice(offset))
  return fragment
}

function safeUrl(value) {
  try {
    const url = new URL(entities(value), location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

/** Render Markdown tokens into DOM nodes, never into HTML. Raw HTML is literal; remote images are links. */
export function richText(value, { markdown = false, mentions = true } = {}) {
  const literal = text => mentions ? mentionText(text) : document.createTextNode(text)
  if (!markdown) return literal(String(value ?? ''))
  const inline = tokens => (tokens ?? []).map(token => {
    const content = () => token.tokens ? inline(token.tokens) : [literal(entities(token.text ?? ''))]
    switch (token.type) {
      case 'botMention': return literal(token.raw)
      case 'strong': return node('strong', content())
      case 'em': return node('em', content())
      case 'del': return node('del', content())
      case 'codespan': return node('code', entities(token.text))
      case 'br': return node('br')
      case 'link': {
        const href = safeUrl(token.href)
        if (!href) return node('span', content())
        const a = node('a', content()); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'
        if (token.title) a.title = entities(token.title)
        return a
      }
      case 'image': {
        const href = safeUrl(token.href), label = literal(`图片：${entities(token.text || '查看图片')}`)
        if (!href) return label
        const a = node('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'
        return a
      }
      case 'html': return literal(token.raw ?? token.text ?? '')
      default: return token.tokens ? node('span', inline(token.tokens)) : literal(entities(token.text ?? token.raw ?? ''))
    }
  })
  const blocks = tokens => (tokens ?? []).map(token => {
    switch (token.type) {
      case 'space': return null
      case 'heading': return node(`h${Math.min(6, Math.max(1, token.depth))}`, inline(token.tokens))
      case 'paragraph': return node('p', inline(token.tokens))
      case 'text': return node('p', token.tokens ? inline(token.tokens) : literal(entities(token.text)))
      case 'code': {
        const code = node('code', token.text)
        if (token.lang) code.dataset.language = token.lang.split(/\s/)[0]
        return node('pre', code)
      }
      case 'blockquote': return node('blockquote', blocks(token.tokens))
      case 'hr': return node('hr')
      case 'list': {
        const list = node(token.ordered ? 'ol' : 'ul', token.items.map(item => {
          const li = node('li', blocks(item.tokens))
          if (item.task) {
            const check = node('input'); check.type = 'checkbox'; check.checked = item.checked; check.disabled = true
            li.className = 'task-item'; li.prepend(check)
          }
          return li
        }))
        if (token.ordered && Number.isFinite(token.start)) list.start = token.start
        return list
      }
      case 'table': {
        const row = (cells, tag) => node('tr', cells.map((cell, i) => {
          const el = node(tag, inline(cell.tokens)); if (token.align[i]) el.style.textAlign = token.align[i]; return el
        }))
        const wrap = node('div', node('table', node('thead', row(token.header, 'th')), node('tbody', token.rows.map(cells => row(cells, 'td')))))
        wrap.className = 'markdown-table'; return wrap
      }
      default: return literal(token.raw ?? token.text ?? '')
    }
  })
  const fragment = document.createDocumentFragment()
  try { fragment.append(...blocks(parser.lexer(String(value ?? ''))).filter(Boolean)) }
  catch { fragment.append(literal(String(value ?? ''))) }
  return fragment
}
