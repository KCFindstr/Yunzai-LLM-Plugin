import { get, post, setUnauthorizedHandler } from './api.js'
import { h, mount, toast } from './ui.js'

const PAGES = [
  ['overview', '概览', '◎', () => import('./pages/overview.js')],
  ['usage', '用量与额度', '＄', () => import('./pages/usage.js')],
  ['conversations', '对话', '☰', () => import('./pages/conversations.js')],
  ['memory', '长期记忆', '✎', () => import('./pages/memory.js')],
  ['vectors', '向量空间', '✦', () => import('./pages/vectors.js')],
  ['personas', '人设', '☺', () => import('./pages/personas.js')],
  ['models', '模型', '⚙', () => import('./pages/models.js')],
  ['config', '配置', '≡', () => import('./pages/config.js')],
  ['stickers', '表情包', '❖', () => import('./pages/stickers.js')],
  ['tools', '工具与技能', '⚒', () => import('./pages/tools.js')],
  ['computer', '电脑任务', '▣', () => import('./pages/computer.js')],
  ['logs', '日志', '›_', () => import('./pages/logs.js')],
]

const app = document.getElementById('app')
let cleanup
let side

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}
try { applyTheme(localStorage.getItem('theme')) } catch {}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches
  const next = dark ? 'light' : 'dark'
  applyTheme(next)
  try { localStorage.setItem('theme', next) } catch {}
}

function login(message) {
  cleanup?.()
  cleanup = undefined
  const pw = h('input', { type: 'password', placeholder: '密码', autocomplete: 'current-password' })
  const err = h('div', { class: 'small bad' }, message ?? '')
  const submit = async e => {
    e.preventDefault()
    try {
      await post('/api/login', { password: pw.value })
      shell()
    } catch (x) {
      err.textContent = x.message
      pw.select()
    }
  }
  mount(app, h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: submit },
    h('div', { class: 'row' }, h('img', { src: 'favicon.svg', width: 32, height: 32 }), h('h1', 'LLM 管理面板')),
    h('div', { class: 'small muted' }, '密码在 web.password 设置；留空时首次启动会随机生成并打印在 Yunzai 日志中（也保存在 data/web-auth.json）。'),
    pw, err,
    h('button', { class: 'btn primary', type: 'submit' }, '登录'),
  )))
  pw.focus()
}

function shell() {
  const nav = h('nav', { class: 'nav' }, PAGES.map(([id, label, ico]) => h('a', { href: `#/${id}`, 'data-id': id }, h('span', { class: 'ico' }, ico), label)))
  side = h('aside', { class: 'side' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg' }), 'Yunzai LLM'),
    nav,
    h('div', { class: 'grow' }),
    h('div', { class: 'side-foot' },
      h('button', { class: 'btn sm', onclick: toggleTheme, title: '切换深色/浅色' }, '◐ 主题'),
      h('button', { class: 'btn sm', onclick: async () => { await post('/api/logout'); login() } }, '退出'),
    ),
  )
  const main = h('main', { class: 'main', id: 'page' })
  mount(app, h('div', { class: 'shell' }, side, main))
  route()
}

export function menuButton() {
  return h('button', { class: 'btn menu-btn', onclick: () => side?.classList.toggle('open') }, '☰')
}

let navSeq = 0

async function route() {
  const page = document.getElementById('page')
  if (!page) return
  const nav = ++navSeq
  const [, id = 'overview', ...rest] = location.hash.split('/')
  const entry = PAGES.find(p => p[0] === id) ?? PAGES[0]
  side?.classList.remove('open')
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('on', a.dataset.id === entry[0])
  cleanup?.()
  cleanup = undefined
  // each navigation renders into its own container; a slower, superseded page must not overwrite a newer one
  // the spinner lives inside the view: pages replace it when they mount their content
  const view = h('div', h('div', { class: 'empty' }, h('span', { class: 'spin' })))
  mount(page, view.cloneNode(true))
  const attach = () => { if (nav === navSeq && view.parentNode !== page) mount(page, view) }
  try {
    const mod = await entry[3]()
    if (nav !== navSeq) return
    // pages that draw before their first await (canvas sizing, live logs) need to be in the DOM already
    attach()
    const c = await mod.render(view, rest.map(decodeURIComponent))
    if (nav !== navSeq) { if (typeof c === 'function') c(); return }
    attach()
    cleanup = typeof c === 'function' ? c : undefined
  } catch (err) {
    if (nav === navSeq && err.message !== '登录已失效') {
      mount(page, h('div', { class: 'card' }, h('h2', '加载失败'), h('pre', err.message)))
      toast(err.message, 'bad')
    }
  }
}

setUnauthorizedHandler(() => login('登录已失效，请重新登录'))
window.addEventListener('hashchange', route)

get('/api/overview').then(shell, () => login())
