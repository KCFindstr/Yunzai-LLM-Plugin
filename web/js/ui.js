/** Tiny DOM helpers: h() builds elements, plus toast / modal / formatting. No framework. */
import { mentionText, richText } from './rich-text.js'
export { mentionText, richText } from './rich-text.js'

const responseModes = (() => {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem('response-markdown') || '{}'))) } catch { return new Map() }
})()

/** Each response owns its presentation state; live refreshes and reloads retain only that response's choice. */
function responseBlock(text, { key, wrapperClass = '', ...options } = {}) {
  const identity = `${location.hash}:${key}`
  let enabled = responseModes.get(identity) !== false
  const body = h('div', { class: 'response-content' })
  const draw = () => {
    const open = body.querySelector('details[data-disclosure]')?.open ?? options.open
    mount(body, contentBlock(text, { ...options, key, open, markdown: enabled }))
  }
  const control = h('label', { class: 'markdown-switch' }, h('input', { type: 'checkbox', role: 'switch', checked: enabled, 'aria-label': '渲染 Markdown', onchange: e => {
    enabled = e.target.checked
    responseModes.delete(identity); responseModes.set(identity, enabled)
    while (responseModes.size > 200) responseModes.delete(responseModes.keys().next().value)
    try { localStorage.setItem('response-markdown', JSON.stringify(Object.fromEntries(responseModes))) } catch {}
    draw()
  } }), h('span', '渲染 Markdown'))
  const root = h('div', { class: `response-block ${wrapperClass}`, 'data-response-key': key }, h('div', { class: 'response-controls' }, control), body)
  draw()
  return root
}

export function responseText(text, className = '', key) {
  return responseBlock(text, { key, wrapperClass: className, className: 'response-body', limit: Infinity })
}

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  usage: '<path d="M12 3v18m4-14H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 0 0-7M8 17h6.5"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 1 1 21 11.5Z"/><path d="M7 9h9M7 13h6"/>',
  memory: '<path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm-2 15a3 3 0 0 1 3-3h13M8 7h7M8 10h5"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m3 10v-2a6 6 0 0 0-2-4.5"/>',
  vectors: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M7.5 5.5l9 5"/>',
  persona: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  models: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  sticker: '<path d="M14 21H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8l-7 7Zm0 0v-4a3 3 0 0 1 3-3h4M8 8h.01M16 8h.01M8 12a5 5 0 0 0 5 2"/>',
  tools: '<path d="m14 6 4 4 4-4a6 6 0 0 1-8 8L6 22l-4-4 8-8a6 6 0 0 1 8-8l-4 4Z"/>',
  computer: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4M2 13h20"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--panel)"/><circle cx="16" cy="12" r="2" fill="var(--panel)"/><circle cx="10" cy="18" r="2" fill="var(--panel)"/>',
  logs: '<path d="m4 6 6 6-6 6m10 0h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  theme: '<path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z"/>',
  logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h13"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.5 3M4.4 15a8 8 0 0 0 13.5 3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
}

