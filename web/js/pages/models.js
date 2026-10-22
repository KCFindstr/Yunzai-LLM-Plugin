import { enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, empty, fmt, h, mount, spinner } from '../ui.js'

const price = p => (p ? `${fmt.usd(p.input)} / ${fmt.usd(p.output)}${p.cacheRead != null ? ` · 缓存 ${fmt.usd(p.cacheRead)}` : ''}` : '未知')

export async function render(root) {
  const d = await get('/api/models')

  const testCell = m => {
    const out = h('span', { class: 'small' })
    const btn = h('button', { class: 'btn sm', onclick: async () => {
      btn.disabled = true
      out.replaceChildren(spinner())
      const r = await act(() => post(`/api/models/${enc(m.id)}/test`))
      btn.disabled = false
      out.replaceChildren(!r ? '' : r.ok ? h('span', { class: 'ok' }, `✓ ${fmt.dur(r.ms)}`) : h('span', { class: 'bad', title: r.error }, `✕ ${r.error.slice(0, 60)}`))
    } }, '测试')
    return h('td', h('div', { class: 'row' }, btn, out))
  }

  const balanceCell = p => {
    const out = h('span', { class: 'small' })
    return h('td', h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !p.hasKey, onclick: async () => {
      out.replaceChildren(spinner())
      const r = await act(() => post(`/api/providers/${enc(p.name)}/balance`))
      out.replaceChildren(r?.text ?? '')
    } }, '查询余额'), out))
  }

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '模型'), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/config/providers' }, '编辑提供商'), h('a', { class: 'btn', href: '#/config/models' }, '编辑模型')),
    card('提供商',
      d.providers.length ? h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', '名称'), h('th', '类型'), h('th', '接口地址'), h('th', 'Key'), h('th', '余额'))),
        h('tbody', d.providers.map(p => h('tr', h('td', h('b', p.name)), h('td', badge(p.type)), h('td', { class: 'small mono' }, p.baseUrl ?? '默认'),
          h('td', p.hasKey ? badge('已配置', 'ok') : badge('未配置', 'bad')), balanceCell(p)))),
      )) : empty('还没有提供商'),
    ),
    card('模型',
      d.models.length ? h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', 'ID'), h('th', '提供商 / 模型'), h('th', '能力'), h('th', '价格（$/百万 token 输入/输出）'), h('th', ''), h('th', '连通性'))),
        h('tbody', d.models.map(m => h('tr',
          h('td', h('b', m.id), m.id === d.defaultModel ? h('div', badge('默认', 'accent')) : null),
          h('td', { class: 'small' }, m.provider, ' / ', h('span', { class: 'mono' }, m.model), m.hasKey ? null : h('div', badge('提供商缺少 Key', 'bad'))),
          h('td', h('div', { class: 'chips' },
            m.thinking ? badge(`思考 ${m.thinking}`) : null,
            m.vision === false ? badge('无视觉') : badge('视觉'),
            m.toolUse === false ? badge('无工具') : null,
            m.nativeSearch === false ? null : badge('自带搜索'))),
          h('td', { class: 'small' }, price(m.price)),
          h('td', m.id !== d.defaultModel ? h('button', { class: 'btn sm', onclick: () => act(() => put('/api/config', { path: 'defaultModel', value: m.id }), `默认模型已切换为 ${m.id}`).then(() => render(root)) }, '设为默认') : null),
          testCell(m),
        ))),
      )) : empty('还没有模型'),
    ),
  )
}
