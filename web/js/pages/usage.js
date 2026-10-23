import { enc, get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, bars, card, confirmDanger, empty, fmt, h, meter, mount, promptFields } from '../ui.js'

const WINDOWS = [['window5h', 'used5h', '5小时'], ['weekly', 'usedWeek', '每周']]

export async function render(root) {
  const u = await get('/api/usage')
  const days = u.daily.map(([d, per]) => [d.slice(5), Object.values(per).reduce((a, b) => a + b, 0)])
  const models = Object.entries(u.totals).sort((a, b) => b[1].cost - a[1].cost)
  const incomplete = new Set(u.incompleteModels ?? [])
  const usageNote = 'Gemini 服务端会话可能漏报历史输入和缓存 token；花费与额度按已报告用量计算，可能偏低，不能保证实际消费上限。实际费用以服务商账单为准。'

  const lookup = async () => {
    const r = await promptFields('查询用户额度', [{ name: 'id', label: 'QQ 号' }])
    if (!r?.id) return
    const d = await act(() => get(`/api/usage/user/${enc(r.id.trim())}`))
    if (!d) return
    const rows = d.models.filter(m => m.user).map(m => h('tr', h('td', m.id),
      WINDOWS.map(([lim, used]) => h('td', fmt.usd(m.user[used]), m.user.limits[lim] ? ` / ${fmt.usd(m.user.limits[lim])}` : ''))))
    const { modal } = await import('../ui.js')
    modal(`${d.name ?? d.id} 的用量`, h('table', h('thead', h('tr', h('th', '模型'), h('th', '5小时'), h('th', '每周'))), h('tbody', rows)))
  }

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '用量与额度'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: lookup }, '查询用户'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (await confirmDanger('清空所有用户、群和全局的额度计数？（不影响累计统计）')) act(() => post('/api/usage/reset', { all: true }), '已重置全部额度').then(() => render(root))
      } }, '重置全部额度（不含统计）'),
    ),
    incomplete.size ? card('用量报告不完整', h('p', { class: 'small muted' }, `${[...incomplete].join('、')}：${usageNote}`)) : null,
    card('最近 14 天花费', bars(days, fmt.usd)),
    h('div', { class: 'grid cols-2', style: { marginTop: '16px' } },
      card('全局额度（按模型）',
        u.models.length ? h('div', { class: 'col', style: { gap: '14px' } }, u.models.map(m => h('div',
          h('div', { class: 'row' }, h('b', m.id), h('span', { class: 'right small muted' },
            ['user', 'group', 'global'].map(s => { const l = m.limits[s]; return l.window5h || l.weekly ? `${{ user: '个人', group: '群', global: '全局' }[s]} ${l.window5h ? fmt.usd(l.window5h) + '/5h' : ''} ${l.weekly ? fmt.usd(l.weekly) + '/周' : ''}` : '' }).filter(Boolean).join(' · ') || '不限额')),
          WINDOWS.map(([lim, used, label]) => h('div', { class: 'row small', style: { marginTop: '4px' } },
            h('span', { class: 'muted', style: { width: '48px' } }, label),
            h('div', { style: { flex: 1 } }, meter(m.global?.[used] ?? 0, m.global?.limits?.[lim])),
            h('span', { style: { width: '130px', textAlign: 'right' } }, fmt.usd(m.global?.[used] ?? 0), m.global?.limits?.[lim] ? ` / ${fmt.usd(m.global.limits[lim])}` : ''))),
        ))) : empty('没有模型'),
      ),
      card('本周花费最多的用户',
        u.topUsers.length ? h('table', h('tbody', u.topUsers.map((x, i) => h('tr',
          h('td', { class: 'muted' }, i + 1), h('td', x.name ?? '-', h('div', { class: 'small muted' }, x.id)), h('td', { class: 'num' }, fmt.usd(x.usd)),
          h('td', { class: 'num' }, h('button', { class: 'btn sm', onclick: async () => {
            if (await confirmDanger(`重置 ${x.name ?? x.id} 的额度计数？`)) act(() => post('/api/usage/reset', { userId: x.id }), '已重置').then(() => render(root))
          } }, '重置')))))) : empty('本周还没有用量'),
      ),
    ),
    card(h('span', { class: 'row', style: { width: '100%' } }, '累计统计（按模型）',
      models.length ? h('button', { class: 'btn sm danger right', onclick: async () => {
        if (await confirmDanger('清零所有模型的累计统计（调用次数、token、花费和每日花费）？不影响额度计数。', '清零')) act(() => post('/api/usage/reset-stats', { all: true }), '累计统计已清零').then(() => render(root))
      } }, '清零全部统计') : null),
      models.length ? h('div', { class: 'table-wrap' }, h('table',
        h('thead', h('tr', h('th', '模型'), h('th', { class: 'num' }, '调用'), h('th', { class: 'num', title: '没有命中缓存的输入 token' }, '未缓存输入'), h('th', { class: 'num' }, '缓存读'),
          h('th', { class: 'num', title: '缓存读 ÷（未缓存输入 + 缓存读）' }, '缓存命中率'), h('th', { class: 'num' }, '缓存写'), h('th', { class: 'num' }, '输出'), h('th', { class: 'num' }, '花费'), h('th', ''))),
        h('tbody', models.map(([id, t]) => {
          const total = t.input + t.cacheRead
          const partial = incomplete.has(id)
          return h('tr', h('td', id, partial ? h('div', { class: 'small muted', title: usageNote }, '用量可能不完整') : null),
            [t.calls, t.input, t.cacheRead].map(v => h('td', { class: 'num' }, fmt.num(v))),
            h('td', { class: 'num', title: partial ? usageNote : '' }, partial ? '待确认' : total ? `${((t.cacheRead / total) * 100).toFixed(1)}%` : '-'),
            [t.cacheWrite, t.output].map(v => h('td', { class: 'num' }, fmt.num(v))),
            h('td', { class: 'num', title: partial ? usageNote : '' }, fmt.usd(t.cost), partial ? h('div', { class: 'small muted' }, '已报告') : null),
            h('td', { class: 'num' }, h('button', { class: 'btn sm ghost danger', title: '清零这个模型的累计统计', onclick: async () => {
              if (await confirmDanger(`清零「${id}」的累计统计？不影响额度计数。`, '清零')) act(() => post('/api/usage/reset-stats', { models: [id] }), `「${id}」的统计已清零`).then(() => render(root))
            } }, '清零')))
        })),
      )) : empty('还没有调用记录'),
    ),
  )
}
