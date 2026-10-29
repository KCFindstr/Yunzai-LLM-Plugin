import { get, post } from './api.js'
import { act, badge, card, fmt, h, paged, spinner } from './ui.js'

/**
 * Config-page helpers for the judges: the proactive reply threshold curve, and playgrounds where an admin writes a
 * chat by hand and sees what the auto-thinking or proactive-reply judge makes of its last message.
 */

const SVG = 'http://www.w3.org/2000/svg'
const s = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  el.append(...children)
  return el
}

/** threshold(t) = end + (start - end) * 0.5^(t / halfLife), same as src/chat/proactive.ts */
export const thresholdAt = (t, seconds) => t.end + (t.start - t.end) * Math.pow(0.5, Math.max(0, seconds) / Math.max(1, t.halfLife))

const duration = sec => (sec >= 3600 ? `${+(sec / 3600).toFixed(1)}小时` : sec >= 60 ? `${+(sec / 60).toFixed(1)}分` : `${Math.round(sec)}秒`)

function curveSvg(t) {
  const W = 560, H = 210, L = 40, R = 12, T = 12, B = 30
  const span = Math.max(60, t.halfLife * 4)
  const x = sec => L + (sec / span) * (W - L - R)
  const y = v => T + (1 - v) * (H - T - B)
  const svg = s('svg', { class: 'curve', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '回复阈值随距机器人上次回复时间的变化', style: 'width:100%;max-width:640px;height:auto;display:block' })
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 }))
    svg.append(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted)' }, v.toFixed(2)))
  }
  for (let k = 0; k <= 4; k++) {
    const sec = k * t.halfLife
    svg.append(s('line', { x1: x(sec), x2: x(sec), y1: y(0), y2: y(0) + 4, stroke: 'var(--muted)' }))
    svg.append(s('text', { x: x(sec), y: H - 10, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted)' }, k ? duration(sec) : '刚回复'))
  }
  svg.append(s('line', { x1: L, x2: W - R, y1: y(t.end), y2: y(t.end), stroke: 'var(--muted)', 'stroke-dasharray': '4 4', 'stroke-width': 1 }))
  const points = Array.from({ length: 121 }, (_, i) => { const sec = (i / 120) * span; return `${x(sec).toFixed(1)},${y(thresholdAt(t, sec)).toFixed(1)}` })
  svg.append(s('path', { d: `M${points.join('L')}`, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5 }))
  svg.append(s('circle', { cx: x(t.halfLife), cy: y(thresholdAt(t, t.halfLife)), r: 3.5, fill: 'var(--accent)' }))
  return svg
}

/** The threshold curve with its three parameters; the chart follows the inputs live, each change is saved. */
export function curveCard(data, keys, threshold, save) {
  const t = { ...threshold }
  const chart = h('div')
  const caption = h('div', { class: 'small muted' })
  const draw = () => {
    chart.replaceChildren(curveSvg(t))
    caption.textContent = `横轴为距上次回复时间。刚回复需分数 ≥ ${t.start.toFixed(2)}，${duration(t.halfLife)}后降至 ≥ ${thresholdAt(t, t.halfLife).toFixed(2)}，久未回复降至 ≥ ${t.end.toFixed(2)}。抽中且分数达到曲线即回复。`
  }
  const input = (k, label, attrs) => {
    const el = h('input', { type: 'number', value: t[k], ...attrs, style: { width: '110px' } })
    el.addEventListener('input', () => { const v = Number(el.value); if (el.value !== '' && Number.isFinite(v)) { t[k] = v; draw() } })
    el.addEventListener('change', () => { if (el.value !== '' && Number.isFinite(Number(el.value))) save([...keys, k], Number(el.value)) })
    return h('label', { class: 'col small', style: { gap: '2px' } }, h('span', label), el)
  }
  draw()
  return card('回复阈值曲线',
    h('div', { class: 'small muted mono', style: { marginBottom: '8px' } }, `${keys.join('.')} · threshold(t) = end + (start − end) × 0.5^(t / halfLife)`),
    h('div', { class: 'row', style: { gap: '16px', flexWrap: 'wrap', marginBottom: '10px' } },
      input('start', '刚回复阈值 start', { min: 0, max: 1, step: 0.01 }),
      input('end', '久未回复阈值 end', { min: 0, max: 1, step: 0.01 }),
      input('halfLife', '半衰期 halfLife（秒）', { min: 1, max: 86400, step: 1 })),
    chart, caption,
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, '可在「分群设置」中按群单独配置。'))
}

