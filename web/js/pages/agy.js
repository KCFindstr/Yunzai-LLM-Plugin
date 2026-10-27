import { enc, get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, statusBadge, phaseBadge, card, confirmDanger, empty, fmt, h, icon, mount, pager, spinner, textBlock, responseSection, mentionText } from '../ui.js'

const EVENT = {
  request: ['任务请求', 'chat'], progress: ['进度', 'clock'], response: ['模型响应', 'models'],
  tool: ['工具调用', 'tools'], report: ['执行结果', 'check'], reply: ['对话回复', 'chat'],
  error: ['执行错误', 'alert'], cancel: ['已取消', 'close'],
}

function expandIndicator() {
  return h('span', { class: 'step-expand-badge', 'aria-hidden': 'true' },
    h('span', { class: 'when-closed' }, '展开详情'),
    h('span', { class: 'when-open' }, '收起'),
    icon('chevron', 12))
}

function timelineEntries(history) {
  const events = [], tools = new Map(), running = new Map()
  for (const event of history.events) {
    if (['request', 'context', 'report', 'reply'].includes(event.kind)) continue
    if (event.kind === 'progress' && ['正在准备共享附件', '正在启动宿主机工作进程', '模型已启动'].includes(event.text)) continue
    const key = event.kind === 'tool' ? event.index != null ? `index:${event.index}` : `tool:${event.tool ?? ''}` : undefined
    // Records saved before step indexes were stored: pair a result only with its tool's latest unfinished call.
    const first = key && (event.index != null ? tools.get(key) : event.phase === 'completed' ? running.get(key) : undefined)
    if (key && event.index == null) {
      if (event.phase === 'running') running.set(key, events.length)
      else running.delete(key)
    }
    if (first != null) {
      events[first] = {
        ...events[first],
        ...event,
        seq: events[first].seq,
        args: event.args || events[first].args,
        text: event.text && event.text !== '正在执行' ? event.text : events[first].text,
        phase: event.phase || events[first].phase,
      }
    } else {
      if (key) tools.set(key, events.length)
      events.push(event)
    }
  }
  return events
}

/** view: { opened, scope, settled, subagents, loadSubagent }; scope prefixes disclosure keys so nested subagent timelines keep their own state. */
function timelineEvent(event, view) {
  const { opened, scope = '' } = view
  const [label, ico] = EVENT[event.kind] ?? ['记录', 'logs']
  const key = `${scope}event:${event.seq}`
  const argsKey = `${scope}args:${event.seq}`
  const isExpandable = event.kind === 'tool'
  const title = h('div', { class: 'computer-event-head' },
    h('strong', event.tool || label),
    isExpandable ? expandIndicator() : null,
    event.step != null ? badge(`第 ${event.step} 轮`) : null,
    // Once its run is over, a call still marked running never reported a result.
    phaseBadge(view.settled && event.phase === 'running' ? { ...event, phase: 'unreported' } : event),
    event.delivery === 'sent' ? badge('已发送', 'ok') : event.delivery === 'failed' ? badge('发送失败，可能部分送达', 'bad') : event.delivery === 'none' ? badge('未发送') : null,
    event.ms != null ? h('span', { class: 'small muted' }, fmt.dur(event.ms)) : null,
    h('time', { class: 'small muted', dateTime: new Date(event.at).toISOString() }, new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })),
  )
  const response = responseSection(event.text, { heading: title, key: `${scope}agy-text:${event.seq}`, open: opened.get(`${scope}agy-text:${event.seq}`), limit: 280, markdown: ['response', 'reply'].includes(event.kind) ? 'auto' : false, className: event.isError ? 'small bad' : 'small' })
  const thinkingKey = `${scope}thinking:${event.seq}`
  const contents = [
    event.thinking ? h('details', { class: 'computer-arguments', 'data-disclosure': thinkingKey, 'data-seq': event.seq, open: opened.get(thinkingKey) },
      h('summary', '查看思考摘要'), h('pre', { class: 'small' }, event.thinking)) : null,
    response.body,
    event.model || event.inputTokens != null ? h('div', { class: 'small muted' },
      [event.model, (event.inputTokens != null || event.outputTokens != null) ? `输入 ${fmt.num(event.inputTokens)} / 输出 ${fmt.num(event.outputTokens)}` : null].filter(Boolean).join(' · ')) : null,
    event.args ? h('details', { class: 'computer-arguments', 'data-disclosure': argsKey, 'data-seq': event.seq, open: opened.get(argsKey) },
      h('summary', '查看调用参数'), h('pre', { class: 'small mono' }, event.args)) : null,
    event.subagent ? subagentSection(event, view) : null,
  ]
  return h('article', { class: `computer-event rollout-event ${event.isError ? 'event-error' : ''}`, 'data-kind': event.kind },
    h('span', { class: 'computer-event-icon' }, icon(ico, 16)),
    h('div', { class: 'computer-event-content' },
      isExpandable ? h('details', { class: 'tool-disclosure', 'data-disclosure': key, open: opened.get(key) ?? event.isError },
        h('summary', title, h('span', { class: 'tool-preview' }, (event.text ?? '').slice(0, 130))),
        h('div', { class: 'tool-content' }, contents))
      : [title, contents],
    ),
  )
}

