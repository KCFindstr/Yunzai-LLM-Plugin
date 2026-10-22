import { enc, get, post } from '../api.js'
import { menuButton } from '../main.js'
import { act, badge, card, confirmDanger, empty, fmt, h, mount } from '../ui.js'

const STATUS = {
  queued: ['排队中', 'accent'], running: ['执行中', 'accent'], waiting: ['等待回复', 'warn'],
  completed: ['已完成', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', ''], interrupted: ['已中断', 'warn'],
}

export async function render(root) {
  const jobs = await get('/api/computer')
  mount(root,
    h('div', { class: 'page-head' }, menuButton(), h('h1', '电脑任务'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => render(root) }, '刷新')),
    jobs.length ? jobs.map(j => {
      const [label, kind] = STATUS[j.status] ?? [j.status, '']
      return card(h('span', badge(label, kind), ' ', h('span', { class: 'mono small muted' }, j.id)),
        h('pre', j.task),
        h('div', { class: 'row small muted', style: { marginTop: '8px' } },
          `发起者 ${j.owner}`, `创建 ${fmt.time(j.createdAt)}`, `更新 ${fmt.ago(j.updatedAt)}`,
          ['queued', 'running', 'waiting'].includes(j.status) ? h('button', { class: 'btn sm danger right', onclick: async () => {
            if (await confirmDanger('取消这个电脑任务？')) act(() => post(`/api/computer/${enc(j.id)}/cancel`), '已取消').then(() => render(root))
          } }, '取消') : null),
        j.progress ? h('div', { class: 'small', style: { marginTop: '6px' } }, `进度：${j.progress}`) : null,
        j.steps != null ? h('div', { class: 'small muted', style: { marginTop: '4px' } },
          `${j.modelId ?? ''} · ${j.steps} 步 · 输入 ${fmt.num(j.inputTokens)} / 输出 ${fmt.num(j.outputTokens)}${j.costUsd != null ? ` · ${fmt.usd(j.costUsd)}` : ''}`) : null,
        j.report ? h('details', { style: { marginTop: '6px' }, open: j.status === 'waiting' }, h('summary', { class: 'small' }, j.status === 'waiting' ? '等待用户回复的问题' : '报告'), h('pre', { class: 'small' }, j.report)) : null,
        j.deliveryError ? h('div', { class: 'small bad', style: { marginTop: '6px' } }, '结果未能送达聊天') : null,
      )
    }) : card(null, empty('没有电脑任务')),
  )
}
