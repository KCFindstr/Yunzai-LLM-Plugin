import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, modal, mount, promptFields, switchEl, tabs } from '../ui.js'

export async function render(root, [sub]) {
  const mode = ['skills', 'commands'].includes(sub) ? sub : 'tools'
  const head = h('div', { class: 'page-head' }, menuButton(), h('h1', '工具与技能'))
  const t = tabs([['tools', '工具'], ['skills', '技能'], ['commands', '指令目录']], mode, id => { location.hash = `#/tools/${id}` })

  if (mode === 'tools') {
    const tools = await get('/api/tools')
    let filter = ''
    const tbody = h('tbody')
    const draw = () => {
      const visible = tools.filter(x => !filter || `${x.name} ${x.description} ${x.source}`.toLowerCase().includes(filter))
      mount(tbody, visible.length ? visible.map(x => h('tr',
        h('td', switchEl(x.enabled, on => act(() => put(`/api/tools/${enc(x.name)}`, { enabled: on }), `${x.name} 已${on ? '启用' : '禁用'}`))),
        h('td', h('b', { class: 'mono' }, x.name), h('div', badge(x.source))),
        h('td', { class: 'small' }, x.description),
        h('td', h('button', { class: 'btn sm ghost', onclick: () => modal(x.name, h('pre', JSON.stringify(x.parameters, null, 2))) }, '参数')),
      )) : h('tr', h('td', { colspan: 4, class: 'muted text-center', style: { padding: '16px' } }, '没有找到匹配的工具')))
    }
    draw()
    return mount(root, head, t,
      h('div', { class: 'row', style: { marginBottom: '12px', justifyContent: 'space-between' } },
        h('span', { class: 'small muted' }, `共 ${tools.length} 个工具`),
        h('input', { type: 'search', placeholder: '搜索工具名称或说明…', 'aria-label': '搜索工具', style: { width: '240px' }, oninput: e => { filter = e.target.value.toLowerCase(); draw() } })),
      card(null, h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', '启用'), h('th', '工具'), h('th', '说明'), h('th', ''))),
        tbody))),
      h('div', { class: 'small muted', style: { marginTop: '10px' } }, '联网搜索、运行代码、电脑等工具的详细设置在「配置 → 工具」。'))
  }

  if (mode === 'skills') {
    const skills = await get('/api/skills')
    const edit = async s => {
      const r = await promptFields(s ? `编辑技能 ${s.name}` : '新建技能', [
        ...(s ? [] : [{ name: 'name', label: '技能名称（英文/数字/横线）' }]),
        { name: 'markdown', label: '内容（第一行写简介，或使用 --- frontmatter）', multiline: true, code: true, rows: 18, value: s ? `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n${s.body}` : '' },
      ], '保存')
      const name = s?.name ?? r?.name?.trim()
      if (r && name) act(() => put(`/api/skills/${enc(name)}`, { markdown: r.markdown }), '已保存').then(ok => ok && render(root, ['skills']))
    }
    return mount(root, head, t,
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('button', { class: 'btn primary', onclick: () => edit() }, '＋ 新建技能')),
      skills.length ? skills.map(s => card(h('span', s.name, ' ', h('span', { class: 'small muted' }, s.description)),
        h('pre', { class: 'small', style: { maxHeight: '240px', overflowY: 'auto' } }, s.body),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn sm', onclick: () => edit(s) }, '编辑'),
          h('button', { class: 'btn sm danger', onclick: async () => {
            if (await confirmDanger(`删除技能「${s.name}」？`)) act(() => del(`/api/skills/${enc(s.name)}`), '已删除').then(ok => ok && render(root, ['skills']))
          } }, '删除')),
      )) : card(null, empty('还没有技能')))
  }

  const c = await get('/api/commands')
  let filter = ''
  const body = h('tbody')
  const draw = () => mount(body, c.entries
    .filter(e => !filter || `${e.cmd} ${e.desc} ${e.plugin ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, 500)
    .map(e => h('tr', h('td', { class: 'mono small' }, e.cmd), h('td', { class: 'small' }, e.desc), h('td', { class: 'small muted' }, e.plugin ?? ''), h('td', e.verified ? badge('已验证', 'ok') : badge('未验证')))))
  draw()
  mount(root, head, t,
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('span', { class: 'small muted' }, `${c.info.verified}/${c.info.entries} 条已验证 · ${c.info.rules} 条规则${c.info.scannedAt ? ` · ${fmt.ago(c.info.scannedAt)}扫描` : ''}`),
      h('input', { type: 'search', placeholder: '搜索指令…', class: 'right', oninput: e => { filter = e.target.value; draw() } }),
      h('button', { class: 'btn', onclick: () => act(() => post('/api/actions/scan-commands'), r => r.message).then(() => render(root, ['commands'])) }, '重新扫描')),
    card(null, h('div', { class: 'table-wrap' }, h('table', h('thead', h('tr', h('th', '指令'), h('th', '说明'), h('th', '插件'), h('th', ''))), body))),
  )
}