/** Local, decorative SVG icons; no external fonts or requests. */
export function icon(name, size = 18) {
  return h('span', { class: 'icon', 'aria-hidden': 'true', html: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.overview}</svg>` })
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs)
    attrs = null
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'html') el.innerHTML = v
    else if (k in el && typeof v !== 'string') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function mount(root, ...children) {
  root.replaceChildren()
  append(root, children)
}

/** Keep long transcripts readable; expanding uses native keyboard-accessible details. */
export function textBlock(text, options = {}) {
  if (!text) return null
  return options.markdown ? responseBlock(text, options) : contentBlock(text, options)
}

function contentBlock(text, { key, open = false, limit = 360, className = 'small', markdown = false, mentions = true } = {}) {
  if (!text) return null
  const content = () => h(markdown ? 'div' : 'pre', { class: `${className}${markdown ? ' rich-text' : ''}` }, richText(text, { markdown, mentions }))
  if (limit === Infinity || (text.length <= limit && text.split('\n').length <= 8)) return content()
  const excerpt = text.slice(0, Math.min(limit, 180)).trim() + '…'
  const preview = h(markdown ? 'div' : 'span', { class: `text-excerpt${markdown ? ' rich-text' : ''}` }, richText(excerpt, { markdown, mentions }))
  return h('details', { class: 'text-disclosure', 'data-disclosure': key, open },
    h('summary', preview,
      h('span', { class: 'disclosure-action' }, h('span', { class: 'when-closed' }, '展开全文'), h('span', { class: 'when-open' }, '收起'))),
    content())
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, icon(kind === 'bad' ? 'alert' : 'check'), msg)
  document.getElementById('toasts').append(t)
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3000)
}

/** Run an async action with a toast on success or failure; returns the result or undefined. */
export async function act(fn, okMsg) {
  try {
    const r = await fn()
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok')
    return r ?? true
  } catch (err) {
    toast(err.message || String(err), 'bad')
    return undefined
  }
}

/** Modal dialog. `actions`: [{ label, kind, value }]; resolves with the clicked value (undefined on dismiss). */
export function modal(title, body, actions = [{ label: '关闭', value: undefined }]) {
  return new Promise(resolve => {
    const previous = document.activeElement
    const close = v => { bg.remove(); document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); resolve(v) }
    const onKey = e => {
      if (document.querySelector('.modal-bg:last-of-type') !== bg) return
      if (e.key === 'Escape') { e.preventDefault(); close(undefined) }
      if (e.key === 'Tab') {
        const items = [...bg.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length)
        const first = items[0], last = items.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(undefined) } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('header', h('span', title), h('button', { class: 'btn ghost sm', 'aria-label': '关闭对话框', onclick: () => close(undefined) }, icon('close'))),
        h('div', { class: 'body' }, body),
        h('footer', actions.map(a => h('button', { class: `btn ${a.kind ?? ''}`, onclick: async () => {
          if (a.run) { const r = await a.run(); if (r === false) return }
          close(a.value)
        } }, a.label))),
      ))
    document.addEventListener('keydown', onKey)
    document.body.append(bg)
    ;(bg.querySelector('input, textarea, select') ?? bg.querySelector('button'))?.focus()
  })
}

export async function confirmDanger(text, label = '确定') {
  return (await modal('请确认', h('p', text), [{ label: '取消', value: false }, { label, kind: 'primary danger', value: true }])) === true
}

/**
 * Pick from a list or type anything: a select with a trailing 自定义输入… option that reveals a text input.
 * `.value` reads/writes the result; `.setOptions(list)` swaps the list (keeps the value). `empty` adds a blank choice.
 */
export function combo(options, value = '', { onchange, empty, placeholder = '' } = {}) {
  const CUSTOM = '\u0000custom'
  const input = h('input', { type: 'text', value: value ?? '', placeholder })
  const sel = h('select')
  const wrap = h('div', { class: 'col', style: { gap: '4px' } }, sel, input)
  let opts = []
  const sync = () => {
    const v = input.value
    const known = opts.includes(v) || (empty != null && v === '')
    sel.value = known ? v : CUSTOM
    sel.style.display = opts.length ? '' : 'none'
    input.style.display = known ? 'none' : ''
  }
  wrap.setOptions = list => {
    opts = [...new Set(list ?? [])].map(String)
    sel.replaceChildren(...(empty != null ? [h('option', { value: '' }, empty)] : []), ...opts.map(o => h('option', { value: o }, o)), h('option', { value: CUSTOM }, '自定义输入…'))
    sync()
  }
  sel.addEventListener('change', () => {
    if (sel.value === CUSTOM) { input.style.display = ''; input.focus(); return }
    input.value = sel.value
    sync()
    onchange?.(input.value)
  })
  input.addEventListener('change', () => { sync(); onchange?.(input.value) })
  Object.defineProperty(wrap, 'value', { get: () => input.value, set: v => { input.value = v ?? ''; sync() } })
  wrap.setOptions(options)
  return wrap
}

/**
 * Modal form; resolves with { name: value } or undefined. Field kinds: text (default), `multiline`, `type: 'password'`, `type: 'checkbox'` (returns a boolean),
 * `options` (select; strings or {value, label}), `combo` (suggestions + free input). `f.onchange(inputs)` runs when the
 * field changes, so one field can update others; `validate(values)` returns an error to keep the dialog open.
 */
export async function promptFields(title, fields, okLabel = '确定', validate) {
  const inputs = {}
  const fire = f => () => f.onchange?.(inputs)
  const make = f => {
    if (f.type === 'checkbox') return h('input', { type: 'checkbox', checked: Boolean(f.value), onchange: fire(f) })
    if (f.options) return h('select', { onchange: fire(f) }, f.options.map(o => {
      const [value, label] = typeof o === 'object' ? [o.value, o.label] : [o, o]
      return h('option', { value, selected: String(value) === String(f.value ?? '') }, label)
    }))
    if (f.combo) return combo(f.combo, f.value ?? '', { onchange: fire(f), placeholder: f.placeholder ?? '' })
    if (f.multiline) return h('textarea', { class: f.code ? 'code' : '', rows: f.rows ?? 8, placeholder: f.placeholder ?? '', oninput: fire(f) }, f.value ?? '')
    return h('input', { type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '', list: f.list, autocomplete: f.type === 'password' ? 'new-password' : undefined, oninput: fire(f) })
  }
  const body = h('div', { class: 'col' }, fields.map(f => {
    const el = inputs[f.name] = make(f)
    return f.type === 'checkbox'
      ? h('label', { class: 'row small' }, el, f.label)
      : h('label', { class: 'col', style: { gap: '4px' } }, h('span', { class: 'small muted' }, f.label), el)
  }))
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]))
  const ok = await modal(title, body, [{ label: '取消', value: false }, {
    label: okLabel, kind: 'primary', value: true,
    run: () => {
      const err = validate?.(values())
      if (err) { toast(err, 'bad'); return false }
    },
  }])
  if (!ok) return undefined
  return values()
}

export const fmt = {
  usd: v => (!Number.isFinite(v) ? '-' : v === 0 ? '$0' : Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`),
  time: ts => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'),
  short: ts => (ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-'),
  ago(ts) {
    if (!ts) return '-'
    const s = Math.max(0, (Date.now() - ts) / 1000)
    if (s < 60) return '刚刚'
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
    return `${Math.floor(s / 86400)} 天前`
  },
  dur(ms) {
    if (ms < 1000) return `${ms}ms`
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${(ms / 1000).toFixed(1)}s`
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60)
    return [d && `${d}天`, hh && `${hh}小时`, `${mm}分`].filter(Boolean).join('')
  },
  bytes: n => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${(n / (1 << 20)).toFixed(0)} MB`),
  num: n => (n ?? 0).toLocaleString('zh-CN'),
}

export const empty = text => h('div', { class: 'empty' }, text)
export const card = (title, ...children) => h('section', { class: 'card' }, title ? h('h2', title) : null, children)
export const stat = (k, v, s) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s ? h('div', { class: 's' }, s) : null)
export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text)
export const spinner = () => h('span', { class: 'spin' })