function subagentSection(event, view) {
  const key = `${view.scope ?? ''}subagent:${event.subagent}`
  const state = view.subagents.get(event.subagent)
  let role
  try { role = JSON.parse(event.args ?? '{}').Role } catch { /* arguments are display text */ }
  const body = !state || (state.loading && !state.data) ? h('div', { class: 'empty loading' }, spinner(), '加载子代理记录…')
    : !state.data ? h('div', { class: 'row small bad' }, `加载失败：${state.error}`, h('button', { class: 'btn sm', type: 'button', onclick: () => view.loadSubagent(event.subagent) }, '重试'))
    : [
        state.data.task ? textBlock(state.data.task, { key: `${key}:task`, open: view.opened.get(`${key}:task`), className: 'computer-task-text', limit: 220 }) : null,
        state.data.dropped ? h('p', { class: 'small warn' }, `较早的 ${state.data.dropped} 条记录已超过显示上限，以下为最近记录。`) : null,
        timeline(state.data, { ...view, scope: `${key}/`, settled: !state.data.running }, '子代理尚无执行记录。'),
      ]
  return h('details', { class: 'subagent-disclosure', 'data-disclosure': key, open: view.opened.get(key),
    // Opening loads once; open panels then follow the page's regular refresh.
    ontoggle: e => { if (e.target.open && !view.subagents.has(event.subagent)) view.loadSubagent(event.subagent) } },
    h('summary', icon('layers', 14), h('strong', role ? `子代理 · ${role}` : '子代理执行记录'),
      state?.data ? statusBadge(state.data.running ? 'running' : 'completed') : null,
      h('span', { class: 'small muted' }, `${state?.data?.events.length ?? '—'} 条记录`), icon('chevron', 12)),
    h('div', { class: 'subagent-body' }, body))
}

function timeline(history, view, emptyText) {
  const entries = timelineEntries(history)
  return entries.length ? h('div', { class: 'computer-timeline' }, entries.map(event => timelineEvent(event, view))) : empty(emptyText)
}

function metric(label, value, ico) {
  return h('div', { class: 'run-metric' }, h('span', icon(ico, 14), label), h('strong', { title: String(value) }, value))
}

