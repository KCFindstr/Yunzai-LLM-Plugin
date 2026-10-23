/** Presentation-only fallback for old snapshots; never rewrites the model request. */
export function splitPromptMessage(text = '') {
  const result = { text, heading: '', recent: [], roster: [], memory: '', quote: '' }
  const newline = text.indexOf('\n')
  let prefix
  // Old snapshots put identity at the top; new requests attach it to the final message header.
  if (/^【(?!消息｜)[^\n]*｜(?:群|私聊)/.test(text) && newline >= 0) {
    result.heading = text.slice(0, newline)
    const rest = text.slice(newline + 1)
    const boundary = rest.indexOf('【消息】\n')
    if (boundary < 0) { result.text = rest; return result }
    result.text = rest.slice(boundary + '【消息】\n'.length)
    prefix = rest.slice(0, boundary)
  } else {
    const header = /^【消息｜[^\n]*｜(?:群|私聊)[^\n]*】\r?$/m.exec(text)
    if (!header) return result
    result.heading = header[0].trimEnd()
    result.text = text.slice(header.index + header[0].length).replace(/^\r?\n/, '')
    prefix = text.slice(0, header.index)
  }
  let section = ''
  const memory = [], quote = []
  for (const line of prefix.trimEnd().split('\n')) {
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

/** Plain text in saved request order; tool schemas and user text stay text, never HTML. */
export function initialPromptText(context) {
  const parts = []
  if (context.truncated) parts.push(`[保存的快照已截取，省略 ${context.omittedMessages ?? 0} 条消息、${context.omittedTools ?? 0} 个工具；以下不是完整请求。]`)
  parts.push(`[system]\n${context.system ?? ''}`)
  parts.push(`[tools]\n${context.tools?.length ? context.tools.map(tool => `${tool.name}\n${tool.description}\n${tool.parameters}`).join('\n\n') : '（无函数工具）'}`)
  if (context.nativeSearch) parts.push('[native search]\n已启用供应商内置搜索')
  for (const [i, message] of (context.messages ?? []).entries()) parts.push(
    `[message ${i + 1 + (context.omittedMessages ?? 0)} · ${message.role}]\n${message.text}${message.imageCount ? `\n[附带 ${message.imageCount} 张图片；快照未保存原始图片字节]` : ''}`)
  return parts.join('\n\n')
}
