import { get, post, setUnauthorizedHandler } from './api.js'
import { h, icon, mount, toast } from './ui.js'

const PAGES = [
  ['overview', '概览', 'overview', () => import('./pages/overview.js'), '工作台'],
  ['usage', '用量与额度', 'usage', () => import('./pages/usage.js'), '工作台'],
  ['conversations', '对话', 'chat', () => import('./pages/conversations.js'), '对话与记忆'],
  ['memory', '长期记忆', 'memory', () => import('./pages/memory.js'), '对话与记忆'],
  ['roster', '群友称呼', 'users', () => import('./pages/roster.js'), '对话与记忆'],
  ['vectors', '向量空间', 'vectors', () => import('./pages/vectors.js'), '对话与记忆'],
  ['personas', '人设', 'persona', () => import('./pages/personas.js'), '模型与资源'],
  ['models', '模型', 'models', () => import('./pages/models.js'), '模型与资源'],
  ['stickers', '表情包', 'sticker', () => import('./pages/stickers.js'), '模型与资源'],
  ['tools', '工具与技能', 'tools', () => import('./pages/tools.js'), '模型与资源'],
  ['computer', '电脑任务', 'computer', () => import('./pages/computer.js'), '系统管理'],
  ['agy', '异步代理（AGY）', 'models', () => import('./pages/agy.js'), '系统管理'],
  ['config', '配置', 'settings', () => import('./pages/config.js'), '系统管理'],
  ['logs', '日志', 'logs', () => import('./pages/logs.js'), '系统管理'],
]

const app = document.getElementById('app')
let cleanup
let side
let backdrop
let navSeq = 0
let menuTrigger

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}
try { applyTheme(localStorage.getItem('theme')) } catch {}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(dark ? 'light' : 'dark')
  try { localStorage.setItem('theme', dark ? 'light' : 'dark') } catch {}
}

function setMenu(open, restoreFocus = false) {
  side?.classList.toggle('open', open)
  if (side) side.inert = !open && matchMedia('(max-width: 860px)').matches
  if (backdrop) backdrop.hidden = !open
  document.body.classList.toggle('menu-open', open)
  for (const button of document.querySelectorAll('.menu-btn')) button.setAttribute('aria-expanded', String(open))
  if (open) side?.querySelector('input')?.focus()
  else if (restoreFocus) menuTrigger?.focus()
}

function login(message) {
  ++navSeq
  cleanup?.()
  cleanup = undefined
  setMenu(false)
  side = undefined
  const pw = h('input', { id: 'password', type: 'password', placeholder: '请输入管理密码', autocomplete: 'current-password', required: true })
  const err = h('div', { class: 'small bad', role: 'alert' }, message ?? '')
  const button = h('button', { class: 'btn primary', type: 'submit' }, '登录管理面板', icon('arrow'))
  const submit = async e => {
    e.preventDefault()
    button.disabled = true
    err.textContent = ''
    try {
      await post('/api/login', { password: pw.value })
      shell()
    } catch (x) {
      err.textContent = x.message
      pw.select()
    } finally { button.disabled = false }
  }
  document.title = '登录 · Yunzai LLM'
  mount(app, h('div', { class: 'login' },
    h('div', { class: 'login-brand' }, h('img', { src: 'favicon.svg', alt: '', width: 40, height: 40 }), h('span', 'Yunzai LLM')),
    h('form', { class: 'card login-card', onsubmit: submit },
      h('div', { class: 'eyebrow' }, '管理工作区'),
      h('h1', '欢迎回来'),
      h('p', { class: 'muted login-intro' }, '登录后管理你的机器人、模型和对话。'),
      h('label', { class: 'col', for: 'password' }, h('span', { class: 'field-label' }, '管理密码'), pw),
      err, button,
      h('details', { class: 'login-help' }, h('summary', '在哪里找到密码？'),
        h('p', '密码在 web.password 设置。留空时，首次启动会生成密码并打印在 Yunzai 日志中，也会保存在 data/web-auth.json。')),
    ),
    h('span', { class: 'small muted' }, 'Yunzai LLM · 机器人管理面板'),
  ))
  pw.focus()
}

