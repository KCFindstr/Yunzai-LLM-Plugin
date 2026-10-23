import { badge, h, textBlock, mentionText } from './ui.js'
import { contextView } from './context-view.js'

export function contextInspector(context, opened, { markdown = false } = {}) {
  const view = contextView(context)
  const disclosure = (key, label, count, children) => h('details', { class: 'context-section quiet-details', 'data-disclosure': key, open: opened.get(key) },
    h('summary', label, count != null ? badge(count) : null), h('div', { class: 'context-section-body' }, children))
  const text = (value, key, limit = 400, formatted = false) => textBlock(value, { key, open: opened.get(key), limit, markdown: formatted && markdown })
  const roles = { user: '用户', assistant: '机器人', tool: '工具' }
  const message = (entry, i) => h('div', { class: `context-message ${entry.role}` },
    h('div', { class: 'row small muted' }, badge(roles[entry.role] ?? entry.role), entry.imageCount ? badge(`${entry.imageCount} 张图片`) : null),
    entry.heading ? h('p', { class: 'small muted' }, mentionText(entry.heading)) : null,
    entry.quote ? h('blockquote', { class: 'small muted' }, mentionText(entry.quote)) : null,
    text(entry.text, `history:${i}`, 400, entry.role === 'assistant'))
  const current = view.current
  return h('div', { class: 'context-inspector' },
    context.truncated ? h('p', { class: 'small warn' }, '部分内容超出保存上限，已截取。') : null,
    h('section', { class: 'context-current' },
      h('div', { class: 'row' }, h('h3', '当前消息'), current.imageCount ? badge(`${current.imageCount} 张图片`) : null),
      current.heading ? h('p', { class: 'small muted' }, mentionText(current.heading)) : null,
      text(current.text, 'context-current', 600),
      current.quote ? disclosure('context-quote', '引用的消息', null, text(current.quote, 'quote-text')) : null),
    current.recent.length ? disclosure('context-recent', '最近群聊', current.recent.length,
      h('ol', { class: 'context-group-lines' }, current.recent.map((line, i) => h('li', text(line.replace(/^\d+\.\s*/, ''), `recent:${i}`, 350))))) : null,
    disclosure('context-history', '历史对话', context.history ? `${context.history.turns} 轮 · ${context.history.messages} 条消息` : `${view.history.length} 条消息`, [
      h('p', { class: 'small muted' }, `${context.history ? `配置上限 ${context.history.maxTurns} 轮。` : ''}一轮 = 用户消息和机器人回复各一条。`,
        context.history && view.history.length < context.history.messages ? ` 当前快照只保留了其中 ${view.history.length} 条。` : ''),
      view.history.length ? view.history.map(message) : h('p', { class: 'small muted' }, '本次没有携带历史对话。')]),
    view.summary.length ? disclosure('context-summary', '对话摘要', null, view.summary.map((entry, i) => text(entry.text, `summary:${i}`))) : null,
    current.memory || view.memory.length ? disclosure('context-memory', '长期记忆与检索结果', null,
      [...view.memory.map((entry, i) => text(entry.text, `memory:${i}`)), current.memory ? text(current.memory, 'current-memory') : null]) : null,
    current.roster.length ? disclosure('context-roster', '群友身份参考', current.roster.length,
      h('ul', { class: 'context-group-lines' }, current.roster.map(line => h('li', mentionText(line))))) : null,
    disclosure('system-prompt', '系统提示', null, h('pre', { class: 'small' }, context.system)),
    disclosure('context-raw', '原始消息快照', context.messages.length,
      context.messages.map((entry, i) => h('div', { class: 'context-message' },
        h('div', { class: 'row small muted' }, badge(`#${i + 1}`), badge(entry.role)), text(entry.text, `raw-context:${i}`)))),
  )
}
