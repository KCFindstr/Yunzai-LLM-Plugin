import { enc, get } from '../api.js'
import { menuButton } from '../main.js'
import { badge, card, empty, fmt, h, icon, mount, spinner } from '../ui.js'

const STATUS = {
  queued: ['排队中', 'accent'], running: ['执行中', 'accent'], completed: ['已完成', 'ok'],
  failed: ['失败', 'bad'], blocked: ['额度不足', 'warn'], interrupted: ['已中断', 'warn'],
}
const EVENT = {
  request: ['用户输入', 'chat'], progress: ['进度', 'clock'], response: ['模型响应', 'models'],
  tool: ['工具调用', 'tools'], reply: ['最终回复', 'check'], error: ['执行错误', 'alert'],
}
const SOURCE = { chat: '聊天', agy: 'AGY 结果回复', computer: '电脑任务结果回复' }

function timelineEvent(event, opened) {
  const [label, ico] = EVENT[event.kind] ?? ['记录', 'logs']
  return h('article', { class: `computer-event ${event.isError ? 'event-error' : ''}` },
    h('span', { class: 'computer-event-icon' }, icon(ico, 16)),
    h('div', { class: 'computer-event-content' },
      h('div', { class: 'computer-event-head' }, h('strong', label),
        event.step != null ? badge(`第 ${event.step} 轮`) : null,
        event.tool ? badge(event.tool) : null,
        event.phase ? badge(event.phase === 'running' ? '开始执行' : event.phase === 'skipped' ? '未执行' : event.isError ? '失败' : '已返回', event.isError ? 'bad' : event.phase === 'skipped' ? 'warn' : '') : null,
        h('time', { class: 'small muted', dateTime: new Date(event.at).toISOString() }, fmt.time(event.at))),
      event.text ? h('pre', { class: event.isError ? 'small bad' : 'small' }, event.text) : null,
      event.ms != null || event.inputTokens != null ? h('div', { class: 'small muted' },
        [event.ms != null ? fmt.dur(event.ms) : null, event.inputTokens != null ? `输入 ${fmt.num(event.inputTokens)} / 输出 ${fmt.num(event.outputTokens)}` : null].filter(Boolean).join(' · ')) : null,
      event.callId ? h('div', { class: 'small muted mono' }, `调用 ${event.callId}`) : null,
      event.args ? h('details', { class: 'computer-arguments', 'data-seq': event.seq, open: opened.has(event.seq) },
        h('summary', '查看调用参数'), h('pre', { class: 'small mono' }, event.args)) : null,
    ))
}