export async function render(root, [id]) {
  let jobs = await get('/api/agy')
  let selected = jobs.find(job => job.id === id) ?? (id ? undefined : jobs[0])
  let stopped = false, busy = false, snapshot = '', listSnapshot = '', filter = ''
  const subagents = new Map()
  const items = h('div')
  const pages = pager(() => { listSnapshot = ''; drawList() }, { anchor: () => list })
  pages.reveal(jobs.indexOf(selected))
  const list = h('div', { class: 'pane-list computer-job-list rollout-list' },
    h('div', { class: 'section-heading' }, h('h2', '任务列表'), badge(`${jobs.length} 个`)),
    h('input', { type: 'search', placeholder: '筛选任务、模型或 ID…', 'aria-label': '筛选异步代理任务', style: { width: '100%', marginBottom: '12px' }, oninput: e => {
      filter = e.target.value.toLowerCase(); pages.reset(); drawList()
    } }), items)
  const detail = h('div', { class: 'computer-job-detail rollout-detail' })
  const connection = h('span', { class: 'small muted', role: 'status' }, '每 3 秒自动更新')
  const refreshButton = h('button', { class: 'btn', onclick: () => refresh() }, icon('refresh', 16), '刷新')

  function drawList() {
    const key = JSON.stringify([jobs, selected?.id, filter])
    if (key === listSnapshot) return
    listSnapshot = key
    const visible = jobs.filter(job => !filter || `${job.task} ${job.id} ${job.modelId ?? ''} ${job.requesterText ?? ''}`.toLowerCase().includes(filter))
    mount(items, visible.length ? pages.slice(visible).map(job => {
      return h('a', { class: `list-item computer-job ${job.id === selected?.id ? 'sel' : ''}`, href: `#/agy/${enc(job.id)}`, 'aria-current': job.id === selected?.id ? 'page' : undefined },
        h('div', { class: 'row' }, statusBadge(job.status), h('span', { class: 'small muted right' }, fmt.short(job.createdAt))),
        h('strong', { class: 'clamp' }, mentionText(job.task)),
        h('span', { class: 'small muted mono clamp' }, job.id),
        h('span', { class: 'small muted' }, [job.modelId, job.steps != null ? `${job.steps} 轮` : null, (job.inputTokens != null || job.outputTokens != null) ? `${fmt.num((job.inputTokens ?? 0) + (job.outputTokens ?? 0))} tokens` : null].filter(Boolean).join(' · ')))
    }) : empty(filter ? '没有匹配的异步代理任务' : '还没有异步代理任务'), visible.length ? pages.el : null)
  }

  async function drawDetail() {
    if (!selected) return mount(detail, card(null, empty(id ? '任务不存在或已清理' : '在聊天中使用 AGY 后，可在这里查看进度和结果。')))
    const job = selected
    let history
    try {
      history = await get(`/api/agy/${enc(job.id)}/history`)
    } catch (error) {
      if (error.status !== 404) throw error
      if (!stopped) mount(detail, card(null, empty('任务不存在或已清理')))
      return
    }
    if (stopped) return
    const opened = new Map([...detail.querySelectorAll('details[data-disclosure]')].map(el => [el.dataset.disclosure, el.open]))
    // Open subagent panels refresh with the page while that subagent is still working.
    const refreshing = [...opened].map(([key, open]) => open && /subagent:([^/:]+)$/.exec(key)?.[1]).filter(Boolean)
    await Promise.all([...new Set(refreshing)].filter(child => subagents.get(child)?.data?.running).map(child => fetchSubagent(job.id, child)))
    if (stopped || selected !== job) return
    const key = JSON.stringify([job, history.events.at(-1)?.seq, history.dropped, [...subagents].map(([child, state]) => [child, state.loading, state.error, JSON.stringify(state.data ?? null).length, state.data?.running])])
    if (snapshot === key) return
    snapshot = key
    const view = { opened, subagents, settled: !['queued', 'running', 'waiting'].includes(job.status), loadSubagent: async child => { await fetchSubagent(job.id, child); if (!stopped) await drawDetail() } }
    const replies = history.events.filter(event => event.kind === 'reply')
    const contexts = history.events.filter(event => event.kind === 'context')
    const execution = timelineEntries(history)
    const duration = (job.updatedAt && job.createdAt) ? Math.max(0, job.updatedAt - job.createdAt) : null
    const totalTokens = (job.inputTokens ?? 0) + (job.outputTokens ?? 0)
    const report = responseSection(job.report, { heading: h('span', { class: 'card-title' }, icon('check'), '执行结果'), key: 'agy-report', open: opened.get('agy-report'), limit: 560, className: 'rollout-reply', markdown: 'auto' })

    mount(detail,
      card(h('span', { class: 'card-title' }, icon('models'), '任务详情', statusBadge(job.status)),
        textBlock(job.task, { key: 'agy-request', open: opened.get('agy-request'), className: 'computer-task-text', limit: 220 }),
        h('div', { class: 'row small muted', style: { marginTop: '12px' } },
          h('span', `ID: ${job.id}`),
          h('span', `创建 ${fmt.time(job.createdAt)}`),
          h('span', `更新 ${fmt.ago(job.updatedAt)}`)),
        job.requesterText && job.requesterText !== job.task ? h('details', { class: 'quiet-details', 'data-disclosure': 'requester-text', open: opened.get('requester-text') },
          h('summary', '原始用户请求'), h('pre', { class: 'small mono' }, job.requesterText)) : null,
        h('details', { class: 'quiet-details', 'data-disclosure': 'agy-prompt', open: opened.get('agy-prompt') },
          h('summary', '实际发送给 AGY 的提示（已脱敏）'),
          contexts.length ? contexts.map((event, index) => h('div',
            h('p', { class: 'small muted' }, `第 ${index + 1} 次启动 · ${fmt.time(event.at)} · sandbox + turbo`),
            h('pre', { class: 'small mono', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, event.text)))
            : h('p', { class: 'small muted' }, '旧任务未保存完整提示；新任务或继续执行后可查看路径映射及完整工作指令。')),
        h('div', { class: 'run-metrics' },
          metric('模型', job.modelId ?? '—', 'models'),
          metric('耗时', duration != null ? fmt.dur(duration) : '—', 'clock'),
          metric('轮次', job.steps != null ? `${job.steps} 轮` : '—', 'layers'),
          metric('图片', job.inputImageCount ? `${job.inputImageCount} 张` : '0 张', 'sticker')),
        (job.inputTokens != null || job.outputTokens != null) ? h('div', { class: 'run-usage small muted' },
          h('span', `输入 ${fmt.num(job.inputTokens)}`),
          job.cacheReadTokens ? h('span', `缓存 ${fmt.num(job.cacheReadTokens)}`) : null,
          h('span', `输出 ${fmt.num(job.outputTokens)}`),
          totalTokens ? h('span', `总计 ${fmt.num(totalTokens)}`) : null) : null,
        job.deliveryError ? h('p', { class: 'small bad' }, '结果未能完整送达聊天，请查看下方对话回复记录。') : null,
        ['running', 'queued', 'waiting'].includes(job.status) ? h('div', { class: 'computer-progress small', role: 'status' }, spinner(),
          job.status === 'queued' ? '等待处理' : job.progress || '正在处理') : (job.progress ? h('div', { class: 'computer-progress small', role: 'status' }, icon('clock', 16), job.progress) : null),
        ['queued', 'running', 'waiting'].includes(job.status) ? h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'btn danger sm', onclick: async () => {
          if (await confirmDanger('取消这个异步代理？')) {
            await act(() => post(`/api/agy/${enc(job.id)}/cancel`), '已取消')
            await refresh()
          }
        } }, '取消任务')) : null),
      card(report.heading,
        report.body ?? empty(['queued', 'running'].includes(job.status) ? '执行结束后会显示结果。' : '此任务没有保存执行结果。')),
      card(h('span', { class: 'card-title' }, icon('chat'), '对话回复', replies.length ? badge(`${replies.length} 条`) : null),
        replies.length ? h('div', { class: 'computer-timeline' }, replies.map(event => timelineEvent(event, view))) : empty(job.progress && !['queued', 'running'].includes(job.status) ? '正在整理并发送回复…' : '还没有保存对话回复。')),
      card(h('span', { class: 'card-title' }, icon('logs'), '执行记录', badge(`${execution.length} 条`)),
        history.dropped ? h('p', { class: 'small warn' }, `较早的 ${history.dropped} 条记录已超过保留上限，以下为最近记录。`) : null,
        timeline(history, view, '此任务尚无详细记录。已有任务仍可查看保存的结果，新执行或继续的任务会记录执行过程。')),
    )
  }

  async function fetchSubagent(jobId, child) {
    const state = subagents.get(child) ?? {}
    if (state.loading) return
    subagents.set(child, Object.assign(state, { loading: true }))
    try { state.data = await get(`/api/agy/${enc(jobId)}/subagents/${enc(child)}`); state.error = undefined }
    catch (error) { state.error = error.message }
    finally { state.loading = false }
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

  mount(root, h('div', { class: 'page-head' }, menuButton(), h('h1', '异步代理'), h('span', { class: 'spacer' }), connection, refreshButton),
    h('p', { class: 'small muted', role: 'note' }, 'AGY 在宿主机以 sandbox + turbo 模式异步执行分析、编程和文件处理，拥有主机完整访问，无需机器人 VM。这里可查看进度与结果；图片反搜使用独立的 Google Lens 工具。'),
    h('div', { class: 'split computer-split' }, list, detail))
  drawList()
  mount(detail, card(null, h('div', { class: 'empty loading' }, spinner(), '加载执行记录…')))
  try { await drawDetail() } catch (error) { mount(detail, card(null, empty(`加载失败：${error.message}`))) }
  const timer = setInterval(refresh, 3000)
  return () => { stopped = true; clearInterval(timer) }
}
