import { enc, get } from '../api.js'
import { menuButton } from '../main.js'
import { badge, card, empty, fmt, h, icon, modal, mount, spinner, textBlock, mentionText } from '../ui.js'
import { parseRolloutJson } from '../rollout-data.js'
import { contextInspector } from '../context-inspector.js'
import { initialPromptText } from '../context-view.js'

const STATUS = {
  queued: ['排队中', 'accent'], running: ['执行中', 'accent'], completed: ['已完成', 'ok'],
  failed: ['失败', 'bad'], blocked: ['额度不足', 'warn'], interrupted: ['已中断', 'warn'],
}
const EVENT = {
  request: ['用户输入', 'chat'], progress: ['进度', 'clock'], response: ['模型响应', 'models'],
  thinking: ['思考强度', 'models'],
  tool: ['工具调用', 'tools'], reply: ['最终回复', 'check'], error: ['执行错误', 'alert'],
}
const SOURCE = { chat: '聊天', agy: 'AGY 结果回复', computer: '电脑任务结果回复' }
const THINKING_SOURCE = { fixed: '固定配置', uniform: '各类消息使用相同强度', unsupported: '接口不支持思考强度设置', obvious: '快速判断', model: '模型判断', systemone: 'System One', heuristic: '关键词规则' }

function thinkingDetails(r, opened) {
  const decision = r.thinkingDecision
  if (!decision) return null
  const answer = parseRolloutJson(decision.judge?.response)?.answers?.kind
  const probabilities = answer?.probabilities
  const values = ['casual', 'question', 'complex'].map(kind => {
    const item = Array.isArray(probabilities) ? probabilities.find(p => (p?.choice ?? p?.name) === kind) : probabilities?.[kind]
    const value = typeof item === 'object' && item ? item.probability ?? item.score ?? item.prob : item
    return { kind, value: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined }
  })
  const labels = { casual: '闲聊', question: '问题', complex: '复杂任务' }
  const confidence = answer?.confidence
  const percent = value => `${Number((value * 100).toFixed(1))}%`
  return h('div', { class: 'thinking-step' },
      h('div', { class: 'row small muted' },
        h('span', decision.setting === 'auto' ? `自动 → ${decision.level}` : `固定 ${decision.setting}`),
        h('span', decision.judge?.model ?? THINKING_SOURCE[decision.source]),
        decision.ms ? h('span', fmt.dur(decision.ms)) : null,
        typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? badge(`置信度 ${percent(confidence)}`) : null),
      values.some(p => p.value != null) ? h('div', { class: 'judge-probabilities', 'aria-label': '分类概率' }, values.map(({ kind, value }) =>
        h('div', { class: `judge-probability ${kind === (decision.judge?.kind ?? decision.kind) ? 'selected' : ''}`, 'data-kind': kind },
          h('span', labels[kind]),
          h('div', { class: 'probability-track', role: 'meter', 'aria-label': labels[kind], 'aria-valuemin': 0, 'aria-valuemax': 100,
            'aria-valuenow': value == null ? undefined : value * 100, 'aria-valuetext': value == null ? '未提供' : percent(value) },
            value == null ? null : h('span', { style: { width: `${value * 100}%` } })),
          h('strong', value == null ? '—' : percent(value))))) : null,
      r.thinking && r.thinking !== decision.level ? h('p', { class: 'small warn' }, `模型接口不支持所选强度，实际使用 ${r.thinking}`) : null,
      decision.judge?.kind && decision.kind !== decision.judge.kind ? h('p', { class: 'small muted' }, `判断返回 ${decision.judge.kind}；附带图片，按 ${decision.kind} 处理。`) : null,
      decision.fallbackReason ? h('p', { class: 'small warn' }, `自动判断回退：${decision.fallbackReason}`) : null,
      decision.judge ? h('details', { class: 'rollout-judge quiet-details', 'data-disclosure': 'judge-response', open: opened.get('judge-response') },
        h('summary', '判断响应'),
        h('pre', { class: 'small mono' }, decision.judge.response),
        h('p', { class: 'small muted' }, [decision.judge.inputTokens != null ? `输入 ${fmt.num(decision.judge.inputTokens)} / 输出 ${fmt.num(decision.judge.outputTokens)}` : null,
          typeof decision.judge.cost === 'number' && Number.isFinite(decision.judge.cost) ? `判断费用 $${decision.judge.cost.toFixed(6)}` : null].filter(Boolean).join(' · '))) : null,
    )
}

function timelineEntries(r) {
  const events = [], tools = new Map()
  let hasThinking = false
  for (const event of r.events) {
    if (['request', 'reply'].includes(event.kind)) continue
    if (event.kind === 'progress' && ['等待模型响应', '正在判断思考强度'].includes(event.text)) continue
    if (event.kind === 'thinking') hasThinking = true
    const key = event.kind === 'tool' && event.callId ? `${event.step ?? ''}:${event.callId}` : undefined
    if (key && tools.has(key)) {
      const first = tools.get(key)
      events[first] = { ...events[first], ...event, seq: events[first].seq, args: event.args || events[first].args }
    } else {
      if (key) tools.set(key, events.length)
      events.push(event)
    }
  }
  if (!hasThinking && r.thinkingDecision) events.unshift({ seq: 'thinking', at: r.createdAt, kind: 'thinking', thinking: r.thinkingDecision.level })
  return events
}

