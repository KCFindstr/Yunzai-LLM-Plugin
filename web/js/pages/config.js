import { api, del, get, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, combo, confirmDanger, empty, h, icon, modal, mount, promptFields, switchEl, tabs, toast } from '../ui.js'

/**
 * Schema-driven config editor. Every write goes through PUT /api/config (validated server-side with the same
 * schema as `npm run config`), so the form can't produce a config the plugin rejects.
 */

const BASIC = ['enable', 'admins', 'defaultModel', 'fallbackModels', 'utilityModel', 'visionModel']
const isContainer = n => n && ['obj', 'map', 'arr'].includes(n.t)
const pathOf = keys => keys.join('.')

let state // { data, open: Set<path>, section, search }

export async function render(root, [section]) {
  const data = await get('/api/config')
  state = { data, open: state?.open ?? new Set(), section: section ?? state?.section ?? 'basic', search: '', root }
  if (section === 'yaml') return renderYaml(root)
  draw()
}

async function refresh() {
  state.data = await get('/api/config')
  draw()
}

function sections() {
  const fields = state.data.schema.fields
  return [['basic', '基础'], ...Object.entries(fields).filter(([k, n]) => !BASIC.includes(k) && isContainer(n)).map(([k, n]) => [k, n.label ?? k])]
}

function draw() {
  const { root } = state
  const secs = sections()
  if (!secs.some(([id]) => id === state.section)) state.section = 'basic'
  const body = h('div')
  const search = h('input', { type: 'search', placeholder: '搜索配置项（名称、键名、说明）…', value: state.search, style: { width: '100%', marginBottom: '12px' },
    oninput: () => { state.search = search.value; drawBody(body) } })

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '配置'), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, '修改立即保存到 config.yaml 并热重载')),
    tabs([['form', '表单'], ['yaml', 'config.yaml']], 'form', id => { if (id === 'yaml') location.hash = '#/config/yaml' }),
    h('div', { class: 'cfg' },
      h('nav', { class: 'cfg-nav card' }, secs.map(([id, label]) => h('a', { href: `#/config/${id}`, class: id === state.section ? 'on' : '' }, label))),
      h('div', problems(), search, body),
    ),
  )
  drawBody(body)
}

function drawBody(body) {
  const { schema, effective } = state.data
  if (state.search.trim()) return mount(body, card(null, searchResults(state.search.trim().toLowerCase())))
  if (state.section === 'basic')
    return mount(body, card('基础', BASIC.filter(k => schema.fields[k]).map(k => leaf(schema.fields[k], [k], effective[k], effective))))
  const node = schema.fields[state.section]
  const skillsLink = state.section === 'skills' ? h('div', { class: 'notice', style: { borderColor: 'var(--accent)', background: 'var(--accent-soft)', marginBottom: '16px' } },
    icon('tools', 18),
    h('span', '要创建、编写或管理具体的技能内容，请前往「工具与技能 → 技能」页面。'),
    h('a', { href: '#/tools/skills', class: 'btn sm primary' }, '前往技能管理 →')) : null
  mount(body, card(node.label ?? state.section,
    skillsLink,
    h('div', { class: 'small muted mono', style: { marginBottom: '6px' } }, state.section),
    descFor([state.section]) ? h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap', marginBottom: '8px' } }, descFor([state.section])) : null,
    container(node, [state.section], effective[state.section], effective)))
}

/** Same checks as the terminal editor's 检查配置: models pointing at a missing provider, keyless defaults, ... */
function problems() {
  const list = state.data.problems ?? []
  if (!list.length) return null
  return h('div', { class: 'card', style: { borderColor: 'var(--warn)', marginBottom: '12px' } },
    h('div', { class: 'warn', style: { fontWeight: 600, marginBottom: '4px' } }, '配置检查发现问题'),
    h('ul', { class: 'small', style: { margin: 0, paddingLeft: '18px' } }, list.map(p => h('li', p))))
}

// ---------- descriptions ----------

