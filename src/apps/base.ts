/** Yunzai's global `plugin` base class, or a stand-in for tests. */
export const BasePlugin: any =
  globalThis.plugin ??
  class {
    e: any
    name: string
    rule: any[]
    priority: number
    constructor(init: any) {
      this.name = init.name
      this.rule = init.rule ?? []
      this.priority = init.priority ?? 5000
      Object.assign(this, init)
    }
    reply(msg: any, quote?: boolean, data?: any) {
      return this.e?.reply?.(msg, quote, data)
    }
    setContext() {}
    finish() {}
    addCleanup() {}
  }
