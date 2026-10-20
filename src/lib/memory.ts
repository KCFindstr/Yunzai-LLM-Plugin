import configManager from './config.js'
import type { ChatMessage, SessionState, YunzaiEvent } from '../types/index.js'

class MemoryManager {
  private sessions = new Map<string, SessionState>()

  getSessionKey(e: YunzaiEvent): string {
    const cfg = configManager.get()
    const isGroup = Boolean(e.group_id || e.isGroup)
    const userId = String(e.user_id || e.sender?.user_id)
    const groupId = String(e.group_id)

    if (isGroup) {
      if (cfg.isolateUserInGroup) {
        return `group:${groupId}:user:${userId}`
      }
      return `group:${groupId}:common`
    }
    return `private:${userId}`
  }

  getMessages(e: YunzaiEvent): ChatMessage[] {
    const cfg = configManager.get()
    if (!cfg.historyLimit || cfg.historyLimit <= 0) {
      return []
    }

    const key = this.getSessionKey(e)
    const session = this.sessions.get(key)
    if (!session) return []

    // 检查超时
    const timeoutMs = (cfg.historyTimeout || 30) * 60 * 1000
    if (Date.now() - session.lastTime > timeoutMs) {
      this.sessions.delete(key)
      return []
    }

    return session.messages
  }

  addMessage(e: YunzaiEvent, role: 'user' | 'assistant', content: string): void {
    const cfg = configManager.get()
    if (!cfg.historyLimit || cfg.historyLimit <= 0) return

    const key = this.getSessionKey(e)
    let session = this.sessions.get(key)
    if (!session) {
      session = { lastTime: Date.now(), messages: [] }
      this.sessions.set(key, session)
    }

    session.lastTime = Date.now()
    session.messages.push({ role, content })

    // 保留最近 historyLimit * 2 条 (一问一答为 2 条)
    const maxMessages = cfg.historyLimit * 2
    if (session.messages.length > maxMessages) {
      session.messages = session.messages.slice(-maxMessages)
    }
  }

  clearSession(e: YunzaiEvent): boolean {
    const key = this.getSessionKey(e)
    return this.sessions.delete(key)
  }

  clearAll(): void {
    this.sessions.clear()
  }
}

export default new MemoryManager()
