import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, h, mount, promptFields } from '../ui.js'

export async function render(root, [nameArg]) {
  const p = await get('/api/personas')
  const sel = p.presets.find(x => x.name === nameArg) ?? p.presets.find(x => x.name === p.active) ?? p.presets[0]
  const go = name => { location.hash = `#/personas/${enc(name)}` }

  const create = async () => {
    const r = await promptFields('新建人设', [{ name: 'name', label: '名称' }, { name: 'text', label: '人设内容', multiline: true, rows: 12 }])
    if (r?.name && r.text) act(() => put(`/api/personas/${enc(r.name.trim())}`, { text: r.text }), '已创建').then(ok => ok && go(r.name.trim()))
  }

  let editor
  const detail = sel ? card(
    h('span', sel.name, ' ', sel.name === p.active ? badge('默认人设', 'accent') : null, sel.file ? badge(`文件 ${sel.file}`) : null),
    h('div', { class: 'row', style: { marginBottom: '10px' } },
      sel.groups.length ? h('span', { class: 'small muted' }, '用于群：', sel.groups.map(g => g.name ?? g.id).join('、')) : null,
      h('span', { class: 'spacer', style: { flex: 1 } }),
      sel.name !== p.active ? h('button', { class: 'btn', onclick: () => act(() => post(`/api/personas/${enc(sel.name)}/activate`), '已设为默认').then(() => render(root, [sel.name])) }, '设为默认') : null,
      h('button', { class: 'btn', onclick: async () => {
        const r = await promptFields('在指定群使用此人设', [{ name: 'groupId', label: '群号' }])
        if (r?.groupId) act(() => post(`/api/personas/${enc(sel.name)}/activate`, { groupId: r.groupId.trim() }), '已设置').then(() => render(root, [sel.name]))
      } }, '用于某个群'),
      sel.name !== p.active ? h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDanger(`删除人设「${sel.name}」？`)) act(() => del(`/api/personas/${enc(sel.name)}`), '已删除').then(() => { location.hash = '#/personas' })
      } }, '删除') : null,
    ),
    editor = h('textarea', { class: 'code', rows: 26, spellcheck: false }, sel.text),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('span', { class: 'small muted' }, sel.file ? `保存会写入 Yunzai/config/Yunzai-LLM-Plugin/${sel.file}` : '保存到 config.yaml 的 persona.presets'),
      h('button', { class: 'btn primary right', onclick: () => act(() => put(`/api/personas/${enc(sel.name)}`, { text: editor.value }), '已保存') }, '保存'),
    ),
  ) : card(null, empty('还没有人设'))

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '人设'), h('span', { class: 'spacer' }),
      p.botName ? h('span', { class: 'small muted' }, `机器人名字：${p.botName}`) : null,
      h('button', { class: 'btn primary', onclick: create }, '＋ 新建人设')),
    h('div', { class: 'split' },
      h('div', { class: 'pane-list' }, p.presets.map(x => h('div', { class: `list-item click ${x === sel ? 'sel' : ''}`, onclick: () => go(x.name) },
        h('div', { class: 'row' }, h('b', x.name), x.name === p.active ? badge('默认', 'accent') : null, x.groups.length ? badge(`${x.groups.length} 个群`) : null),
        h('div', { class: 'small muted clamp', style: { marginTop: '4px' } }, x.text.slice(0, 200)),
      ))),
      h('div', detail),
    ),
  )
}
