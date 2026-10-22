import { get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, empty, fmt, h, mount, stat, switchEl } from '../ui.js'
import { turnList } from './conversations.js'

export async function render(root) {
  const [o, turns] = await Promise.all([get('/api/overview'), get('/api/turns?limit=12')])
  const action = (name, label) => h('button', { class: 'btn', onclick: () => act(() => post(`/api/actions/${name}`), r => r.message).then(() => render(root)) }, label)

  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '概览'),
      h('span', { class: 'spacer' }),
      h('label', { class: 'row' }, h('span', { class: 'muted' }, '插件总开关'),
        switchEl(o.enable, on => act(() => post(`/api/actions/${on ? 'enable' : 'disable'}`), r => r.message))),
    ),
    h('div', { class: 'stats' },
      stat('今日对话', fmt.num(o.today.turns), o.today.errors ? h('span', { class: 'bad' }, `${o.today.errors} 次出错`) : `平均 ${fmt.dur(o.today.avgMs)}`),
      stat('今日花费', fmt.usd(o.today.cost), '最近 24 小时'),
      stat('默认模型', o.defaultModel || '未配置', o.defaultModelReady ? h('span', { class: 'ok' }, 'API Key 已配置') : h('span', { class: 'bad' }, '缺少 API Key')),
      stat('当前人设', o.persona || '-', `${o.counts.groups} 个群有单独设置`),
      stat('会话', fmt.num(o.counts.sessions), `档案 ${o.counts.archive} 段 · 向量 ${o.counts.vectors}`),
      stat('长期记忆', fmt.num(o.counts.memoryEntries), `${o.counts.memoryUsers} 人 · ${o.counts.memoryGroups} 群`),
      stat('向量检索', o.embedding.ready ? '已启用' : '仅关键词', o.embedding.model),
      stat('运行时间', fmt.dur(o.uptime), `${o.node} · ${fmt.bytes(o.rss)}`),
    ),
    h('div', { class: 'grid cols-2' },
      card('机器人账号',
        o.bots.length
          ? h('table', h('thead', h('tr', h('th', '账号'), h('th', '昵称'), h('th', '适配器'), h('th', { class: 'num' }, '群'), h('th', { class: 'num' }, '好友'))),
              h('tbody', o.bots.map(b => h('tr', h('td', h('span', { class: 'dot ok' }), ' ', b.uin), h('td', b.nickname), h('td', b.adapter ?? '-'), h('td', { class: 'num' }, b.groups), h('td', { class: 'num' }, b.friends)))))
          : empty('没有检测到在线的机器人账号'),
      ),
      card('维护',
        h('div', { class: 'col' },
          h('div', { class: 'row' }, action('reload', '重载配置'), action('refresh-prices', '刷新价格表'), action('scan-commands', '扫描指令')),
          h('div', { class: 'small muted' },
            `模型 ${o.counts.models} · 提供商 ${o.counts.providers} · 工具 ${o.counts.tools} · 技能 ${o.counts.skills} · 表情 ${o.counts.stickers}`, h('br'),
            `指令目录 ${o.catalog.verified}/${o.catalog.entries} 已验证 · 价格表 ${o.prices.count} 个模型${o.prices.age ? `（${o.prices.age}前更新）` : ''}`),
          o.recentErrors.length
            ? h('div', h('div', { class: 'small muted', style: { margin: '6px 0' } }, '最近错误'),
                o.recentErrors.map(l => h('div', { class: 'small' }, badge(fmt.short(l.at), 'bad'), ' ', h('span', { class: 'clip' }, l.text.slice(0, 200)))))
            : h('div', { class: 'small ok' }, '最近没有错误'),
        ),
      ),
    ),
    card(h('span', '最近对话 ', h('a', { href: '#/conversations/turns', class: 'small' }, '全部 →')), turnList(turns)),
  )
}
