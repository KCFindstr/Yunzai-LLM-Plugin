import { fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

const srvReplies: any[] = []
const srvStatus: number[] = []
const srv = await mockServer((_req, n) => [srvStatus[n - 1] ?? 200, srvReplies[n - 1] ?? textReply('（没有更多预设回复）')])

function textReply(text: string, cost = 0.001) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost } }
}
function toolReply(name: string, args: any) {
  return {
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
  }
}

writeUserConfig(`
providers:
  mock: { type: openai, baseUrl: '${srv.url}', apiKey: test-key, maxRetries: 0 }
  mockgem: { type: gemini, baseUrl: '${srv.url}', apiKey: test-key, maxRetries: 0 }
models:
  - id: main
    provider: mock
    model: mock-model
    pricing: { input: 1, output: 2 }
  - id: tiny
    provider: mock
    model: mock-tiny
    pricing: { input: 1, output: 2 }
    quota: { window5h: 0.0015 }
  - id: gem
    provider: mockgem
    model: gem-model
    pricing: { input: 1, output: 2 }
defaultModel: main
fallbackModels: []
chat: { summarize: false, groupContext: 3 }
reply:
  quote: never
  typing: { charsPerSecond: 1000, minDelay: 0, maxDelay: 0 }
  groupRate: { count: 100, perSeconds: 60 }
trigger: { userCooldown: 0 }
sticker: { enable: false }
tools:
  webSearch: { enable: false }
`)

const { setLoaderForTest, ownClasses } = await import('../src/core/yunzai.ts')
const { LLMChat } = await import('../src/apps/chat.ts')
const { registerCommandTools } = await import('../src/commands/tools.ts')
const { scanCatalog, catalogEntries, matchRule, concretize, scrapeHelpText, promptEntries, formatCommandCatalog, searchCommands } = await import('../src/commands/catalog.ts')
const { recordGroupMessage } = await import('../src/chat/groupLog.ts')
const { config } = await import('../src/core/config.ts')

