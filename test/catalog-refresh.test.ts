import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { setLoaderForTest } from '../src/core/yunzai.ts'
import { catalogVersion, ensureCatalog, formatCommandCatalog, promptEntries, searchCommands } from '../src/commands/catalog.ts'
import { registerCommandTools } from '../src/commands/tools.ts'
import { registry } from '../src/tools/registry.ts'
import { buildSystemPrompt } from '../src/chat/prompt.ts'

it('refreshes command discovery after plugins are removed and added without advertising disabled games', async () => {
  const loader: any = { priority: [{ name: 'game', plugin: { rule: [{ reg: /^#深渊$/, fnc: 'abyss' }] } }] }
  setLoaderForTest(loader)
  config.set('tools.botCommand.hints', [{ cmd: '#深渊', desc: '原神深渊' }, { cmd: '#ping', desc: '连接检查' }, { cmd: '#pong', desc: '新功能' }])
  await ensureCatalog()
  assert.ok(promptEntries(50).some(entry => entry.cmd === '#深渊'))
  const version = catalogVersion
  await ensureCatalog()
  assert.equal(catalogVersion, version, 'unchanged live rules do not rescan help files')

  loader.priority = [{ name: 'health', plugin: { rule: [{ reg: /^#ping$/, fnc: 'ping' }] } }]
  registerCommandTools()
  const found = await registry.get('search_bot_commands')!.run({ query: '连接检查' }, {} as any)
  assert.match(String(found), /#ping/)
  assert.equal(searchCommands('深渊').length, 0)
  assert.equal(promptEntries(50).some(entry => entry.cmd === '#深渊'), false)
  assert.doesNotMatch(formatCommandCatalog(), /深渊|星穹铁道|绝区零/)
  const prompt = buildSystemPrompt({ isGroup: true, botName: 'B', eff: config.effective(), tools: ['run_bot_command', 'search_bot_commands', 'list_bot_commands'], nativeSearch: false, markdown: false })
  assert.match(prompt, /#ping/)
  assert.doesNotMatch(prompt, /#深渊|\*体力|\*火花面板|\*忘却之庭|别名库/)
  assert.match(prompt, /不猜指令/)

  loader.priority.push({ name: 'new', plugin: { rule: [{ reg: /^#pong$/, fnc: 'pong' }] } })
  const listed = await registry.get('list_bot_commands')!.run({}, {} as any)
  assert.match(String(listed), /#pong/)
  assert.match(String(listed), /#ping/)
})