export function switchEl(checked, onchange, label = '启用或停用') {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked, onchange: () => onchange(input.checked, input) })
  return h('label', { class: 'switch' }, input, h('span'))
}

/**
 * Client-side pagination for long lists. `slice(items)` clamps the page and returns the visible part; `el` is the
 * nav (hidden when everything fits on one page). Page changes call `onchange` and bring `anchor` back to its top.
 */
export function pager(onchange, { size = 50, anchor } = {}) {
  let page = 0, pages = 1, total = 0
  const el = h('nav', { class: 'pager', 'aria-label': '分页' })
  const go = p => {
    page = Math.max(0, Math.min(pages - 1, p))
    onchange()
    const top = anchor?.() ?? el.parentElement
    if (top?.scrollHeight > top?.clientHeight) top.scrollTop = 0
    if (top?.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' })
  }
  const draw = () => {
    el.hidden = pages <= 1
    if (el.hidden) return el.replaceChildren()
    mount(el,
      h('button', { class: 'btn sm', disabled: page === 0, 'aria-label': '上一页', onclick: () => go(page - 1) }, '‹ 上一页'),
      h('label', { class: 'small muted pager-pos' }, '第',
        h('select', { 'aria-label': '页码', onchange: e => go(Number(e.target.value)) },
          Array.from({ length: pages }, (_, i) => h('option', { value: i, selected: i === page }, i + 1))),
        `/ ${pages} 页 · 共 ${fmt.num(total)} 条`),
      h('button', { class: 'btn sm', disabled: page >= pages - 1, 'aria-label': '下一页', onclick: () => go(page + 1) }, '下一页 ›'))
  }
  return {
    el,
    slice(items) {
      total = items.length
      pages = Math.max(1, Math.ceil(total / size))
      page = Math.min(page, pages - 1)
      draw()
      return items.slice(page * size, (page + 1) * size)
    },
    reset() { page = 0 },
    /** Jump to the page holding `index` (e.g. the selected item); ignored when not found. */
    reveal(index) { if (index >= 0) page = Math.floor(index / size) },
  }
}

/** A self-contained paged list: `render(pageItems)` returns the content for one page. */
export function paged(items, render, options) {
  const body = h('div')
  const p = pager(() => draw(), options)
  const wrap = h('div', { class: 'paged' }, body, p.el)
  const draw = () => mount(body, render(p.slice(items)))
  draw()
  return wrap
}

export function tabs(items, active, onpick) {
  return h('div', { class: 'tabs' }, items.map(([id, label]) => h('button', { class: id === active ? 'on' : '', onclick: () => onpick(id) }, label)))
}

/** Simple bar chart: [[label, value]]. */
export function bars(data, format = v => v) {
  const max = Math.max(1e-9, ...data.map(d => d[1]))
  return h('div', { class: 'bars' }, data.map(([label, v]) => h('div', { class: 'b', title: `${label}：${format(v)}` },
    h('div', { class: 'small muted' }, v ? format(v) : ''),
    h('div', { class: 'fill', style: { height: `${(v / max) * 100}%` } }),
    h('div', { class: 'lab' }, label),
  )))
}

export function meter(used, limit) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0
  return h('div', { class: `meter ${pct > 85 ? 'hot' : ''}` }, h('div', { style: { width: `${pct}%` } }))
}