function descFor(keys) {
  const d = state.data.descriptions
  const generic = keys.map(k => (typeof k === 'number' ? '*' : k))
  const tries = [generic.join('.')]
  if (keys[0] === 'providers' || keys[0] === 'groups') {
    const tail = generic.slice(2).join('.')
    for (const [k, v] of Object.entries(d)) if (k.split('.')[0] === keys[0] && k.split('.').slice(2).join('.') === tail && tail) return v
    if (keys[0] === 'groups' && keys.length > 2) tries.push(tail)
  }
  for (const t of tries) if (d[t]) return d[t]
  return ''
}

const isOverridden = keys => state.data.overridden.includes(pathOf(keys))

// ---------- writes ----------

async function save(keys, value, msg = '已保存') {
  const ok = await act(() => put('/api/config', { path: pathOf(keys), value }), msg)
  if (ok) await refresh()
  return ok
}

async function reset(keys, msg = '已恢复默认') {
  const ok = await act(() => del(`/api/config?path=${encodeURIComponent(pathOf(keys))}`), msg)
  if (ok) await refresh()
}

// ---------- containers ----------

function container(node, keys, value, parent) {
  if (node.t === 'obj') return Object.entries(node.fields).map(([k, f]) => {
    if (f.whenTypes && parent && value && !f.whenTypes.includes(value.type)) return null
    return isContainer(f) ? group(f, [...keys, k], value?.[k], value) : leaf(f, [...keys, k], value?.[k], value)
  })
  if (node.t === 'map') return mapEditor(node, keys, value ?? {})
  if (node.t === 'arr') return arrEditor(node, keys, value ?? [])
  return null
}

function group(node, keys, value, parent, title, actions) {
  const p = pathOf(keys)
  const content = h('div', { style: { paddingBottom: '8px' } })
  const det = h('details', { class: 'group', open: state.open.has(p) },
    h('summary', title ?? node.label ?? keys.at(-1), h('span', { class: 'small muted mono' }, keys.at(-1)),
      isOverridden(keys) ? badge('已修改', 'warn') : null,
      node.t === 'map' ? badge(`${Object.keys(value ?? {}).length} 项`) : node.t === 'arr' ? badge(`${(value ?? []).length} 项`) : null,
      h('span', { style: { flex: 1 } }), actions),
    descFor(keys) ? h('div', { class: 'small muted', style: { whiteSpace: 'pre-wrap' } }, descFor(keys)) : null,
    content,
  )
  // render lazily on first open: big maps (groups) stay cheap
  let filled = false
  const fill = () => {
    if (filled) return
    filled = true
    content.replaceChildren(...[container(node, keys, value, parent)].flat(Infinity).filter(Boolean))
  }
  if (det.open) fill()
  det.addEventListener('toggle', () => {
    if (det.open) { state.open.add(p); fill() } else state.open.delete(p)
  })
  return det
}

function mapEditor(node, keys, value) {
  const entries = Object.entries(value)
  const isGroups = pathOf(keys) === 'groups'
  const add = async () => {
    if (pathOf(keys) === 'providers') return addProvider()
    const fields = [{ name: 'key', label: node.keyLabel ?? '键名', list: isGroups ? 'cfg-groups' : undefined }]
    if (!isContainer(node.value)) fields.push(fieldFor(node.value, 'value', node.value.label ?? '值', {}))
    const dl = isGroups ? h('datalist', { id: 'cfg-groups' }, state.data.groups.map(g => h('option', { value: g.id }, g.name))) : null
    if (dl) document.body.append(dl)
    const r = await promptFields(`添加${node.label ?? ''}`, fields, '确定', r => {
      const k = r.key.trim()
      if (!k) return `请填写${node.keyLabel ?? '键名'}`
      if (node.keyPattern && !new RegExp(node.keyPattern).test(k)) return `${node.keyLabel ?? '键名'}格式不正确`
      if (k in value) return '已存在'
    })
    dl?.remove()
    if (!r) return
    const k = r.key.trim()
    state.open.add(pathOf([...keys, k]))
    await save([...keys, k], isContainer(node.value) ? {} : fieldValue(node.value, r.value), '已添加')
  }
  return [
    entries.length ? null : h('div', { class: 'small muted', style: { padding: '6px 0' } }, '（空）'),
    entries.map(([k, v]) => {
      const childKeys = [...keys, k]
      const remove = h('button', { class: 'btn sm ghost danger', onclick: async e => {
        e.preventDefault()
        if (await confirmDanger(`删除 ${pathOf(childKeys)}？`)) reset(childKeys, '已删除')
      } }, '删除')
      if (!isContainer(node.value)) return leaf(node.value, childKeys, v, value, k, remove)
      const name = isGroups ? state.data.groups.find(g => g.id === k)?.name : undefined
      return group(node.value, childKeys, v, value, name ? `${k} · ${name}` : k, remove)
    }),
    h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: add }, `＋ 添加${node.keyLabel ? `（${node.keyLabel}）` : ''}`),
  ]
}

