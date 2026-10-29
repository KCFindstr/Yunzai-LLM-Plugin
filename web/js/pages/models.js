import { enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, empty, fmt, h, icon, mount, spinner } from '../ui.js'

const price = p => (p ? `${fmt.usd(p.input)} / ${fmt.usd(p.output)}${p.cacheRead != null ? ` · 缓存 ${fmt.usd(p.cacheRead)}` : ''}` : '未知')
const CHAT_TYPES = ['openai', 'openai-responses', 'anthropic', 'gemini']
const USE = { voyage: '向量', systemone: 'System One 判断' }

export async function render(root) {
  const d = await get('/api/models')
  let filter = ''
  const modelTableBody = h('tbody')

  // kind: chat / embedding / systemone (ids are unique within a kind)
  const testCell = (m, kind = 'chat') => {
    const out = h('span', { class: 'small' })
    const btn = h('button', { class: 'btn sm', onclick: async () => {
      btn.disabled = true
      out.replaceChildren(spinner())
      const r = await act(() => post(`/api/models/${enc(m.id)}/test?kind=${kind}`))
      btn.disabled = false
      out.replaceChildren(!r ? '' : r.ok ? h('span', { class: 'ok' }, `✓ ${fmt.dur(r.ms)}${kind === 'chat' ? '' : ` · ${r.text}`}`) : h('span', { class: 'bad', title: r.error }, `✕ ${r.error.slice(0, 60)}`))
    } }, '测试')
    return h('td', h('div', { class: 'row' }, btn, out))
  }

  const balanceCell = p => {
    const out = h('span', { class: 'small' })
    if (!CHAT_TYPES.includes(p.type)) return h('td')
    return h('td', h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !p.hasKey, onclick: async () => {
      out.replaceChildren(spinner())
      const r = await act(() => post(`/api/providers/${enc(p.name)}/balance`))
      out.replaceChildren(r?.text ?? '')
    } }, '查询余额'), out))
  }

  function drawModels() {
    const visible = d.models.filter(m => !filter || `${m.id} ${m.provider} ${m.model} ${m.thinking ?? ''}`.toLowerCase().includes(filter))
    mount(modelTableBody, visible.length ? visible.map(m => h('tr', { class: m.id === d.defaultModel ? 'sel' : '' },
      h('td', h('b', m.id), m.id === d.defaultModel ? h('div', { style: { marginTop: '2px' } }, badge('默认模型', 'accent')) : null, note(`models.${d.models.indexOf(m)}`)),
      h('td', { class: 'small' }, m.provider, ' / ', h('span', { class: 'mono' }, m.model), m.hasKey ? null : h('div', badge('提供商缺少 Key', 'bad'))),
      h('td', h('div', { class: 'chips' },
        m.thinking ? badge(`思考 ${m.thinking}`) : null,
        m.vision === false ? badge('无视觉') : badge('视觉'),
        m.toolUse === false ? badge('无工具') : null,
        m.nativeSearch === false ? null : badge('自带搜索'))),
      h('td', { class: 'small' }, price(m.price)),
      h('td', m.id !== d.defaultModel ? h('button', { class: 'btn sm', onclick: () => act(() => put('/api/config', { path: 'defaultModel', value: m.id }), `默认模型已切换为 ${m.id}`).then(() => render(root)) }, '设为默认') : null),
      testCell(m),
    )) : h('tr', h('td', { colspan: 6, class: 'muted text-center', style: { padding: '16px' } }, '没有找到匹配的模型')))
  }

  drawModels()

  // a notice (e.g. an auto-thinking model used for background jobs) sits under the model it concerns
  function note(path) {
    const texts = (d.notices ?? []).filter(n => n.paths.includes(path)).map(n => n.text)
    return texts.length ? h('div', { class: 'small', style: { marginTop: '6px', maxWidth: '360px', padding: '6px 8px', border: '1px solid var(--accent)', background: 'var(--accent-soft)', borderRadius: '8px' } }, texts.join(' ')) : null
  }

  const simpleTable = (list, kind, extra, prefix) => list.length ? h('div', { class: 'table-wrap' }, h('table',
    h('thead', h('tr', h('th', 'ID'), h('th', '提供商 / 模型'), h('th', ''), h('th', '连通性'))),
    h('tbody', list.map(m => h('tr',
      h('td', h('b', m.id), note(`${prefix}.${list.indexOf(m)}`)),
      h('td', { class: 'small' }, m.provider, ' / ', h('span', { class: 'mono' }, m.model), m.hasKey ? null : h('div', badge('提供商缺少 Key', 'bad'))),
      h('td', h('div', { class: 'chips' }, extra(m))),
      testCell(m, kind)))))) : empty('还没有模型')

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '模型'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/config/providers' }, '编辑提供商'), h('a', { class: 'btn', href: '#/config/models' }, '编辑模型')),
    card(h('span', { class: 'card-title' }, icon('settings'), '提供商', badge(`${d.providers.length} 个`)),
      d.providers.length ? h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', '名称'), h('th', '类型'), h('th', '用途'), h('th', '接口地址'), h('th', 'Key'), h('th', '余额'))),
        h('tbody', d.providers.map(p => h('tr', h('td', h('b', p.name)), h('td', badge(p.type)), h('td', { class: 'small' }, USE[p.type] ?? '聊天'),
          h('td', { class: 'small mono' }, p.baseUrl ?? '默认'),
          h('td', p.hasKey ? badge('已配置', 'ok') : badge(p.type === 'systemone' && !/typesafe\.ai/.test(p.baseUrl ?? '') ? '无需' : '未配置', p.type === 'systemone' && !/typesafe\.ai/.test(p.baseUrl ?? '') ? '' : 'bad')),
          balanceCell(p)))),
      )) : empty('还没有提供商'),
    ),
    card(
      h('div', { class: 'row', style: { width: '100%', justifyContent: 'space-between' } },
        h('span', { class: 'card-title' }, icon('models'), '聊天模型', badge(`${d.models.length} 个`)),
        h('input', { type: 'search', placeholder: '筛选模型 ID、提供商或能力…', 'aria-label': '筛选模型', style: { width: '240px' }, oninput: e => { filter = e.target.value.toLowerCase(); drawModels() } })),
      d.models.length ? h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', 'ID'), h('th', '提供商 / 模型'), h('th', '能力'), h('th', '价格（$/百万 token 输入/输出）'), h('th', ''), h('th', '连通性'))),
        modelTableBody,
      )) : empty('还没有模型'),
    ),
    card(h('span', { class: 'card-title' }, icon('vectors'), '向量模型', badge(`${d.embeddingModels.length} 个`)),
      simpleTable(d.embeddingModels, 'embedding', m => [badge(`${m.dimensions} 维`), m.active ? badge('旧聊天检索使用中', 'accent') : null], 'embeddingModels')),
    card(h('span', { class: 'card-title' }, icon('layers'), 'System One 模型', badge(`${d.systemoneModels.length} 个`)),
      simpleTable(d.systemoneModels, 'systemone', m => [m.judge ? badge('自动思考判断使用中', 'accent') : null], 'systemoneModels')),
  )
}
