import configManager from './config.js'

class MemoryManager {
  constructor() {
    // key => { lastTime: number, messages: Array<{ role: string, content: string }> }
    this.sessions = new Map()
  }

  getSessionKey(e) {
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

  getMessages(e) {
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

  addMessage(e, role, content) {
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

  clearSession(e) {
    const key = this.getSessionKey(e)
    return this.sessions.delete(key)
  }

  clearAll() {
    this.sessions.clear()
  }
}

export default new MemoryManager()