function arrEditor(node, keys, value) {
  const add = async () => {
    if (pathOf(keys) === 'models') return addModel()
    const create = node.create ?? []
    const fields = create.map(f => fieldFor(node.item.fields?.[f], f, node.item.fields?.[f]?.label ?? f, {}))
    let item = {}
    if (fields.length) {
      const r = await promptFields(`添加${node.label ?? ''}`, fields)
      if (!r) return
      for (const f of create) {
        const v = fieldValue(node.item.fields?.[f], r[f])
        if (v !== undefined) item[f] = v
      }
    }
    state.open.add(pathOf([...keys, value.length]))
    await save([...keys, value.length], item, '已添加')
  }
  return [
    value.length ? null : h('div', { class: 'small muted', style: { padding: '6px 0' } }, '（空）'),
    value.map((item, i) => {
      const title = item?.id ? `${item.id}  ${item.provider ?? ''}/${item.model ?? ''}` : item?.name ?? `#${i + 1}`
      const remove = h('button', { class: 'btn sm ghost danger', onclick: async e => {
        e.preventDefault()
        if (await confirmDanger(`删除「${title}」？`)) reset([...keys, i], '已删除')
      } }, '删除')
      return group(node.item, [...keys, i], item, value, title, remove)
    }),
    h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: add }, '＋ 添加'),
  ]
}

// ---------- leaves ----------

function leaf(node, keys, value, parent, title, extra) {
  const overridden = isOverridden(keys)
  return h('div', { class: 'field' },
    h('div',
      h('div', { class: 'name' }, title ?? node.label ?? keys.at(-1), ' ', overridden ? badge('已修改', 'warn') : null),
      h('div', { class: 'key' }, pathOf(keys)),
      descFor(keys) ? h('div', { class: 'desc' }, descFor(keys)) : null,
    ),
    h('div', { class: 'ctl' }, control(node, keys, value, parent), h('div', { class: 'row' },
      overridden && !extra ? h('button', { class: 'btn sm ghost', onclick: () => reset(keys) }, '恢复默认') : null, extra)),
  )
}

