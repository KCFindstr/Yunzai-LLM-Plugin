import { del, get, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, empty, fmt, h, mount, promptFields } from '../ui.js'

/**
 * Names for platform IDs. Configured names (`names`, or `groups.<id>.names` for one group) override what the
 * adapter reports — QQBot usually reports only opaque IDs, so this is how the bot learns who is who.
 */

let onlyUnknown = false
let filter = ''

const setName = (path, name) => act(() => put('/api/config', { path, value: name }), '已保存')
const clearName = path => act(() => del(`/api/config?path=${encodeURIComponent(path)}`), '已清除')

export async function render(root) {
  const scopes = await get('/api/roster')
  const globalNames = (await get('/api/config')).effective.names ?? {}
  const body = h('div')

  const row = (scope, p) => {
    const effective = p.group || p.global || p.observed
    const input = h('input', { type: 'text', value: p.group || p.global || '', placeholder: p.observed ? `识别到：${p.observed}` : '未知，填写称呼', style: { width: '180px' } })
    const save = async path => { if (!input.value.trim()) return; if (await setName(path, input.value.trim())) render(root) }
    return h('tr',
      h('td', h('span', { class: 'mono small' }, p.id)),
      h('td', effective ? h('b', effective) : h('span', { class: 'muted' }, '称呼未知'),
        h('div', { class: 'small muted' }, p.group ? '本群设置' : p.global ? '全局设置' : p.observed ? '来自适配器/消息' : '')),
      h('td', { class: 'small muted' }, fmt.ago(p.seen)),
      h('td', h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        input,
        h('button', { class: 'btn sm primary', onclick: () => save(`names.${p.id}`) }, '全局'),
        scope.groupId ? h('button', { class: 'btn sm', onclick: () => save(`groups.${scope.groupId}.names.${p.id}`), title: '只在这个群使用这个称呼' }, '仅本群') : null,
        p.group ? h('button', { class: 'btn sm ghost danger', onclick: () => clearName(`groups.${scope.groupId}.names.${p.id}`).then(ok => ok && render(root)) }, '清除本群') : null,
        p.global ? h('button', { class: 'btn sm ghost danger', onclick: () => clearName(`names.${p.id}`).then(ok => ok && render(root)) }, '清除全局') : null,
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
          h('thead', h('tr', h('th', '平台ID'), h('th', '当前称呼'), h('th', '最近出现'), h('th', '设置称呼'))),
          h('tbody', people.map(p => row(scope, p))))))
    }).filter(Boolean)
    mount(body, cards.length ? cards : card(null, empty(scopes.length ? '没有匹配的群友' : '还没有记录到群友：有人在群里发言后会出现在这里')))
  }

  const addManual = async () => {
    const r = await promptFields('添加称呼', [{ name: 'id', label: '平台ID（QQ号，或 QQBot 的用户ID）' }, { name: 'name', label: '称呼' }])
    if (r?.id?.trim() && r.name?.trim() && (await setName(`names.${r.id.trim()}`, r.name.trim()))) render(root)
  }

  const globalCount = Object.keys(globalNames).length
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '群友称呼'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: addManual }, '＋ 按ID添加')),
    h('div', { class: 'small muted', style: { marginBottom: '12px' } },
      '这里设置的称呼优先于适配器提供的昵称/群名片，用于对话中的发言人、最近群友、群聊记录和长期记忆。「全局」对所有群和私聊生效，「仅本群」只在这个群生效并覆盖全局。',
      globalCount ? ` 已设置 ${globalCount} 个全局称呼（也可在「配置 → 群友称呼」中编辑）。` : ''),
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('input', { type: 'search', placeholder: '搜索ID或称呼…', value: filter, oninput: e => { filter = e.target.value; draw() } }),
      h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: onlyUnknown, onchange: e => { onlyUnknown = e.target.checked; draw() } }), '只看称呼未知的')),
    body,
  )
  draw()
}
