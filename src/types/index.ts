/**
 * Yunzai 全局对象类型声明
 */
declare global {
  const plugin: typeof import('./plugin.js').PluginBase
  const logger: {
    info(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
    mark(...args: any[]): void
    debug(...args: any[]): void
    red(str: string): string
    green(str: string): string
    yellow(str: string): string
    blue(str: string): string
    cyan(str: string): string
    magenta(str: string): string
  }
  const Bot: Record<string, any>
}

export interface PluginConfig {
  apiUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  temperature: number
  maxTokens: number
  timeout: number
  prefix: string[]
  atReply: boolean
  replyQuote: boolean
  historyLimit: number
  historyTimeout: number
  isolateUserInGroup: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SessionState {
  lastTime: number
  messages: ChatMessage[]
}

export interface YunzaiRule {
  reg: string | RegExp
  fnc: string
  permission?: 'master' | 'admin' | 'all'
  event?: string
}

export interface YunzaiPluginInit {
  name: string
  dsc?: string
  event?: string
  priority?: number
  rule?: YunzaiRule[]
}

export interface YunzaiEvent {
  msg?: string
  raw_message?: string
  user_id?: string | number
  group_id?: string | number
  isGroup?: boolean
  atBot?: boolean
  atme?: boolean
  at?: string | number
  self_id?: string | number
  sender?: {
    user_id?: string | number
    nickname?: string
    card?: string
  }
  reply(msg: any, quote?: boolean, data?: any): Promise<any>
}
