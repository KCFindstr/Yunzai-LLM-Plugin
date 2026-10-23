import { get } from './api.js'
import { card, empty, fmt, h, mount } from './ui.js'

export function usageBreakdown(modelIds) {
  const localDate = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  const end = new Date(), start = new Date(end.getTime() - 7 * 86400_000)
  const from = h('input', { type: 'datetime-local', value: localDate(start), required: true, 'aria-label': '开始时间' })
  const to = h('input', { type: 'datetime-local', value: localDate(new Date(end.getTime() + 60000)), required: true, 'aria-label': '结束时间' })
  const option = (value, text) => h('option', { value }, text)
  const model = h('select', { 'aria-label': '筛选模型' }, option('', '所有模型'), [...new Set(modelIds)].sort().map(id => option(id, id)))
  const category = h('select', { 'aria-label': '用量类型' }, [['all', '全部类型'], ['input', '输入'], ['output', '输出'], ['cached', '缓存']].map(([v, text]) => option(v, text)))
  const metric = h('select', { 'aria-label': '统计指标' }, [['both', 'Token 与费用'], ['tokens', 'Token'], ['cost', '费用']].map(([v, text]) => option(v, text)))
  const results = h('div'), note = h('p', { class: 'small muted' })
  const rules = h('details', { class: 'quiet-details small muted' }, h('summary', '统计口径'),
    h('p', '时间按本地时区，包含开始、不包含结束。缓存包括缓存读和写；输出包含思考 token。其他费用为搜索和请求费。服务商仅返回总费用时记入“未分摊费用”，不推算各类费用。'))
  const submit = h('button', { class: 'btn', type: 'submit' }, '查询')
  let data, sequence = 0
  function draw() {
    if (!data) return
    const groups = [
      { key: 'input', label: '未缓存输入', tokens: row => row.input, cost: row => row.inputCost },
      { key: 'output', label: '输出', tokens: row => row.output, cost: row => row.outputCost },
      { key: 'cached', label: '缓存', tokens: row => row.cacheRead + row.cacheWrite + row.cacheWrite1h, cost: row => row.cachedCost },
    ].filter(group => category.value === 'all' || category.value === group.key)
    const columns = groups.flatMap(group => [
      metric.value !== 'cost' ? { label: `${group.label} token`, value: row => fmt.num(group.tokens(row)) } : null,
      metric.value !== 'tokens' ? { label: `${group.label}费用`, value: row => fmt.usd(group.cost(row)) } : null,
    ].filter(Boolean))
    if (metric.value !== 'tokens' && category.value === 'all') columns.push(
      { label: '其他费用', value: row => fmt.usd(row.otherCost) },
      { label: '未分摊费用', value: row => fmt.usd(Math.abs(row.unattributedCost) < 1e-12 ? 0 : row.unattributedCost) },
      { label: '总费用', value: row => fmt.usd(row.cost) })
    const total = data.rows.reduce((sum, row) => { for (const [key, value] of Object.entries(row)) if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value; return sum }, {})
    const row = (entry, label) => h('tr', h('td', label, entry.incompleteCalls || entry.missingUsageCalls ? h('div', { class: 'small warn' }, '用量报告不完整') : null),
      h('td', { class: 'num' }, fmt.num(entry.calls)), columns.map(col => h('td', { class: 'num' }, col.value(entry))))
    mount(results, data.rows.length ? h('div', { class: 'table-wrap' }, h('table',
      h('thead', h('tr', h('th', '模型'), h('th', { class: 'num' }, '调用'), columns.map(col => h('th', { class: 'num' }, col.label)))),
      h('tbody', data.rows.map(entry => row(entry, entry.model))), h('tfoot', row(total, '合计')))) : empty('该时间范围内没有详细用量记录。'))
  }
  async function load(event) {
    event?.preventDefault()
    const startMs = new Date(from.value).getTime(), endMs = new Date(to.value).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) { note.textContent = '结束时间必须晚于开始时间。'; return }
    const current = ++sequence
    submit.disabled = true
    try {
      const query = new URLSearchParams({ from: String(startMs), to: String(endMs), model: model.value })
      const response = await get(`/api/usage/history?${query}`)
      if (current !== sequence) return
      data = response
      const known = new Set([...model.options].map(o => o.value))
      for (const id of data.models) if (!known.has(id)) model.append(option(id, id))
      note.textContent = `详细统计自 ${fmt.time(data.startedAt)} 开始保存；更早的数据只有累计统计。`
      draw()
    } catch (error) { if (current === sequence) { data = undefined; mount(results, empty(`详细统计暂不可用：${error.message}`)) } }
    finally { if (current === sequence) submit.disabled = false }
  }
  category.addEventListener('change', draw); metric.addEventListener('change', draw)
  const view = card('按时间与模型统计', h('form', { class: 'usage-filters', onsubmit: load },
    h('label', '开始', from), h('label', '结束', to), h('label', '模型', model),
    h('label', '类型', category), h('label', '显示', metric), submit), note, rules, results)
  void load()
  return view
}
