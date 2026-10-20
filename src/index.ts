import { LLMAdmin } from './apps/admin.ts'
import { LLMChat } from './apps/chat.ts'
import { startPriceRefresh } from './billing/pricing.ts'
import { scanCatalog } from './commands/catalog.ts'
import { registerCommandTools } from './commands/tools.ts'
import { config } from './core/config.ts'
import { log } from './core/log.ts'
import { flushAllStores } from './core/store.ts'
import { ownClasses } from './core/yunzai.ts'
import { loadCustomTools } from './tools/custom.ts'
import { loadSkills, registerSkillTool } from './tools/skills.ts'
import { registerWebTools } from './tools/web.ts'
import { registerMemoryTool } from './memory/tool.ts'

ownClasses.add(LLMChat)
ownClasses.add(LLMAdmin)

const STARTED = Symbol.for('yunzai-llm-plugin.started')

function startup() {
  if ((globalThis as any)[STARTED]) return
  ;(globalThis as any)[STARTED] = true

  config.watch()
  registerWebTools()
  registerCommandTools()
  registerSkillTool()
  registerMemoryTool()
  loadSkills()
  loadCustomTools().catch(err => log.warn('加载自定义工具失败', err))
  startPriceRefresh()

  const B = globalThis.Bot
  const scan = () => setTimeout(() => scanCatalog().catch(err => log.warn('扫描指令失败', err)), 3000)
  if (B?.stat?.online === 2) scan()
  else B?.once?.('online', scan)
  B?.once?.('exit', () => flushAllStores())
  process.once('exit', () => flushAllStores())

  const c = config.get()
  const def = config.defaultModelId()
  log.mark(
    `Yunzai-LLM-Plugin v2 已加载：${c.models.length} 个模型，默认 ${def || '未配置'}${config.hasKey(config.getProvider(config.getModel(def)?.provider ?? '')) ? '' : '（未配置 API Key，发送 #llm帮助 查看配置方法）'}`,
  )
}

startup()

export const apps = { chat: LLMChat, admin: LLMAdmin }
export { LLMAdmin, LLMChat }
