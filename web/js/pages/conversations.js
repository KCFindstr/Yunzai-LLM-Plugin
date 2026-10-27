import { del, enc, get, post, put } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, statusBadge, card, confirmDanger, empty, fmt, h, icon, modal, mount, paged, pager, promptFields, tabs, mentionText, responseText } from '../ui.js'

/** Recent turns table, shared with the overview page. */
export function turnList(turns, { showConv = true } = {}) {
  if (!turns.length) return empty('还没有对话记录')
  return paged(turns, page => h('div', { class: 'table-wrap' }, h('table',
    h('thead', h('tr', h('th', '时间'), showConv ? h('th', '会话 / 发言人') : null, h('th', '内容'), h('th', '模型'), h('th', { class: 'num' }, '耗时'), h('th', { class: 'num' }, '花费'))),
    h('tbody', page.map(t => h('tr', { class: 'clickable-tr', onclick: () => showTurn(t) },
      h('td', { class: 'small muted', style: { whiteSpace: 'nowrap' } }, fmt.short(t.at)),
      showConv ? h('td', { class: 'small' }, h('a', { href: `#/conversations/${enc(t.conv)}`, onclick: e => e.stopPropagation() }, t.label ?? t.conv), h('div', { class: 'muted' }, t.userName ?? t.userId ?? '')) : null,
      h('td', { style: { maxWidth: '520px' } },
        h('div', { class: 'clip' }, mentionText(t.input)),
        t.error ? h('div', { class: 'small bad clip' }, `出错：${t.error}`) : h('div', { class: 'small muted clip' }, '↳ ', mentionText(t.reply || '（无文字回复）')),
        t.tools.length ? h('div', { class: 'chips', style: { marginTop: '4px' } }, [...new Set(t.tools)].map(n => badge(`${n}${t.tools.filter(x => x === n).length > 1 ? `×${t.tools.filter(x => x === n).length}` : ''}`, 'accent'))) : null,
      ),
      h('td', { class: 'small' }, t.model ?? '-'),
      h('td', { class: 'num small' }, fmt.dur(t.ms)),
      h('td', { class: 'num small', title: t.tokens?.inputIncomplete ? '历史输入与缓存用量可能缺失，花费可能偏低' : '' }, fmt.usd(t.cost), t.tokens?.inputIncomplete ? h('div', { class: 'small muted' }, '已报告') : null),
    ))),
  )))
}

