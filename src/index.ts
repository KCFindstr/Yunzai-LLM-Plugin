import { LLMChat } from './apps/chat.js'
import { LLMManage } from './apps/manage.js'

if (typeof logger !== 'undefined') {
  logger.info('-----------------')
  logger.info('[Yunzai-LLM-Plugin] (TypeScript) v1.0.0 初始化成功！')
  logger.info('-----------------')
}

export const apps = {
  chat: LLMChat,
  manage: LLMManage
}

export { LLMChat, LLMManage }
