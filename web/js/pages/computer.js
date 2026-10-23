import { enc, get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, icon, modal, mount, spinner, textBlock } from '../ui.js'

const STATUS = {
  queued: ['排队中', 'accent'], running: ['执行中', 'accent'], waiting: ['等待回复', 'warn'],
  completed: ['已完成', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', ''], interrupted: ['已中断', 'warn'],
}
const EVENT = { request: ['用户请求', 'persona'], response: ['电脑代理', 'models'], tool: ['工具结果', 'tools'], report: ['代理报告', 'check'], reply: ['对话回复', 'chat'], error: ['执行错误', 'alert'] }

function screenshot(jobId, image, label) {
  const src = `/api/computer/${enc(jobId)}/images/${enc(image.id)}`
  const img = h('img', { src, alt: label, loading: 'lazy', onerror: () => {
    mount(button, icon('alert'), h('span', '截图不存在或已清理'))
    button.disabled = true
  } })
  const button = h('button', { class: 'computer-screenshot', 'aria-label': `放大${label}`, onclick: () => modal(label, h('div', { class: 'col' },
    h('img', { src, alt: label, style: { width: '100%', height: 'auto' } }), h('a', { href: src, target: '_blank', rel: 'noopener', class: 'small' }, '在新标签页打开原图 →'))) }, img, h('span', label, icon('computer', 14)))
  return button
}

function timelineEvent(job, event, open, expanded) {
  const [label, ico] = EVENT[event.kind] ?? ['记录', 'logs']
  const title = h('div', { class: 'computer-event-head' },
    h('strong', label), event.step != null ? badge(`第 ${event.step} 轮`) : null,
    event.tool ? badge(event.tool) : null,
    event.model ? h('span', { class: 'small muted' }, event.model) : null,
    event.delivery === 'sent' ? badge('已发送', 'ok') : event.delivery === 'failed' ? badge('发送失败，可能部分送达', 'bad') : event.delivery === 'none' ? badge('未发送') : null,
    h('time', { class: 'small muted', dateTime: new Date(event.at).toISOString() }, fmt.time(event.at)),
  )
  const contents = [
    event.text ? textBlock(event.text, { key: `computer-text:${event.seq}`, open: expanded.get(`computer-text:${event.seq}`), className: event.isError ? 'small bad' : 'small' }) : null,
    event.tools?.length ? h('div', { class: 'chips' }, event.tools.map(tool => badge(tool.name, 'accent'))) : null,
    event.ms != null ? h('div', { class: 'small muted' }, `${fmt.dur(event.ms)} · 输入 ${fmt.num(event.inputTokens)} / 输出 ${fmt.num(event.outputTokens)} · ${fmt.usd(event.cost)}`) : null,
    event.tools?.length || event.args ? h('details', { class: 'computer-arguments', 'data-seq': event.seq, open }, h('summary', '查看调用参数'),
      h('pre', { class: 'small mono' }, event.args || event.tools.map(tool => `${tool.name}\n${tool.args}`).join('\n\n'))) : null,
    event.images?.length ? h('div', { class: 'computer-images' }, event.images.map((image, i) => screenshot(job.id, image, `${event.kind === 'reply' ? '已发送' : '提供给对话模型的'}截图 ${i + 1}`)))
      : event.hasScreenshot ? h('span', { class: 'small muted' }, '截图已返回电脑代理；图片未保存（未选择分享或超过保留上限）。') : null,
  ]
  return h('article', { class: `computer-event ${event.isError ? 'event-error' : ''}` }, h('span', { class: 'computer-event-icon' }, icon(ico, 16)), h('div', { class: 'computer-event-content' }, title, contents))
}

export async function render(root, [id]) {
  let jobs = await get('/api/computer')
  let selected = jobs.find(job => job.id === id) ?? jobs[0]
  let stopped = false, busy = false, snapshot = '', listSnapshot = ''
  const list = h('div', { class: 'pane-list computer-job-list' })
  const detail = h('div', { class: 'computer-job-detail' })
  const connection = h('span', { class: 'small muted', role: 'status' }, '每 3 秒自动更新')
  const refreshButton = h('button', { class: 'btn', onclick: () => refresh() }, icon('refresh', 16), '刷新')

  function drawList() {
    const key = JSON.stringify(jobs)
    if (key === listSnapshot) return
    listSnapshot = key
    mount(list, h('div', { class: 'section-heading' }, h('h2', '任务列表'), badge(`${jobs.length} 个`)), jobs.map(job => {
      const [label, kind] = STATUS[job.status] ?? [job.status, '']
      return h('a', { class: `list-item computer-job ${job.id === selected?.id ? 'sel' : ''}`, href: `#/computer/${enc(job.id)}`, 'aria-current': job.id === selected?.id ? 'page' : undefined },
        h('div', { class: 'row' }, badge(label, kind), h('span', { class: 'small muted right' }, fmt.ago(job.updatedAt))),
        h('strong', { class: 'clamp' }, job.task), h('span', { class: 'small muted mono' }, job.id),
      )
    }))
  }

  async function drawDetail() {
    if (!selected) return mount(detail, card(null, empty('没有电脑任务')))
    const job = selected
    let history
    try { history = await get(`/api/computer/${enc(job.id)}/history`) }
    catch (error) {
      if (error.message !== '没有这个接口') throw error
      history = { events: [], dropped: 0, needsRestart: true }
    }
    if (stopped) return
    const key = JSON.stringify([job, history.events.at(-1)?.seq, history.dropped, history.needsRestart])
    if (snapshot === key) return
    snapshot = key
    const opened = new Set([...detail.querySelectorAll('details[open][data-seq]')].map(el => Number(el.dataset.seq)))
    const expanded = new Map([...detail.querySelectorAll('details[data-disclosure]')].map(el => [el.dataset.disclosure, el.open]))
    const [label, kind] = STATUS[job.status] ?? [job.status, '']
    const replies = history.events.filter(event => event.kind === 'reply')
    const sent = replies.flatMap(event => event.images ?? [])
    const missing = replies.reduce((count, event) => count + Math.max(0, (event.imageCount ?? event.images?.length ?? 0) - (event.images?.length ?? 0)), 0)
    mount(detail,
      card(h('span', { class: 'card-title' }, icon('computer'), '任务详情', badge(label, kind)),
        textBlock(job.task, { key: 'computer-request', open: expanded.get('computer-request'), className: 'computer-task-text' }),
        h('div', { class: 'row small muted', style: { marginTop: '12px' } }, `发起者 ${job.owner}`, `创建 ${fmt.time(job.createdAt)}`, `更新 ${fmt.ago(job.updatedAt)}`),
        job.requesterText && job.requesterText !== job.task ? h('details', { class: 'computer-arguments' }, h('summary', '原始用户请求'), h('pre', { class: 'small' }, job.requesterText)) : null,
        job.progress ? h('div', { class: 'computer-progress small' }, icon('clock', 16), job.progress) : null,
        job.steps != null ? h('div', { class: 'small muted', style: { marginTop: '10px' } }, `${job.modelId ?? ''} · ${job.steps} 轮 · 输入 ${fmt.num(job.inputTokens)} / 输出 ${fmt.num(job.outputTokens)}${job.costUsd != null ? ` · ${fmt.usd(job.costUsd)}` : ''}`) : null,
        job.report ? h('details', { class: 'computer-arguments', open: job.status === 'waiting' }, h('summary', job.status === 'waiting' ? '等待用户回复的问题' : '最新代理报告'), h('pre', { class: 'small' }, job.report)) : null,
        job.deliveryError ? h('p', { class: 'small bad' }, '结果未能完整送达聊天，请查看下方发送记录。') : null,
        ['queued', 'running', 'waiting'].includes(job.status) ? h('button', { class: 'btn danger', style: { marginTop: '12px' }, onclick: async () => {
          if (await confirmDanger('取消这个电脑任务？')) { await act(() => post(`/api/computer/${enc(job.id)}/cancel`), '已取消'); await refresh() }
        } }, '取消任务') : null,
      ),
      card(h('span', { class: 'card-title' }, icon('sticker'), '已发送的截图', badge(`${sent.length} 张`)),
        sent.length ? h('div', { class: 'computer-images' }, sent.map((image, i) => screenshot(job.id, image, `已发送的截图 ${i + 1}`))) : empty(missing ? '已发送的截图未能保留。' : '此任务还没有已发送的截图。'),
        missing ? h('p', { class: 'small muted' }, `${missing} 张已发送图片超过保留上限或未能保存。`) : null),
      card(h('span', { class: 'card-title' }, icon('chat'), '执行记录', badge(`${history.events.filter(event => event.kind === 'response').length} 轮`)),
        history.dropped ? h('p', { class: 'small warn' }, `较早的 ${history.dropped} 条记录已超过保留上限，以下为最近记录。`) : null,
        history.events.length ? h('div', { class: 'computer-timeline' }, history.events.map(event => timelineEvent(job, event, opened.has(event.seq), expanded))) : empty(history.needsRestart ? '重启机器人后启用执行记录。现有任务摘要仍可查看。' : '此任务没有保存详细记录。新执行或继续的任务将开始记录。'),
      ),
    )
  }

  async function refresh() {
    if (stopped || busy) return
    busy = true
    refreshButton.disabled = true
    try {
      jobs = await get('/api/computer')
      if (stopped) return
      selected = jobs.find(job => job.id === selected?.id) ?? jobs[0]
      drawList()
      await drawDetail()
      connection.textContent = '每 3 秒自动更新'
    } catch (error) { if (!stopped) connection.textContent = `更新失败：${error.message}，将自动重试` }
    finally { busy = false; refreshButton.disabled = false }
  }

  mount(root, h('div', { class: 'page-head' }, menuButton(), h('h1', '电脑任务'), h('span', { class: 'spacer' }), connection, refreshButton),
    h('div', { class: 'split computer-split' }, list, detail))
  drawList()
  mount(detail, card(null, h('div', { class: 'empty loading' }, spinner(), '加载执行记录…')))
  await drawDetail()
  const timer = setInterval(refresh, 3000)
  return () => { stopped = true; clearInterval(timer) }
}
