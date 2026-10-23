import { get, post } from '../api.js'
import { act, badge, card, empty, fmt, h, icon, mount, stat, switchEl } from '../ui.js'
import { turnList } from './conversations.js'

export async function render(root) {
  const [o, turns] = await Promise.all([get('/api/overview'), get('/api/turns?limit=12')])
  const action = (name, label, ico) => h('button', { class: 'btn', onclick: async e => {
    const button = e.currentTarget
    button.disabled = true
    const result = await act(() => post(`/api/actions/${name}`), r => r.message)
    button.disabled = false
    if (result && root.isConnected) await act(() => render(root))
  } }, icon(ico, 16), label)
  const metric = (label, value, sub, ico) => stat(h('span', { class: 'metric-label' }, label, icon(ico, 18)), value, sub)
  const shortcut = (href, ico, title, desc) => h('a', { class: 'shortcut', href },
    h('span', { class: 'shortcut-icon' }, icon(ico, 21)), h('div', h('strong', title), h('span', desc)), icon('arrow', 18))

  mount(root,
    h('div', { class: 'overview-head page-head' },
      h('div', h('div', { class: 'eyebrow' }, '工作台 / OVERVIEW'), h('h1', '概览'), h('p', { class: 'page-description' }, '查看运行状态，让机器人的日常管理更简单。')),
      h('div', { class: 'plugin-control' },
        h('span', { class: `dot ${o.enable ? 'ok' : ''}` }),
        h('div', h('strong', '插件总开关'), h('span', { class: 'small muted plugin-status', role: 'status' }, o.enable ? '已启用 · 正在接收对话' : '已停用 · 暂停接收对话')),
        switchEl(o.enable, async (on, input) => {
          input.disabled = true
          const result = await act(() => post(`/api/actions/${on ? 'enable' : 'disable'}`), r => r.message)
          input.disabled = false
          if (!result) input.checked = !on
          else if (root.isConnected) await act(() => render(root))
        }, '插件总开关'),
      ),
    ),
    !o.defaultModelReady ? h('div', { class: 'notice warn' }, icon('alert'), h('span', '默认模型缺少 API Key，配置后即可开始对话。'), h('a', { href: '#/config/providers', class: 'btn sm' }, '配置提供商', icon('arrow', 14))) : null,
    h('div', { class: 'stats overview-stats' },
      metric('今日对话', fmt.num(o.today.turns), o.today.errors ? h('span', { class: 'bad' }, `${o.today.errors} 次出错 · 平均 ${fmt.dur(o.today.avgMs)}`) : `平均响应 ${fmt.dur(o.today.avgMs)}`, 'chat'),
      metric('今日花费', fmt.usd(o.today.cost), '最近 24 小时', 'usage'),
      metric('默认模型', h('a', { href: '#/models', title: o.defaultModel || '前往配置模型' }, o.defaultModel || '未配置'), o.defaultModelReady ? h('span', { class: 'ok' }, 'API Key 已配置') : h('span', { class: 'bad' }, '缺少 API Key'), 'models'),
      metric('运行时间', fmt.dur(o.uptime), `${o.node} · ${fmt.bytes(o.rss)}`, 'clock'),
    ),
    h('section', { class: 'overview-section', 'aria-label': '快捷入口' },
      h('div', { class: 'section-heading' }, h('h2', '常用管理'), h('span', { class: 'small muted' }, '从这里开始')),
      h('div', { class: 'shortcuts' },
        shortcut('#/rollouts', 'layers', '执行记录', '模型响应、工具调用与执行时间线'),
        shortcut('#/models', 'models', '管理模型', '提供商、连通性与默认模型'),
        shortcut('#/usage', 'usage', '用量与额度', '费用明细与模型限额设置'),
        shortcut('#/agy', 'models', '异步代理', 'AGY 后台任务状态与结果'),
        shortcut('#/personas', 'persona', '调整人设', '编辑机器人的身份与表达方式'),
        shortcut('#/config', 'settings', '偏好与配置', '按需调整功能，即时保存生效'),
      ),
    ),
    h('div', { class: 'overview-section' },
      h('div', { class: 'section-heading' }, h('h2', '对话与记忆'), h('a', { class: 'small', href: '#/conversations' }, '查看会话 →')),
      h('div', { class: 'resource-grid' },
        h('a', { class: 'resource', href: '#/personas' }, icon('persona', 20), h('div', h('span', '当前人设'), h('strong', o.persona || '-'), h('small', `${o.counts.groups} 个群有单独设置`))),
        h('a', { class: 'resource', href: '#/conversations' }, icon('chat', 20), h('div', h('span', '会话'), h('strong', fmt.num(o.counts.sessions)), h('small', `档案 ${o.counts.archive} 段 · 向量 ${o.counts.vectors}`))),
        h('a', { class: 'resource', href: '#/memory' }, icon('memory', 20), h('div', h('span', '长期记忆'), h('strong', fmt.num(o.counts.memoryEntries)), h('small', `${o.counts.memoryUsers} 人 · ${o.counts.memoryGroups} 群`))),
        h('a', { class: 'resource', href: '#/vectors' }, icon('vectors', 20), h('div', h('span', '向量检索'), h('strong', o.embedding.ready ? '已启用' : '仅关键词'), h('small', o.embedding.model))),
      ),
    ),
    h('div', { class: 'grid cols-2 overview-details' },
      card(h('span', { class: 'card-title' }, icon('computer'), '机器人账号', badge(`${o.bots.length} 个在线`, o.bots.length ? 'ok' : '')),
        o.bots.length
          ? h('div', { class: 'table-wrap' }, h('table', h('thead', h('tr', h('th', '账号'), h('th', '昵称'), h('th', '适配器'), h('th', { class: 'num' }, '群'), h('th', { class: 'num' }, '好友'))),
              h('tbody', o.bots.map(b => h('tr', h('td', h('span', { class: 'dot ok' }), ' ', b.uin), h('td', b.nickname), h('td', b.adapter ?? '-'), h('td', { class: 'num' }, b.groups), h('td', { class: 'num' }, b.friends))))))
          : empty('没有检测到在线的机器人账号'),
      ),
      card(h('span', { class: 'card-title' }, icon('tools'), '维护与状态'),
        h('div', { class: 'col' },
          h('div', { class: 'row maintenance-actions' }, action('reload', '重载配置', 'refresh'), action('refresh-prices', '刷新价格表', 'usage'), action('scan-commands', '扫描指令', 'search')),
          h('div', { class: 'small muted system-summary' },
            `模型 ${o.counts.models} · 提供商 ${o.counts.providers} · 工具 ${o.counts.tools} · 技能 ${o.counts.skills} · 表情 ${o.counts.stickers}`, h('br'),
            `指令目录 ${o.catalog.verified}/${o.catalog.entries} 已验证 · 价格表 ${o.prices.count} 个模型${o.prices.age ? `（${o.prices.age}前更新）` : ''}`),
          o.recentErrors.length
            ? h('div', { class: 'recent-errors' }, h('a', { href: '#/logs', class: 'small bad' }, '最近错误 · 查看日志 →'),
                o.recentErrors.map(l => h('div', { class: 'small error-line' }, badge(fmt.short(l.at), 'bad'), h('span', { class: 'clip', title: l.text }, l.text.slice(0, 200)))))
            : h('div', { class: 'health-message small ok' }, icon('check', 16), '最近没有错误'),
        ),
      ),
    ),
    h('div', { class: 'overview-section recent-turns' },
      card(h('span', { class: 'section-heading' }, h('span', { class: 'card-title' }, icon('chat'), '最近对话'), h('a', { href: '#/conversations/turns', class: 'small' }, '查看全部 →')), turnList(turns)),
    ),
  )
}
