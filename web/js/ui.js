/** Tiny DOM helpers: h() builds elements, plus toast / modal / formatting. No framework. */

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

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg)
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
    const close = v => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v) }
    const onKey = e => { if (e.key === 'Escape') close(undefined) }
    const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(undefined) } },
      h('div', { class: 'modal', role: 'dialog' },
        h('header', title),
        h('div', { class: 'body' }, body),
        h('footer', actions.map(a => h('button', { class: `btn ${a.kind ?? ''}`, onclick: async () => {
          if (a.run) { const r = await a.run(); if (r === false) return }
          close(a.value)
        } }, a.label))),
      ))
    document.addEventListener('keydown', onKey)
    document.body.append(bg)
    bg.querySelector('input, textarea')?.focus()
  })
}

export async function confirmDanger(text, label = '确定') {
  return (await modal('请确认', h('p', text), [{ label: '取消', value: false }, { label, kind: 'primary danger', value: true }])) === true
}

/** Prompt for one or more text fields; resolves with { name: value } or undefined. */
export async function promptFields(title, fields, okLabel = '确定') {
  const inputs = {}
  const body = h('div', { class: 'col' }, fields.map(f => h('label', { class: 'col', style: { gap: '4px' } },
    h('span', { class: 'small muted' }, f.label),
    inputs[f.name] = f.multiline
      ? h('textarea', { class: f.code ? 'code' : '', rows: f.rows ?? 8, placeholder: f.placeholder ?? '' }, f.value ?? '')
      : h('input', { type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '', list: f.list }),
  )))
  const ok = await modal(title, body, [{ label: '取消', value: false }, { label: okLabel, kind: 'primary', value: true }])
  if (!ok) return undefined
  return Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))
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

export function switchEl(checked, onchange) {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onchange(input.checked, input) })
  return h('label', { class: 'switch' }, input, h('span'))
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