function control(node, keys, value, parent) {
  switch (node.t) {
    case 'bool':
      return h('div', switchEl(Boolean(value), on => save(keys, on)))
    case 'num': {
      const input = h('input', { type: 'number', value: value ?? '', step: node.int ? 1 : 'any', min: node.min, max: node.max, placeholder: node.nullable ? '空 = 不限' : '' })
      input.addEventListener('change', () => {
        const raw = input.value.trim()
        if (raw === '') return node.nullable ? save(keys, null) : toast('不能为空', 'bad')
        save(keys, Number(raw))
      })
      const range = [node.min != null && `≥ ${node.min}`, node.max != null && `≤ ${node.max}`].filter(Boolean).join('，')
      return h('div', { class: 'col', style: { gap: '2px' } }, input, range ? h('span', { class: 'small muted' }, `${node.int ? '整数' : '数字'} ${range}`) : null)
    }
    case 'str': {
      const sugg = suggestionsFor(node, parent)
      // a real list to pick from (a datalist only shows what matches the text already typed)
      if (sugg.length) return combo(sugg, value ?? '', { empty: node.required ? undefined : '（空）', onchange: v => (v === '' && !node.required ? reset(keys, '已清除') : save(keys, v)) })
      const input = h('input', { type: 'text', value: value ?? '', placeholder: node.pattern ? `格式：${node.pattern}` : '' })
      input.addEventListener('change', () => save(keys, input.value))
      return h('div', input)
    }
    case 'text': {
      const ta = h('textarea', { rows: Math.min(18, Math.max(4, String(value ?? '').split('\n').length + 1)) }, value ?? '')
      return h('div', { class: 'col' }, ta, h('div', h('button', { class: 'btn sm primary', onclick: () => save(keys, ta.value) }, '保存')))
    }
    case 'secret': {
      const input = h('input', { type: 'password', placeholder: value?.set ? '输入新值以替换' : '未配置', autocomplete: 'new-password' })
      return h('div', { class: 'col' },
        h('div', { class: 'row small' }, value?.set ? badge('已配置', 'ok') : badge('未配置', 'bad'), value?.shown ? h('span', { class: 'mono muted' }, value.shown) : null),
        h('div', { class: 'row' }, input,
          h('button', { class: 'btn sm primary', onclick: () => {
            const raw = input.value.trim()
            if (!raw) return toast('请输入新值', 'bad')
            save(keys, raw.includes(',') ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw)
          } }, '保存')),
        h('span', { class: 'small muted' }, '多个 Key 用英文逗号分隔；env:变量名 从环境变量读取'))
    }
    case 'enum': {
      // option values are strings; map back so enums mixing booleans (reply.markdown: false / true / auto) save the real value
      const unset = value == null || value === ''
      const sel = h('select', { onchange: () => (sel.value === '' ? reset(keys, '已清除') : save(keys, enumValue(node, sel.value))) },
        node.allowEmpty || unset ? h('option', { value: '', selected: unset }, '（空）') : null,
        node.values.map(v => h('option', { value: String(v), selected: v === value }, String(v))))
      if (!unset && !node.values.includes(value)) sel.prepend(h('option', { value: String(value), selected: true }, `${value}（无效）`))
      return sel
    }
    case 'multi': {
      const cur = Array.isArray(value) ? value : []
      return h('div', { class: 'col', style: { gap: '4px' } },
        h('div', { class: 'chips' }, [...new Set([...cur, ...node.values])].map(v => h('span', {
          class: `chip ${cur.includes(v) ? 'on' : ''}`,
          onclick: () => save(keys, cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v]),
        }, node.ordered && cur.includes(v) ? `${cur.indexOf(v) + 1}. ${v}` : v))),
        node.ordered ? h('span', { class: 'small muted' }, '按点击顺序排列；取消后重新点击可调整顺序') : null)
    }
    case 'list': {
      const ta = h('textarea', { rows: Math.max(3, (value ?? []).length + 1), placeholder: '每行一个' }, (value ?? []).join('\n'))
      return h('div', { class: 'col' }, ta, h('div', h('button', { class: 'btn sm primary', onclick: () => {
        const items = ta.value.split(/[\n,，]/).map(s => s.trim()).filter(Boolean).map(s => (/^\d{1,15}$/.test(s) ? Number(s) : s))
        save(keys, items)
      } }, '保存')))
    }
    case 'any': {
      const ta = h('textarea', { class: 'code', rows: 6, placeholder: 'JSON，例如 {"key": "value"}' }, value == null ? '' : JSON.stringify(value, null, 2))
      return h('div', { class: 'col' }, ta, h('div', h('button', { class: 'btn sm primary', onclick: () => {
        if (!ta.value.trim()) return reset(keys)
        try { save(keys, JSON.parse(ta.value)) } catch (err) { toast(`JSON 格式错误：${err.message}`, 'bad') }
      } }, '保存')))
    }
    case 'pricing': {
      const auto = value == null || value === 'auto'
      const sel = h('select', { onchange: () => (sel.value === 'auto' ? save(keys, 'auto') : save(keys, { input: 0, output: 0 })) },
        h('option', { value: 'auto', selected: auto }, '自动（价格表）'), h('option', { value: 'manual', selected: !auto }, '手动填写'))
      if (auto) return sel
      return h('div', { class: 'col' }, sel, Object.entries(node.fields).map(([k, f]) => h('label', { class: 'row small' },
        h('span', { style: { width: '170px' } }, f.label),
        (() => { const i = h('input', { type: 'number', step: 'any', value: value?.[k] ?? '', style: { width: '120px' } }); i.addEventListener('change', () => (i.value === '' ? reset([...keys, k], '已清除') : save([...keys, k], Number(i.value)))); return i })())))
    }
    default:
      return h('pre', { class: 'small' }, JSON.stringify(value))
  }
}

// ---------- typed dialog fields ----------

