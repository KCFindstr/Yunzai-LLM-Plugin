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
  const chartArea = h('div', { class: 'usage-chart-section' })
  const results = h('div'), note = h('p', { class: 'small muted' })
  const rules = h('details', { class: 'quiet-details small muted' }, h('summary', '统计口径'),
    h('p', '时间按本地时区，包含开始、不包含结束。缓存包括缓存读和写；输出包含思考 token。其他费用为搜索和请求费。服务商仅返回总费用时记入“未分摊费用”，不推算各类费用。'))
  const submit = h('button', { class: 'btn', type: 'submit' }, '查询')

  let data, sequence = 0, chartObserver
  let chartMetric = 'cost' // 'cost' | 'tokens'
  let chartMode = 'line' // 'line' | 'grouped' | 'category'

  const setRange = (startOffsetMs, startOfToday = false, startOfMonth = false) => {
    const now = new Date()
    let startDate
    if (startOfMonth) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1)
    } else if (startOfToday) {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else {
      startDate = new Date(now.getTime() - startOffsetMs)
    }
    from.value = localDate(startDate)
    to.value = localDate(new Date(now.getTime() + 60000))
    void load()
  }

  const presets = h('div', { class: 'usage-quick-presets' },
    h('span', { class: 'small muted' }, '快捷时间：'),
    h('button', { type: 'button', class: 'usage-preset-btn', onclick: () => setRange(0, true) }, '今天'),
    h('button', { type: 'button', class: 'usage-preset-btn', onclick: () => setRange(7 * 86400_000) }, '最近 7 天'),
    h('button', { type: 'button', class: 'usage-preset-btn', onclick: () => setRange(14 * 86400_000) }, '最近 14 天'),
    h('button', { type: 'button', class: 'usage-preset-btn', onclick: () => setRange(30 * 86400_000) }, '最近 30 天'),
    h('button', { type: 'button', class: 'usage-preset-btn', onclick: () => setRange(0, false, true) }, '本月'),
  )

  function renderChart() {
    chartObserver?.disconnect()
    if (!data || !data.rows.length) {
      mount(chartArea, null)
      return
    }

    const effectiveMetric = metric.value === 'tokens' ? 'tokens' : (metric.value === 'cost' ? 'cost' : chartMetric)
    const isTokens = effectiveMetric === 'tokens'
    const formatVal = v => isTokens ? fmt.num(v) : fmt.usd(v)
    const compactVal = v => isTokens
      ? (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : fmt.num(v))
      : fmt.usd(v)

    const totalAllCost = data.rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
    const totalCalls = data.rows.reduce((sum, r) => sum + (r.calls ?? 0), 0)
    const totalInputTokens = data.rows.reduce((s, r) => s + (r.input ?? 0), 0)
    const totalOutputTokens = data.rows.reduce((s, r) => s + (r.output ?? 0), 0)
    const totalCachedTokens = data.rows.reduce((s, r) => s + ((r.cacheRead ?? 0) + (r.cacheWrite ?? 0) + (r.cacheWrite1h ?? 0)), 0)
    const totalAllTokens = totalInputTokens + totalOutputTokens + totalCachedTokens

    const totalInputCost = data.rows.reduce((s, r) => s + (r.inputCost ?? 0), 0)
    const totalOutputCost = data.rows.reduce((s, r) => s + (r.outputCost ?? 0), 0)
    const totalCachedCost = data.rows.reduce((s, r) => s + (r.cachedCost ?? 0), 0)
    const totalOtherCost = data.rows.reduce((s, r) => s + ((r.otherCost ?? 0) + (r.unattributedCost ?? 0)), 0)

    const sumInput = isTokens ? totalInputTokens : totalInputCost
    const sumOutput = isTokens ? totalOutputTokens : totalOutputCost
    const sumCached = isTokens ? totalCachedTokens : totalCachedCost
    const sumOther = isTokens ? 0 : totalOtherCost
    const sumTotal = isTokens ? totalAllTokens : totalAllCost

    const summaryStrip = h('div', { class: 'usage-chart-summary' },
      h('div', { class: 'usage-chart-metric' }, h('span', '总费用'), h('strong', fmt.usd(totalAllCost))),
      h('div', { class: 'usage-chart-metric' }, h('span', '总 Token'), h('strong', fmt.num(totalAllTokens))),
      h('div', { class: 'usage-chart-metric' }, h('span', '调用总计'), h('strong', `${fmt.num(totalCalls)} 次`)),
      totalCalls ? h('div', { class: 'usage-chart-metric' }, h('span', '平均调用花费'), h('strong', fmt.usd(totalAllCost / totalCalls))) : null,
    )

    const legendItems = [
      { key: 'input', label: '未缓存输入', colorClass: 'seg-input', val: sumInput },
      { key: 'output', label: '输出', colorClass: 'seg-output', val: sumOutput },
      { key: 'cached', label: '缓存', colorClass: 'seg-cached', val: sumCached },
    ].filter(item => category.value === 'all' || category.value === item.key)

    if (!isTokens && sumOther > 0 && category.value === 'all') {
      legendItems.push({ key: 'other', label: '其他/未分摊', colorClass: 'seg-other', val: sumOther })
    }

    const legendBar = h('div', { class: 'usage-chart-legend' },
      legendItems.map(item => {
        const pct = sumTotal > 0 ? (item.val / sumTotal * 100).toFixed(1) : '0.0'
        return h('div', { class: 'usage-legend-item', title: `${item.label}：${formatVal(item.val)} (${pct}%)` },
          h('span', { class: `usage-legend-dot ${item.colorClass}` }),
          h('span', { class: 'usage-legend-label' }, item.label),
          h('span', { class: 'usage-legend-val' }, `${formatVal(item.val)} (${pct}%)`),
        )
      })
    )

    const metricToggle = metric.value === 'both' ? h('div', { class: 'usage-chart-toggles' },
      h('button', { type: 'button', class: `usage-chart-toggle-btn ${effectiveMetric === 'cost' ? 'on' : ''}`, onclick: () => { chartMetric = 'cost'; renderChart() } }, '按花费'),
      h('button', { type: 'button', class: `usage-chart-toggle-btn ${effectiveMetric === 'tokens' ? 'on' : ''}`, onclick: () => { chartMetric = 'tokens'; renderChart() } }, '按 Token'),
    ) : null

    const modeToggle = h('div', { class: 'usage-chart-toggles' },
      h('button', { type: 'button', class: `usage-chart-toggle-btn ${chartMode === 'line' ? 'on' : ''}`, onclick: () => { chartMode = 'line'; renderChart() } }, '折线'),
      h('button', { type: 'button', class: `usage-chart-toggle-btn ${chartMode === 'grouped' ? 'on' : ''}`, onclick: () => { chartMode = 'grouped'; renderChart() } }, '分组'),
      h('button', { type: 'button', class: `usage-chart-toggle-btn ${chartMode === 'category' ? 'on' : ''}`, onclick: () => { chartMode = 'category'; renderChart() } }, '类型汇总'),
    )

    const modelFilterTag = model.value ? h('div', { class: 'row small', style: { gap: '6px' } },
      h('span', { class: 'badge accent' }, `当前模型：${model.value}`),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { model.value = ''; void load() } }, '查看所有模型 ✕')) : null

    const chartHeader = h('div', { class: 'usage-chart-head' },
      summaryStrip,
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, modelFilterTag, modeToggle, metricToggle),
    )

    const activeModels = data.rows.map(r => r.model)
    const isMultiModel = activeModels.length > 1

    const defaultHint = chartMode === 'line'
      ? (isMultiModel ? '提示：时间折线图展示各模型不同用量类型；沿折线移动查看各时段用量' : '提示：时间折线图分离展示未缓存输入、输出与缓存；沿折线移动查看各时段用量')
      : (data.rows.length > 1
        ? (chartMode === 'category' ? '提示：显示各类别的汇总分布' : '提示：默认分离输入/输出/缓存；悬浮查看明细，点击柱形可按模型筛选')
        : '当前模型用量构成分布（未缓存输入、输出、缓存）')

    const detailBox = h('div', { class: 'usage-chart-detail', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, defaultHint)
    const swatch = (color, dash = 'none') => h('span', { class: 'usage-legend-swatch', 'aria-hidden': 'true',
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="12" viewBox="0 0 26 12"><line x1="2" y1="6" x2="24" y2="6" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dash}" /></svg>` })
    const showDetails = (title, subtitle, values) => {
      detailBox.className = 'usage-chart-detail active'
      mount(detailBox,
        h('div', { class: 'usage-detail-head' }, h('strong', title), h('span', subtitle)),
        h('div', { class: 'usage-detail-values' }, values.map(item => h('div', { class: 'usage-detail-value' },
          item.color ? swatch(item.color, item.dash) : h('span', { class: `usage-legend-dot ${item.colorClass}` }),
          h('span', { class: 'usage-detail-label' }, item.label), h('strong', formatVal(item.val))))))
    }

    if (chartMode === 'line' && data.timeline && data.timeline.length) {
      const pts = data.timeline
      const N = pts.length
      const diff = (data.to ?? 0) - (data.from ?? 0)

      const MODEL_COLORS = [
        '#3b82f6', // Blue
        '#a855f7', // Purple
        '#f59e0b', // Amber
        '#06b6d4', // Cyan
        '#ec4899', // Pink
        '#10b981', // Emerald
        '#f97316', // Orange
        '#6366f1', // Indigo
      ]

      const typeDefs = [
        { key: 'input', label: '未缓存输入', short: '输入', dash: 'none', tokenKey: 'input', costKey: 'inputCost', defaultColor: '#3b82f6' },
        { key: 'output', label: '输出', short: '输出', dash: '6 3', tokenKey: 'output', costKey: 'outputCost', defaultColor: '#10b981' },
        { key: 'cached', label: '缓存', short: '缓存', dash: '2 3', tokenKey: 'cached', costKey: 'cachedCost', defaultColor: '#8b5cf6' },
      ]

      if (!isTokens && category.value === 'all' && pts.some(pt => pt.otherCost > 0)) {
        typeDefs.push({ key: 'other', label: '其他/未分摊', short: '其他', dash: '6 2 2 2', tokenKey: '', costKey: 'otherCost', defaultColor: '#f59e0b' })
      }

      const activeTypes = typeDefs.filter(t => category.value === 'all' || category.value === t.key)

      const allSeries = []
      for (let mIdx = 0; mIdx < activeModels.length; mIdx++) {
        const modelName = activeModels[mIdx]
        const modelBaseColor = isMultiModel ? MODEL_COLORS[mIdx % MODEL_COLORS.length] : null
        for (const t of activeTypes) {
          const color = modelBaseColor || t.defaultColor
          const dash = (isMultiModel && activeTypes.length > 1) ? t.dash : 'none'
          const getVal = pt => {
            const m = pt.byModel?.[modelName]
            if (!m) return 0
            return isTokens ? (m[t.tokenKey] ?? 0) : (m[t.costKey] ?? 0)
          }
          const total = pts.reduce((sum, pt) => sum + getVal(pt), 0)
          allSeries.push({
            key: `${modelName}__${t.key}`,
            model: modelName,
            type: t.key,
            label: isMultiModel ? `${modelName} · ${t.label}` : t.label,
            shortLabel: isMultiModel ? `${modelName} · ${t.short}` : t.short,
            color,
            dash,
            getVal,
            total,
          })
        }
      }

      let series = allSeries.filter(s => s.total > 0 || !isMultiModel || category.value !== 'all')
      if (!series.length && allSeries.length) series = allSeries.slice(0, 3)

      const lineLegendBar = h('div', { class: 'usage-chart-legend' },
        series.map(s => {
          const pct = sumTotal > 0 ? (s.total / sumTotal * 100).toFixed(1) : '0.0'
          return h(isMultiModel ? 'button' : 'div', {
            class: `usage-legend-item ${isMultiModel ? 'clickable' : ''}`,
            type: isMultiModel ? 'button' : null,
            title: isMultiModel ? `${s.label}：${formatVal(s.total)} (${pct}%)\n点击筛选该模型` : `${s.label}：${formatVal(s.total)} (${pct}%)`,
            onclick: isMultiModel ? () => { model.value = s.model; void load() } : null,
          },
            swatch(s.color, s.dash),
            h('span', { class: 'usage-legend-label' }, s.label),
            h('span', { class: 'usage-legend-val' }, `${compactVal(s.total)} (${pct}%)`),
          )
        })
      )

      const maxVal = Math.max(1e-9, ...pts.flatMap(pt => series.map(s => s.getVal(pt))))
      const height = 180
      const padL = Math.max(52, isTokens ? 48 : 56), padR = 20, padT = 16, padB = 26
      const plotH = height - padT - padB
      const getY = val => padT + plotH - (maxVal > 0 ? (val / maxVal) * plotH : 0)

      const lineChartWrap = h('div', { class: 'usage-line-chart', tabIndex: 0, role: 'group',
        'aria-label': '模型用量趋势，使用左右方向键选择时段' })
      let geometry, selectedIndex

      function drawSvg(w) {
        const width = Math.max(360, Math.round(w || lineChartWrap.clientWidth || 800))
        const plotW = width - padL - padR
        const getX = i => padL + (N > 1 ? (i / (N - 1)) * plotW : plotW / 2)
        geometry = { getX, plotW }

        const gridSvg = `
          <line x1="${padL}" y1="${padT}" x2="${padL + plotW}" y2="${padT}" class="usage-line-grid" />
          <line x1="${padL}" y1="${padT + plotH / 2}" x2="${padL + plotW}" y2="${padT + plotH / 2}" class="usage-line-grid" />
          <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" class="usage-line-grid" />
          <text x="${padL - 8}" y="${padT}" text-anchor="end" dominant-baseline="central" class="usage-line-axis-text">${compactVal(maxVal)}</text>
          <text x="${padL - 8}" y="${padT + plotH / 2}" text-anchor="end" dominant-baseline="central" class="usage-line-axis-text">${compactVal(maxVal / 2)}</text>
          <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" dominant-baseline="central" class="usage-line-axis-text">0</text>
        `

        const tickCount = Math.min(6, N)
        const tickIndices = Array.from({ length: tickCount }, (_, k) => Math.round((k / (tickCount - 1 || 1)) * (N - 1)))
        const uniqueTicks = [...new Set(tickIndices)]
        const formatXTime = ts => {
          const d = new Date(ts)
          if (diff <= 24 * 3600_000) {
            return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
          }
          return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
        const xLabelsSvg = uniqueTicks.map(idx => {
          const x = getX(idx)
          return `<text x="${x.toFixed(1)}" y="${padT + plotH + 16}" text-anchor="middle" dominant-baseline="hanging" class="usage-line-axis-text">${formatXTime(pts[idx].time)}</text>`
        }).join('')

        const pathsSvg = series.map(s => {
          const coords = pts.map((pt, i) => [getX(i), getY(s.getVal(pt))])
          const d = 'M ' + coords.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')
          const areaD = `${d} L ${coords[coords.length - 1][0].toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0][0].toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
          const dashAttr = s.dash !== 'none' ? `stroke-dasharray="${s.dash}"` : ''
          const areaSvg = series.length <= 4 ? `<path d="${areaD}" class="usage-area-path" fill="${s.color}" style="opacity: 0.08;" />` : ''
          return `
            ${areaSvg}
            <path d="${d}" class="usage-line-path" stroke="${s.color}" stroke-width="2.2" ${dashAttr} />
          `
        }).join('')

        const crosshairDots = series.map(s => `<circle class="usage-line-dot" fill="${s.color}" cx="0" cy="0" r="4.5" />`).join('')
        const crosshairSvg = `
          <g class="usage-crosshair-group" style="display: none;">
            <line x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" class="usage-line-crosshair" />
            ${crosshairDots}
          </g>
        `

        lineChartWrap.innerHTML = `<svg class="usage-line-svg" viewBox="0 0 ${width} ${height}">
          ${gridSvg}
          ${pathsSvg}
          ${crosshairSvg}
          ${xLabelsSvg}
        </svg>`
        if (selectedIndex != null) paintSelection(selectedIndex)
      }

      function paintSelection(idx) {
        const pt = pts[idx]
        if (!pt) return
        const ptX = geometry.getX(idx)
        const crossGroup = lineChartWrap.querySelector('.usage-crosshair-group')
        if (crossGroup) crossGroup.style.display = ''
        const line = lineChartWrap.querySelector('.usage-line-crosshair')
        if (line) {
          line.setAttribute('x1', ptX.toFixed(1))
          line.setAttribute('x2', ptX.toFixed(1))
        }
        const dots = lineChartWrap.querySelectorAll('.usage-line-dot')
        for (const [index, s] of series.entries()) {
          const dot = dots[index]
          if (dot) {
            dot.setAttribute('cx', ptX.toFixed(1))
            dot.setAttribute('cy', getY(s.getVal(pt)).toFixed(1))
            dot.style.display = (s.getVal(pt) > 0 || series.length <= 4) ? '' : 'none'
          }
        }

        const d = new Date(pt.time)
        const timeStr = diff <= 24 * 3600_000
          ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
          : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

        if (selectedIndex !== idx) {
          const values = series.map(s => ({ label: s.shortLabel, val: s.getVal(pt), color: s.color, dash: s.dash }))
          showDetails(timeStr, `${fmt.num(pt.calls)} 次调用 · ${isTokens ? 'Token' : '费用（USD）'}`,
            values)
        }
        selectedIndex = idx
      }

      lineChartWrap.onpointermove = e => {
        const svg = lineChartWrap.querySelector('svg')
        const matrix = svg?.getScreenCTM()
        if (!matrix) return
        const point = svg.createSVGPoint()
        point.x = e.clientX; point.y = e.clientY
        const x = point.matrixTransform(matrix.inverse()).x
        const ratio = Math.max(0, Math.min(1, (x - padL) / geometry.plotW))
        paintSelection(Math.round(ratio * (N - 1)))
      }
      lineChartWrap.onpointerdown = lineChartWrap.onpointermove
      lineChartWrap.onkeydown = e => {
        const current = selectedIndex ?? N - 1
        const next = { ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(N - 1, current + 1), Home: 0, End: N - 1 }[e.key]
        if (next != null) { e.preventDefault(); paintSelection(next) }
      }

      let curW = 800
      drawSvg(curW)

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(entries => {
          if (!lineChartWrap.isConnected) { observer.disconnect(); return }
          for (const entry of entries) {
            const w = Math.round(entry.contentRect.width)
            if (w > 0 && Math.abs(w - curW) > 4) {
              curW = w
              drawSvg(curW)
            }
          }
        })
        chartObserver = observer
        observer.observe(lineChartWrap)
      }

      mount(chartArea, h('div', { class: 'usage-chart-wrap' }, chartHeader, lineLegendBar, lineChartWrap, detailBox))
      return
    }

    let barsCanvas
    if (data.rows.length === 1 || chartMode === 'category') {
      const catItems = [
        { id: 'input', label: '未缓存输入', colorClass: 'seg-input', val: sumInput },
        { id: 'output', label: '输出', colorClass: 'seg-output', val: sumOutput },
        { id: 'cached', label: '缓存', colorClass: 'seg-cached', val: sumCached },
      ].filter(item => category.value === 'all' || category.value === item.id)

      if (!isTokens && sumOther > 0 && category.value === 'all') {
        catItems.push({ id: 'other', label: '其他/未分摊', colorClass: 'seg-other', val: sumOther })
      }

      const maxVal = Math.max(1e-9, ...catItems.map(i => i.val))
      barsCanvas = h('div', { class: 'usage-chart-canvas' }, catItems.map(item => {
        const heightPct = Math.max(2, (item.val / maxVal) * 100)
        const pctStr = sumTotal > 0 ? (item.val / sumTotal * 100).toFixed(1) : '0.0'
        return h('div', {
          class: 'usage-bar-col',
          role: 'button',
          tabIndex: 0,
          'aria-label': `${item.label} ${formatVal(item.val)}`,
          onmouseenter: () => showDetails(item.label, `占比 ${pctStr}% · 各模型汇总`, [item]),
          onfocus: () => showDetails(item.label, `占比 ${pctStr}% · 各模型汇总`, [item]),
        },
          h('span', { class: 'usage-bar-val' }, compactVal(item.val)),
          h('div', { class: 'usage-bar-track' },
            h('div', { class: `usage-bar-fill ${item.colorClass}`, style: { height: `${heightPct}%` } })),
          h('span', { class: 'usage-bar-lab', title: item.label }, item.label),
        )
      }))
    } else {
      const allVals = data.rows.flatMap(r => {
        const vals = []
        if (category.value === 'all' || category.value === 'input') vals.push(isTokens ? r.input : r.inputCost)
        if (category.value === 'all' || category.value === 'output') vals.push(isTokens ? r.output : r.outputCost)
        if (category.value === 'all' || category.value === 'cached') vals.push(isTokens ? (r.cacheRead + r.cacheWrite + r.cacheWrite1h) : r.cachedCost)
        if (!isTokens && category.value === 'all') vals.push((r.otherCost ?? 0) + (r.unattributedCost ?? 0))
        return vals
      })
      const maxSegVal = Math.max(1e-9, ...allVals)

      barsCanvas = h('div', { class: 'usage-chart-canvas' }, data.rows.map(row => {
        const inVal = isTokens ? row.input : row.inputCost
        const outVal = isTokens ? row.output : row.outputCost
        const cacheVal = isTokens ? (row.cacheRead + row.cacheWrite + row.cacheWrite1h) : row.cachedCost
        const othVal = isTokens ? 0 : ((row.otherCost ?? 0) + (row.unattributedCost ?? 0))
        const rowTotal = (category.value === 'all' || category.value === 'input' ? inVal : 0)
          + (category.value === 'all' || category.value === 'output' ? outVal : 0)
          + (category.value === 'all' || category.value === 'cached' ? cacheVal : 0)
          + (category.value === 'all' ? othVal : 0)

        const segs = [
          { key: 'input', label: '未缓存输入', colorClass: 'seg-input', val: inVal },
          { key: 'output', label: '输出', colorClass: 'seg-output', val: outVal },
          { key: 'cached', label: '缓存', colorClass: 'seg-cached', val: cacheVal },
        ].filter(seg => category.value === 'all' || category.value === seg.key)

        if (!isTokens && othVal > 0 && category.value === 'all') {
          segs.push({ key: 'other', label: '其他/未分摊', colorClass: 'seg-other', val: othVal })
        }

        const subBars = segs.map(seg => {
          const hPct = Math.max(2, (seg.val / maxSegVal) * 100)
          return h('div', {
            class: `usage-bar-sub ${seg.colorClass}`,
            style: { height: `${hPct}%` },
            title: `${row.model} · ${seg.label}: ${formatVal(seg.val)}`,
            onmouseenter: e => {
              e.stopPropagation()
              showDetails(row.model, `${seg.label} · 点击筛选此模型`, [seg])
            },
          })
        })

        return h('div', {
          class: `usage-bar-col grouped ${row.model === model.value ? 'selected' : ''}`,
          role: 'button',
          tabIndex: 0,
          'aria-label': `${row.model} ${formatVal(rowTotal)}`,
          onclick: () => { model.value = row.model; void load() },
          onmouseenter: () => showDetails(row.model, `${fmt.num(row.calls)} 次调用 · 点击筛选此模型`, segs),
          onfocus: () => showDetails(row.model, `${fmt.num(row.calls)} 次调用 · 点击筛选此模型`, segs),
        },
          h('span', { class: 'usage-bar-val' }, compactVal(rowTotal)),
          h('div', { class: 'usage-bar-track grouped' }, subBars),
          h('span', { class: 'usage-bar-lab', title: row.model }, row.model),
        )
      }))
    }

    mount(chartArea, h('div', { class: 'usage-chart-wrap' }, chartHeader, legendBar, barsCanvas, detailBox))
  }

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

    const total = data.rows.reduce((sum, row) => {
      for (const [key, value] of Object.entries(row)) if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value
      return sum
    }, {})

    const row = (entry, label) => h('tr', { class: entry.model ? 'clickable-tr' : '', onclick: entry.model ? () => { model.value = entry.model; void load() } : null },
      h('td', label, entry.incompleteCalls || entry.missingUsageCalls ? h('div', { class: 'small warn' }, '用量报告不完整') : null),
      h('td', { class: 'num' }, fmt.num(entry.calls)),
      columns.map(col => h('td', { class: 'num' }, col.value(entry))))

    renderChart()

    mount(results, data.rows.length ? h('div', { class: 'table-wrap' }, h('table',
      h('thead', h('tr', h('th', '模型'), h('th', { class: 'num' }, '调用'), columns.map(col => h('th', { class: 'num' }, col.label)))),
      h('tbody', data.rows.map(entry => row(entry, entry.model))),
      h('tfoot', row(total, '合计')))) : empty('该时间范围内没有详细用量记录。'))
  }

  async function load(event) {
    event?.preventDefault()
    const startMs = new Date(from.value).getTime(), endMs = new Date(to.value).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      note.textContent = '结束时间必须晚于开始时间。'
      return
    }
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
    } catch (error) {
      if (current === sequence) {
        data = undefined
        mount(chartArea, null)
        mount(results, empty(`详细统计暂不可用：${error.message}`))
      }
    } finally {
      if (current === sequence) submit.disabled = false
    }
  }

  category.addEventListener('change', draw)
  metric.addEventListener('change', () => {
    if (metric.value === 'cost') chartMetric = 'cost'
    if (metric.value === 'tokens') chartMetric = 'tokens'
    draw()
  })

  const view = card('按时间与模型统计',
    h('form', { class: 'usage-filters', onsubmit: load },
      h('label', '开始', from),
      h('label', '结束', to),
      h('label', '模型', model),
      h('label', '类型', category),
      h('label', '显示', metric),
      submit),
    presets,
    note,
    rules,
    chartArea,
    results)

  void load()
  return view
}
