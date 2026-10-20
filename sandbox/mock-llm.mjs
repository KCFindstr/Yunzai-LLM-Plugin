/**
 * Scripted OpenAI-compatible /chat/completions server for offline sandbox runs.
 * It "decides" based on keywords so the full pipeline (tools, command dispatch, stickers) can be exercised.
 */
import http from 'node:http'

const COMMANDS = [
  [/星铁.*(深渊|忘却之庭|混沌)/, '*忘却之庭'],
  [/星铁.*体力|开拓力/, '*体力'],
  [/绝区零.*(深渊|式舆)/, '%式舆防卫战'],
  [/上期深渊/, '#上期深渊'],
  [/深渊/, '#深渊'],
  [/体力|树脂/, '#体力'],
  [/(\S{2,4})的?面板/, m => `#${m[1]}面板`],
  [/抽卡记录/, '#抽卡记录'],
  [/重启/, '#重启'],
]

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const t = typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('')
    return t.split('【消息】').pop().replace(/^【[^】]*】\n?/, '').trim()
  }
  return ''
}

function reply(content, toolCalls) {
  return {
    id: `mock-${Date.now()}`,
    choices: [{ index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } },
  }
}

const call = (name, args) => [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]

let stickerN = 0

export function decide(body) {
  const messages = body.messages ?? []
  const system = messages[0]?.content ?? ''
  const tools = new Set((body.tools ?? []).map(t => t.function?.name))
  const last = messages.at(-1)

  if (/整理表情包库/.test(system)) {
    stickerN++
    return reply(JSON.stringify({ name: `测试表情${stickerN}`, desc: '一个彩色条纹方块', use: '开心或者调侃的时候', tags: ['开心', '调侃'], text: '' }))
  }
  if (/对话记录整理助手/.test(system)) return reply('对方是测试用户，聊过深渊和表情包。')
  if (/只回复：OK/.test(lastUserText(messages))) return reply('OK')

  if (last?.role === 'tool') {
    const content = String(last.content ?? '')
    if (/不允许|主人指令|没有插件/.test(content)) return reply('这个我帮不了你哦，直接发指令试试？')
    if (/已记住|已合并/.test(content)) return reply('好，我记住啦')
    return reply(`（模拟）根据工具结果：${content.slice(0, 60)}`)
  }

  const text = lastUserText(messages)
  if (tools.has('run_bot_command'))
    for (const [re, cmd] of COMMANDS) {
      const m = re.exec(text)
      if (m) return reply(null, call('run_bot_command', { command: typeof cmd === 'function' ? cmd(m) : cmd }))
    }
  const remember = /^记住(.+)$/.exec(text)
  if (remember && tools.has('memory')) return reply(null, call('memory', { action: 'add', scope: 'user', text: remember[1].replace(/^[：:，,\s]+/, '') }))
  if (/搜索|新闻/.test(text) && tools.has('web_search')) return reply(null, call('web_search', { query: text }))
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  if (url && tools.has('web_fetch')) return reply(null, call('web_fetch', { url }))
  if (/表情/.test(text)) {
    const name = /# 表情包[\s\S]*?\n- ([^：\n]+)：/.exec(system)?.[1]
    return reply(name ? `哈哈哈\n[表情:${name}]` : '我还没有表情包呢')
  }
  if (/你记得我什么/.test(text)) {
    const mem = messages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .find(c => c.startsWith('【长期记忆'))
    return reply(mem ? `我记得：${mem.split('\n').slice(1).join('；')}` : '我还不了解你呢')
  }
  if (/两条/.test(text)) return reply('第一条消息\n\n第二条消息')
  if (/长文/.test(text)) return reply('很长的内容。'.repeat(120))
  return reply(`（模拟回复）收到：${text.slice(0, 30)}`)
}

export function startMockLLM(port, log = () => {}) {
  const server = http
    .createServer(async (req, res) => {
      let raw = ''
      for await (const c of req) raw += c
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {}
      const out = decide(body)
      log(`\x1b[90m[MockLLM] ${req.url} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} -> ${out.choices[0].message.tool_calls?.[0]?.function?.name ?? 'text'}\x1b[0m`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
    .listen(port, '127.0.0.1')
  return { close: () => server.close() }
}