function shell() {
  const nav = h('nav', { class: 'nav', 'aria-label': '主导航' })
  const noResults = h('div', { class: 'nav-empty', role: 'status', hidden: true }, '没有匹配的页面')
  const search = h('input', { type: 'search', placeholder: '查找页面…', 'aria-label': '查找页面', oninput: () => {
    const q = search.value.trim().toLowerCase()
    let count = 0
    for (const section of nav.querySelectorAll('.nav-group')) {
      let visible = 0
      for (const a of section.querySelectorAll('a')) {
        a.hidden = !`${a.textContent} ${a.dataset.id}`.toLowerCase().includes(q)
        if (!a.hidden) visible++
      }
      section.hidden = visible === 0
      count += visible
    }
    noResults.hidden = count !== 0
  }, onkeydown: e => {
    if (e.key === 'Enter') nav.querySelector('a:not([hidden])')?.click()
  } })
  for (const group of new Set(PAGES.map(p => p[4]))) {
    nav.append(h('div', { class: 'nav-group' }, h('div', { class: 'nav-label' }, group),
      PAGES.filter(p => p[4] === group).map(([id, label, ico]) => h('a', { href: `#/${id}`, 'data-id': id, onclick: () => { if (location.hash === `#/${id}`) setMenu(false, true) } }, icon(ico), h('span', label), icon('chevron', 14))),
    ))
  }
  side = h('aside', { class: 'side', id: 'sidebar', 'aria-label': '工作区导航' },
    h('a', { class: 'brand', href: '#/overview', 'aria-label': 'Yunzai LLM 概览' },
      h('img', { src: 'favicon.svg', alt: '' }), h('div', h('strong', 'Yunzai LLM'), h('span', '机器人管理工作区'))),
    h('button', { class: 'btn side-close', 'aria-label': '关闭导航', onclick: () => setMenu(false, true) }, icon('close', 16)),
    h('div', { class: 'nav-search' }, icon('search', 16), search),
    nav, noResults,
    h('div', { class: 'grow' }),
    h('div', { class: 'side-foot' },
      h('div', { class: 'workspace-label' }, icon('layers', 16), h('span', '管理工作区')),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: toggleTheme, title: '切换深色/浅色主题', 'aria-label': '切换深色/浅色主题' }, icon('theme', 16), '切换主题'),
        h('button', { class: 'btn sm', onclick: async () => {
          try { await post('/api/logout'); login() } catch (err) { toast(err.message, 'bad') }
        } }, icon('logout', 16), '退出'),
      ),
    ),
  )
  backdrop = h('button', { class: 'nav-backdrop', hidden: true, tabindex: -1, 'aria-label': '关闭导航', onclick: () => setMenu(false, true) })
  const main = h('main', { class: 'main', id: 'page', tabindex: -1 })
  mount(app, h('div', { class: 'shell' },
    h('a', { class: 'skip-link', href: '#page', onclick: e => { e.preventDefault(); main.focus() } }, '跳到主要内容'),
    side, backdrop,
    h('div', { class: 'workspace' },
      h('header', { class: 'topbar' }, menuButton(),
        h('div', { class: 'breadcrumbs' }, h('span', '管理面板'), icon('chevron', 14), h('strong', { id: 'current-page' }, '概览')),
        h('span', { class: 'topbar-note' }, 'Yunzai LLM'),
      ), main,
    ),
  ))
  route()
}

export function menuButton() {
  return h('button', { class: 'btn menu-btn', 'aria-label': '打开导航', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onclick: e => {
    menuTrigger = e.currentTarget
    setMenu(!side?.classList.contains('open'))
  } }, icon('menu'))
}

async function route() {
  const page = document.getElementById('page')
  if (!page) return
  const nav = ++navSeq
  const [, id = 'overview', ...rest] = location.hash.split('/')
  const entry = PAGES.find(p => p[0] === id) ?? PAGES[0]
  const wasOpen = side?.classList.contains('open')
  setMenu(false)
  if (wasOpen) page.focus()
  for (const a of document.querySelectorAll('.nav a')) {
    a.classList.toggle('on', a.dataset.id === entry[0])
    if (a.dataset.id === entry[0]) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  document.getElementById('current-page').textContent = entry[1]
  document.title = `${entry[1]} · Yunzai LLM`
  cleanup?.()
  cleanup = undefined
  const view = h('div', { class: 'page-view', 'data-page': entry[0] }, h('div', { class: 'empty loading', role: 'status' }, h('span', { class: 'spin' }), '正在加载…'))
  mount(page, view.cloneNode(true))
  const attach = () => { if (nav === navSeq && view.parentNode !== page) mount(page, view) }
  try {
    const mod = await entry[3]()
    if (nav !== navSeq) return
    attach()
    const c = await mod.render(view, rest.map(decodeURIComponent))
    if (nav !== navSeq) { if (typeof c === 'function') c(); return }
    attach()
    cleanup = typeof c === 'function' ? c : undefined
  } catch (err) {
    if (nav === navSeq && err.message !== '登录已失效') {
      mount(page, h('div', { class: 'card error-state', role: 'alert' }, icon('alert', 28), h('h2', '页面暂时无法加载'), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn primary', onclick: route }, '重新加载')))
      toast(err.message, 'bad')
    }
  }
}

document.addEventListener('keydown', e => {
  if (!side?.classList.contains('open')) return
  if (e.key === 'Escape') { e.preventDefault(); setMenu(false, true) }
  if (e.key === 'Tab') {
    const items = [...side.querySelectorAll('a[href], button, input')].filter(el => !el.hidden && el.getClientRects().length)
    const first = items[0], last = items.at(-1)
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  }
})
matchMedia('(min-width: 861px)').addEventListener('change', () => setMenu(false))
setUnauthorizedHandler(() => login('登录已失效，请重新登录'))
window.addEventListener('hashchange', route)
get('/api/overview').then(shell, () => login())
