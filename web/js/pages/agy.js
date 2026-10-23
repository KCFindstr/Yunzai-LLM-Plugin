import { enc, get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, icon, mount, spinner } from '../ui.js'

const STATUS = {
  queued: ['排队中', 'accent'], running: ['执行中', 'accent'], waiting: ['等待回复', 'warn'],
  completed: ['已完成', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', ''], interrupted: ['已中断', 'warn'],
}
const EVENT = {
  request: ['任务请求', 'chat'], progress: ['进度', 'clock'], response: ['AGY 响应', 'models'],
  tool: ['工具调用', 'tools'], report: ['执行结果', 'check'], reply: ['对话回复', 'chat'],
  error: ['执行错误', 'alert'], cancel: ['已取消', 'close'],
}

function timelineEvent(event, open) {
  const [label, ico] = EVENT[event.kind] ?? ['记录', 'logs']
  return h('article', { class: `computer-event ${event.isError ? 'event-error' : ''}` },
    h('span', { class: 'computer-event-icon' }, icon(ico, 16)),
    h('div', { class: 'computer-event-content' },
      h('div', { class: 'computer-event-head' }, h('strong', label),
        event.step != null ? badge(`第 ${event.step} 轮`) : null,
        event.tool ? badge(event.tool) : null,
        event.phase === 'running' ? badge('开始执行', 'accent') : event.phase === 'completed' ? badge(event.isError ? '失败' : '已返回', event.isError ? 'bad' : '') : null,
        event.delivery === 'sent' ? badge('已发送', 'ok') : event.delivery === 'failed' ? badge('发送失败，可能部分送达', 'bad') : event.delivery === 'none' ? badge('未发送') : null,
        h('time', { class: 'small muted', dateTime: new Date(event.at).toISOString() }, fmt.time(event.at))),
      event.text ? h('pre', { class: event.isError ? 'small bad' : 'small' }, event.text) : null,
      event.model || event.ms != null || event.inputTokens != null ? h('div', { class: 'small muted' },
        [event.model, event.ms != null ? fmt.dur(event.ms) : null, event.inputTokens != null ? `输入 ${fmt.num(event.inputTokens)} / 输出 ${fmt.num(event.outputTokens)}` : null].filter(Boolean).join(' · ')) : null,
      event.args ? h('details', { class: 'computer-arguments', 'data-seq': event.seq, open }, h('summary', '查看调用参数'), h('pre', { class: 'small mono' }, event.args)) : null,
    ))
}

export async function render(root, [id]) {
  let jobs = await get('/api/agy')
  let selected = jobs.find(job => job.id === id) ?? (id ? undefined : jobs[0])
  let stopped = false, busy = false, snapshot = '', listSnapshot = ''
  const list = h('div', { class: 'pane-list computer-job-list' })
  const detail = h('div', { class: 'computer-job-detail' })
  const connection = h('span', { class: 'small muted', role: 'status' }, '每 3 秒自动更新')
  const refreshButton = h('button', { class: 'btn', onclick: () => refresh() }, icon('refresh', 16), '刷新')

  function drawList() {
    const key = JSON.stringify(jobs)
    if (key === listSnapshot) return
    listSnapshot = key
    mount(list, h('div', { class: 'section-heading' }, h('h2', '任务列表'), badge(`${jobs.length} 个`)),
      jobs.length ? jobs.map(job => {
        const [label, kind] = STATUS[job.status] ?? [job.status, '']
        return h('a', { class: `list-item computer-job ${job.id === selected?.id ? 'sel' : ''}`, href: `#/agy/${enc(job.id)}`, 'aria-current': job.id === selected?.id ? 'page' : undefined },
          h('div', { class: 'row' }, badge(label, kind), h('span', { class: 'small muted right' }, fmt.ago(job.updatedAt))),
          h('strong', { class: 'clamp' }, job.task), h('span', { class: 'small muted mono' }, job.id))
      }) : empty('还没有 AGY 任务'))
  }

  async function drawDetail() {
    if (!selected) return mount(detail, card(null, empty(id ? '任务不存在或已清理' : '在聊天中使用 AGY 后，可在这里查看进度和结果。')))
    const job = selected
    const history = await get(`/api/agy/${enc(job.id)}/history`)
    if (stopped) return
    const key = JSON.stringify([job, history.events.at(-1)?.seq, history.dropped])
    if (snapshot === key) return
    snapshot = key
    const opened = new Set([...detail.querySelectorAll('details[open][data-seq]')].map(el => Number(el.dataset.seq)))
    const [label, kind] = STATUS[job.status] ?? [job.status, '']
    const replies = history.events.filter(event => event.kind === 'reply')
    const execution = history.events.filter(event => event.kind !== 'reply')
    mount(detail,
      card(h('span', { class: 'card-title' }, icon('models'), '任务详情', badge(label, kind)),
        h('pre', { class: 'computer-task-text' }, job.task),
        h('div', { class: 'row small muted', style: { marginTop: '12px' } }, h('span', `创建 ${fmt.time(job.createdAt)}`), h('span', `更新 ${fmt.ago(job.updatedAt)}`)),
        job.requesterText && job.requesterText !== job.task ? h('details', { class: 'computer-arguments' }, h('summary', '原始用户请求'), h('pre', { class: 'small' }, job.requesterText)) : null,
        job.progress ? h('div', { class: 'computer-progress small', role: 'status' }, icon('clock', 16), job.progress) : null,
        h('div', { class: 'small muted', style: { marginTop: '10px' } },
          [job.modelId, job.steps != null ? `${job.steps} 轮` : null, job.inputTokens != null ? `输入 ${fmt.num(job.inputTokens)} / 输出 ${fmt.num(job.outputTokens)}` : null,
            job.inputImageCount ? `${job.inputImageCount} 张输入图片` : null].filter(Boolean).join(' · ')),
        job.deliveryError ? h('p', { class: 'small bad' }, '结果未能完整送达聊天，请查看下方对话回复记录。') : null,
        ['queued', 'running', 'waiting'].includes(job.status) ? h('button', { class: 'btn danger', style: { marginTop: '12px' }, onclick: async () => {
          if (await confirmDanger('取消这个 AGY 任务？')) {
            await act(() => post(`/api/agy/${enc(job.id)}/cancel`), '已取消')
            await refresh()
          }
        } }, '取消任务') : null),
      card(h('span', { class: 'card-title' }, icon('check'), '执行结果'),
        job.report ? h('pre', { class: 'small' }, job.report) : empty(['queued', 'running'].includes(job.status) ? '执行结束后会显示结果。' : '此任务没有保存执行结果。')),
      card(h('span', { class: 'card-title' }, icon('chat'), '对话回复'),
        replies.length ? replies.map(event => timelineEvent(event, false)) : empty(job.progress && !['queued', 'running'].includes(job.status) ? '正在整理并发送回复…' : '还没有保存对话回复。')),
      card(h('span', { class: 'card-title' }, icon('logs'), '执行记录', badge(`${execution.length} 条`)),
        h('p', { class: 'small muted', style: { marginBottom: '16px' } }, '记录可见响应、工具调用与结果；敏感信息已过滤。'),
        history.dropped ? h('p', { class: 'small warn' }, `较早的 ${history.dropped} 条记录已超过保留上限，以下为最近记录。`) : null,
        execution.length ? h('div', { class: 'computer-timeline' }, execution.map(event => timelineEvent(event, opened.has(event.seq))))
          : empty('此任务尚无详细记录。已有任务仍可查看保存的结果，新执行或继续的任务会记录执行过程。')),
    )
  }

  async function refresh() {
    if (stopped || busy) return
    busy = true
    refreshButton.disabled = true
    try {
      jobs = await get('/api/agy')
      if (stopped) return
      selected = jobs.find(job => job.id === (selected?.id ?? id)) ?? (id ? undefined : jobs[0])
      drawList()
      await drawDetail()
      connection.textContent = '每 3 秒自动更新'
    } catch (error) { if (!stopped) connection.textContent = `更新失败：${error.message}，将自动重试` }
    finally { busy = false; refreshButton.disabled = false }
  }

  mount(root, h('div', { class: 'page-head' }, menuButton(), h('h1', 'AGY 任务'), h('span', { class: 'spacer' }), connection, refreshButton),
    h('div', { class: 'split computer-split' }, list, detail))
  drawList()
  mount(detail, card(null, h('div', { class: 'empty loading' }, spinner(), '加载执行记录…')))
  try { await drawDetail() } catch (error) { mount(detail, card(null, empty(`加载失败：${error.message}`))) }
  const timer = setInterval(refresh, 3000)
  return () => { stopped = true; clearInterval(timer) }
}