function expandIndicator() {
  return h('span', { class: 'step-expand-badge', 'aria-hidden': 'true' },
    h('span', { class: 'when-closed' }, '展开详情'),
    h('span', { class: 'when-open' }, '收起'),
    icon('chevron', 12))
}

function timelineEvent(event, opened, r) {
  const [label, ico] = EVENT[event.kind] ?? ['记录', 'logs']
  const key = `event:${event.seq}`
  const argsKey = `args:${event.seq}`
  const isExpandable = event.kind === 'tool'
  const title = h('div', { class: 'computer-event-head' },
    h('strong', event.tool || label),
    isExpandable ? expandIndicator() : null,
    event.images?.length ? badge(`${event.images.length} 张图片`) : null,
    event.step != null ? badge(`第 ${event.step} 轮`) : null,
    event.thinking ? badge(`思考 ${event.thinking}`) : null,
    event.phase ? badge(event.phase === 'running' ? '执行中' : event.phase === 'skipped' ? '未执行' : event.isError ? '失败' : '已返回', event.isError ? 'bad' : event.phase === 'running' ? 'accent' : '') : null,
    event.ms != null ? h('span', { class: 'small muted' }, fmt.dur(event.ms)) : null,
    h('time', { class: 'small muted', dateTime: new Date(event.at).toISOString() }, new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })))
  const contents = [
    event.images?.length ? h('div', { class: 'rollout-images' }, event.images.map((image, index) => {
      const url = `/api/rollouts/${enc(r.id)}/images/${enc(image.id)}`
      return h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, loading: 'lazy', alt: `${event.tool ?? '工具'} 返回的图片 ${index + 1}` }))
    })) : null,
    event.omittedImages ? h('p', { class: 'small warn' }, `${event.omittedImages} 张图片无法保存或超出图片保存上限。`) : null,
    event.text ? textBlock(event.text, { key: `text:${event.seq}`, open: opened.get(`text:${event.seq}`), limit: 280, markdown: event.kind === 'response', className: event.isError ? 'small bad' : 'small' }) : null,
    event.inputTokens != null ? h('div', { class: 'small muted' }, `输入 ${fmt.num(event.inputTokens)} / 输出 ${fmt.num(event.outputTokens)}`) : null,
    event.callId ? h('div', { class: 'small muted mono' }, event.callId) : null,
    event.args ? h('details', { class: 'computer-arguments', 'data-disclosure': argsKey, open: opened.get(argsKey) },
      h('summary', '调用参数'), h('pre', { class: 'small mono' }, event.args)) : null,
  ]
  return h('article', { class: `computer-event rollout-event ${event.isError ? 'event-error' : ''}`, 'data-kind': event.kind },
    h('span', { class: 'computer-event-icon' }, icon(ico, 16)),
    h('div', { class: 'computer-event-content' },
      event.kind === 'tool' ? h('details', { class: 'tool-disclosure', 'data-disclosure': key, open: opened.get(key) ?? event.isError },
        h('summary', title, h('span', { class: 'tool-preview' }, mentionText((event.text ?? '').slice(0, 130)))), h('div', { class: 'tool-content' }, contents))
        : [title, event.kind === 'thinking' ? thinkingDetails(r, opened) : contents],
    ))
}

function metric(label, value, ico) {
  return h('div', { class: 'run-metric' }, h('span', icon(ico, 14), label), h('strong', { title: String(value) }, value))
}

function requestDetails(r, opened) {
  const context = r.context
  const disclosure = (key, label, ico, count, content, action) => h('details', { class: 'request-disclosure', 'data-disclosure': key, open: opened.get(key) },
    h('summary', icon(ico, 17), h('strong', label), badge(count), action, icon('chevron', 15)), h('div', { class: 'request-content' }, content))
  return h('div', { class: 'request-inspector' },
    disclosure('available-tools', '可用工具', 'tools', context ? `${context.tools.length}${context.omittedTools ? '+' : ''}` : '—',
      context ? [context.nativeSearch ? badge('原生搜索', 'accent') : null, context.tools.length ? h('div', { class: 'tool-catalog' }, context.tools.map((tool, index) =>
        h('details', { class: 'quiet-details', 'data-disclosure': `tool-spec:${index}`, open: opened.get(`tool-spec:${index}`) },
          h('summary', tool.name), h('p', { class: 'small' }, tool.description), h('pre', { class: 'small mono' }, (() => { try { return JSON.stringify(JSON.parse(tool.parameters), null, 2) } catch { return tool.parameters } })())))) : empty('本轮未提供函数工具。')]
        : empty('此记录未保存工具列表。')),
    disclosure('chat-context', '聊天上下文', 'memory', context ? `${context.messages.length}${context.omittedMessages ? '+' : ''} 条消息` : '—',
      context ? contextInspector(context, opened)
        : empty('此记录未保存聊天上下文。'), context ? h('button', { class: 'btn sm', type: 'button', 'aria-label': '查看初始提示原文', onclick: event => {
          event.preventDefault(); event.stopPropagation()
          modal('初始提示原文', h('textarea', { class: 'code raw-prompt-text', readOnly: true, spellcheck: false, rows: 24, 'aria-label': '初始提示原文' }, initialPromptText(context)))
        } }, '原文') : null))
}

