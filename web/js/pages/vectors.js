import { enc, get } from '../api.js'
import { menuButton } from '../main.js'
import { badge, card, empty, fmt, h, mount, toast } from '../ui.js'

/**
 * 3D view of the recall archive: the server projects every stored vector onto its top three principal
 * components; this page renders them on a canvas with a hand-rolled perspective camera (no WebGL / libs).
 * Topic clusters come from k-means on the full vectors server-side, labelled by keywords (no LLM).
 */

const PALETTE = ['#8b7dff', '#4cc9f0', '#f72585', '#7ae582', '#ffb703', '#ff7b54', '#b5179e', '#2ec4b6', '#e9c46a', '#a0c4ff', '#ff99c8', '#90e0ef']
const LIGHT_PALETTE = ['#6854c5', '#137dab', '#bd296a', '#25854b', '#a56b08', '#c44f32', '#933ca3', '#078778', '#937220', '#4c6cba', '#b34479', '#207f8c']

export async function render(root, [keyArg]) {
  const head = h('div', { class: 'page-head' }, menuButton(), h('h1', '向量空间'),
    h('span', { class: 'small muted' }, '旧聊天档案的语义投影（PCA 前三主成分）'))
  const space = h('div', { class: 'space' })
  mount(root, head, space)

  let data
  let kChoice = '' // '' = pick k automatically
  const load = async (q = '') => {
    const params = new URLSearchParams()
    if (keyArg) params.set('key', keyArg)
    if (q) params.set('q', q)
    if (kChoice) params.set('k', kChoice)
    data = await get(`/api/vectors?${params}`)
    return data
  }
  try {
    await load()
  } catch (err) {
    mount(space, h('div', { class: 'empty' }, err.message))
    return
  }

  if (data.points.length < 2) {
    mount(root, head, card(null, empty(
      data.ready
        ? '向量还不够：至少需要两段已向量化的旧聊天档案。聊天记录超出上限被整理成档案后会自动向量化。'
        : '还没有启用向量检索：在「配置 → 长期记忆 → 向量检索」填写 Voyage API Key（或 env:VOYAGE_API_KEY）后，新整理的档案会自动向量化。',
    )))
    return
  }

  // ---------- scene state ----------
  const sessionKeys = [...new Set(data.points.map(p => p.key))]
  let palette = PALETTE
  const colorOf = Object.fromEntries(sessionKeys.map((k, i) => [k, palette[i % palette.length]]))
  // colour by topic cluster, session, or date (oldest blue → newest pink)
  let colorMode = data.clusters?.k > 1 ? 'cluster' : 'session'
  const days = data.points.map(p => p.day).sort()
  const dayRank = Object.fromEntries([...new Set(days)].map((d, i, all) => [d, all.length > 1 ? i / (all.length - 1) : 1]))
  const lerpHex = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('')
  const clusterColor = id => palette[id % palette.length]
  const colorFor = p => (colorMode === 'date' ? lerpHex(palette[1], palette[2], dayRank[p.day] ?? 1) : colorMode === 'cluster' ? clusterColor(p.cluster) : colorOf[p.key])
  const clusterName = c => (c.keywords.length ? c.keywords.slice(0, 3).join(' · ') : `主题 ${c.id + 1}`)
  const kindLabel = p => (p.kind === 'day' ? `${p.day} 当日概要` : fmt.time(p.at))
  const labelOf = Object.fromEntries(data.sessions.map(s => [s.key, s.label]))
  const hidden = new Set()
  const hiddenClusters = new Set()
  const isHidden = p => hidden.has(p.key) || hiddenClusters.has(p.cluster)
  const cam = { yaw: 0.7, pitch: 0.35, dist: 2.6, target: [0, 0, 0], goal: null }
  let auto = true
  let hover = -1
  let selected = -1
  let query = data.query
  const stars = Array.from({ length: 220 }, () => [Math.random(), Math.random(), Math.random() * 0.8 + 0.2])

  // ---------- DOM ----------
  const canvas = h('canvas')
  const tip = h('div', { class: 'tip' })
  const detail = h('div', { class: 'detail' })
  const qInput = h('input', { type: 'search', placeholder: '输入一句话，看它落在哪里（需要向量 Key）…', value: '' })
  const sessionSel = h('select', { onchange: () => { location.hash = sessionSel.value ? `#/vectors/${enc(sessionSel.value)}` : '#/vectors' } },
    h('option', { value: '' }, `全部会话（${data.points.length} 点）`),
    data.sessions.map(s => h('option', { value: s.key, selected: s.key === keyArg }, `${s.label}（${s.vectors}）`)))
  const kSel = h('select', { title: 'k-means 的主题数；自动时按轮廓系数选择', onchange: async () => {
    kChoice = kSel.value
    try {
      const d = await load(query?.text ?? '')
      query = d.query
      hiddenClusters.clear()
      selected = -1
      detail.style.display = 'none'
      if (colorMode !== 'cluster') { colorMode = 'cluster'; colorSel.value = 'cluster' }
      renderKOptions()
      renderLegend()
    } catch (err) { toast(err.message, 'bad') }
  } })
  // silhouettes only come with an automatic pick: keep the last ones to annotate the manual choices
  let autoScores = []
  const renderKOptions = () => {
    const c = data.clusters
    if (c.auto) autoScores = c.scores ?? []
    const sil = Object.fromEntries(autoScores.map(s => [s.k, s.silhouette]))
    mount(kSel,
      h('option', { value: '', selected: !kChoice }, c.auto ? `主题：自动（k=${c.k}）` : '主题：自动'),
      Array.from({ length: Math.max(0, c.maxK - 1) }, (_, i) => i + 2).map(k =>
        h('option', { value: String(k), selected: kChoice === String(k) }, `主题：k=${k}${sil[k] != null ? `（轮廓 ${sil[k].toFixed(2)}）` : ''}`)))
    kSel.disabled = c.maxK < 2
  }
  renderKOptions()
  const autoBtn = h('button', { class: 'btn sm', onclick: () => { auto = !auto; autoBtn.textContent = auto ? '❚❚ 自转' : '▶ 自转' } }, '❚❚ 自转')
  const legend = h('div', { class: 'legend' })
  const renderLegend = () => {
    legend.style.opacity = colorMode === 'date' ? '.5' : '1'
    if (colorMode === 'cluster') {
      const c = data.clusters
      mount(legend,
        h('div', { class: 'muted', style: { marginBottom: '4px' } }, `${c.k} 个主题${c.auto ? '（自动）' : ''} · 点击名称查看`),
        c.list.map(cl => {
          const cb = h('input', { type: 'checkbox', checked: !hiddenClusters.has(cl.id), onchange: () => { cb.checked ? hiddenClusters.delete(cl.id) : hiddenClusters.add(cl.id) } })
          return h('label', cb, h('span', { class: 'sw', style: { background: clusterColor(cl.id) } }),
            h('span', { class: 'clip', onclick: e => { e.preventDefault(); showCluster(cl.id) } }, clusterName(cl)),
            h('span', { class: 'muted' }, cl.size))
        }))
      return
    }
    mount(legend,
      h('div', { class: 'muted', style: { marginBottom: '4px' } }, `解释方差 ${data.variance.map(v => `${(v * 100).toFixed(1)}%`).join(' / ')}`),
      sessionKeys.map(k => {
        const cb = h('input', { type: 'checkbox', checked: !hidden.has(k), onchange: () => { cb.checked ? hidden.delete(k) : hidden.add(k) } })
        return h('label', cb, h('span', { class: 'sw', style: { background: colorOf[k] } }), h('span', { class: 'clip' }, labelOf[k] ?? k), h('span', { class: 'muted' }, data.points.filter(p => p.key === k).length))
      }))
  }
  const colorSel = h('select', { onchange: e => { colorMode = e.target.value; renderLegend() } },
    h('option', { value: 'cluster', selected: colorMode === 'cluster' }, '按主题着色'),
    h('option', { value: 'session', selected: colorMode === 'session' }, '按会话着色'),
    h('option', { value: 'date' }, `按日期着色（${days[0] ?? ''} → ${days.at(-1) ?? ''}）`))
  renderLegend()
  const hud = h('div', { class: 'hud' },
    h('form', { class: 'row', onsubmit: async e => {
      e.preventDefault()
      const q = qInput.value.trim()
      qInput.blur() // so ←/→ browse right away
      try {
        const d = await load(q)
        query = d.query
        if (query) { selected = -1; showQuery() } else detail.style.display = 'none'
      } catch (err) { toast(err.message, 'bad') }
    } }, qInput, h('button', { class: 'btn sm', type: 'submit' }, '定位')),
    sessionSel,
    colorSel,
    kSel,
    autoBtn,
    h('button', { class: 'btn sm', onclick: () => { Object.assign(cam, { yaw: 0.7, pitch: 0.35, dist: 2.6, goal: [0, 0, 0] }); selected = -1; detail.style.display = 'none' } }, '⟲ 复位'),
  )
  mount(space, canvas, hud, legend, tip, detail,
    h('div', { class: 'help' }, '拖动旋转 · Shift/右键拖动平移 · 滚轮缩放 · 单击查看 · 双击飞到该点 · ←/→ 逐个浏览'))

  // ---------- projection ----------
  const ctx = canvas.getContext('2d')
  let theme
  const updateTheme = () => {
    const css = getComputedStyle(space)
    const color = name => css.getPropertyValue(name).trim()
    theme = { ink: color('--canvas-ink'), star: color('--canvas-star'), overlay: color('--canvas-overlay') }
    palette = css.colorScheme === 'light' ? LIGHT_PALETTE : PALETTE
    sessionKeys.forEach((key, i) => { colorOf[key] = palette[i % palette.length] })
    renderLegend()
  }
  updateTheme()
  const themeObserver = new MutationObserver(updateTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const systemTheme = matchMedia('(prefers-color-scheme: dark)')
  systemTheme.addEventListener('change', updateTheme)
  let W = 0, H = 0, dpr = 1
  const resize = () => {
    dpr = Math.min(2, devicePixelRatio || 1)
    W = space.clientWidth
    H = space.clientHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    // resizing clears the canvas, and rAF is paused while the window is hidden: repaint now
    if (started) draw()
  }
  let started = false
  const ro = new ResizeObserver(resize)
  ro.observe(space)
  resize()

  /** world -> [screenX, screenY, depth, scale]; null when behind the camera */
  const project = ([x, y, z]) => {
    x -= cam.target[0]; y -= cam.target[1]; z -= cam.target[2]
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
    const x1 = cy * x + sy * z
    const z1 = -sy * x + cy * z
    const y2 = cp * y - sp * z1
    const z2 = sp * y + cp * z1
    const depth = cam.dist - z2
    if (depth < 0.05) return null
    const f = (Math.min(W, H) * 0.9) / depth
    return [W / 2 + x1 * f, H / 2 - y2 * f, depth, f]
  }

  // ---------- drawing ----------
  let raf
  let screen = []
  let dragging = false, panning = false, moved = 0, last = [0, 0]
  const nearestSet = () => new Set((query?.nearest ?? []).map(n => n.index))

  const frame = () => {
    raf = requestAnimationFrame(frame)
    if (auto && !dragging) cam.yaw += 0.0025
    if (cam.goal) {
      for (let i = 0; i < 3; i++) cam.target[i] += (cam.goal[i] - cam.target[i]) * 0.12
      if (cam.goal.every((g, i) => Math.abs(g - cam.target[i]) < 1e-3)) cam.goal = null
    }
    draw()
  }

  function draw() {
    if (!W || !H) return
    ctx.clearRect(0, 0, W, H)

    for (const [sx, sy, b] of stars) {
      ctx.fillStyle = theme.star
      ctx.fillRect(((sx * W + cam.yaw * 12 * b) % W + W) % W, sy * H, b * 1.4, b * 1.4)
    }

    // axes through the origin
    const axes = [[[1.1, 0, 0], 'PC1', palette[2]], [[0, 1.1, 0], 'PC2', palette[3]], [[0, 0, 1.1], 'PC3', palette[1]]]
    const o = project([0, 0, 0])
    ctx.lineWidth = 1
    for (const [v, label, color] of axes) {
      const a = project(v.map(x => -x)), b = project(v)
      if (!a || !b) continue
      ctx.strokeStyle = color + '55'
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
      ctx.fillStyle = color + 'aa'
      ctx.font = '11px system-ui'
      ctx.fillText(label, b[0] + 4, b[1] - 4)
    }
    if (o) { ctx.fillStyle = theme.ink; ctx.globalAlpha = .35; ctx.beginPath(); ctx.arc(o[0], o[1], 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1 }

    const near = nearestSet()
    screen = data.points.map((p, i) => {
      const s = isHidden(p) ? null : project(p.xyz)
      return s ? { i, x: s[0], y: s[1], depth: s[2], f: s[3] } : null
    }).filter(Boolean).sort((a, b) => b.depth - a.depth)

    // query links under the points
    const qs = query && project(query.xyz)
    if (qs) for (const n of query.nearest) {
      const p = data.points[n.index]
      const s = !isHidden(p) && project(p.xyz)
      if (!s) continue
      const strong = n.score >= query.minScore
      ctx.strokeStyle = theme.ink
      ctx.globalAlpha = strong ? Math.max(.25, Math.min(1, .25 + n.score * .6)) : .12
      ctx.setLineDash(strong ? [] : [4, 4])
      ctx.beginPath(); ctx.moveTo(qs[0], qs[1]); ctx.lineTo(s[0], s[1]); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    for (const s of screen) {
      const p = data.points[s.i]
      const isDay = p.kind === 'day'
      const r = Math.max(2.5, Math.min(14, s.f * 0.028)) * (isDay ? 1.5 : 1)
      const color = colorFor(p)
      const lit = s.i === hover || s.i === selected || near.has(s.i)
      const fade = Math.max(0.35, Math.min(1, 2.6 / s.depth))
      ctx.globalAlpha = fade
      ctx.fillStyle = color + '33'
      ctx.beginPath(); ctx.arc(s.x, s.y, r * (lit ? 3.4 : 2.4), 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = color
      ctx.beginPath()
      // daily digests are diamonds, detailed archive entries are dots
      if (isDay) { ctx.moveTo(s.x, s.y - r * 1.3); ctx.lineTo(s.x + r * 1.3, s.y); ctx.lineTo(s.x, s.y + r * 1.3); ctx.lineTo(s.x - r * 1.3, s.y); ctx.closePath() }
      else ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
      ctx.fill()
      if (isDay) { ctx.strokeStyle = theme.ink; ctx.lineWidth = 1; ctx.stroke() }
      if (lit) {
        ctx.strokeStyle = theme.ink
        ctx.lineWidth = s.i === selected ? 2 : 1.2
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2); ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // topic labels at each cluster's centroid in the projection
    if (colorMode === 'cluster') {
      ctx.font = '12px system-ui'
      for (const cl of data.clusters.list) {
        if (hiddenClusters.has(cl.id)) continue
        const c = project(cl.xyz)
        if (!c) continue
        const label = cl.keywords.slice(0, 2).join(' · ') || `主题 ${cl.id + 1}`
        const w = ctx.measureText(label).width
        ctx.fillStyle = theme.overlay
        ctx.fillRect(c[0] - w / 2 - 6, c[1] - 9, w + 12, 18)
        ctx.strokeStyle = clusterColor(cl.id)
        ctx.lineWidth = 1
        ctx.strokeRect(c[0] - w / 2 - 6, c[1] - 9, w + 12, 18)
        ctx.fillStyle = theme.ink
        ctx.fillText(label, c[0] - w / 2, c[1] + 4)
      }
    }

    if (qs) {
      ctx.save()
      ctx.translate(qs[0], qs[1])
      ctx.rotate(performance.now() / 1500)
      ctx.fillStyle = theme.ink
      ctx.shadowColor = theme.ink
      ctx.shadowBlur = 16
      ctx.beginPath()
      for (let k = 0; k < 10; k++) {
        const rr = k % 2 ? 4 : 10
        ctx.lineTo(Math.cos((k * Math.PI) / 5) * rr, Math.sin((k * Math.PI) / 5) * rr)
      }
      ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.fillStyle = theme.ink
      ctx.font = '12px system-ui'
      ctx.fillText(query.text.slice(0, 24), qs[0] + 14, qs[1] + 4)
    }
  }
  started = true
  frame()

  // ---------- interaction ----------
  const pick = (x, y) => {
    let best = -1, bestD = 14 * 14
    for (const s of screen) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2
      if (d < bestD) { bestD = d; best = s.i }
    }
    return best
  }
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }

  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('pointerdown', e => {
    document.activeElement?.blur?.()
    dragging = true; panning = e.shiftKey || e.button === 2; moved = 0
    last = [e.clientX, e.clientY]
    canvas.setPointerCapture(e.pointerId)
    canvas.classList.add('drag')
    auto = false; autoBtn.textContent = '▶ 自转'
  })
  canvas.addEventListener('pointermove', e => {
    const [x, y] = local(e)
    if (dragging) {
      const dx = e.clientX - last[0], dy = e.clientY - last[1]
      moved += Math.abs(dx) + Math.abs(dy)
      last = [e.clientX, e.clientY]
      if (panning) {
        // move the orbit target in the camera's screen plane
        const k = cam.dist / (Math.min(W, H) * 0.9)
        const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
        const right = [cy, 0, -sy], up = [-sy * sp, cp, -cy * sp]
        for (let i = 0; i < 3; i++) cam.target[i] += (-dx * right[i] + dy * up[i]) * k
        cam.goal = null
      } else {
        cam.yaw -= dx * 0.008
        cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.008))
      }
      tip.style.display = 'none'
      return
    }
    hover = pick(x, y)
    if (hover >= 0) {
      const p = data.points[hover]
      tip.replaceChildren(h('div', { style: { color: colorFor(p), fontWeight: 600 } }, labelOf[p.key] ?? p.key), h('div', { class: 'muted' }, kindLabel(p)), p.text.slice(0, 220) + (p.text.length > 220 ? '…' : ''))
      tip.style.display = 'block'
      tip.style.left = `${Math.min(x + 14, W - 330)}px`
      tip.style.top = `${Math.min(y + 14, H - tip.offsetHeight - 8)}px`
    } else tip.style.display = 'none'
  })
  const up = e => {
    if (!dragging) return
    dragging = false
    canvas.classList.remove('drag')
    if (moved < 4) {
      const i = pick(...local(e))
      if (i >= 0) select(i, false)
    }
  }
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('pointerleave', () => { hover = -1; tip.style.display = 'none' })
  canvas.addEventListener('dblclick', e => { const i = pick(...local(e)); if (i >= 0) select(i, true) })
  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    cam.dist = Math.max(0.4, Math.min(12, cam.dist * Math.exp(e.deltaY * 0.0012)))
  }, { passive: false })

  // browse order: by time
  const order = data.points.map((p, i) => i).sort((a, b) => data.points[a].at - data.points[b].at)
  const onKey = e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const pos = order.indexOf(selected)
      const next = order[(pos + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length]
      select(next, true)
    } else if (e.key === 'Escape') { selected = -1; detail.style.display = 'none' }
    else if (e.key.toLowerCase() === 'r') { Object.assign(cam, { yaw: 0.7, pitch: 0.35, dist: 2.6, goal: [0, 0, 0] }) }
  }
  document.addEventListener('keydown', onKey)

  function select(i, fly) {
    selected = i
    const p = data.points[i]
    if (fly) { cam.goal = [...p.xyz]; cam.dist = Math.min(cam.dist, 1.6); auto = false; autoBtn.textContent = '▶ 自转' }
    const neighbors = data.points.map((q, j) => [j, Math.hypot(...q.xyz.map((v, k) => v - p.xyz[k]))]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 5)
    const pos = order.indexOf(i)
    const cl = data.clusters?.list[p.cluster]
    mount(detail, 
      h('div', { class: 'row' },
        h('span', { class: 'sw', style: { background: colorOf[p.key], width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block' } }),
        h('b', labelOf[p.key] ?? p.key),
        h('button', { class: 'btn sm ghost right', onclick: () => { selected = -1; detail.style.display = 'none' } }, '✕')),
      h('div', { class: 'muted small', style: { margin: '4px 0 8px' } }, `${kindLabel(p)} · 第 ${pos + 1}/${order.length} 个`),
      cl && h('div', { class: 'small', style: { cursor: 'pointer', marginBottom: '8px' }, onclick: () => showCluster(cl.id) },
        h('span', { style: { color: clusterColor(cl.id) } }, '◆ '), `主题：${clusterName(cl)} →`),
      h('pre', { style: { fontFamily: 'inherit', fontSize: '13px' } }, p.text),
      h('div', { class: 'row', style: { margin: '10px 0' } },
        h('button', { class: 'btn sm', onclick: () => select(order[(pos - 1 + order.length) % order.length], true) }, '← 上一段'),
        h('button', { class: 'btn sm', onclick: () => select(order[(pos + 1) % order.length], true) }, '下一段 →'),
        h('button', { class: 'btn sm', onclick: () => { cam.goal = [...p.xyz]; cam.dist = 1.2 } }, '飞到这里'),
      ),
      h('a', { href: `#/conversations/${enc(p.key)}` }, '打开会话 →'),
      h('div', { class: 'muted small', style: { margin: '12px 0 6px' } }, '投影空间中最近的点'),
      neighbors.map(([j, d]) => h('div', { style: { cursor: 'pointer', padding: '4px 0', borderTop: '1px solid var(--line)' }, onclick: () => select(j, true) },
        h('span', { style: { color: colorOf[data.points[j].key] } }, '● '),
        h('span', { class: 'muted small' }, `距离 ${d.toFixed(2)} `),
        data.points[j].text.slice(0, 60))),
    )
    detail.style.display = 'block'
  }

  function showCluster(id) {
    const cl = data.clusters.list[id]
    selected = -1
    mount(detail,
      h('div', { class: 'row' },
        h('span', { style: { background: clusterColor(id), width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block' } }),
        h('b', `主题 ${id + 1}`),
        h('button', { class: 'btn sm ghost right', onclick: () => { detail.style.display = 'none' } }, '✕')),
      h('div', { class: 'muted small', style: { margin: '4px 0 8px' } }, `${cl.size} 段 · 紧密度 ${cl.cohesion.toFixed(3)}（成员与中心的平均余弦）`),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px', marginBottom: '10px' } }, cl.keywords.length ? cl.keywords.map(k => badge(k, 'accent')) : h('span', { class: 'muted small' }, '没有足够的共同关键词')),
      h('div', { class: 'row', style: { margin: '0 0 10px' } },
        h('button', { class: 'btn sm', onclick: () => { cam.goal = [...cl.xyz]; cam.dist = Math.min(cam.dist, 1.6) } }, '飞到中心'),
        h('button', { class: 'btn sm', onclick: () => { hiddenClusters.clear(); data.clusters.list.forEach(c => c.id !== id && hiddenClusters.add(c.id)); renderLegend() } }, '只看这个主题'),
        h('button', { class: 'btn sm', onclick: () => { hiddenClusters.clear(); renderLegend() } }, '显示全部')),
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, '最接近中心的档案'),
      cl.exemplars.map(j => h('div', { style: { cursor: 'pointer', padding: '6px 0', borderTop: '1px solid var(--line)' }, onclick: () => select(j, true) },
        h('div', { class: 'muted small clip' }, `${labelOf[data.points[j].key] ?? data.points[j].key} · ${kindLabel(data.points[j])}`),
        h('div', { class: 'small', style: { marginTop: '2px' } }, data.points[j].text.slice(0, 140)))),
    )
    detail.style.display = 'block'
  }

  function showQuery() {
    mount(detail, 
      h('div', { class: 'row' }, h('b', '★ 查询'), h('button', { class: 'btn sm ghost right', onclick: () => { detail.style.display = 'none' } }, '✕')),
      h('pre', { style: { fontFamily: 'inherit', margin: '6px 0 10px' } }, query.text),
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, `余弦相似度最高的档案（≥ ${query.minScore} 视为相关）`),
      query.nearest.map(n => {
        const p = data.points[n.index]
        return h('div', { style: { cursor: 'pointer', padding: '6px 0', borderTop: '1px solid var(--line)' }, onclick: () => select(n.index, true) },
          h('div', { class: 'row' }, h('span', { style: { color: colorOf[p.key] } }, '●'), badge(n.score.toFixed(3), n.score >= query.minScore ? 'ok' : ''), h('span', { class: 'muted small clip' }, labelOf[p.key] ?? p.key)),
          h('div', { class: 'small', style: { marginTop: '2px' } }, p.text.slice(0, 100)))
      }),
    )
    detail.style.display = 'block'
    cam.goal = [...query.xyz]
  }

  return () => {
    themeObserver.disconnect()
    systemTheme.removeEventListener('change', updateTheme)
    cancelAnimationFrame(raf)
    ro.disconnect()
    document.removeEventListener('keydown', onKey)
  }
}
