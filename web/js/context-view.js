/** Presentation-only fallback for old snapshots; never rewrites the model request. */
export function splitPromptMessage(text = '') {
  const result = { text, heading: '', recent: [], roster: [], memory: '', quote: '' }
  const newline = text.indexOf('\n')
  if (newline < 0 || !/^【[^\n]*｜(?:群|私聊)/.test(text)) return result
  result.heading = text.slice(0, newline)
  const rest = text.slice(newline + 1)
  const boundary = rest.indexOf('【消息】\n')
  if (boundary < 0) { result.text = rest; return result }
  result.text = rest.slice(boundary + '【消息】\n'.length)
  let section = ''
  const memory = [], quote = []
  for (const line of rest.slice(0, boundary).trimEnd().split('\n')) {
    if (line === '【最近群聊】') { section = 'recent'; continue }
    if (line === '【最近群友·仅身份参考】') { section = 'roster'; continue }
    if (/^【(?:长期记忆|相关旧聊天)/.test(line)) section = 'memory'
    if (/^【引用/.test(line)) section = 'quote'
    if (section === 'recent' || section === 'roster') result[section].push(line)
    else if (section === 'memory') memory.push(line)
    else if (section === 'quote') quote.push(line)
  }
  result.memory = memory.join('\n'); result.quote = quote.join('\n')
  return result
}

export function contextView(context) {
  const messages = context.messages ?? []
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const currentIndex = messages.findIndex(message => message.source === 'current')
  const index = currentIndex >= 0 ? currentIndex : lastUser
  const currentMessage = messages[index]
  const current = context.current ?? splitPromptMessage(currentMessage?.text)
  const history = [], memory = [], summary = []
  let inHistory = false
  messages.forEach((message, i) => {
    if (i === index) return
    const inferred = !message.source && !inHistory && message.role === 'user'
    if (message.source === 'memory' || inferred && message.text.startsWith('【长期记忆')) memory.push(message)
    else if (message.source === 'summary' || inferred && message.text.startsWith('【之前对话的摘要】')) summary.push(message)
    else { history.push({ ...message, ...splitPromptMessage(message.text) }); inHistory = true }
  })
  return { current: { ...current, imageCount: currentMessage?.imageCount ?? 0 }, history, memory, summary }
}