export async function render(root, [id]) {
  let rollouts = await get('/api/rollouts')
  let selected = id ?? rollouts[0]?.id
  let stopped = false, busy = false, snapshot = '', listSnapshot = '', filter = ''
  const items = h('div')
  const list = h('div', { class: 'pane-list computer-job-list rollout-list' },
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
        h('strong', { class: 'clamp' }, mentionText(r.input)),
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
    const opened = new Map([...detail.querySelectorAll('details[data-disclosure]')].map(el => [el.dataset.disclosure, el.open]))
    const [label, kind] = STATUS[r.status] ?? [r.status, '']
    const execution = timelineEntries(r)
    const progress = r.events.at(-1)
    mount(detail,
      card(h('span', { class: 'card-title' }, icon('layers'), '执行详情', badge(label, kind)),
        textBlock(r.input, { key: 'request', open: opened.get('request'), className: 'computer-task-text', limit: 220 }),
        h('div', { class: 'row small muted', style: { marginTop: '12px' } },
          h('span', r.label), h('span', SOURCE[r.source]), h('time', fmt.time(r.createdAt))),
        h('div', { class: 'row small', style: { marginTop: '10px' } },
          h('a', { class: 'btn sm', href: `#/conversations/${enc(r.conv)}` }, icon('chat', 14), '对话'),
          h('a', { class: 'btn sm', href: `#/vectors/${enc(r.conv)}` }, icon('vectors', 14), '向量空间'),
          r.inputImageCount ? badge(`${r.inputImageCount} 张图片`) : null),
        h('div', { class: 'run-metrics' }, metric('模型', r.model ?? '—', 'models'), metric('耗时', fmt.dur(r.ms), 'clock'),
          metric('费用', fmt.usd(r.cost), 'usage'), metric('轮次', r.steps, 'layers')),
        r.tokens ? h('div', { class: 'run-usage small muted' }, h('span', `输入 ${fmt.num(r.tokens.input)}`), h('span', `缓存 ${fmt.num(r.tokens.cacheRead)}`), h('span', `输出 ${fmt.num(r.tokens.output)}`)) : null,
        r.tokens?.inputIncomplete ? h('p', { class: 'small warn' }, '上游可能漏报历史输入与缓存用量，花费可能偏低。') : null,
        r.jobId ? h('a', { class: 'small', href: `#/${r.source === 'agy' ? 'agy' : 'computer'}/${enc(r.jobId)}` }, '查看来源任务 →') : null,
        ['running', 'queued'].includes(r.status) ? h('div', { class: 'computer-progress small', role: 'status' }, spinner(),
          r.status === 'queued' ? '等待处理' : progress?.kind === 'tool' ? `${progress.tool} ${progress.phase === 'running' ? '执行中' : '已返回'}` : progress?.text || '正在处理') : null),
      card(h('span', { class: 'card-title' }, icon('chat'), '最终回复'),
        r.reply ? textBlock(r.reply, { key: 'reply', open: opened.get('reply'), limit: 560, className: 'rollout-reply', markdown: true }) : empty(['queued', 'running'].includes(r.status) ? '执行结束后会显示最终回复。' : '本次执行没有生成最终回复。')),
      requestDetails(r, opened),
      card(h('span', { class: 'card-title' }, icon('logs'), '执行记录', badge(`${execution.length} 条`)),
        r.dropped ? h('p', { class: 'small warn' }, `较早的 ${r.dropped} 条记录已超过保留上限，以下为最近记录。`) : null,
        execution.length ? h('div', { class: 'computer-timeline' }, execution.map(event => timelineEvent(event, opened, r))) : empty('尚无详细执行记录。')),
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
    h('p', { class: 'small warn', role: 'note' }, '执行记录及工具返回的图片保留 30 天，到期自动删除。'),
    h('div', { class: 'split computer-split' }, list, detail))
  drawList()
  mount(detail, card(null, h('div', { class: 'empty loading' }, spinner(), '加载执行记录…')))
  try { await drawDetail() } catch (error) { mount(detail, card(null, empty(`加载失败：${error.message}`))) }
  const timer = setInterval(refresh, 3000)
  return () => { stopped = true; clearInterval(timer) }
}
