import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = process.env.YZ_LLM_SKILLS_DIR || path.join(root, 'skills')
const dataDir = process.env.YZ_LLM_DATA_DIR || path.join(root, 'data')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yzllm-initial-request-'))
// Without a config.yaml, run against a temp copy of the defaults so the real config dir is never written
let configDir = process.env.YZ_LLM_CONFIG_DIR || path.join(root, 'config')
if (!fs.existsSync(path.join(configDir, 'config.yaml'))) {
  configDir = path.join(temp, 'config')
  fs.mkdirSync(configDir)
  fs.copyFileSync(path.join(root, 'config', 'default_config.yaml'), path.join(configDir, 'default_config.yaml'))
}
process.env.YZ_LLM_PLUGIN_DIR = root
process.env.YZ_LLM_CONFIG_DIR = configDir
process.env.YZ_LLM_SKILLS_DIR = skillsDir
process.env.YZ_LLM_DATA_DIR = temp
process.env.YZ_LLM_TOOLS_DIR = path.join(temp, 'tools')
process.env.YZ_LLM_QUIET = '1'

try {
  const stickerIndex = path.join(dataDir, 'stickers', 'index.json')
  if (fs.existsSync(stickerIndex)) {
    const items = JSON.parse(fs.readFileSync(stickerIndex, 'utf8')).items.map(({ id, name, desc, use, indexed }) => ({ id, name, desc, use, indexed }))
    fs.mkdirSync(path.join(temp, 'stickers'), { recursive: true })
    fs.writeFileSync(path.join(temp, 'stickers', 'index.json'), JSON.stringify({ v: 1, items }))
  }
  const { config } = await import('../src/core/config.ts')
  const { registry } = await import('../src/tools/registry.ts')
  const { setLoaderForTest } = await import('../src/core/yunzai.ts')
  const { registerCommandTools } = await import('../src/commands/tools.ts')
  const { registerWebTools } = await import('../src/tools/web.ts')
  const { registerSendImageTool } = await import('../src/tools/sendImage.ts')
  const { registerSkillTool, loadSkills } = await import('../src/tools/skills.ts')
  const { registerMemoryTool } = await import('../src/memory/tool.ts')
  const { registerStickerTools } = await import('../src/stickers/tool.ts')
  const { registerRenderTool } = await import('../src/tools/render.ts')
  const { registerExecTool } = await import('../src/tools/exec.ts')
  const { registerAgyTool } = await import('../src/tools/agy.ts')
  const { registerGoogleLensTool } = await import('../src/tools/googleLens.ts')
  const { registerComputerTool } = await import('../src/tools/computer.ts')
  const { loadCustomTools } = await import('../src/tools/custom.ts')
  const { buildSystemPrompt, buildHeader, buildMemoryBlock } = await import('../src/chat/prompt.ts')
  const { markdownEnabled } = await import('../src/chat/format.ts')
  const { recordGroupMessage } = await import('../src/chat/groupLog.ts')
  const { addMemory } = await import('../src/memory/store.ts')
  const { scanCatalog } = await import('../src/commands/catalog.ts')
  setLoaderForTest({ priority: [] })
  for (const register of [registerCommandTools, registerWebTools, registerSendImageTool, registerSkillTool, registerMemoryTool, registerStickerTools, registerRenderTool, registerExecTool, registerComputerTool, registerAgyTool, registerGoogleLensTool]) register()
  loadSkills()
  await loadCustomTools()
  await scanCatalog()

  const groupId = process.argv.find(argument => argument.startsWith('--group='))?.slice(8) || '2'
  const isAdmin = process.argv.includes('--admin')
  const eff = config.effective(groupId)
  const model = config.getModel(eff.model)
  if (!model) throw new Error('No configured model for the example')
  const provider = config.getProvider(model.provider)
  const botName = config.get().persona.botName || '天津风'
  const event = {
    self_id: 100000000, user_id: 1001, group_id: groupId, group_name: '示例群',
    message_id: 'example-initial', message_type: 'group', adapter_name: 'OneBotv11',
    sender: { nickname: '岛风', card: '岛风' }, isMaster: isAdmin,
    message: [{ type: 'at', qq: 100000000 }, { type: 'text', text: '截一下你的桌面给我看看' }],
  }
  recordGroupMessage({ ...event, user_id: 1002, message_id: 'example-earlier', sender: { nickname: '雪风' }, message: [{ type: 'text', text: '周六一起看猫吧' }] })
  recordGroupMessage(event)
  addMemory('user', '1001', '喜欢被叫岛风')
  addMemory('group', groupId, '群友约好周六一起看猫')
  const input = { text: '[at:you] 截一下你的桌面给我看看', images: [], imageSegments: [] }
  const ctx = { e: event, eff, model, isAdmin, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
  const { prepareRuntimeTools } = await import('../src/core/setup.ts')
  if (model.toolUse !== false) await prepareRuntimeTools(eff, undefined, isAdmin)
  const offered = model.toolUse === false ? [] : registry.forTurn(ctx)
  const tools = registry.specs(offered, ctx)
  const shared = eff.chat.sessionScope === 'group'
  const memoryEnabled = config.get().memory.enable
  const nudge = offered.some(tool => tool.name === 'memory')
  const memoryPrefix = memoryEnabled ? buildMemoryBlock(event, { user: !shared, group: true, nudge }) : ''
  const turnMemory = memoryEnabled && shared ? buildMemoryBlock(event, { user: true, group: false, nudge }) : ''
  const nativeSearch = Boolean(eff.tools.enable && eff.tools.webSearch.enable && eff.tools.webSearch.provider === 'native' && ['anthropic', 'openai-responses', 'gemini'].includes(provider?.type) && model.nativeSearch !== false)
  const header = buildHeader(event, eff, input, isAdmin, { conv: 'example', memory: turnMemory })
  const system = buildSystemPrompt({ isGroup: true, botName, eff, tools: offered.map(tool => tool.name), nativeSearch, markdown: markdownEnabled(event, eff.reply) })
  const messages = []
  if (memoryPrefix) messages.push({ role: 'user', content: [{ type: 'text', text: memoryPrefix }] })
  messages.push(
    { role: 'user', content: [{ type: 'text', text: '【之前对话的摘要】\n岛风问过桌面是否会保留文件，已说明它是独立的持久角色PC。' }] },
    { role: 'user', content: [{ type: 'text', text: '【私有示例历史｜发言人 岛风(平台ID 1001)】\n你的电脑叫什么？' }] },
    { role: 'assistant', content: '叫 Amatsukaze 喵！' },
    { role: 'user', content: [{ type: 'text', text: header.sent + input.text }] },
  )
  const snapshot = {
    context: {
      source: 'Current effective configuration and production prompt/tool builders; synthetic conversation; no LLM call',
      groupId, isAdmin, providerType: provider?.type,
      sessionScope: eff.chat.sessionScope, markdown: markdownEnabled(event, eff.reply),
      overrides: ['Synthetic names, group name, memory, summary and history; isolated data directory', 'No live PluginsLoader: no verified third-party command entries', 'Custom JavaScript modules are not executed; configured HTTP tool schemas are included', 'Transport endpoints, authentication and provider-only configuration are excluded'],
    },
    initial: {
      model: { id: model.id, model: model.model },
      system, messages, tools, nativeSearch,
      maxTokens: model.maxTokens ?? eff.chat.maxOutputTokens,
      temperature: model.temperature ?? eff.chat.temperature,
      thinkingSetting: model.thinking ?? eff.chat.thinking,
    },
  }
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n')
} finally {
  const { flushAllStores } = await import('../src/core/store.ts')
  flushAllStores()
  const resolved = fs.realpathSync(temp)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('yzllm-initial-request-')) throw new Error('Unexpected temporary directory')
  fs.rmSync(resolved, { recursive: true, force: true })
}
