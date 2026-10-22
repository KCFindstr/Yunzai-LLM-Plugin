import { del, enc, get } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, modal, mount, tabs } from '../ui.js'

/** Recent turns table, shared with the overview page. */
export function turnList(turns, { showConv = true } = {}) {
  if (!turns.length) return empty('还没有对话记录')
  return h('div', { class: 'table-wrap' }, h('table',
    h('thead', h('tr', h('th', '时间'), showConv ? h('th', '会话 / 发言人') : null, h('th', '内容'), h('th', '模型'), h('th', { class: 'num' }, '耗时'), h('th', { class: 'num' }, '花费'))),
    h('tbody', turns.map(t => h('tr', { style: { cursor: 'pointer' }, onclick: () => showTurn(t) },
      h('td', { class: 'small muted', style: { whiteSpace: 'nowrap' } }, fmt.short(t.at)),
      showConv ? h('td', { class: 'small' }, h('a', { href: `#/conversations/${enc(t.conv)}`, onclick: e => e.stopPropagation() }, t.label ?? t.conv), h('div', { class: 'muted' }, t.userName ?? t.userId ?? '')) : null,
      h('td', { style: { maxWidth: '520px' } },
        h('div', { class: 'clip' }, t.input),
        t.error ? h('div', { class: 'small bad clip' }, `出错：${t.error}`) : h('div', { class: 'small muted clip' }, '↳ ', t.reply || '（无文字回复）'),
        t.tools.length ? h('div', { class: 'chips', style: { marginTop: '4px' } }, [...new Set(t.tools)].map(n => badge(`${n}${t.tools.filter(x => x === n).length > 1 ? `×${t.tools.filter(x => x === n).length}` : ''}`, 'accent'))) : null,
      ),
      h('td', { class: 'small' }, t.model ?? '-'),
      h('td', { class: 'num small' }, fmt.dur(t.ms)),
      h('td', { class: 'num small' }, fmt.usd(t.cost)),
    ))),
  ))
}

function showTurn(t) {
  modal(`${fmt.time(t.at)} · ${t.userName ?? t.userId ?? ''}`, h('div', { class: 'col' },
    h('div', { class: 'small muted' }, `${t.model ?? '-'} · ${fmt.dur(t.ms)} · ${fmt.usd(t.cost)}${t.tokens ? ` · 输入 ${fmt.num(t.tokens.input)} / 缓存 ${fmt.num(t.tokens.cacheRead)} / 输出 ${fmt.num(t.tokens.output)}` : ''}`),
    h('div', { class: 'chat' }, h('div', { class: 'bubble user' }, t.input), t.reply ? h('div', { class: 'bubble assistant' }, t.reply) : null),
    t.tools.length ? h('div', h('span', { class: 'small muted' }, '工具调用：'), t.tools.join(' → ')) : null,
    t.error ? h('pre', { class: 'bad' }, t.error) : null,
  ))
}

const kindLabel = { group: '群聊', member: '群成员', private: '私聊' }

export async function render(root, [sub]) {
  const mode = sub === 'turns' ? 'turns' : 'sessions'
  const head = h('div', { class: 'page-head' }, menuButton(), h('h1', '对话'))
  const switcher = tabs([['sessions', '会话'], ['turns', '最近对话']], mode, id => { location.hash = id === 'turns' ? '#/conversations/turns' : '#/conversations' })

  if (mode === 'turns') {
    const turns = await get('/api/turns?limit=300')
    return mount(root, head, switcher, card(null, turnList(turns)))
  }

  const sessions = await get('/api/sessions')
  const detail = h('div')
  const list = h('div', { class: 'pane-list' })
  let filter = ''
  const drawList = selected => mount(list,
    h('input', { type: 'search', placeholder: '筛选会话…', value: filter, style: { width: '100%', marginBottom: '8px' }, oninput: e => { filter = e.target.value; drawList(selected); list.querySelector('input').focus() } }),
    sessions.filter(s => !filter || `${s.label} ${s.key} ${s.summary ?? ''}`.toLowerCase().includes(filter.toLowerCase())).map(s => h('div', {
      class: `list-item click ${s.key === selected ? 'sel' : ''}`,
      onclick: () => { location.hash = `#/conversations/${enc(s.key)}` },
    },
      h('div', { class: 'row' }, h('b', { class: 'clip', style: { maxWidth: '70%' } }, s.label), h('span', { class: 'right small muted' }, fmt.ago(s.updatedAt))),
      h('div', { class: 'row small muted', style: { marginTop: '2px' } }, badge(kindLabel[s.kind]), `${s.messages / 2} 轮`, s.archive ? ` · 档案 ${s.archive}` : '', s.days ? ` · 概要 ${s.days} 天` : '', s.vectors ? ` · 向量 ${s.vectors}` : ''),
      s.summary ? h('div', { class: 'small muted clamp', style: { marginTop: '4px' } }, s.summary) : null,
    )),
    sessions.length ? null : empty('还没有会话'),
  )

  const key = sub && sub !== 'turns' ? sub : sessions[0]?.key
  drawList(key)
  mount(root, head, switcher, h('div', { class: 'split' }, list, detail))
  if (key) await drawDetail(detail, key, () => render(root, [key]))
  else mount(detail, card(null, empty('选择左侧的会话查看详情')))
}

