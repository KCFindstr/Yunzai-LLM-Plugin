import { registerImageTools } from './tools/images.ts'
import { LLMAdmin } from './apps/admin.ts'
import { LLMChat } from './apps/chat.ts'
import { startPriceRefresh } from './billing/pricing.ts'
import { scanCatalog } from './commands/catalog.ts'
import { registerCommandTools } from './commands/tools.ts'
import { config } from './core/config.ts'
import { log } from './core/log.ts'
import { finishLayoutMigration } from './core/layout.ts'
import { flushAllStores } from './core/store.ts'
import { ownClasses } from './core/yunzai.ts'
import { loadCustomTools } from './tools/custom.ts'
import { loadSkills, registerSkillTool } from './tools/skills.ts'
import { registerWebTools } from './tools/web.ts'
import { registerSendImageTool } from './tools/sendImage.ts'
import { registerMemoryTool } from './memory/tool.ts'
import { registerStickerTools } from './stickers/tool.ts'
import { registerRenderTool } from './tools/render.ts'
import { registerExecTool, stopKeepalive } from './tools/exec.ts'
import { closeOwnBrowser } from './render/browser.ts'
import { registerComputerTool, computerQueue } from './tools/computer.ts'
import { registerGoogleLensTool } from './tools/googleLens.ts'
import { registerAgyTool, agyQueue } from './tools/agy.ts'
import { refreshComputerKeepalive, stopComputerKeepalive } from './computer/keepalive.ts'
import { startWeb, stopWeb } from './web/server.ts'
import { startArchiveJobs, stopArchiveJobs } from './chat/archiveJobs.ts'

ownClasses.add(LLMChat)
ownClasses.add(LLMAdmin)

const STARTED = Symbol.for('yunzai-llm-plugin.started')

function startup() {
  if ((globalThis as any)[STARTED]) return
  ;(globalThis as any)[STARTED] = true

  config.watch()
  finishLayoutMigration().catch(err => log.warn(`目录迁移收尾失败: ${err?.message ?? err}`))
  registerWebTools()
  registerSendImageTool()
  registerCommandTools()
  registerSkillTool()
  registerMemoryTool()
  registerStickerTools()
  registerRenderTool()
  registerExecTool()
  registerImageTools()
  registerComputerTool()
  registerAgyTool()
  registerGoogleLensTool()
  refreshComputerKeepalive()
  config.onChange(refreshComputerKeepalive)
  loadSkills()
  loadCustomTools().catch(err => log.warn('加载自定义工具失败', err))
  startPriceRefresh()
  // group chatter summaries and daily digests, independent of anyone talking to the bot
  startArchiveJobs()
  try {
    startWeb()
  } catch (err: any) {
    log.error('启动网页管理面板失败', err)
  }
  // host/port/enable edits apply without a restart
  config.onChange(() => startWeb())

  const B = globalThis.Bot
  const scan = () => setTimeout(() => scanCatalog().catch(err => log.warn('扫描指令失败', err)), 3000)
  if (B?.stat?.online === 2) scan()
  else B?.once?.('online', scan)
  B?.once?.('exit', () => {
    computerQueue.stop()
    agyQueue.stop()
    stopArchiveJobs()
    stopWeb()
    stopComputerKeepalive()
    flushAllStores()
    stopKeepalive()
    return closeOwnBrowser()
  })
  process.once('exit', () => {
    computerQueue.stop()
    agyQueue.stop()
    stopArchiveJobs()
    stopComputerKeepalive()
    flushAllStores()
    stopKeepalive()
  })

  const c = config.get()
  const def = config.defaultModelId()
  log.mark(
    `Yunzai-LLM-Plugin v2 已加载：${c.models.length} 个模型，默认 ${def || '未配置'}${config.hasKey(config.getProvider(config.getModel(def)?.provider ?? '')) ? '' : '（未配置 API Key，发送 #llm帮助 查看配置方法）'}`,
  )
}

startup()

export const apps = { chat: LLMChat, admin: LLMAdmin }
export { LLMAdmin, LLMChat }