/** replaceChildren without the null placeholders of optional parts */
const show = (el, ...children) => el.replaceChildren(...children.filter(Boolean))

const textarea = (placeholder, rows = 5, value = '') => h('textarea', { rows, placeholder, style: { width: '100%' } }, value)
const field = (label, control) => h('label', { class: 'col small', style: { gap: '4px', flex: 1, minWidth: '180px' } }, h('span', label), control)

/** Judge choices: System One models, then chat models; '' = the configured one. */
function judgeSelect(data, current, hint, always = false) {
  const e = data.effective
  return h('select', h('option', { value: '' }, `当前设置（${current || hint}）`),
    always ? h('option', { value: 'always' }, 'always · 不判断，抽中即回复') : null,
    (e.systemoneModels ?? []).map(m => h('option', { value: m.id }, `${m.id} · System One ${m.model}`)),
    (e.models ?? []).map(m => h('option', { value: m.id }, `${m.id} · ${m.model}`)))
}

function inputs(data, extra = []) {
  const e = data.effective
  const botName = h('input', { type: 'text', value: e.persona?.botName ?? '', placeholder: '机器人名字（空=配置的名字）' })
  const recent = textarea('最近群聊，每行一条：名字: 内容\n例如：\n岛风: 今晚谁打深渊\n天津风: 我来，[at:you] 你也来吗', 6)
  const history = textarea('（可选）和机器人的最近对话，每行一条，机器人的回复写成：你：……', 3)
  const sender = h('input', { type: 'text', value: '岛风', placeholder: '发言人' })
  const message = textarea('要评估的消息（最后一条）', 3)
  const view = h('div', { class: 'col', style: { gap: '10px' } },
    h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap' } }, ...extra, field('机器人名字', botName)),
    field('最近群聊（仅供判断语境）', recent), field('最近对话（可选）', history),
    h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap' } }, field('发言人', sender)), field('待评估的消息', message))
  const body = () => ({ botName: botName.value, recent: recent.value, history: history.value, sender: sender.value, message: message.value })
  return { view, body, message }
}

function promptBlock(prompt) {
  return h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'small' }, '发送给判断模型的内容'),
    h('div', { class: 'small muted' }, '系统提示'), h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, prompt.system),
    h('div', { class: 'small muted' }, '用户消息'), h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, prompt.user))
}

export function thinkingPlayground(data) {
  const e = data.effective
  const judge = judgeSelect(data, e.autoThinking?.judge, '后台任务模型 / 默认模型')
  const model = h('select', (e.models ?? []).map(m => h('option', { value: m.id, selected: m.id === (e.defaultModel || e.models[0]?.id) }, `${m.id} · ${m.model}`)))
  const form = inputs(data, [field('判断模型', judge), field('按哪个模型换算思考强度', model)])
  const out = h('div', { style: { marginTop: '12px' } })
  const run = h('button', { class: 'btn primary', onclick: async () => {
    if (!form.message.value.trim()) return form.message.focus()
    run.disabled = true
    out.replaceChildren(spinner())
    const r = await act(() => post('/api/playground/thinking', { ...form.body(), judge: judge.value || undefined, model: model.value }))
    run.disabled = false
    if (!r) return out.replaceChildren()
    show(out,
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        badge(`类别 ${r.kind}`, r.source === 'fallback' ? 'warn' : 'accent'), badge(`思考强度 ${r.level}（${r.model ?? ''}）`, 'ok'),
        badge(r.source === 'fallback' ? '判断失败，使用第一个类别' : r.source === 'systemone' ? `System One ${r.judge?.model ?? ''}` : `模型 ${r.judge?.model ?? ''}`),
        badge(fmt.dur(r.ms)), r.judge?.cost != null ? badge(fmt.usd(r.judge.cost)) : null),
      r.fallbackReason ? h('div', { class: 'small bad', style: { marginTop: '6px' } }, r.fallbackReason) : null,
      r.judge?.probabilities && Object.keys(r.judge.probabilities).length
        ? h('div', { class: 'chips', style: { marginTop: '6px' } }, Object.entries(r.judge.probabilities).map(([k, v]) => h('span', { class: 'chip' }, `${k} ${(v * 100).toFixed(1)}%`))) : null,
      r.judge?.response ? h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', marginTop: '8px' } }, r.judge.response) : null,
      promptBlock(r.prompt))
  } }, '运行判断')
  return card('试一试：自动思考强度判断',
    h('p', { class: 'small muted' }, '手写一段聊天，看判断模型把最后一条消息归入哪个类别、对应哪个思考强度。会实际调用判断模型（计入用量），不会发送任何消息。'),
    form.view, h('div', { class: 'row', style: { marginTop: '10px' } }, run), out)
}