async function drawDetail(el, key, refresh) {
  const s = await get(`/api/sessions/${enc(key)}`)
  mount(el,
    card(h('span', s.label, ' ', badge(kindLabel[s.kind])),
      h('div', { class: 'row small muted' }, h('span', { class: 'mono' }, s.key), h('span', `最后活跃 ${fmt.time(s.updatedAt)}`),
        h('a', { class: 'right', href: `#/vectors/${enc(key)}` }, '在向量空间中查看 →'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (await confirmDanger('清除这个会话的全部历史、摘要、档案和向量？')) act(() => del(`/api/sessions/${enc(key)}`), '已清除').then(() => { location.hash = '#/conversations' })
        } }, '清除会话')),
    ),
    card('滚动摘要', s.summary ? h('pre', s.summary) : empty('还没有摘要（历史未超出上限时不生成）')),
    card(`每日概要（${s.days.length} 天）`,
      s.days.length ? [...s.days].reverse().map(d => h('div', { class: 'list-item' },
        h('div', { class: 'row small' },
          h('b', d.day),
          h('span', { class: 'muted' }, `由 ${d.sources.length} 段整理 · ${fmt.ago(d.at)}更新`),
          d.vector ? badge('已向量化', 'accent') : badge('无向量'),
          h('button', { class: 'btn sm ghost danger right', onclick: async () => {
            if (await confirmDanger(`删除 ${d.day} 的当日概要？（下次整理时会根据仍保留的档案重新生成）`)) act(() => del(`/api/sessions/${enc(key)}/archive/${enc(d.id)}`), '已删除').then(refresh)
          } }, '删除'),
        ),
        h('pre', { style: { marginTop: '6px' } }, d.text),
      )) : empty('还没有每日概要：每天结束后，当天的档案会在后台整理成一条概要')),
    card(`旧聊天档案（${s.archive.length} 段）`,
      s.archive.length ? [...s.archive].reverse().map(a => h('div', { class: 'list-item' },
        h('div', { class: 'row small' },
          h('span', { class: 'muted' }, fmt.time(a.at)),
          a.chat ? badge('群聊', 'accent') : null,
          a.raw ? badge('原文·待整理', 'warn') : badge('摘要', 'ok'),
          a.vector ? badge('已向量化', 'accent') : badge('无向量'),
          h('button', { class: 'btn sm ghost danger right', onclick: async () => {
            if (await confirmDanger('删除这段档案？')) act(() => del(`/api/sessions/${enc(key)}/archive/${enc(a.id)}`), '已删除').then(refresh)
          } }, '删除'),
        ),
        h('pre', { style: { marginTop: '6px' } }, a.text),
      )) : empty('还没有档案'),
    ),
    card(`当前上下文（${s.messages.length / 2} 轮）`,
      s.messages.length ? h('div', { class: 'chat' }, s.messages.map(m => h('div', { class: `bubble ${m.role}` }, m.text))) : empty('当前没有上下文（空闲超时后会重新开始）'),
    ),
    card('最近对话', turnList(s.turns, { showConv: false })),
  )
}
