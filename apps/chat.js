import plugin from '../../lib/plugins/plugin.js'
import configManager from '../lib/config.js'
import { askLLM } from '../lib/llm.js'

export class LLMChat extends plugin {
  constructor() {
    super({
      name: 'LLM智能对话',
      dsc: '与大语言模型进行单轮与多轮智能对话',
      event: 'message',
      priority: 600,
      rule: [
        {
          reg: '^#?(chat|ai)\\s*([\\s\\S]*)$',
          fnc: 'onChatCommand'
        },
        {
          reg: '.*',
          fnc: 'onAtMessage'
        }
      ]
    })
  }

  /**
   * 通过 #chat 或 #ai 指令触发
   */
  async onChatCommand(e) {
    const rawMsg = (e.msg || '').trim()
    const match = rawMsg.match(/^#?(chat|ai)\s*([\s\S]*)$/i)
    if (!match) return false

    const query = match[2]?.trim()
    if (!query) {
      await e.reply('你想和我聊些什么呢？\n使用示例：#chat 帮我写一段 Python 快速排序代码', true)
      return true
    }

    return await this.replyLLM(e, query)
  }

  /**
   * 群聊中 @机器人 时自动触发
   */
  async onAtMessage(e) {
    const cfg = configManager.get()
    if (!cfg.atReply) return false

    // 检查是否艾特了机器人
    const isAtBot = Boolean(e.atBot || e.atme || (e.at && String(e.at) === String(e.self_id)))
    if (!isAtBot) return false

    // 过滤掉指令前缀，避免重复响应
    const rawMsg = (e.msg || '').trim()
    if (/^#?(chat|ai|llm)/i.test(rawMsg)) {
      return false
    }

    if (!rawMsg) {
      await e.reply('你好！有什么我可以帮你的吗？', true)
      return true
    }

    return await this.replyLLM(e, rawMsg)
  }

  /**
   * 请求 LLM 并回复
   */
  async replyLLM(e, query) {
    const cfg = configManager.get()
    const reply = await askLLM(e, query)
    await e.reply(reply, cfg.replyQuote)
    return true
  }
}
