import { del, enc, get, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, empty, fmt, h, modal, mount, pager, promptFields, toast } from '../ui.js'

/**
 * Names for platform IDs. Configured names (`names`, or `groups.<id>.names` for one group) override what the
 * adapter reports — QQBot usually reports only opaque IDs, so this is how the bot learns who is who.
 */

let onlyUnknown = false
let filter = ''

const pathFor = (scope, id, where) => (where === 'group' ? `groups.${scope.groupId}.names.${id}` : `names.${id}`)

async function showRecent(scope, p) {
  const d = await get(`/api/roster/${enc(scope.key)}/${enc(p.id)}`).catch(err => (toast(err.message, 'bad'), undefined))
  if (!d) return
  const name = p.group || p.global || p.observed
  modal(`${name ?? '称呼未知'} · ${p.id}`, h('div', { class: 'col' },
    h('div', { class: 'small muted' }, `在「${scope.label}」最近的发言（最多 5 条，敏感内容不记录）`),
    d.messages.length
      ? h('div', { class: 'chat' }, [...d.messages].reverse().map(m => h('div', { class: 'bubble user' }, h('div', { class: 'small muted' }, fmt.time(m.t)), m.text)))
      : empty('还没有记录到发言（这个功能上线后发的消息才会出现在这里）'),
    d.turns.length ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, '和机器人的对话') : null,
    d.turns.length ? h('div', { class: 'chat' }, d.turns.map(t => [
      h('div', { class: 'bubble user' }, h('div', { class: 'small muted' }, fmt.time(t.at)), t.input),
      t.reply ? h('div', { class: 'bubble assistant' }, t.reply) : null,
    ])) : null,
  ))
}

export async function render(root) {
  const scopes = await get('/api/roster')
  const body = h('div')
  // one pager per scope, kept across redraws so saving a name doesn't jump back to page 1
  const pagers = new Map()
  const pagerFor = key => pagers.get(key) ?? pagers.set(key, pager(() => draw())).get(key)

  const row = (scope, p) => {
    const effective = p.group || p.global || p.observed
    const source = p.group ? '本群称呼' : p.global ? '全局称呼' : p.observed ? '来自适配器/消息' : ''
    const input = h('input', { type: 'text', value: p.group || p.global || '', placeholder: p.observed ? `识别到：${p.observed}` : '输入称呼', style: { width: '150px' } })
    // where the name applies: everywhere, or only in this group (overrides the global name here)
    const where = scope.groupId
      ? h('select', { title: '这个称呼在哪里生效' },
          h('option', { value: 'global', selected: !p.group }, '所有群和私聊'),
          h('option', { value: 'group', selected: Boolean(p.group) }, `仅「${scope.label}」`))
      : null
    const save = h('button', { class: 'btn sm primary', onclick: async () => {
      const name = input.value.trim()
      if (!name) return toast('请输入称呼', 'bad')
      const target = where?.value ?? 'global'
      const ok = await act(() => put('/api/config', { path: pathFor(scope, p.id, target), value: name }), `已保存为${target === 'group' ? '本群' : '全局'}称呼`)
      if (ok) render(root)
    } }, '保存')
    const clear = (target, label) => h('button', { class: 'btn sm ghost danger', onclick: async () => {
      if (await act(() => del(`/api/config?path=${encodeURIComponent(pathFor(scope, p.id, target))}`), '已清除')) render(root)
    } }, label)
    return h('tr',
      h('td', h('span', { class: 'mono small' }, p.id)),
      h('td', effective ? h('b', effective) : h('span', { class: 'muted' }, '称呼未知'), h('div', { class: 'small muted' }, source)),
      h('td', { class: 'small muted', style: { whiteSpace: 'nowrap' } }, fmt.ago(p.seen),
        h('div', h('button', { class: 'btn sm ghost', onclick: () => showRecent(scope, p), title: '看看这个人最近说了什么' }, `最近发言${p.messages ? `（${p.messages}）` : ''}`))),
      h('td', h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } },
        input, where, save,
        p.group ? clear('group', '清除本群称呼') : null,
        p.global ? clear('global', '清除全局称呼') : null,
      )),
    )
  }

  const draw = () => {
    const q = filter.toLowerCase()
    const cards = scopes.map(scope => {
      const people = scope.people
        .filter(p => !onlyUnknown || !(p.group || p.global || p.observed))
        .filter(p => !q || `${p.id} ${p.observed ?? ''} ${p.group ?? ''} ${p.global ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => b.seen - a.seen)
      if (!people.length) return null
      return card(h('span', scope.label, ' ', scope.groupId ? h('span', { class: 'small muted mono' }, scope.groupId) : null, ' ', badge(`${people.length} 人`)),
        h('div', { class: 'table-wrap' }, h('table',
          h('thead', h('tr', h('th', '平台ID'), h('th', '当前称呼'), h('th', '最近出现'), h('th', '设置称呼（选好生效范围后点保存）'))),
          h('tbody', pagerFor(scope.key).slice(people).map(p => row(scope, p)))), pagerFor(scope.key).el))
    }).filter(Boolean)
    mount(body, cards.length ? cards : card(null, empty(scopes.length ? '没有匹配的群友' : '还没有记录到群友：有人在群里发言后会出现在这里')))
  }

  const addManual = async () => {
    const r = await promptFields('添加全局称呼', [{ name: 'id', label: '平台ID（QQ号，或 QQBot 的用户ID）' }, { name: 'name', label: '称呼（所有群和私聊生效）' }])
    if (r?.id?.trim() && r.name?.trim() && (await act(() => put('/api/config', { path: `names.${r.id.trim()}`, value: r.name.trim() }), '已保存'))) render(root)
  }

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '群友称呼'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: addManual }, '＋ 按ID添加')),
    h('div', { class: 'small muted', style: { marginBottom: '12px' } },
      '这里设置的称呼优先于适配器提供的昵称/群名片，用于对话中的发言人、最近群友、群聊记录和长期记忆。',
      '生效范围选「所有群和私聊」写入全局称呼；选「仅本群」只在该群使用，并覆盖全局称呼。不认识的ID可以点「最近发言」看看他说过什么。'),
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('input', { type: 'search', placeholder: '搜索ID或称呼…', value: filter, oninput: e => { filter = e.target.value; for (const p of pagers.values()) p.reset(); draw() } }),
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: onlyUnknown, onchange: e => { onlyUnknown = e.target.checked; for (const p of pagers.values()) p.reset(); draw() } }), '只看称呼未知的')),
    body,
  )
  draw()
}
