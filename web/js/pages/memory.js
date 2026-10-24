import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, meter, mount, pager, promptFields, stat, tabs } from '../ui.js'

export async function render(root, [scopeArg, keyArg]) {
  const data = await get('/api/memory')
  const scope = scopeArg === 'group' ? 'group' : 'user'
  const owners = scope === 'group' ? data.groups : data.users
  const selected = owners.find(o => o.key === keyArg) ?? owners[0]
  let filter = ''

  const list = h('div', { class: 'pane-list' })
  const pages = pager(() => drawList(), { anchor: () => list })
  pages.reveal(owners.indexOf(selected))
  const drawList = () => mount(list,
    h('input', { type: 'search', placeholder: scope === 'group' ? '筛选群…' : '筛选用户…', value: filter, style: { width: '100%', marginBottom: '8px' }, oninput: e => { filter = e.target.value; pages.reset(); drawList(); list.querySelector('input').focus() } }),
    pages.slice(owners.filter(o => !filter || `${o.name ?? ''} ${o.key} ${o.entries.map(e => e.text).join(' ')}`.toLowerCase().includes(filter.toLowerCase()))).map(o => h('div', {
      class: `list-item click ${o === selected ? 'sel' : ''}`,
      onclick: () => { location.hash = `#/memory/${scope}/${enc(o.key)}` },
    },
      h('div', { class: 'row' }, h('b', o.name ?? o.key), h('span', { class: 'right small muted' }, `${o.entries.length} 条`)),
      o.name ? h('div', { class: 'small muted mono' }, o.key) : null,
      h('div', { style: { marginTop: '6px' } }, meter(o.usage.chars, o.usage.maxChars)),
    )),
    owners.length ? null : empty(scope === 'group' ? '还没有群记忆' : '还没有用户记忆'),
    pages.el,
  )
  drawList()

  const add = async () => {
    const r = await promptFields(scope === 'group' ? '添加群记忆' : '添加用户记忆', [
      { name: 'key', label: scope === 'group' ? '群号' : 'QQ 号', value: selected?.key ?? '' },
      { name: 'text', label: '内容（一句话）' },
    ])
    if (r?.key && r.text) act(() => post(`/api/memory/${scope}/${enc(r.key.trim())}`, { text: r.text }), '已添加').then(() => render(root, [scope, r.key.trim()]))
  }

  const detail = selected ? card(
    h('span', selected.name ?? selected.key, ' ', badge(`${selected.usage.entries}/${selected.usage.maxEntries} 条 · ${selected.usage.chars}/${selected.usage.maxChars} 字`)),
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('span', { class: 'small muted mono' }, `${scope}:${selected.key}`),
      h('button', { class: 'btn sm danger right', onclick: async () => {
        if (await confirmDanger(`清空 ${selected.name ?? selected.key} 的全部长期记忆？`)) act(() => del(`/api/memory/${scope}/${enc(selected.key)}`), '已清空').then(() => render(root, [scope]))
      } }, '全部清空')),
    selected.entries.map(m => {
      const text = h('div', { style: { flex: 1, whiteSpace: 'pre-wrap' } }, m.text)
      return h('div', { class: 'list-item' }, h('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        badge(m.id), text,
        h('button', { class: 'btn sm ghost', onclick: async () => {
          const r = await promptFields(`修改 ${m.id}`, [{ name: 'text', label: '内容', value: m.text, multiline: true, rows: 3 }])
          if (r?.text) act(() => put(`/api/memory/${scope}/${enc(selected.key)}/${enc(m.id)}`, { text: r.text }), '已保存').then(() => render(root, [scope, selected.key]))
        } }, '编辑'),
        h('button', { class: 'btn sm ghost danger', onclick: async () => {
          if (await confirmDanger(`删除记忆 ${m.id}？`)) act(() => del(`/api/memory/${scope}/${enc(selected.key)}/${enc(m.id)}`), '已删除').then(() => render(root, [scope, selected.key]))
        } }, '删除'),
      ), h('div', { class: 'small muted', style: { marginTop: '4px' } }, `${fmt.time(m.updatedAt)}${m.by ? ` · 来自 ${m.by}` : ''}`))
    }),
  ) : card(null, empty('选择左侧条目'))

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '长期记忆'), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: add }, '＋ 添加')),
    h('div', { class: 'stats' }, stat('记忆条目', data.stats.entries), stat('用户', data.stats.users), stat('群', data.stats.groups)),
    tabs([['user', `用户（${data.users.length}）`], ['group', `群（${data.groups.length}）`]], scope, id => { location.hash = `#/memory/${id}` }),
    h('div', { class: 'split' }, list, h('div', detail)),
  )
}