export function proactivePlayground(data) {
  const e = data.effective
  const groups = Object.keys(e.groups ?? {})
  const group = h('select', h('option', { value: '' }, '默认参数'), groups.map(id => h('option', { value: id }, `群 ${id}${e.groups[id]?.proactive?.enable ? '（已开启）' : ''}`)))
  const judge = judgeSelect(data, e.proactive?.judge || e.autoThinking?.judge, '后台任务模型 / 默认模型', true)
  const since = h('input', { type: 'number', min: 0, placeholder: '空 = 本次启动后还没回复过', value: '' })
  const form = inputs(data, [field('使用哪个群的参数', group), field('判断模型', judge), field('距机器人自己上次回复（秒）', since)])
  const out = h('div', { style: { marginTop: '12px' } })
  const run = h('button', { class: 'btn primary', onclick: async () => {
    if (!form.message.value.trim()) return form.message.focus()
    run.disabled = true
    out.replaceChildren(spinner())
    const r = await act(() => post('/api/playground/proactive', { ...form.body(), groupId: group.value || undefined, judge: judge.value || undefined, sinceLast: since.value === '' ? null : Number(since.value) }))
    run.disabled = false
    if (!r) return out.replaceChildren()
    show(out,
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        badge(r.error ? '判断失败' : r.reply ? '会接话' : '不接话', r.error ? 'bad' : r.reply ? 'ok' : 'warn'),
        badge(`分数 ${r.score != null ? r.score.toFixed(2) : '?'}`), badge(`阈值 ${r.threshold.toFixed(2)}`),
        r.model ? badge(`${r.source === 'systemone' ? 'System One ' : ''}${r.model}`) : null, badge(fmt.dur(r.ms)), r.cost != null ? badge(fmt.usd(r.cost)) : null),
      r.error ? h('div', { class: 'small bad', style: { marginTop: '6px' } }, r.error) : null,
      r.response ? h('pre', { class: 'small', style: { whiteSpace: 'pre-wrap', marginTop: '8px' } }, r.response) : null,
      promptBlock(r.prompt))
  } }, '运行判断')
  return card('试一试：主动发言判断',
    h('p', { class: 'small muted' }, '手写群聊测试判断模型评分与阈值触发。仅测试判断不发回复，实际调用判断模型（计入用量）。'),
    form.view, h('div', { class: 'row', style: { marginTop: '10px' } }, run), out)
}

/** Groups with proactive replies on, and the latest decisions since the bot started. */
export function recentProactiveCard() {
  const body = h('div', spinner())
  get('/api/proactive').then(d => {
    body.replaceChildren(
      h('div', { class: 'small', style: { marginBottom: '8px' } }, d.groups.length
        ? ['已开启：', ...d.groups.map(g => badge(`${g.name ?? '群'} ${g.id} · 概率 ${g.probability}${g.judge === 'always' ? '，不判断' : ' + 判断'}`, 'accent'))]
        : h('span', { class: 'muted' }, '暂无群开启主动发言：可在「分群设置」添加群号并启用。')),
      d.recent.length ? paged(d.recent, rows => h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', '时间'), h('th', '群'), h('th', '消息'), h('th', '分数 / 阈值'), h('th', '结果'))),
        h('tbody', rows.map(r => h('tr',
          h('td', { class: 'small' }, fmt.time(r.at)), h('td', { class: 'small mono' }, r.groupId), h('td', { class: 'small' }, r.text),
          h('td', { class: 'small mono' }, `${r.score != null ? r.score.toFixed(2) : '?'} / ${r.threshold.toFixed(2)}`),
          h('td', r.error ? badge('失败', 'bad') : r.reply ? badge('接话', 'ok') : badge('不接话'))))))), { size: 10 })
        : h('div', { class: 'small muted' }, '本次启动后还没有主动发言判断。'))
  }).catch(err => body.replaceChildren(h('span', { class: 'small bad' }, err.message)))
  return card('最近的主动发言判断', body)
}