export async function render(root, [id]) {
  let rollouts = await get('/api/rollouts')
  let selected = id ?? rollouts[0]?.id
  let stopped = false, busy = false, snapshot = '', listSnapshot = '', filter = ''
  const items = h('div')
  const list = h('div', { class: 'pane-list computer-job-list' },
    h('div', { class: 'section-heading' }, h('h2', '执行列表')),
    h('input', { type: 'search', placeholder: '筛选输入、会话或模型…', 'aria-label': '筛选执行记录', style: { width: '100%', marginBottom: '12px' }, oninput: e => {
      filter = e.target.value.toLowerCase(); drawList()
    } }), items)
  const detail = h('div', { class: 'computer-job-detail rollout-detail' })
  const connection = h('span', { class: 'small muted', role: 'status' }, '每 3 秒自动更新')
  const refreshButton = h('button', { class: 'btn', onclick: () => refresh() }, icon('refresh', 16), '刷新')

  function drawList() {
    const key = JSON.stringify([rollouts, selected, filter])
    if (key === listSnapshot) return
    listSnapshot = key
    const visible = rollouts.filter(r => !filter || `${r.input} ${r.label} ${r.model ?? ''} ${r.id}`.toLowerCase().includes(filter))
    mount(items, visible.length ? visible.map(r => {
      const [label, kind] = STATUS[r.status] ?? [r.status, '']
      return h('a', { class: `list-item computer-job ${r.id === selected ? 'sel' : ''}`, href: `#/rollouts/${enc(r.id)}`, 'aria-current': r.id === selected ? 'page' : undefined },
        h('div', { class: 'row' }, badge(label, kind), h('span', { class: 'small muted right' }, fmt.short(r.createdAt))),
        h('strong', { class: 'clamp' }, r.input),
        h('span', { class: 'small muted clamp' }, r.label),
        h('span', { class: 'small muted' }, [r.model, `${r.steps} 轮`, fmt.usd(r.cost)].filter(Boolean).join(' · ')))
    }) : empty(filter ? '没有匹配的执行记录' : '还没有执行记录。新的聊天请求会自动记录。'))
  }

  async function drawDetail() {
    if (!selected) return mount(detail, card(null, empty('新的聊天请求会在这里显示模型响应、工具调用与最终回复。此前的对话摘要仍可在“对话”中查看。')))
    let r
    try { r = await get(`/api/rollouts/${enc(selected)}/history`) }
    catch (error) {
      if (error.status !== 404) throw error
      if (!stopped) mount(detail, card(null, empty('执行记录不存在或已清理')))
      return
    }
    if (stopped) return
    const key = JSON.stringify(r)
    if (snapshot === key) return
    snapshot = key
    const opened = new Set([...detail.querySelectorAll('details[open][data-seq]')].map(el => Number(el.dataset.seq)))
    const [label, kind] = STATUS[r.status] ?? [r.status, '']
    const execution = r.events.filter(event => event.kind !== 'reply')
    const progress = r.events.at(-1)
    mount(detail,
      card(h('span', { class: 'card-title' }, icon('layers'), '执行详情', badge(label, kind)),
        h('pre', { class: 'computer-task-text' }, r.input),
        h('div', { class: 'row small muted', style: { marginTop: '12px' } },
          h('a', { href: `#/conversations/${enc(r.conv)}` }, r.label), h('span', SOURCE[r.source]), h('time', fmt.time(r.createdAt))),
        h('div', { class: 'small muted', style: { marginTop: '10px' } },
          [r.model, `${r.steps} 轮`, fmt.dur(r.ms), fmt.usd(r.cost), r.inputImageCount ? `${r.inputImageCount} 张输入图片` : null].filter(Boolean).join(' · ')),
        r.tokens ? h('p', { class: 'small muted' }, `输入 ${fmt.num(r.tokens.input)} / 缓存 ${fmt.num(r.tokens.cacheRead)} / 输出 ${fmt.num(r.tokens.output)}`) : null,
        r.tokens?.inputIncomplete ? h('p', { class: 'small warn' }, '上游可能漏报历史输入与缓存用量，花费可能偏低。') : null,
        r.jobId ? h('a', { class: 'small', href: `#/${r.source === 'agy' ? 'agy' : 'computer'}/${enc(r.jobId)}` }, '查看来源任务 →') : null,
        ['running', 'queued'].includes(r.status) ? h('div', { class: 'computer-progress small', role: 'status' }, spinner(),
          r.status === 'queued' ? '等待处理' : progress?.kind === 'tool' ? `${progress.tool} ${progress.phase === 'running' ? '执行中' : '已返回'}` : progress?.text || '正在处理') : null),
      card(h('span', { class: 'card-title' }, icon('chat'), '最终回复'),
        r.reply ? h('pre', { class: 'small' }, r.reply) : empty(['queued', 'running'].includes(r.status) ? '执行结束后会显示最终回复。' : '本次执行没有生成最终回复。')),
      card(h('span', { class: 'card-title' }, icon('logs'), '执行记录', badge(`${execution.length} 条`)),
        h('p', { class: 'small muted', style: { marginBottom: '16px' } }, '记录可见响应、工具调用与结果；敏感信息已过滤。'),
        r.dropped ? h('p', { class: 'small warn' }, `较早的 ${r.dropped} 条记录已超过保留上限，以下为最近记录。`) : null,
        execution.length ? h('div', { class: 'computer-timeline' }, execution.map(event => timelineEvent(event, opened))) : empty('尚无详细执行记录。')),
    )
  }

  async function refresh() {
    if (stopped || busy) return
    busy = true; refreshButton.disabled = true
    try {
      rollouts = await get('/api/rollouts')
      if (stopped) return
      selected ??= id ?? rollouts[0]?.id
      drawList()
      await drawDetail()
      connection.textContent = '每 3 秒自动更新'
    } catch (error) { if (!stopped) connection.textContent = `更新失败：${error.message}，将自动重试` }
    finally { busy = false; refreshButton.disabled = false }
  }

  mount(root, h('div', { class: 'page-head' }, menuButton(), h('h1', '执行记录'), h('span', { class: 'spacer' }), connection, refreshButton),
    h('div', { class: 'split computer-split' }, list, detail))
  drawList()
  mount(detail, card(null, h('div', { class: 'empty loading' }, spinner(), '加载执行记录…')))
  try { await drawDetail() } catch (error) { mount(detail, card(null, empty(`加载失败：${error.message}`))) }
  const timer = setInterval(refresh, 3000)
  return () => { stopped = true; clearInterval(timer) }
}