const suggestionsFor = (node, parent) => (node.suggestByProvider ? node.suggestByProvider[parent?.provider] ?? [] : node.suggest ?? [])
const enumValue = (node, raw) => node.values.find(v => String(v) === raw) ?? raw

/** promptFields entry for a schema leaf, so add dialogs offer the same choices as the form. */
function fieldFor(node, name, label, parent) {
  if (!node) return { name, label }
  if (node.t === 'enum') return { name, label, options: [...(node.allowEmpty ? [{ value: '', label: '（空）' }] : []), ...node.values.map(String)] }
  if (node.t === 'bool') return { name, label, type: 'checkbox' }
  if (node.t === 'num') return { name, label, type: 'number' }
  if (node.t === 'text') return { name, label, multiline: true, rows: 10 }
  if (node.t === 'list') return { name, label: `${label}（每行一个）`, multiline: true, rows: 4 }
  if (node.t === 'str' && suggestionsFor(node, parent).length) return { name, label, combo: suggestionsFor(node, parent) }
  return { name, label }
}

/** Dialog result → config value; undefined = leave unset. */
function fieldValue(node, raw) {
  if (typeof raw === 'boolean') return raw
  const v = String(raw ?? '').trim()
  if (v === '') return undefined
  if (node?.t === 'enum') return enumValue(node, v)
  if (node?.t === 'num') return Number(v)
  if (node?.t === 'list') return v.split(/[\n,，]/).map(s => s.trim()).filter(Boolean)
  return node?.t === 'text' ? raw : v
}

// ---------- guided add (same steps as the terminal editor's 添加提供商 / 添加模型) ----------

const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'custom'

async function addProvider() {
  const existing = Object.keys(state.data.effective.providers ?? {})
  const presets = state.data.presets ?? []
  const types = state.data.schema.fields.providers.value.fields.type.values
  const freeName = base => { let n = base, i = 2; while (existing.includes(n)) n = `${base}${i++}`; return n }
  let autoName = freeName(slug(presets[0]?.[0]))
  const r = await promptFields('添加提供商', [
    { name: 'preset', label: '预设', value: '0',
      options: [...presets.map(([n, t, u], i) => ({ value: String(i), label: `${n} · ${t} · ${u}` })), { value: 'custom', label: '自定义…' }],
      onchange: inp => {
        const p = presets[Number(inp.preset.value)]
        if (!p) return
        inp.type.value = p[1]
        inp.baseUrl.value = p[2]
        // follow the preset unless the name was typed by hand
        if (inp.name.value === autoName) inp.name.value = autoName = freeName(slug(p[0]))
      } },
    { name: 'name', label: '名称（英文，用于模型配置）', value: autoName },
    { name: 'type', label: '接口类型', value: presets[0]?.[1] ?? 'openai', options: types },
    { name: 'baseUrl', label: '接口地址', value: presets[0]?.[2] ?? '' },
    { name: 'apiKey', label: 'API Key（可留空稍后设置；多个用英文逗号分隔；env:变量名 读取环境变量）', type: 'password' },
  ], '添加', r => {
    const n = r.name.trim()
    if (!/^[\w-]+$/.test(n)) return '名称只能包含字母数字下划线横线'
    if (existing.includes(n)) return '名称已存在'
    if (!/^https?:\/\/\S+$/.test(r.baseUrl.trim())) return '请输入 http(s) 接口地址'
  })
  if (!r) return
  const name = r.name.trim()
  const p = { type: r.type, baseUrl: r.baseUrl.trim() }
  const key = r.apiKey.trim()
  if (key) p.apiKey = key.includes(',') ? key.split(',').map(s => s.trim()).filter(Boolean) : key
  if (/deepseek\.com/.test(p.baseUrl)) p.balance = 'deepseek'
  state.open.add(pathOf(['providers', name]))
  if (!(await save(['providers', name], p, `已添加提供商 ${name}`))) return
  const next = await modal('提供商已添加', h('p', `现在为 ${name} 添加一个模型？`), [{ label: '稍后', value: false }, { label: '添加模型', kind: 'primary', value: true }])
  if (next) await addModel(name)
}

const modelOptions = () => state.data.schema.fields.models.item.fields.model.suggestByProvider ?? {}

