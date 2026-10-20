import configManager from '../lib/config.js'
import memoryManager from '../lib/memory.js'
import type { YunzaiEvent } from '../types/index.js'

const BasePlugin = (typeof plugin !== 'undefined' ? plugin : class {
  e!: YunzaiEvent
  constructor(public init: any) {}
  reply(msg: any, quote?: boolean, data?: any) {
    return this.e?.reply(msg, quote, data)
  }
}) as any

export class LLMManage extends BasePlugin {
  constructor() {
    super({
      name: 'LLM插件管理',
      dsc: 'LLM 插件参数管理与状态查询',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#(llm|ai|chat)(帮助|help)$',
          fnc: 'help'
        },
        {
          reg: '^#(llm|ai|chat)(状态|status|info)$',
          fnc: 'status'
        },
        {
          reg: '^#(llm|chat|ai)(重置|清除记忆|清空记忆|reset)$',
          fnc: 'clearMemory'
        },
        {
          reg: '^#llm切换模型\\s*(.+)$',
          fnc: 'switchModel',
          permission: 'master'
        },
        {
          reg: '^#llm设置提示词\\s*([\\s\\S]+)$',
          fnc: 'setSystemPrompt',
          permission: 'master'
        }
      ]
    })
  }

  async help(): Promise<boolean> {
    const e = this.e as YunzaiEvent
    const msg = [
      '🤖 === Yunzai-LLM-Plugin 帮助指南 (TS版) === 🤖',
      '',
      '【常用指令】',
      '• #chat <问题>  : 与 AI 进行对话 (支持多轮记忆)',
      '• #ai <问题>    : 简写指令',
      '• @机器人 <内容> : 群聊中直接艾特提问',
      '• #清除记忆     : 清除当前会话的上下文记忆',
      '• #llm状态      : 查看当前模型与插件配置',
      '',
      '【主人管理指令】',
      '• #llm切换模型 <模型名> : 实时切换使用的模型',
      '• #llm设置提示词 <人设> : 实时修改 AI 人设提示词',
      '',
      '配置文件路径: plugins/Yunzai-LLM-Plugin/config/config.yaml'
    ].join('\n')

    await e.reply(msg, true)
    return true
  }

  async status(): Promise<boolean> {
    const e = this.e as YunzaiEvent
    const cfg = configManager.get()
    const history = memoryManager.getMessages(e)
    const key = memoryManager.getSessionKey(e)

    const maskedKey = cfg.apiKey
      ? cfg.apiKey.slice(0, 7) + '****' + cfg.apiKey.slice(-4)
      : '未配置'

    const msg = [
      '📊 === Yunzai-LLM-Plugin 运行状态 === 📊',
      `• 当前模型: ${cfg.model || '未设定'}`,
      `• API 端点: ${cfg.apiUrl || '未设定'}`,
      `• API 密钥: ${maskedKey}`,
      `• 生成温度: ${cfg.temperature ?? 0.7}`,
      `• 最大Token: ${cfg.maxTokens ?? 2048}`,
      `• 会话标识: ${key}`,
      `• 当前会话记忆: 已缓存 ${history.length} 条对话`,
      `• 上下文轮数上限: ${cfg.historyLimit} 轮`
    ].join('\n')

    await e.reply(msg, true)
    return true
  }

  async clearMemory(): Promise<boolean> {
    const e = this.e as YunzaiEvent
    const cleared = memoryManager.clearSession(e)
    if (cleared) {
      await e.reply('✨ 当前会话的上下文记忆已清空，开启全新的对话吧！', true)
    } else {
      await e.reply('当前会话暂无上下文记忆，无需清空。', true)
    }
    return true
  }

  async switchModel(): Promise<boolean> {
    const e = this.e as YunzaiEvent
    const match = (e.msg || '').match(/^#llm切换模型\s*(.+)$/)
    const newModel = match?.[1]?.trim()
    if (!newModel) {
      await e.reply('请指定模型名称，例如：#llm切换模型 deepseek-chat', true)
      return true
    }

    configManager.set('model', newModel)
    await e.reply(`✅ 已成功切换当前模型为：${newModel}`, true)
    return true
  }

  async setSystemPrompt(): Promise<boolean> {
    const e = this.e as YunzaiEvent
    const match = (e.msg || '').match(/^#llm设置提示词\s*([\s\S]+)$/)
    const prompt = match?.[1]?.trim()
    if (!prompt) {
      await e.reply('请提供提示词内容', true)
      return true
    }

    configManager.set('systemPrompt', prompt)
    memoryManager.clearSession(e)
    await e.reply('✅ 系统提示词已更新，并已重置当前对话记忆！', true)
    return true
  }
}
