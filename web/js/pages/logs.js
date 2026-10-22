import { get } from '../api.js'
import { menuButton } from '../main.js'
import { h, mount } from '../ui.js'

const LEVELS = [['', '全部'], ['error', '错误'], ['warn', '警告'], ['mark', '重要'], ['info', '信息']]

export async function render(root) {
  let after = 0
  let level = ''
  let paused = false
  const box = h('div', { class: 'log' })
  const line = l => h('div', { class: `l ${l.level}` }, h('span', { class: 't' }, new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })), l.text)

  const poll = async () => {
    if (paused) return
    const lines = await get(`/api/logs?after=${after}${level ? `&level=${level}` : ''}`).catch(() => [])
    if (!lines.length) return
    after = lines.at(-1).seq
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30
    box.append(...lines.map(line))
    while (box.childElementCount > 1500) box.firstChild.remove()
    if (stick) box.scrollTop = box.scrollHeight
  }
  const restart = () => { after = 0; box.replaceChildren(); poll() }
  const pauseBtn = h('button', { class: 'btn', onclick: () => { paused = !paused; pauseBtn.textContent = paused ? '▶ 继续' : '❚❚ 暂停' } }, '❚❚ 暂停')

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '日志'), h('span', { class: 'spacer' }),
      h('select', { onchange: e => { level = e.target.value; restart() } }, LEVELS.map(([v, l]) => h('option', { value: v }, l))),
      pauseBtn, h('button', { class: 'btn', onclick: restart }, '清屏重载')),
    h('div', { class: 'small muted', style: { marginBottom: '8px' } }, '本插件最近 1000 行日志（调试日志需设置环境变量 YZ_LLM_DEBUG=1）'),
    box,
  )
  await poll()
  const timer = setInterval(poll, 2000)
  return () => clearInterval(timer)
}
