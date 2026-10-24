/**
 * Scripted OpenAI-compatible /chat/completions server for offline sandbox runs.
 * It "decides" based on keywords so the full pipeline (tools, command dispatch, stickers) can be exercised.
 */
import fs from 'node:fs'
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
    // the user's text follows the current-turn heading line 【消息｜time｜…】
    return t
      .split(/^【消息[^\n]*\n?/m)
      .pop()
      .replace(/^【[^】]*】\n?/, '')
      .replace(/^(\[at:[^\]]+\]\s*)+/, '')
      .trim()
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

  // thinking=auto judge (chat.thinkingJudge.mode: model)
  if (/消息分类器/.test(system)) {
    const msg = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map(c => c.text ?? '').join('')
    return reply(/配队|整理|攻略|规划|代码|分析/.test(msg) ? 'complex' : /[?？]|几|多少|什么/.test(msg) ? 'question' : 'casual')
  }
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
    if (/已渲染为图片/.test(content)) return reply('整理好啦，看图喵！')
    // 「做张海报」: run_code saved img/poster.png, now lay it out with render_html (same sandbox workspace)
    if (/IMG_READY/.test(content) && tools.has('render_html'))
      return reply(null, call('render_html', { html: '<h2>胡桃出场统计</h2><img src="img/poster.png" style="width:100%"><p>数据来自沙盒里的 run_code</p>' }))
    const exit = /^退出码 (\d+)[\s\S]*?\[stdout\]\n([^\n]*)/.exec(content)
    if (exit) return reply(`算好了：${exit[2]}`)
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
  if (/怎么配队/.test(text) && /回复会按 Markdown 显示/.test(system))
    return reply(
      '哼哼，算你问对猫了喵！\n\n## 胡桃 + 行秋 双水蒸发\n\n| 位置 | 角色 | 作用 |\n|---|---|---|\n| 主C | 胡桃 | E 后重击蒸发 |\n| 副C | 行秋 | 大招挂水、减伤 |\n| 辅助 | 夜兰 / 钟离 | 补伤害 / 护盾 |\n\n**手法**：行秋 EQ → 胡桃 E → 9 重击。\n\n学费记得交小鱼干喵～',
    )
  if (/表格|整理一下|对比一下/.test(text) && tools.has('render_html'))
    return reply(null, call('render_html', { html: '<h2>对比</h2><table><tr><th>角色</th><th>定位</th></tr><tr><td>胡桃</td><td>主C</td></tr><tr><td>行秋</td><td>副C</td></tr></table>' }))
  if (/做张海报/.test(text) && tools.has('run_code'))
    return reply(null, call('run_code', {
      language: 'python',
      code: 'import os\nimport matplotlib.pyplot as plt\nos.makedirs("img", exist_ok=True)\nplt.bar(["胡桃","行秋","夜兰"],[5,3,4]);plt.savefig("img/poster.png");print("IMG_READY")',
    }))
  if (/算一下|画个图/.test(text) && tools.has('run_code'))
    return reply(null, call('run_code', {
      language: 'python',
      code: /画个图/.test(text)
        ? 'import matplotlib.pyplot as plt\nplt.bar(["胡桃","行秋"],[3,5]);plt.title("出场次数");plt.savefig("out/c.png");print("done")'
        : 'import math\nprint(math.comb(90, 3))',
    }))
  if (/搜索|新闻/.test(text) && tools.has('web_search')) return reply(null, call('web_search', { query: text }))
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  if (url && tools.has('web_fetch')) return reply(null, call('web_fetch', { url }))
  if (/表情/.test(text)) {
    const name = /# 表情包[\s\S]*?\n- ([^：\n]+)：/.exec(system)?.[1]
    return reply(name ? `哈哈哈\n[表情:${name}]` : '我还没有表情包呢')
  }
  if (/你记得我什么/.test(text)) {
    // the memory block rides in a prefix or the current turn's header; an empty one only carries the （还没有…） nudge
    const content = messages
      .map(m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join('')))
      .filter(c => c.includes('【长期记忆·关于'))
      .at(-1) ?? ''
    const facts = (/^【长期记忆·关于[^\n]*\n((?:(?!【)[^\n]*\n?)*)/m.exec(content)?.[1] ?? '')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('（还没有'))
    return reply(facts.length ? `我记得：${facts.join('；')}` : '我还不了解你呢')
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
      if (process.env.MOCK_DUMP) fs.appendFileSync(process.env.MOCK_DUMP, `${JSON.stringify({ url: req.url, body })}
`)
      const out = decide(body)
      log(`\x1b[90m[MockLLM] ${req.url} msgs=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} -> ${out.choices[0].message.tool_calls?.[0]?.function?.name ?? 'text'}\x1b[0m`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
    .listen(port, '127.0.0.1')
  return { close: () => server.close() }
}
