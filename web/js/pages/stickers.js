import { del, enc, get, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, confirmDanger, empty, h, mount, promptFields } from '../ui.js'

export async function render(root) {
  const list = await get('/api/stickers')
  let filter = ''
  const grid = h('div', { class: 'sticker-grid' })

  const draw = () => mount(grid, list
    .filter(s => !filter || `${s.name} ${s.desc} ${s.use} ${(s.tags ?? []).join(' ')}`.toLowerCase().includes(filter.toLowerCase()))
    .map(s => h('div', { class: 'sticker' },
      h('div', { class: 'img' }, s.hasImage ? h('img', { src: `/api/stickers/${enc(s.id)}/image`, loading: 'lazy', alt: s.name }) : h('span', { class: 'muted small' }, s.kind === 'mface' ? '商城表情' : '无图片')),
      h('div', { class: 'meta' },
        h('div', { class: 'row' }, h('b', { class: 'clip', style: { maxWidth: '100%' } }, s.name)),
        h('div', { class: 'muted clamp', title: s.desc }, s.desc || '（未识别）'),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          s.indexed ? null : badge('未识别', 'warn'), badge(`用过 ${s.uses}`),
          h('button', { class: 'btn sm ghost right', onclick: async () => {
            const r = await promptFields(`编辑「${s.name}」`, [
              { name: 'name', label: '名称', value: s.name },
              { name: 'desc', label: '描述', value: s.desc, multiline: true, rows: 3 },
              { name: 'use', label: '适用场景', value: s.use, multiline: true, rows: 2 },
            ])
            if (r) act(() => put(`/api/stickers/${enc(s.id)}`, r), '已保存').then(ok => ok && render(root))
          } }, '编辑'),
          h('button', { class: 'btn sm ghost danger', onclick: async () => {
            if (await confirmDanger(`删除表情「${s.name}」？`)) act(() => del(`/api/stickers/${enc(s.id)}`), '已删除').then(ok => ok && render(root))
          } }, '删除'),
        ),
      ),
    )))
  draw()

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', `表情包（${list.length}）`), h('span', { class: 'spacer' }),
      h('input', { type: 'search', placeholder: '搜索名称、描述…', oninput: e => { filter = e.target.value; draw() } })),
    h('div', { class: 'small muted', style: { marginBottom: '12px' } }, '添加表情请在 QQ 中发送 #llm添加表情（可引用图片），或直接让机器人保存。'),
    list.length ? grid : empty('还没有表情包'),
  )
}
