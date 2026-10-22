import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, modal, mount, toast } from '../ui.js'

const MAX_BYTES = 10 * 1024 * 1024
const FILTERS = [['all', '全部'], ['unindexed', '未识别'], ['image', '图片'], ['mface', '商城表情']]
const SORTS = [['new', '最新添加'], ['uses', '最常使用'], ['name', '名称']]

let view = { filter: 'all', sort: 'new', q: '', auto: true, hint: '' }

export async function render(root) {
  let list = await get('/api/stickers')
  const selected = new Set()
  const grid = h('div', { class: 'sticker-grid' })
  const queue = h('div', { class: 'col', style: { gap: '6px' } })
  const queueCard = card('上传进度', queue)
  queueCard.style.display = 'none'
  const countEl = h('span', { class: 'small muted' })
  const delSelBtn = h('button', { class: 'btn danger', disabled: true, onclick: deleteSelected }, '删除选中')

  const reload = async () => { list = await get('/api/stickers'); draw() }

  function visible() {
    const q = view.q.toLowerCase()
    const out = list.filter(s =>
      (view.filter === 'all' || (view.filter === 'unindexed' ? !s.indexed : s.kind === view.filter)) &&
      (!q || `${s.name} ${s.desc} ${s.use} ${(s.tags ?? []).join(' ')} ${s.text ?? ''} ${s.id}`.toLowerCase().includes(q)))
    if (view.sort === 'uses') out.sort((a, b) => b.uses - a.uses)
    else if (view.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    else out.sort((a, b) => b.addedAt - a.addedAt)
    return out
  }

  function draw() {
    for (const id of [...selected]) if (!list.some(s => s.id === id)) selected.delete(id)
    const items = visible()
    countEl.textContent = `显示 ${items.length} / ${list.length} 个 · 未识别 ${list.filter(s => !s.indexed).length} 个${selected.size ? ` · 已选 ${selected.size}` : ''}`
    delSelBtn.disabled = !selected.size
    delSelBtn.textContent = selected.size ? `删除选中（${selected.size}）` : '删除选中'
    mount(grid, items.length ? items.map(tile) : h('div', { style: { gridColumn: '1 / -1' } }, empty(list.length ? '没有匹配的表情' : '还没有表情包：把图片拖到这里，或点「上传」')))
  }

  function tile(s) {
    const check = h('input', { type: 'checkbox', checked: selected.has(s.id), onclick: e => e.stopPropagation(), onchange: () => { check.checked ? selected.add(s.id) : selected.delete(s.id); draw() } })
    return h('div', { class: `sticker ${selected.has(s.id) ? 'sel' : ''}` },
      h('div', { class: 'img', style: { position: 'relative', cursor: 'zoom-in' }, onclick: () => detail(s) },
        s.hasImage ? h('img', { src: `/api/stickers/${enc(s.id)}/image?v=${s.hash?.slice(0, 8) ?? ''}`, loading: 'lazy', alt: s.name }) : h('span', { class: 'muted small' }, s.kind === 'mface' ? '商城表情（无预览）' : '无图片'),
        h('label', { class: 'pick', onclick: e => e.stopPropagation() }, check)),
      h('div', { class: 'meta' },
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('b', { class: 'clip', title: s.name }, s.name), s.kind === 'mface' ? badge('商城', 'accent') : null),
        h('div', { class: 'muted clamp', title: s.desc }, s.desc || '（未识别）'),
        s.tags?.length ? h('div', { class: 'chips', style: { marginTop: '4px' } }, s.tags.slice(0, 4).map(t => h('span', { class: 'chip' }, t))) : null,
        h('div', { class: 'row', style: { marginTop: '6px', gap: '4px' } }, s.indexed ? null : badge('未识别', 'warn'), badge(`用过 ${s.uses}`)),
        h('div', { class: 'row', style: { marginTop: '4px', gap: '2px', flexWrap: 'nowrap', justifyContent: 'flex-end' } },
          h('button', { class: 'btn sm ghost', title: '编辑', onclick: () => edit(s) }, '编辑'),
          s.hasImage ? h('button', { class: 'btn sm ghost', title: '用视觉模型重新识别名称和描述', onclick: e => reindex(s, e.currentTarget) }, '识别') : null,
          h('button', { class: 'btn sm ghost danger', title: '删除', onclick: async () => {
            if (await confirmDanger(`删除表情「${s.name}」？`)) act(() => del(`/api/stickers/${enc(s.id)}`), '已删除').then(ok => ok && reload())
          } }, '删除'),
        ),
      ),
    )
  }

  function detail(s) {
    modal(s.name, h('div', { class: 'col' },
      s.hasImage ? h('div', { style: { textAlign: 'center', background: 'var(--panel-2)', borderRadius: '10px', padding: '12px' } },
        h('img', { src: `/api/stickers/${enc(s.id)}/image?v=${s.hash?.slice(0, 8) ?? ''}`, style: { maxWidth: '100%', maxHeight: '360px' } })) : null,
      h('table', h('tbody',
        [['ID', h('span', { class: 'mono' }, s.id)], ['描述', s.desc || '-'], ['适用场景', s.use || '-'], ['标签', (s.tags ?? []).join('、') || '-'], ['图中文字', s.text || '-'],
          ['类型', s.kind === 'mface' ? '商城表情' : `图片${s.mime ? `（${s.mime.replace('image/', '')}）` : ''}`], ['添加', `${fmt.time(s.addedAt)}${s.addedBy ? ` · ${s.addedBy === 'web' ? '网页面板' : s.addedBy}` : ''}`], ['使用次数', s.uses]]
          .map(([k, v]) => h('tr', h('th', { style: { width: '90px' } }, k), h('td', v))))),
    ), [{ label: '编辑', run: () => { edit(s); return true } }, { label: '关闭', kind: 'primary' }])
  }

  async function edit(s) {
    const fields = {
      name: h('input', { type: 'text', value: s.name, maxlength: 20 }),
      desc: h('textarea', { rows: 2, maxlength: 60 }, s.desc ?? ''),
      use: h('textarea', { rows: 2, maxlength: 60 }, s.use ?? ''),
      tags: h('input', { type: 'text', value: (s.tags ?? []).join('、'), placeholder: '用顿号或逗号分隔，最多 8 个' }),
      text: h('input', { type: 'text', value: s.text ?? '' }),
    }
    const labels = { name: '名称（模型发表情时用 [表情:名称]）', desc: '画面描述', use: '适用场景', tags: '标签', text: '图中文字' }
    const body = h('div', { class: 'col' }, Object.entries(fields).map(([k, el]) => h('label', { class: 'col', style: { gap: '4px' } }, h('span', { class: 'small muted' }, labels[k]), el)))
    const ok = await modal(`编辑「${s.name}」`, body, [{ label: '取消', value: false }, { label: '保存', kind: 'primary', value: true }])
    if (!ok) return
    const patch = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]))
    if (await act(() => put(`/api/stickers/${enc(s.id)}`, patch), '已保存')) reload()
  }

  async function reindex(s, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '识别中…' }
    const r = await act(() => post(`/api/stickers/${enc(s.id)}/index`), r => `识别为「${r.name}」`)
    if (r) reload()
    else if (btn) { btn.disabled = false; btn.textContent = '识别' }
  }

  async function indexAll(btn) {
    const pending = list.filter(s => !s.indexed && s.hasImage)
    if (!pending.length) return toast('没有需要识别的表情')
    if (!(await confirmDanger(`用视觉模型识别 ${pending.length} 个未识别的表情？每个会调用一次模型。`, '开始识别'))) return
    btn.disabled = true
    let done = 0, failed = 0
    for (const s of pending) {
      btn.textContent = `识别中 ${done + failed + 1}/${pending.length}`
      try { await post(`/api/stickers/${enc(s.id)}/index`); done++ } catch { failed++ }
    }
    btn.disabled = false
    btn.textContent = '识别全部未识别'
    toast(`识别完成：成功 ${done} 个${failed ? `，失败 ${failed} 个` : ''}`, failed ? 'bad' : 'ok')
    reload()
  }

  async function deleteSelected() {
    const ids = [...selected]
    if (!ids.length || !(await confirmDanger(`删除选中的 ${ids.length} 个表情？`))) return
    let failed = 0
    for (const id of ids) await del(`/api/stickers/${enc(id)}`).catch(() => failed++)
    selected.clear()
    toast(failed ? `删除完成，${failed} 个失败` : `已删除 ${ids.length} 个`, failed ? 'bad' : 'ok')
    reload()
  }

  // ---------- upload ----------

  const readAsDataUrl = file => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

  async function upload(files) {
    files = [...files].filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name))
    if (!files.length) return toast('没有可上传的图片', 'bad')
    queueCard.style.display = ''
    let added = 0
    for (const file of files) {
      const status = h('span', { class: 'small muted' }, '等待中')
      queue.prepend(h('div', { class: 'row small', style: { flexWrap: 'nowrap' } }, h('span', { class: 'clip', style: { flex: 1 } }, file.name), status))
      if (file.size > MAX_BYTES) { status.className = 'small bad'; status.textContent = `超过 ${MAX_BYTES >> 20} MB，已跳过`; continue }
      status.textContent = view.auto ? '上传并识别中…' : '上传中…'
      try {
        const r = await post('/api/stickers', { data: await readAsDataUrl(file), index: view.auto, hint: view.hint })
        if (!r.isNew) { status.className = 'small'; status.textContent = `已存在：「${r.sticker.name}」` }
        else if (r.indexError) { status.className = 'small warn'; status.textContent = `已添加，识别失败：${r.indexError}` }
        else { status.className = 'small ok'; status.textContent = `已添加「${r.sticker.name}」${r.sticker.desc ? ` · ${r.sticker.desc}` : ''}` }
        if (r.isNew) added++
      } catch (err) {
        status.className = 'small bad'
        status.textContent = err.message
      }
    }
    if (added) reload()
  }

  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp', multiple: true, style: { display: 'none' }, onchange: () => { upload(fileInput.files); fileInput.value = '' } })
  const dropZone = h('div', { class: 'drop-zone' },
    h('div', h('b', '拖放图片到这里'), h('span', { class: 'muted' }, ' 或 '), h('a', { href: '#', onclick: e => { e.preventDefault(); fileInput.click() } }, '选择文件')),
    h('div', { class: 'row small', style: { justifyContent: 'center', marginTop: '8px' } },
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: view.auto, onchange: e => { view.auto = e.target.checked } }), '上传后用视觉模型自动命名'),
      h('input', { type: 'text', placeholder: '备注（可选，作为识别提示）', value: view.hint, style: { width: '220px' }, oninput: e => { view.hint = e.target.value } })),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, `PNG / JPEG / GIF / WebP，每张不超过 ${MAX_BYTES >> 20} MB；相同图片会自动去重。也可在 QQ 中发送 #llm添加表情 或 #llm导入收藏表情。`),
  )

  // drag anywhere on the page; highlight the drop zone while dragging
  let depth = 0
  const isFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
  const onEnter = e => { if (!isFiles(e)) return; e.preventDefault(); depth++; dropZone.classList.add('over') }
  const onOver = e => { if (isFiles(e)) e.preventDefault() }
  const onLeave = e => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; dropZone.classList.remove('over') } }
  const onDrop = e => {
    if (!isFiles(e)) return
    e.preventDefault()
    depth = 0
    dropZone.classList.remove('over')
    upload(e.dataTransfer.files)
  }
  document.addEventListener('dragenter', onEnter)
  document.addEventListener('dragover', onOver)
  document.addEventListener('dragleave', onLeave)
  document.addEventListener('drop', onDrop)

  const indexBtn = h('button', { class: 'btn', onclick: e => indexAll(e.currentTarget) }, '识别全部未识别')
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '表情包'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '＋ 上传'), fileInput),
    dropZone,
    queueCard,
    h('div', { class: 'row', style: { margin: '16px 0 12px' } },
      h('input', { type: 'search', placeholder: '搜索名称、描述、标签、图中文字…', value: view.q, style: { minWidth: '240px' }, oninput: e => { view.q = e.target.value; draw() } }),
      h('select', { onchange: e => { view.filter = e.target.value; draw() } }, FILTERS.map(([v, l]) => h('option', { value: v, selected: v === view.filter }, l))),
      h('select', { onchange: e => { view.sort = e.target.value; draw() } }, SORTS.map(([v, l]) => h('option', { value: v, selected: v === view.sort }, l))),
      countEl,
      h('span', { class: 'spacer', style: { flex: 1 } }),
      h('button', { class: 'btn', onclick: () => { const items = visible(); const all = items.every(s => selected.has(s.id)); for (const s of items) all ? selected.delete(s.id) : selected.add(s.id); draw() } }, '全选/取消'),
      indexBtn, delSelBtn),
    grid,
  )
  draw()

  return () => {
    document.removeEventListener('dragenter', onEnter)
    document.removeEventListener('dragover', onOver)
    document.removeEventListener('dragleave', onLeave)
    document.removeEventListener('drop', onDrop)
  }
}
