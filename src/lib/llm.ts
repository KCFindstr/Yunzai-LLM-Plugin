import configManager from './config.js'
import memoryManager from './memory.js'
import type { ChatMessage, YunzaiEvent } from '../types/index.js'

export async function askLLM(e: YunzaiEvent, query: string): Promise<string> {
  const cfg = configManager.get()

  if (!cfg.apiKey || cfg.apiKey.includes('your-api-key')) {
    return '【提示】未配置有效 API Key！请管理员前往 plugins/Yunzai-LLM-Plugin/config/config.yaml 中配置 apiKey。'
  }

  const endpoint = (cfg.apiUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const url = `${endpoint}/chat/completions`

  // 构建消息数组
  const history = memoryManager.getMessages(e)
  const messages: ChatMessage[] = []

  if (cfg.systemPrompt) {
    messages.push({
      role: 'system',
      content: cfg.systemPrompt
    })
  }

  messages.push(...history)
  messages.push({
    role: 'user',
    content: query
  })

  const payload = {
    model: cfg.model || 'deepseek-chat',
    messages,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.7,
    max_tokens: cfg.maxTokens || 2048
  }

  const timeoutMs = (cfg.timeout || 60) * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey.trim()}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    clearTimeout(timer)

    if (!response.ok) {
      const errText = await response.text()
      if (typeof logger !== 'undefined') {
        logger.error(`[Yunzai-LLM-Plugin] API 请求失败 [HTTP ${response.status}]: ${errText}`)
      }
      let detail = errText
      try {
        const parsed = JSON.parse(errText)
        if (parsed.error?.message) detail = parsed.error.message
      } catch {}
      return `【LLM 请求出错】HTTP ${response.status}: ${detail}`
    }

    const data: any = await response.json()
    const replyContent = data.choices?.[0]?.message?.content?.trim()

    if (!replyContent) {
      return '【LLM 提示】大模型返回了空回复，请重试。'
    }

    // 记录到多轮对话记忆中
    memoryManager.addMessage(e, 'user', query)
    memoryManager.addMessage(e, 'assistant', replyContent)

    return replyContent
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return `【LLM 请求超时】请求超过了 ${cfg.timeout || 60} 秒，请检查网络连接或稍后重试。`
    }
    if (typeof logger !== 'undefined') {
      logger.error(`[Yunzai-LLM-Plugin] 调用异常: ${err.message}`)
    }
    return `【LLM 发生异常】${err.message}`
  }
}