async function addModel(providerName) {
  const { effective, schema } = state.data
  const providers = Object.keys(effective.providers ?? {})
  if (!providers.length) return toast('请先添加提供商', 'bad')
  const ids = (effective.models ?? []).map(m => m.id)
  const byProvider = modelOptions()
  const defId = m => m.replace(/^.*\//, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-')
  const provider = providerName ?? providers[0]
  const first = p => byProvider[p]?.[0] ?? ''
  let autoId = defId(first(provider))
  const followModel = inp => {
    if (inp.id.value === autoId) inp.id.value = autoId = defId(inp.model.value)
    inp.vision.checked = !/deepseek/.test(inp.model.value)
  }
  const r = await promptFields('添加模型', [
    { name: 'provider', label: '提供商', value: provider, options: providers.map(p => ({ value: p, label: `${p} · ${effective.providers[p].type}` })),
      onchange: inp => {
        inp.model.setOptions(byProvider[inp.provider.value] ?? [])
        inp.model.value = first(inp.provider.value)
        followModel(inp)
      } },
    { name: 'model', label: '上游模型（官方 API 的模型 ID）', value: first(provider), combo: byProvider[provider] ?? [], onchange: followModel },
    { name: 'id', label: '别名 id（在指令里使用，可用中文）', value: autoId },
    { name: 'thinking', label: '思考强度', value: 'low', options: state.data.thinking ?? schema.fields.models.item.fields.thinking.values },
    { name: 'vision', label: '支持图片输入', type: 'checkbox', value: !/deepseek/.test(first(provider)) },
    { name: 'makeDefault', label: '设为默认模型', type: 'checkbox', value: !effective.defaultModel },
  ], '添加', r => {
    if (!r.model.trim()) return '请填写上游模型名'
    const id = r.id.trim()
    if (!/^[\p{L}\p{N}_.-]+$/u.test(id)) return '别名只能包含中英文、数字和 . _ -（不能有空格）'
    if (ids.includes(id)) return '别名已存在'
  })
  if (!r) return
  const id = r.id.trim()
  const entry = { id, provider: r.provider, model: r.model.trim(), thinking: r.thinking, pricing: 'auto', ...(r.vision ? {} : { vision: false }) }
  state.open.add(pathOf(['models', ids.length]))
  if (!(await save(['models', ids.length], entry, `已添加模型 ${id}`))) return
  if (r.makeDefault) await save(['defaultModel'], id, `已设 ${id} 为默认模型`)
}

// ---------- search ----------

function searchResults(q) {
  const out = []
  const walk = (node, keys, value, parent) => {
    if (!node) return
    if (node.t === 'obj') for (const [k, f] of Object.entries(node.fields)) walk(f, [...keys, k], value?.[k], value)
    else if (node.t === 'map') for (const [k, v] of Object.entries(value ?? {})) walk(node.value, [...keys, k], v, value)
    else if (node.t === 'arr') (value ?? []).forEach((v, i) => walk(node.item, [...keys, i], v, value))
    else if (`${node.label ?? ''} ${pathOf(keys)} ${descFor(keys)}`.toLowerCase().includes(q)) out.push(leaf(node, keys, value, parent))
  }
  walk(state.data.schema, [], state.data.effective, null)
  return out.length ? out.slice(0, 80) : empty('没有匹配的配置项')
}

// ---------- raw YAML ----------

async function renderYaml(root) {
  const { text } = await get('/api/config/raw')
  const ta = h('textarea', { class: 'code', spellcheck: false, style: { minHeight: 'calc(100vh - 260px)' } }, text)
  const err = h('pre', { class: 'small bad' })
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '配置'), h('span', { class: 'spacer' }),
      h('span', { class: 'small muted' }, '这里是完整的 config.yaml（含密钥），只写需要覆盖默认值的项')),
    tabs([['form', '表单'], ['yaml', 'config.yaml']], 'yaml', id => { if (id === 'form') location.hash = '#/config' }),
    card(null, ta, err, h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: () => renderYaml(root) }, '放弃修改'),
      h('button', { class: 'btn primary right', onclick: async () => {
        err.textContent = ''
        try {
          await api('PUT', '/api/config/raw', { text: ta.value })
          toast('已保存并重载', 'ok')
        } catch (x) { err.textContent = x.message }
      } }, '校验并保存'))),
  )
}