// ---- fake PluginsLoader with a few "game plugin" rules ----
class Genshin {}
class StarRail {}
class CatchAll {}
class Admin {}
const dealt: any[] = []
const loader: any = {
  srReg: /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/,
  zzzReg: /^#?(%|％|绝区零|绝区)+/,
  groupCD: {},
  singleCD: {},
  msgThrottle: {},
  dealText: (t: string) => t.replace(/^\s*[＃井]\s*/, '#').trim(),
  filtEvent: (e: any, v: any) => !v.event || v.event === 'message' || v.event === `message.${e.message_type}`,
  priority: [
    { class: Admin, name: '系统', plugin: { event: 'message', rule: [{ reg: /^#重启$/, fnc: 'restart', permission: 'master' }] } },
    { class: Genshin, name: '原神战绩', plugin: { event: 'message', rule: [{ reg: /^#?(上期)?深渊$/, fnc: 'abyss' }, { reg: /^#?(.+)面板$/, fnc: 'panel' }] } },
    { class: StarRail, name: '星铁战绩', plugin: { event: 'message', rule: [{ reg: /^#星铁(忘却之庭|混沌回忆)$/, fnc: 'moc' }] } },
    { class: CatchAll, name: '复读', plugin: { event: 'message', rule: [{ reg: /.*/, fnc: 'echo' }] } },
    { class: LLMChat, name: 'LLM对话', plugin: new LLMChat() },
  ],
  async deal(e: any) {
    dealt.push(e)
    // simulate what the real loader would do for a matched command: the plugin replies via e.reply
    const text = e.message.filter((s: any) => s.type === 'text').map((s: any) => s.text).join('')
    await e.reply(`[插件结果] ${text}`)
  },
}
ownClasses.add(LLMChat)
setLoaderForTest(loader, { getGroup: () => ({}) })
registerCommandTools()

async function trigger(over: Record<string, any> = {}) {
  const { e, sent } = fakeEvent(over)
  const p = new LLMChat()
  Object.assign(p, { e })
  const handled = await p.onMessage()
  return { handled, sent, e }
}

describe('command catalog', () => {
  before(async () => {
    await scanCatalog()
  })

  it('validates presets against live rules (incl. * prefix normalisation) and ignores catch-alls', () => {
    const byCmd = new Map(catalogEntries().map(c => [c.cmd, c]))
    assert.equal(byCmd.get('#深渊')?.verified, true)
    assert.equal(byCmd.get('#上期深渊')?.verified, true)
    assert.equal(byCmd.get('*忘却之庭')?.verified, true, '* -> #星铁 normalisation')
    assert.equal(byCmd.get('#{角色}面板')?.verified, true)
    assert.equal(byCmd.get('#体力')?.verified, false, 'catch-all rule must not verify')
  })

  it('matchRule skips our own and catch-all rules', async () => {
    assert.equal((await matchRule('#深渊'))?.plugin, '原神战绩')
    assert.equal(await matchRule('随便说点什么'), undefined)
    assert.equal((await matchRule('#重启'))?.permission, 'master')
  })

  it('scrapes miao-style help files and concretizes placeholders', () => {
    const js = `export const helpList = [{ group: '查询', list: [
      { icon: 1, title: '#深渊 / #上期深渊', desc: '深境螺旋数据' },
      { icon: 2, title: "#角色名+面板", desc: "查看角色面板" } ] }]`
    assert.deepEqual(scrapeHelpText('help-cfg.js', js), [
      { cmd: '#深渊', desc: '深境螺旋数据' },
      { cmd: '#上期深渊', desc: '深境螺旋数据' },
      { cmd: '#角色名+面板', desc: '查看角色面板' },
    ])
    assert.equal(concretize('#角色名+面板'), '#刻晴面板')
    assert.equal(concretize('#角色'), '#角色', 'bare #角色 is a real command')
    assert.equal(concretize('#【角色名】天赋'), '#刻晴天赋')
    assert.deepEqual(scrapeHelpText('help.yaml', 'list:\n  - title: "%体力"\n    desc: 电量'), [{ cmd: '%体力', desc: '电量' }])
    assert.deepEqual(
      scrapeHelpText('help.js', `{ title: '#五星 #武器', desc: '角色数据' }, { title: '*跃迁分析(角色/光锥)', desc: '抽卡分析' }`).map(x => x.cmd),
      ['#五星', '#武器', '*跃迁分析(角色/光锥)'],
    )
  })

  it('prompt list covers every game even with a small limit and hides synonyms', () => {
    const cmds = promptEntries(3).map(c => c.cmd)
    assert.equal(cmds.length, 3)
    assert.ok(cmds.includes('#深渊') || cmds.some(c => c.startsWith('#')), String(cmds))
    assert.ok(cmds.some(c => c.startsWith('*')), `星铁 entry expected in ${cmds}`)
    assert.ok(!promptEntries(100).some(c => c.cmd === '*混沌回忆'), 'hidden synonym not listed')
  })

  it('formatCommandCatalog returns full categorized list and supports filtering', () => {
    const full = formatCommandCatalog()
    assert.ok(full.includes('机器人已安装指令列表'))
    assert.ok(full.includes('星穹铁道'))
    assert.ok(full.includes('原神'))

    const srOnly = formatCommandCatalog({ game: 'sr' })
    assert.ok(srOnly.includes('星穹铁道'))
  })

  it('searchCommands matches role queries and rule candidates', () => {
    const hits1 = searchCommands('火花面板')
    assert.ok(hits1.length > 0)
    assert.ok(hits1.some(h => h.includes('面板') || h.includes('火花')))

    const all = searchCommands('all')
    assert.ok(all[0].includes('机器人已安装指令列表'))
  })
})

describe('chat flow', () => {
  beforeEach(() => {
    dealt.length = 0
    srv.requests.length = 0
    srvReplies.length = 0
    srvStatus.length = 0
  })
  after(() => srv.close())

  it('ignores messages that do not @ the bot (no LLM call)', async () => {
    const { handled, sent } = await trigger({ atBot: false, message: [{ type: 'text', text: '帮我查查深渊' }] })
    assert.equal(handled, false)
    assert.equal(sent.length, 0)
    assert.equal(srv.requests.length, 0)
  })

  it('ignores synthesized command events', async () => {
    const { handled } = await trigger({ llmDispatched: true })
    assert.equal(handled, false)
    assert.equal(srv.requests.length, 0)
  })

  it('replies to @ with model text and keeps the system prompt stable across turns', async () => {
    srvReplies.push(textReply('你好呀~'), textReply('我记得你'))
    recordGroupMessage({ self_id: 10000, group_id: 30001, user_id: 555, sender: { card: '路人' }, message: [{ type: 'text', text: '今天好热' }], message_id: 'x0' })
    const r1 = await trigger({ message_id: 'a1' })
    assert.equal(r1.handled, true)
    assert.deepEqual(r1.sent.map(s => s.msg), ['你好呀~'])
    const r2 = await trigger({ message_id: 'a2', message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '还记得我吗' }] })
    assert.deepEqual(r2.sent.map(s => s.msg), ['我记得你'])

    const [q1, q2] = srv.requests.map(r => r.body)
    assert.equal(q1.messages[0].content, q2.messages[0].content, 'system prompt byte-identical')
    assert.doesNotMatch(q1.messages[0].content, /\d{4}-\d{2}-\d{2}/, 'no timestamp in system prompt')
    assert.match(q1.messages[0].content, /#深渊/, 'verified commands listed in prompt')
    assert.doesNotMatch(q1.messages[0].content, /#体力 —/, 'unverified commands not listed')
    assert.match(q1.messages[1].content, /路人: 今天好热/, 'ambient group chat in the user turn')
    assert.equal(q2.messages.length, 4, 'system + previous user + previous assistant + new user')
    assert.equal(q2.messages[2].content, '你好呀~')
    assert.doesNotMatch(q2.messages[1].content, /今天好热/, 'ambient chat not persisted into history')
  })

  it('turns natural language into an existing command and stops without extra text', async () => {
    srvReplies.push(toolReply('run_bot_command', { command: '#深渊' }))
    const groupSent: any[] = []
    const group = { sendMsg: async (m: any) => groupSent.push(m) }
    const { sent, e } = await trigger({ group, message_id: 'b1', user_id: 20002, message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '帮我查查深渊数据' }] })
    assert.equal(srv.requests.length, 1, 'no second LLM call after dispatch')
    assert.equal(dealt.length, 1)
    const e2 = dealt[0]
    assert.equal(e2.llmDispatched, true)
    assert.equal(e2.user_id, e.user_id, 'same user -> same permissions')
    assert.equal(e2.raw_message, '#深渊')
    assert.deepEqual(e2.message, [{ type: 'at', qq: 10000 }, { type: 'text', text: '#深渊' }])
    assert.deepEqual(sent.map(s => s.msg), [], 'LLM itself sends nothing')
    assert.deepEqual(groupSent, ['[插件结果] #深渊'], 'plugin result went through the group sender')
    assert.equal(e2.group, group, 'group object carried over to the synthesized event')
  })

  it('refuses master commands and unknown commands, then answers normally', async () => {
    srvReplies.push(toolReply('run_bot_command', { command: '#重启' }), textReply('这个我做不到哦'))
    const { sent } = await trigger({ message_id: 'c1', user_id: 20003, message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '重启一下机器人' }] })
    assert.equal(dealt.length, 0)
    const toolMsg = srv.requests[1].body.messages.at(-1)
    assert.equal(toolMsg.role, 'tool')
    assert.match(toolMsg.content, /不允许|主人指令/)
    assert.deepEqual(sent.map(s => s.msg), ['这个我做不到哦'])
  })

  it('drops a parameter the endpoint rejects (400) and retries once', async () => {
    srvReplies.push({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }, textReply('好的'))
    srvStatus.push(400, 200)
    const { sent } = await trigger({ message_id: 'e1', user_id: 20005 })
    assert.deepEqual(sent.map(s => s.msg), ['好的'])
    assert.equal(srv.requests[0].body.reasoning_effort, 'low')
    assert.equal(srv.requests[1].body.reasoning_effort, undefined)
    srvReplies.push(textReply('第二次'))
    await trigger({ message_id: 'e2', user_id: 20005 })
    assert.equal(srv.requests[2].body.reasoning_effort, undefined, 'remembered for later turns')
  })

  it('gemini: reuses the server-side chain, falls back to full context when it expired', async () => {
    config.set('defaultModel', 'gem')
    const gem = (id: string, text: string) => ({ id, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: {} })
    srvReplies.push(gem('int_1', '一'), gem('int_2', '二'), { error: { message: 'interaction not found' } }, gem('int_3', '三'))
    srvStatus.push(200, 200, 404, 200)
    const u = { user_id: 20006 }
    await trigger({ ...u, message_id: 'g1' })
    await trigger({ ...u, message_id: 'g2', message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '第二句' }] })
    const r3 = await trigger({ ...u, message_id: 'g3', message: [{ type: 'at', qq: 10000 }, { type: 'text', text: '第三句' }] })
    const [b1, b2, b3, b4] = srv.requests.map(r => r.body)
    assert.equal(srv.requests[0].url, '/v1beta/interactions')
    assert.equal(b1.previous_interaction_id, undefined)
    assert.equal(b2.previous_interaction_id, 'int_1')
    assert.equal(b2.input.length, 1, 'only the new user turn is sent')
    assert.equal(b3.previous_interaction_id, 'int_2')
    assert.equal(b4.previous_interaction_id, undefined, 'stateless retry')
    assert.equal(b4.input.length, 5, 'full history resent: u,a,u,a,u')
    assert.deepEqual(r3.sent.map(s => s.msg), ['三'])
    config.set('defaultModel', 'main')
  })

  it('falls back / notifies when the quota is exhausted', async () => {
    config.set('defaultModel', 'tiny')
    srvReplies.push(textReply('第一句', 0.002))
    const r1 = await trigger({ message_id: 'd1', user_id: 20004 })
    assert.deepEqual(r1.sent.map(s => s.msg), ['第一句'])
    const r2 = await trigger({ message_id: 'd2', user_id: 20004 })
    assert.equal(srv.requests.length, 1, 'no LLM call once over quota')
    assert.match(String(r2.sent[0]?.msg), /额度用完/)
    const r3 = await trigger({ message_id: 'd3', user_id: 20004 })
    assert.equal(r3.sent.length, 0, 'quota notice is rate-limited')
    config.set('fallbackModels', ['main'])
    srvReplies.push(textReply('换个模型继续'))
    const r4 = await trigger({ message_id: 'd4', user_id: 20004 })
    assert.deepEqual(r4.sent.map(s => s.msg), ['换个模型继续'])
    assert.equal(srv.requests.at(-1)!.body.model, 'mock-model')
    config.set('defaultModel', 'main')
  })
})
