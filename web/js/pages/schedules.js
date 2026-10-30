import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, icon, mentionText, mount, pager, promptFields, stat, tabs } from '../ui.js'

const STATUS = { active: ['进行中', 'ok'], done: ['已完成', ''], cancelled: ['已取消', ''], failed: ['失败', 'bad'], missed: ['已错过', 'warn'] }
const REPEAT = [['none', '一次性'], ['daily', '每天'], ['weekdays', '每个工作日'], ['weekly', '每周'], ['interval', '按间隔']]

/** "YYYY-MM-DDTHH:mm" in the browser's time zone, for datetime-local inputs. */
const localInput = ts => new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 16)

const chatLabel = t => t.groupId ? `${t.groupName ?? '群'} ${t.groupId}` : '私聊'

async function edit(t, refresh) {
  const r = await promptFields(`编辑定时任务 ${t.id}`, [
    { name: 'task', label: '到点要做的事', value: t.task, multiline: true, rows: 4 },
    { name: 'nextAt', label: '下次执行时间（浏览器时区）', type: 'datetime-local', value: localInput(t.nextAt) },
    { name: 'repeat', label: '重复', value: t.repeat, options: REPEAT.map(([value, label]) => ({ value, label })) },
    { name: 'everyMinutes', label: '间隔分钟数（仅「按间隔」）', type: 'number', value: t.everyMinutes ?? '' },
  ], '保存', v => {
    if (!v.task.trim()) return '任务内容不能为空'
    if (!v.nextAt || !Number.isFinite(new Date(v.nextAt).getTime())) return '请选择时间'
    if (v.repeat === 'interval' && !(Number(v.everyMinutes) > 0)) return '请填写间隔分钟数'
  })
  if (!r) return
  const body = { task: r.task, nextAt: new Date(r.nextAt).getTime(), repeat: r.repeat, everyMinutes: r.repeat === 'interval' ? Number(r.everyMinutes) : undefined }
  if (await act(() => put(`/api/schedules/${enc(t.id)}`, body), '已保存')) refresh()
}

export async function render(root, [tabArg]) {
  const tab = ['active', 'ended', 'all'].includes(tabArg) ? tabArg : 'active'
  const data = await get('/api/schedules')
  const tasks = data.tasks
  const active = tasks.filter(t => t.status === 'active').sort((a, b) => a.nextAt - b.nextAt)
  const ended = tasks.filter(t => t.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = tab === 'active' ? active : tab === 'ended' ? ended : [...active, ...ended]
  let filter = ''
  const refresh = () => render(root, [tab])

  const body = h('div')
  const pages = pager(() => draw(), { size: 20, anchor: () => body })
  const row = t => {
    const [label, kind] = STATUS[t.status] ?? [t.status, '']
    return h('tr',
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, t.status === 'active' ? [fmt.time(t.nextAt), h('div', { class: 'muted' }, fmt.dur(Math.max(0, t.nextAt - Date.now())), ' 后')] : h('span', { class: 'muted' }, fmt.time(t.lastRunAt ?? t.updatedAt))),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, t.repeatText),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, chatLabel(t)),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, t.userName, h('div', { class: 'muted mono' }, t.userId)),
      h('td', { class: 'small', style: { minWidth: '220px', whiteSpace: 'pre-wrap' } }, mentionText(t.task),
        t.lastError ? h('div', { class: 'bad', style: { marginTop: '4px' } }, t.lastError)
          : t.lastResult ? h('div', { class: 'muted', style: { marginTop: '4px' } }, '上次：', mentionText(t.lastResult)) : null),
      h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, t.running ? badge('执行中', 'run') : badge(label, kind), t.runs ? h('div', { class: 'muted' }, `已执行 ${t.runs} 次`) : null,
        t.lastRolloutId ? h('a', { class: 'small', href: `#/rollouts/${enc(t.lastRolloutId)}` }, '执行记录 →') : null),
      h('td', { style: { whiteSpace: 'nowrap' } }, t.status === 'active'
        ? [h('button', { class: 'btn sm ghost', disabled: t.running, onclick: () => edit(t, refresh) }, '编辑'),
          h('button', { class: 'btn sm ghost danger', onclick: async () => {
            if (await confirmDanger(`取消定时任务「${t.task.slice(0, 30)}」？`, '取消任务') && await act(() => post(`/api/schedules/${enc(t.id)}/cancel`), '已取消')) refresh()
          } }, '取消')]
        : h('button', { class: 'btn sm ghost danger', onclick: async () => {
          if (await confirmDanger('删除这条记录？') && await act(() => del(`/api/schedules/${enc(t.id)}`), '已删除')) refresh()
        } }, '删除')))
  }
  const draw = () => {
    const q = filter.toLowerCase()
    const list = shown.filter(t => !q || `${t.task} ${t.id} ${t.userName} ${t.userId} ${t.groupId ?? ''} ${t.groupName ?? ''}`.toLowerCase().includes(q))
    mount(body, list.length ? h('div', { class: 'table-wrap' }, h('table',
      h('thead', h('tr', h('th', tab === 'ended' ? '结束时间' : '下次执行'), h('th', '重复'), h('th', '对话'), h('th', '发起人'), h('th', '任务'), h('th', '状态'), h('th', '操作'))),
      h('tbody', pages.slice(list).map(row)))) : empty(q ? '没有匹配的定时任务' : tab === 'active' ? '没有进行中的定时任务。在聊天中对机器人说「10分钟后提醒我…」即可创建。' : '没有记录'),
    list.length ? pages.el : null)
  }
  draw()

  const limits = data.limits
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '定时任务'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: refresh }, icon('refresh', 16), '刷新')),
    h('div', { class: 'stats' },
      stat('进行中', active.length, limits.enable ? `每人最多 ${limits.maxPerUser} 个` : 'schedule 工具已关闭'),
      stat('24 小时内', active.filter(t => t.nextAt - data.now < 86400_000).length),
      stat('重复任务', active.filter(t => t.repeat !== 'none').length),
      stat('已结束', ended.length, '保留 30 天')),
    tabs([['active', `进行中（${active.length}）`], ['ended', `已结束（${ended.length}）`], ['all', '全部']], tab, id => { location.hash = `#/schedules/${id}` }),
    card(null,
      h('input', { type: 'search', placeholder: '筛选任务、发起人、群号或 ID…', 'aria-label': '筛选定时任务', style: { width: '100%', marginBottom: '12px' },
        oninput: e => { filter = e.target.value; pages.reset(); draw() } }),
      body,
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, '时间按浏览器时区显示；机器人按北京时间计算「每天 / 工作日」。到点时机器人在原对话里执行任务并回复。')),
  )
}