function showTurn(t) {
  modal(`${fmt.time(t.at)} · ${t.userName ?? t.userId ?? ''}`, h('div', { class: 'col', style: { gap: '12px' } },
    h('div', { class: 'row small muted', style: { flexWrap: 'wrap', gap: '8px' } },
      badge(t.model ?? '未知模型', 'accent'),
      badge(`耗时 ${fmt.dur(t.ms)}`),
      badge(`费用 ${fmt.usd(t.cost)}`),
      t.tokens ? h('span', `输入 ${fmt.num(t.tokens.input)} / 缓存 ${fmt.num(t.tokens.cacheRead)} / 输出 ${fmt.num(t.tokens.output)}`) : null),
    t.tokens?.inputIncomplete ? h('p', { class: 'small warn' }, '上游可能漏报历史输入和缓存 token，以上花费可能偏低；实际费用以服务商账单为准。') : null,
    h('div', { class: 'chat' }, h('div', { class: 'bubble user' }, mentionText(t.input)), t.reply ? responseText(t.reply, 'bubble assistant', `turn:${t.rolloutId || `${t.conv}:${t.at}`}`) : null),
    t.tools.length ? h('div', { class: 'chips' }, h('span', { class: 'small muted' }, '工具调用：'), t.tools.map(tool => badge(tool, 'accent'))) : null,
    t.rolloutId ? h('a', { class: 'btn primary sm', style: { alignSelf: 'flex-start' }, href: `#/rollouts/${enc(t.rolloutId)}`, onclick: e => e.currentTarget.closest('.modal-bg')?.querySelector('header button')?.click() }, icon('layers', 14), ' 查看完整执行记录 →') : null,
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
  const detail = h('div', { class: 'rollout-detail' })
  const items = h('div')
  let filter = ''
  let selectedKey = sub && sub !== 'turns' ? sub : sessions[0]?.key
  const pages = pager(() => drawItems(selectedKey), { anchor: () => list })
  pages.reveal(sessions.findIndex(s => s.key === selectedKey))

  function drawItems(selected) {
    const visible = sessions.filter(s => !filter || `${s.label} ${s.key} ${s.summary ?? ''}`.toLowerCase().includes(filter))
    mount(items, visible.length ? pages.slice(visible).map(s => h('div', {
      class: `list-item computer-job click ${s.key === selected ? 'sel' : ''}`,
      onclick: () => { location.hash = `#/conversations/${enc(s.key)}` },
    },
      h('div', { class: 'row' }, h('b', { class: 'clamp' }, s.label), h('span', { class: 'right small muted' }, fmt.ago(s.updatedAt))),
      h('div', { class: 'row small muted', style: { gap: '6px' } },
        s.waitingCallback ? statusBadge('waiting_callback') : null,
        badge(kindLabel[s.kind] ?? s.kind),
        badge(`${s.messages / 2} 轮`),
        s.archive ? badge(`档案 ${s.archive}`) : null,
        s.vectors ? badge(`向量 ${s.vectors}`, 'accent') : null),
      h('span', { class: 'small muted mono clamp' }, s.key),
      s.summary ? h('div', { class: 'small muted clamp', style: { marginTop: '2px' } }, s.summary) : null,
    )) : empty(filter ? '没有匹配的会话' : '还没有会话'), visible.length ? pages.el : null)
  }

  const searchInput = h('input', {
    type: 'search',
    placeholder: '筛选会话或摘要…',
    'aria-label': '筛选会话',
    style: { width: '100%', marginBottom: '10px' },
    oninput: e => { filter = e.target.value.toLowerCase(); pages.reset(); drawItems(selectedKey) },
  })
  const list = h('div', { class: 'pane-list computer-job-list rollout-list' }, searchInput, items)

  drawItems(selectedKey)
  mount(root, head, switcher, h('div', { class: 'split computer-split' }, list, detail))
  if (selectedKey) await drawDetail(detail, selectedKey, () => render(root, [selectedKey]))
  else mount(detail, card(null, empty('选择左侧的会话查看详情')))
}

async function drawDetail(el, key, refresh) {
  const s = await get(`/api/sessions/${enc(key)}`)
  const base = `/api/sessions/${enc(key)}`
  const savedMessage = result => result.vectorStatus === 'ready' ? '已保存并更新向量'
    : result.vectorStatus === 'pending' ? '已保存；向量更新将在后台重试'
      : result.vectorStatus === 'disabled' ? '已保存；配置向量模型后会自动向量化' : '已保存'

  function historyButtons(title, url, text, { regenerate = true, regenerateEnabled = true, allowEmpty = false, note = '档案和每日概要保存后自动更新向量。' } = {}) {
    return [
      h('button', { class: 'btn sm ghost', onclick: async e => {
        const button = e.currentTarget
        const input = h('textarea', { rows: 10, 'aria-label': `编辑${title}` }, text)
        let saving = false
        const saved = await modal(`编辑${title}`, h('label', { class: 'col' }, h('span', { class: 'small muted' }, note), input), [
          { label: '取消', value: false },
          { label: '保存', kind: 'primary', value: true, run: async () => {
            if (saving) return false
            saving = true
            button.disabled = true
            try {
              const result = await act(() => {
                if (!allowEmpty && !input.value.trim()) throw new Error('内容不能为空')
                return put(url, { text: input.value, previousText: text })
              }, savedMessage)
              return Boolean(result)
            } finally { saving = false; button.disabled = false }
          } },
        ])
        if (saved && el.isConnected) await refresh()
      } }, '编辑'),
      regenerate ? h('button', { class: 'btn sm ghost', disabled: !regenerateEnabled, title: regenerateEnabled ? '' : '这条旧档案未保留聊天原文，无法重新生成；仍可手动编辑。', onclick: async e => {
        const button = e.currentTarget
        button.disabled = true
        try {
          const data = await act(() => get('/api/models'))
          if (!data) return
          const options = data.models.filter(m => m.hasKey).map(m => ({ value: m.id, label: `${m.id} · ${m.model}` }))
          const fields = await promptFields(`重新生成${title}`, [{ name: 'model', label: `使用仍保留的原文或档案生成；预算 ${s.summaryMaxTokens} tokens（含思考）。保存后自动更新档案向量。`,
            value: s.summaryModel, options: [{ value: '', label: '自动选择辅助模型' }, ...options] }], '重新生成')
          if (!fields) return
          button.textContent = '生成中…'
          const result = await act(() => post(`${url}/regenerate`, fields.model ? { model: fields.model } : {}), savedMessage)
          if (result && el.isConnected) await refresh()
        } finally { button.disabled = false; button.textContent = '重新生成' }
      } }, '重新生成') : null,
    ]
  }
  mount(el,
    card(h('span', { class: 'card-title' }, icon('chat'), s.label, ' ', badge(kindLabel[s.kind] ?? s.kind), s.waitingCallback ? [' ', statusBadge('waiting_callback')] : null),
      h('div', { class: 'row small muted' },
        h('span', { class: 'mono' }, s.key),
        h('span', `最后活跃 ${fmt.time(s.updatedAt)}`),
        h('a', { class: 'right', href: `#/vectors/${enc(key)}` }, '在向量空间中查看 →'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (await confirmDanger('清除这个会话的全部历史、摘要、档案和向量？')) act(() => del(`/api/sessions/${enc(key)}`), '已清除').then(() => { location.hash = '#/conversations' })
        } }, '清除会话')),
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, `摘要输出预算：${s.summaryMaxTokens} tokens（含思考） · `,
        h('a', { href: '#/config/chat' }, '修改预算')),
    ),
    card(h('span', { class: 'card-title' }, icon('memory'), '滚动摘要',
      h('span', { class: 'right row' }, historyButtons('滚动摘要', `${base}/summary`, s.summary ?? '', { allowEmpty: true, note: '滚动摘要直接用于后续对话；留空可清除。' }))),
      s.summary ? h('pre', { class: 'small' }, s.summary) : empty('还没有摘要（历史未超出上限时不生成）')),
    card(h('span', { class: 'card-title' }, icon('clock'), `每日概要（${s.days.length} 天）`),
      s.days.length ? paged([...s.days].reverse(), page => page.map(d => h('div', { class: 'list-item' },
        h('div', { class: 'row small' },
          h('b', d.day),
          h('span', { class: 'muted' }, `由 ${d.sources.length} 段整理 · ${fmt.ago(d.at)}更新`),
          d.vector ? badge('已向量化', 'accent') : badge('无向量'),
          d.stale ? badge('源档案已修改·待刷新', 'warn') : null,
          h('span', { class: 'right row' }, historyButtons(`${d.day} 每日概要`, `${base}/archive/${enc(d.id)}`, d.text),
          h('button', { class: 'btn sm ghost danger', onclick: async () => {
            if (await confirmDanger(`删除 ${d.day} 的当日概要？（下次整理时会根据仍保留的档案重新生成）`)) act(() => del(`/api/sessions/${enc(key)}/archive/${enc(d.id)}`), '已删除').then(refresh)
          } }, '删除')),
        ),
        h('pre', { class: 'small', style: { marginTop: '6px' } }, d.text),
      )), { size: 10 }) : empty('还没有每日概要：每天结束后，当天的档案会在后台整理成一条概要')),
    card(h('span', { class: 'card-title' }, icon('layers'), `旧聊天档案（${s.archive.length} 段）`),
      s.archive.length ? paged([...s.archive].reverse(), page => page.map(a => h('div', { class: 'list-item' },
        h('div', { class: 'row small' },
          h('span', { class: 'muted' }, fmt.time(a.at)),
          a.chat ? badge('群聊', 'accent') : null,
          a.raw ? badge('原文·待整理', 'warn') : badge('摘要', 'ok'),
          !a.raw ? badge(a.sourceAvailable ? '原文已保留' : '原文未保留', a.sourceAvailable ? '' : 'warn') : null,
          a.vector ? badge('已向量化', 'accent') : badge('无向量'),
          h('span', { class: 'right row' }, historyButtons('旧聊天档案', `${base}/archive/${enc(a.id)}`, a.text, { regenerateEnabled: a.sourceAvailable, note: '保存为已整理的档案，并自动更新向量；由它生成的每日概要将在后台刷新。' }),
          h('button', { class: 'btn sm ghost danger', onclick: async () => {
            if (await confirmDanger('删除这段档案？')) act(() => del(`/api/sessions/${enc(key)}/archive/${enc(a.id)}`), '已删除').then(refresh)
          } }, '删除')),
        ),
        h('pre', { class: 'small', style: { marginTop: '6px' } }, a.text),
      )), { size: 10 }) : empty('还没有档案'),
    ),
    card(h('span', { class: 'card-title' }, icon('chat'), `当前上下文（${s.messages.length / 2} 轮）`),
      s.messages.length ? h('div', { class: 'chat' }, s.messages.map((m, i) => h('div', { class: 'context-message' },
        h('div', { class: 'row small muted' }, h('span', m.role === 'assistant' ? '机器人' : '用户'),
          h('span', { class: 'right row' }, historyButtons('上下文消息', `${base}/messages/${i}`, m.text, { regenerate: false, allowEmpty: true, note: '修改机器人后续看到的上下文；已发送的消息不受影响。' }))),
        m.role === 'assistant' ? responseText(m.text, 'bubble assistant', `message:${i}`) : h('div', { class: `bubble ${m.role}` }, mentionText(m.text)),
      ))) : empty('当前没有上下文（空闲超时后会重新开始）'),
    ),
    card(h('span', { class: 'card-title' }, icon('logs'), '最近对话'), turnList(s.turns, { showConv: false })),
  )
}
