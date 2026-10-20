import type { YunzaiPluginInit, YunzaiEvent } from './index.js'

export class PluginBase {
  e!: YunzaiEvent

  constructor(public init: YunzaiPluginInit) {}

  reply(msg: any, quote?: boolean, data?: any): Promise<any> {
    return this.e.reply(msg, quote, data)
  }
}
