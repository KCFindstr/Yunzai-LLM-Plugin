import { get } from '../api.js'
import { menuButton } from '../main.js'
import { h, mount } from '../ui.js'

const LEVELS = [['', '全部级别'], ['error', '错误 · ERROR'], ['warn', '警告 · WARN'], ['mark', '重要 · MARK'], ['info', '信息 · INFO'], ['debug', '调试 · DEBUG']]

export async function render(root) {
  let after = 0, level = '', search = '', paused = false, stopped = false, busy = false, generation = 0, lines = [], reload = false
  const box = h('div', { class: 'log', 'aria-label': '日志内容' })
  const status = h('span', { class: 'small muted log-status', role: 'status' })
  const nodes = new Map()
  let pendingDraw = false
  const placeholder = h('div', { class: 'empty' })
  function selectingLogs() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return false
    for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(box)) return true
    return false
  }
  function selectionChanged() {
    if (pendingDraw && !selectingLogs()) draw()
  }
  function highlighted(text) {
    if (!search) return text
    const pieces = [], lower = text.toLowerCase()
    let offset = 0, found
    while ((found = lower.indexOf(search, offset)) !== -1) {
      pieces.push(text.slice(offset, found), h('mark', text.slice(found, found + search.length)))
      offset = found + search.length
    }
    return [...pieces, text.slice(offset)]
  }
  function draw(force = false) {
    if (stopped) return
    if (!force && selectingLogs()) {
      pendingDraw = true
      status.textContent = `正在选择文本 · ${paused ? '已暂停接收' : '新日志暂存，取消选择后显示'}`
      return
    }
    if (force && selectingLogs()) window.getSelection().removeAllRanges()
    pendingDraw = false
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30, scroll = box.scrollTop
    const visible = lines.filter(line => (!level || line.level === level) && (!search || line.text.toLowerCase().includes(search)))
    const children = visible.length ? visible.map(line => {
      if (!nodes.has(line.seq)) nodes.set(line.seq, h('div', { class: `l ${line.level}`, 'data-seq': line.seq },
        h('time', { class: 't' }, new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })),
        h('span', { class: 'log-level' }, line.level.toUpperCase()), h('span', { class: 'log-message' }, highlighted(line.text))))
      return nodes.get(line.seq)
    }) : [placeholder]
    placeholder.textContent = lines.length ? '没有匹配的日志' : '暂无日志'
    // Keep existing rows attached: replacing or re-appending them destroys browser selections.
    const retained = new Set(children)
    for (const child of [...box.childNodes]) if (!retained.has(child)) child.remove()
    children.forEach((child, index) => {
      const before = box.childNodes[index]
      if (before !== child) box.insertBefore(child, before ?? null)
    })
    status.textContent = `显示 ${visible.length} / ${lines.length} 条 · ${paused ? '已暂停接收' : '每 2 秒更新'}`
    box.scrollTop = stick ? box.scrollHeight : scroll
  }
  async function poll(force = false) {
    if (stopped || busy || (paused && !force)) return
    busy = true
    const current = generation
    try {
      // Advance across every level; changing filters never discards or refetches other levels.
      const batch = await get(`/api/logs?after=${after}`)
      if (stopped || current !== generation) return
      if (batch.length) {
        after = batch.at(-1).seq
        lines = [...lines, ...batch].slice(-1000)
        const retained = new Set(lines.map(line => line.seq))
        for (const key of nodes.keys()) if (!retained.has(key)) nodes.delete(key)
      }
      draw()
    } catch (error) { if (!stopped && current === generation) status.textContent = `更新失败：${error.message}` }
    finally { busy = false; if (reload && !stopped) { reload = false; void poll(true) } }
  }
  const pauseBtn = h('button', { class: 'btn', onclick: () => {
    paused = !paused; pauseBtn.textContent = paused ? '继续接收' : '暂停接收'; draw(); if (!paused) void poll()
  } }, '暂停接收')
  const clearBtn = h('button', { class: 'btn', onclick: () => {
    generation++; after = 0; lines = []; nodes.clear(); draw(true)
    if (busy) reload = true; else void poll(true)
  } }, '清屏重载')
  const searchInput = h('input', { type: 'search', placeholder: '搜索日志内容…', 'aria-label': '搜索日志内容', oninput: e => {
    search = e.target.value.trim().toLowerCase(); nodes.clear(); draw(true)
  } })
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '日志'), h('span', { class: 'spacer' }), pauseBtn, clearBtn),
    h('div', { class: 'log-toolbar' },
      h('label', h('span', { class: 'small muted' }, '日志级别'), h('select', { 'aria-label': '日志级别', onchange: e => { level = e.target.value; draw(true) } }, LEVELS.map(([value, label]) => h('option', { value }, label)))),
      h('label', { class: 'log-search' }, h('span', { class: 'small muted' }, '内容搜索'), searchInput),
      h('button', { class: 'btn ghost', onclick: () => { searchInput.value = ''; search = ''; nodes.clear(); draw(true); searchInput.focus() } }, '清除搜索')),
    h('div', { class: 'log-meta' }, status, h('details', { class: 'quiet-details' }, h('summary', '调试设置'), h('p', '设置 YZ_LLM_DEBUG=1 后重启机器人以记录调试日志。'))), box)
  document.addEventListener('selectionchange', selectionChanged)
  await poll()
  const timer = setInterval(() => void poll(), 2000)
  return () => { stopped = true; generation++; clearInterval(timer); document.removeEventListener('selectionchange', selectionChanged) }
}
