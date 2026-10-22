import { enc, get } from '../api.js'
import { menuButton } from '../main.js'
import { badge, card, empty, fmt, h, mount, toast } from '../ui.js'

/**
 * 3D view of the recall archive: the server projects every stored vector onto its top three principal
 * components; this page renders them on a canvas with a hand-rolled perspective camera (no WebGL / libs).
 */

const PALETTE = ['#8b7dff', '#4cc9f0', '#f72585', '#7ae582', '#ffb703', '#ff7b54', '#b5179e', '#2ec4b6', '#e9c46a', '#a0c4ff', '#ff99c8', '#90e0ef']

export async function render(root, [keyArg]) {
  const head = h('div', { class: 'page-head' }, menuButton(), h('h1', '向量空间'),
    h('span', { class: 'small muted' }, '旧聊天档案的语义投影（PCA 前三主成分）'))
  const space = h('div', { class: 'space' })
  mount(root, head, space)

  let data
  const load = async (q = '') => {
    const params = new URLSearchParams()
    if (keyArg) params.set('key', keyArg)
    if (q) params.set('q', q)
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
  const colorOf = Object.fromEntries(sessionKeys.map((k, i) => [k, PALETTE[i % PALETTE.length]]))
  const labelOf = Object.fromEntries(data.sessions.map(s => [s.key, s.label]))
  const hidden = new Set()
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
  const autoBtn = h('button', { class: 'btn sm', onclick: () => { auto = !auto; autoBtn.textContent = auto ? '❚❚ 自转' : '▶ 自转' } }, '❚❚ 自转')
  const legend = h('div', { class: 'legend' },
    h('div', { style: { marginBottom: '4px', color: '#8b91a8' } }, `解释方差 ${data.variance.map(v => `${(v * 100).toFixed(1)}%`).join(' / ')}`),
    sessionKeys.map(k => {
      const cb = h('input', { type: 'checkbox', checked: true, onchange: () => { cb.checked ? hidden.delete(k) : hidden.add(k) } })
      return h('label', cb, h('span', { class: 'sw', style: { background: colorOf[k] } }), h('span', { class: 'clip' }, labelOf[k] ?? k), h('span', { style: { color: '#8b91a8' } }, data.points.filter(p => p.key === k).length))
    }))
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
    sessionSel, autoBtn,
    h('button', { class: 'btn sm', onclick: () => { Object.assign(cam, { yaw: 0.7, pitch: 0.35, dist: 2.6, goal: [0, 0, 0] }); selected = -1; detail.style.display = 'none' } }, '⟲ 复位'),
  )
  mount(space, canvas, hud, legend, tip, detail,
    h('div', { class: 'help' }, '拖动旋转 · Shift/右键拖动平移 · 滚轮缩放 · 单击查看 · 双击飞到该点 · ←/→ 逐个浏览'))

  // ---------- projection ----------
  const ctx = canvas.getContext('2d')
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
      ctx.fillStyle = `rgba(200,210,255,${0.15 + 0.35 * b})`
      ctx.fillRect(((sx * W + cam.yaw * 12 * b) % W + W) % W, sy * H, b * 1.4, b * 1.4)
    }

    // axes through the origin
    const axes = [[[1.1, 0, 0], 'PC1', '#ff7b8f'], [[0, 1.1, 0], 'PC2', '#7ae582'], [[0, 0, 1.1], 'PC3', '#4cc9f0']]
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
    if (o) { ctx.fillStyle = '#ffffff55'; ctx.beginPath(); ctx.arc(o[0], o[1], 2, 0, Math.PI * 2); ctx.fill() }

    const near = nearestSet()
    screen = data.points.map((p, i) => {
      const s = hidden.has(p.key) ? null : project(p.xyz)
      return s ? { i, x: s[0], y: s[1], depth: s[2], f: s[3] } : null
    }).filter(Boolean).sort((a, b) => b.depth - a.depth)

    // query links under the points
    const qs = query && project(query.xyz)
    if (qs) for (const n of query.nearest) {
      const p = data.points[n.index]
      const s = !hidden.has(p.key) && project(p.xyz)
      if (!s) continue
      const strong = n.score >= query.minScore
      ctx.strokeStyle = strong ? `rgba(255,255,255,${0.25 + n.score * 0.6})` : 'rgba(255,255,255,0.12)'
      ctx.setLineDash(strong ? [] : [4, 4])
      ctx.beginPath(); ctx.moveTo(qs[0], qs[1]); ctx.lineTo(s[0], s[1]); ctx.stroke()
      ctx.setLineDash([])
    }

    for (const s of screen) {
      const p = data.points[s.i]
      const r = Math.max(2.5, Math.min(14, s.f * 0.028))
      const color = colorOf[p.key]
      const lit = s.i === hover || s.i === selected || near.has(s.i)
      const fade = Math.max(0.35, Math.min(1, 2.6 / s.depth))
      ctx.globalAlpha = fade
      ctx.fillStyle = color + '33'
      ctx.beginPath(); ctx.arc(s.x, s.y, r * (lit ? 3.4 : 2.4), 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = color
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill()
      if (lit) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = s.i === selected ? 2 : 1.2
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2); ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    if (qs) {
      ctx.save()
      ctx.translate(qs[0], qs[1])
      ctx.rotate(performance.now() / 1500)
      ctx.fillStyle = '#fff'
      ctx.shadowColor = '#fff'
      ctx.shadowBlur = 16
      ctx.beginPath()
      for (let k = 0; k < 10; k++) {
        const rr = k % 2 ? 4 : 10
        ctx.lineTo(Math.cos((k * Math.PI) / 5) * rr, Math.sin((k * Math.PI) / 5) * rr)
      }
      ctx.closePath(); ctx.fill()
      ctx.restore()
      ctx.fillStyle = '#fff'
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
      tip.replaceChildren(h('div', { style: { color: colorOf[p.key], fontWeight: 600 } }, labelOf[p.key] ?? p.key), h('div', { style: { color: '#8b91a8' } }, fmt.time(p.at)), p.text.slice(0, 220) + (p.text.length > 220 ? '…' : ''))
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
    mount(detail, 
      h('div', { class: 'row' },
        h('span', { class: 'sw', style: { background: colorOf[p.key], width: '10px', height: '10px', borderRadius: '50%', display: 'inline-block' } }),
        h('b', labelOf[p.key] ?? p.key),
        h('button', { class: 'btn sm ghost right', style: { color: '#e6e8f0' }, onclick: () => { selected = -1; detail.style.display = 'none' } }, '✕')),
      h('div', { class: 'muted small', style: { margin: '4px 0 8px' } }, `${fmt.time(p.at)} · 第 ${pos + 1}/${order.length} 段`),
      h('pre', { style: { fontFamily: 'inherit', fontSize: '13px' } }, p.text),
      h('div', { class: 'row', style: { margin: '10px 0' } },
        h('button', { class: 'btn sm', onclick: () => select(order[(pos - 1 + order.length) % order.length], true) }, '← 上一段'),
        h('button', { class: 'btn sm', onclick: () => select(order[(pos + 1) % order.length], true) }, '下一段 →'),
        h('button', { class: 'btn sm', onclick: () => { cam.goal = [...p.xyz]; cam.dist = 1.2 } }, '飞到这里'),
      ),
      h('a', { href: `#/conversations/${enc(p.key)}` }, '打开会话 →'),
      h('div', { class: 'muted small', style: { margin: '12px 0 6px' } }, '投影空间中最近的点'),
      neighbors.map(([j, d]) => h('div', { style: { cursor: 'pointer', padding: '4px 0', borderTop: '1px solid #ffffff14' }, onclick: () => select(j, true) },
        h('span', { style: { color: colorOf[data.points[j].key] } }, '● '),
        h('span', { class: 'muted small' }, `距离 ${d.toFixed(2)} `),
        data.points[j].text.slice(0, 60))),
    )
    detail.style.display = 'block'
  }

  function showQuery() {
    mount(detail, 
      h('div', { class: 'row' }, h('b', '★ 查询'), h('button', { class: 'btn sm ghost right', style: { color: '#e6e8f0' }, onclick: () => { detail.style.display = 'none' } }, '✕')),
      h('pre', { style: { fontFamily: 'inherit', margin: '6px 0 10px' } }, query.text),
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, `余弦相似度最高的档案（≥ ${query.minScore} 视为相关）`),
      query.nearest.map(n => {
        const p = data.points[n.index]
        return h('div', { style: { cursor: 'pointer', padding: '6px 0', borderTop: '1px solid #ffffff14' }, onclick: () => select(n.index, true) },
          h('div', { class: 'row' }, h('span', { style: { color: colorOf[p.key] } }, '●'), badge(n.score.toFixed(3), n.score >= query.minScore ? 'ok' : ''), h('span', { class: 'muted small clip' }, labelOf[p.key] ?? p.key)),
          h('div', { class: 'small', style: { marginTop: '2px' } }, p.text.slice(0, 100)))
      }),
    )
    detail.style.display = 'block'
    cam.goal = [...query.xyz]
  }

  return () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
    document.removeEventListener('keydown', onKey)
  }
}
