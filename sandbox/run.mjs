#!/usr/bin/env node
/**
 * Isolated end-to-end sandbox. NEVER touches the production NapCat or the prod Yunzai port.
 *
 *   node sandbox/run.mjs                 interactive REPL (mock LLM unless sandbox/config.yaml exists)
 *   node sandbox/run.mjs --mock          force the scripted mock LLM
 *   node sandbox/run.mjs --script f.txt  run a scenario file non-interactively (exit code 1 on failed expect)
 *   node sandbox/run.mjs --verbose       echo the full Yunzai log
 *
 * Layout: sandbox/.runtime/ gets a *copy* of Yunzai's lib/ (PluginsLoader imports plugins relative to its own path),
 * the OneBot adapters, this plugin's build, safe config files and any test plugins (see install-plugins.mjs).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { BOT_ID, GROUP_ID, MASTER_ID, startFakeNapCat, USER_ID } from './fake-napcat.mjs'
import { startMockLLM } from './mock-llm.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(here, '..')
const ROOT = path.resolve(PLUGIN, '..', '..')
// --runtime <name>: separate runtime dir (e.g. one without game plugins, to mirror prod's plugin set)
const runtimeArg = process.argv.includes('--runtime') ? process.argv[process.argv.indexOf('--runtime') + 1] : ''
const RT = path.join(here, runtimeArg ? `.runtime-${runtimeArg.replace(/[^\w-]/g, '')}` : '.runtime')
const PORTS = { yunzai: 2599, napcatWs: 3299, napcatHttp: 3298, mockLLM: 3297, redis: 6390 }
// OneBotClient (forward WS) is a local, optional adapter; without it the fake NapCat dials stock OneBotv11 instead
const ONEBOT_CLIENT = path.join(ROOT, 'plugins', 'adapter', 'OneBotClient.js')
const forwardWs = fs.existsSync(ONEBOT_CLIENT)
// Yunzai doesn't ship redis: on Windows download a pinned msys2 build into sandbox/redis (git-ignored), elsewhere redis-server on PATH
const REDIS_DIR = path.join(here, 'redis')
const REDIS = process.platform === 'win32' ? path.join(REDIS_DIR, 'redis-server.exe') : 'redis-server'
const REDIS_ZIP = {
  url: 'https://github.com/redis-windows/redis-windows/releases/download/8.10.2/Redis-8.10.2-Windows-x64-msys2.zip',
  sha256: '7c8cebd50347eaa1d9e784da842ed47a4f33394637835531d6614777b950ee85',
}

const argv = process.argv.slice(2)
const flag = f => argv.includes(f)
const scriptFile = argv.includes('--script') ? argv[argv.indexOf('--script') + 1] : undefined
const verbose = flag('--verbose')
const userConfig = path.join(here, 'config.yaml')
const useMock = flag('--mock') || !fs.existsSync(userConfig)

const print = line => {
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(`${line}\n`)
  if (rl && !scriptFile) rl.prompt(true)
}

// ---------------- runtime preparation ----------------

function copyDir(src, dst, filter = () => true) {
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true, filter: s => filter(s) })
}

function junction(target, link) {
  try {
    const st = fs.lstatSync(link)
    if (st.isSymbolicLink() || st.isDirectory()) return
  } catch {}
  fs.symlinkSync(target, link, 'junction')
}

function writeYaml(rel, text) {
  const f = path.join(RT, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text, 'utf8')
}

const MOCK_PLUGIN_CONFIG = `# 沙盒自动生成：使用本地模拟 LLM（node sandbox/run.mjs --mock）
providers:
  mock: { type: openai, baseUrl: 'http://127.0.0.1:${PORTS.mockLLM}/v1', apiKey: sandbox-key, maxRetries: 0 }
models:
  - id: mock
    provider: mock
    model: mock-model
    pricing: { input: 1, output: 4, cacheRead: 0.1 }
    quota: { user: { window5h: 0.05, weekly: 0.1 } }
defaultModel: mock
fallbackModels: []
pricing: { sources: [] }
reply:
  typing: { charsPerSecond: 40, minDelay: 200, maxDelay: 800 }
  # scripted scenarios send far faster than people; prod default is 6/60s
  groupRate: { count: 30, perSeconds: 60 }
sticker: { probability: 1, cooldown: 0 }
# the mock answers instantly, so scripted follow-ups would otherwise hit the per-user anti-spam cooldown
trigger: { userCooldown: 0 }
tools:
  webSearch: { enable: false }
`

/** Remove our junctions first so a recursive delete can never descend into the real Yunzai dirs. */
function unlinkJunctions() {
  for (const d of ['node_modules', 'resources', 'renderers']) {
    const link = path.join(RT, d)
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
    } catch {}
  }
}

async function ensureRedis() {
  if (process.platform !== 'win32' || fs.existsSync(REDIS)) return
  print(`[sandbox] downloading Redis for Windows: ${REDIS_ZIP.url}`)
  const res = await fetch(REDIS_ZIP.url)
  if (!res.ok) throw new Error(`Redis download failed: HTTP ${res.status}`)
  const zip = Buffer.from(await res.arrayBuffer())
  const hash = createHash('sha256').update(zip).digest('hex')
  if (hash !== REDIS_ZIP.sha256) throw new Error(`Redis download checksum mismatch: ${hash}`)
  const tmp = fs.mkdtempSync(path.join(here, '.redis-'))
  try {
    fs.writeFileSync(path.join(tmp, 'redis.zip'), zip)
    // Windows 10+ ships bsdtar, which extracts zip archives
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', 'redis.zip'], { cwd: tmp, stdio: 'ignore' })
    const src = path.join(tmp, path.basename(REDIS_ZIP.url, '.zip'))
    fs.mkdirSync(REDIS_DIR, { recursive: true })
    for (const f of fs.readdirSync(src)) if (f === 'redis-server.exe' || f.endsWith('.dll') || f.startsWith('README')) fs.copyFileSync(path.join(src, f), path.join(REDIS_DIR, f))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function prepare() {
  if (flag('--fresh')) {
    unlinkJunctions()
    fs.rmSync(RT, { recursive: true, force: true })
  }
  fs.mkdirSync(RT, { recursive: true })
  copyDir(path.join(ROOT, 'lib'), path.join(RT, 'lib'))
  for (const f of ['app.js', 'package.json', '.puppeteerrc.cjs'])
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(RT, f))
  for (const d of ['node_modules', 'resources', 'renderers']) if (fs.existsSync(path.join(ROOT, d))) junction(path.join(ROOT, d), path.join(RT, d))
  copyDir(path.join(ROOT, 'config', 'default_config'), path.join(RT, 'config', 'default_config'))

  // --- Yunzai config: local-only endpoints ---
  writeYaml('config/config/server.yaml', `url: http://localhost:${PORTS.yunzai}\nport: ${PORTS.yunzai}\nredirect: https://git.trss.me/Yunzai\nauth:\n`)
  writeYaml('config/config/redis.yaml', `path: ${JSON.stringify(REDIS)}\nhost: 127.0.0.1\nport: ${PORTS.redis}\nusername:\npassword:\ndb: 0\n`)
  writeYaml(
    'config/config/other.yaml',
    `autoFriend: 0\nautoGroup: 0\nautoQuit: 0\nmasterQQ:\n  - ${MASTER_ID}\nmaster:\n  - "${BOT_ID}:${MASTER_ID}"\ndisablePrivate: false\nwhiteGroup:\nwhiteUser:\nblackGroup:\nblackUser:\n`,
  )
  // cooldowns off so scripted back-to-back messages aren't dropped by Yunzai's own throttling
  writeYaml('config/config/group.yaml', `default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n  botAlias:\n    - 沙盒\n`)
  writeYaml('config/config/bot.yaml', `log_level: ${verbose ? 'debug' : 'info'}\nfile_watch: false\nonline_msg_exp: 99999999\nplugin_load_timeout: 120\nupdate_time: 0\n`)
  if (forwardWs) writeYaml('config/config/onebot_client.yaml', `servers:\n  - name: sandbox\n    url: ws://127.0.0.1:${PORTS.napcatWs}\n`)
  else fs.rmSync(path.join(RT, 'config', 'config', 'onebot_client.yaml'), { force: true })
  for (const f of ['onebot11.yaml', 'milky.yaml', 'satori.yaml']) writeYaml(`config/config/${f}`, '# sandbox: disabled\n')

  // hard safety check: no config may point anywhere but localhost
  for (const f of fs.readdirSync(path.join(RT, 'config', 'config'))) {
    const t = fs
      .readFileSync(path.join(RT, 'config', 'config', f), 'utf8')
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('#'))
      .join('\n')
    for (const m of t.matchAll(/(?:wss?|https?):\/\/([^/:\s"']+)/g))
      if (!['127.0.0.1', 'localhost', 'git.trss.me'].includes(m[1])) throw new Error(`沙盒配置 ${f} 指向非本地地址 ${m[1]}，已中止`)
  }

  // --- plugins: adapters (only OneBot), system/other, this plugin's build ---
  fs.mkdirSync(path.join(RT, 'plugins'), { recursive: true })
  const adapterDst = path.join(RT, 'plugins', 'adapter')
  fs.rmSync(adapterDst, { recursive: true, force: true })
  fs.mkdirSync(adapterDst)
  fs.copyFileSync(path.join(ROOT, 'plugins', 'adapter', 'OneBotv11.js'), path.join(adapterDst, 'OneBotv11.js'))
  if (forwardWs) fs.copyFileSync(ONEBOT_CLIENT, path.join(adapterDst, 'OneBotClient.js'))
  for (const d of ['system', 'other']) if (fs.existsSync(path.join(ROOT, 'plugins', d))) copyDir(path.join(ROOT, 'plugins', d), path.join(RT, 'plugins', d))

  const dst = path.join(RT, 'plugins', 'Yunzai-LLM-Plugin')
  fs.mkdirSync(path.join(dst, 'config'), { recursive: true })
  for (const f of ['index.js', 'package.json']) fs.copyFileSync(path.join(PLUGIN, f), path.join(dst, f))
  copyDir(path.join(PLUGIN, 'dist'), path.join(dst, 'dist'))
  if (fs.existsSync(path.join(PLUGIN, 'skills'))) copyDir(path.join(PLUGIN, 'skills'), path.join(dst, 'skills'))
  if (fs.existsSync(path.join(PLUGIN, 'tools'))) copyDir(path.join(PLUGIN, 'tools'), path.join(dst, 'tools'))
  // management panel assets (served on web.port)
  copyDir(path.join(PLUGIN, 'web'), path.join(dst, 'web'))
  fs.copyFileSync(path.join(PLUGIN, 'config', 'default_config.yaml'), path.join(dst, 'config', 'default_config.yaml'))
  // persona files referenced as `file:xxx.md`
  for (const f of fs.readdirSync(path.join(PLUGIN, 'config'))) if (/\.(md|txt)$/i.test(f)) fs.copyFileSync(path.join(PLUGIN, 'config', f), path.join(dst, 'config', f))
  let pluginConfig = useMock ? MOCK_PLUGIN_CONFIG : fs.readFileSync(userConfig, 'utf8')
  // --overlay <file>: YAML merged over the generated config (e.g. a copy of prod's settings without providers/keys)
  const overlayArg = argv.includes('--overlay') ? argv[argv.indexOf('--overlay') + 1] : undefined
  if (overlayArg) {
    const merge = (a, b) => {
      if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b
      const o = { ...a }
      for (const [k, v] of Object.entries(b)) o[k] = merge(o[k], v)
      return o
    }
    pluginConfig = YAML.stringify(merge(YAML.parse(pluginConfig), YAML.parse(fs.readFileSync(overlayArg, 'utf8'))))
  }
  fs.writeFileSync(path.join(dst, 'config', 'config.yaml'), pluginConfig)
  // scripted runs must not depend on earlier runs (e.g. quota already spent today); stickers are kept
  if (scriptFile)
    for (const f of ['usage.json', 'sessions.json', 'memory.json']) fs.rmSync(path.join(dst, 'data', f), { force: true })
}

// ---------------- processes ----------------

let yz
let rl
let markCatalogReady
const catalogReady = new Promise(r => (markCatalogReady = r))
const logFile = path.join(RT, 'yunzai.log')

function startYunzai() {
  fs.writeFileSync(logFile, '')
  const out = fs.createWriteStream(logFile, { flags: 'a' })
  yz = spawn(process.execPath, ['app.js'], { cwd: RT, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const onData = chunk => {
    out.write(chunk)
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue
      if (/指令目录/.test(line)) markCatalogReady()
      if (verbose || /\[LLM\]|ERRO|错误|Error|自然语言指令|插件加载|指令目录/.test(line)) print(`\x1b[90m  yz│\x1b[0m ${line}`)
    }
  }
  yz.stdout.on('data', onData)
  yz.stderr.on('data', onData)
  yz.on('exit', code => print(`\x1b[31m[Yunzai 已退出 code=${code}]\x1b[0m`))
}

async function shutdown(code = 0) {
  try {
    await fetch(`http://127.0.0.1:${PORTS.yunzai}/exit`, { signal: AbortSignal.timeout(3000) })
  } catch {}
  await new Promise(r => setTimeout(r, 2500))
  yz?.kill()
  napcat?.close()
  mock?.close()
  process.exit(code)
}

// ---------------- commands ----------------

let napcat
let mock
let currentUser = USER_ID

const HELP = `命令：
  ga <文本>        测试用户在群里 @机器人
  g <文本>         测试用户在群里说话（不@，机器人不应回复）
  ma <文本>        主人在群里 @机器人
  gr <文本>        回复（引用）机器人上一条消息，不@
  gi <图> [文本]   群里发图片并@机器人（图: red/green/blue/yellow）
  gs <图>          群里发「表情包」并@机器人
  p <文本>         主人私聊（如 p #llm帮助）
  pi <图> [文本]   主人私聊发图片（如 pi red #llm添加表情）
  pm [文本]        主人私聊发商城表情(mface)
  pu <文本>        普通用户私聊（默认不回复）
  pr <文本>        主人私聊，引用上一条注入的消息（如 pr #llm添加表情）
  as <QQ>          切换测试用户 QQ
  sleep <毫秒> | expect <正则> | log | help | quit`

async function exec(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/)
  const arg = line.trim().slice(cmd.length).trim()
  switch (cmd) {
    case 'ga':
      return napcat.inject({ user: currentUser, at: true, text: arg })
    case 'g':
      return napcat.inject({ user: currentUser, text: arg })
    case 'ma':
      return napcat.inject({ user: MASTER_ID, at: true, text: arg })
    case 'gr':
      return napcat.inject({ user: currentUser, replyTo: napcat.lastBotMessageId(), text: arg })
    case 'gi':
      return napcat.inject({ user: currentUser, at: true, image: rest[0], text: rest.slice(1).join(' ') })
    case 'gs':
      return napcat.inject({ user: currentUser, at: true, image: rest[0], sticker: true })
    case 'p':
      return napcat.inject({ private: true, user: MASTER_ID, text: arg })
    case 'pi':
      return napcat.inject({ private: true, user: MASTER_ID, image: rest[0], text: rest.slice(1).join(' ') })
    case 'pm':
      return napcat.inject({ private: true, user: MASTER_ID, mface: true, text: arg })
    case 'pu':
      return napcat.inject({ private: true, user: currentUser, text: arg })
    case 'pr':
      return napcat.inject({ private: true, user: MASTER_ID, replyTo: napcat.lastUserMessageId(), text: arg })
    case 'gu':
      return napcat.inject({ user: currentUser, at: true, image: rest[0], text: rest.slice(1).join(' ') })
    case 'as':
      currentUser = Number(rest[0]) || USER_ID
      return print(`当前测试用户：${currentUser}`)
    case 'sleep':
      return new Promise(r => setTimeout(r, Number(rest[0]) || 1000))
    case 'expect': {
      // the mock answers instantly, so a short timeout keeps failing runs fast; real APIs get more time
      await napcat.expect(new RegExp(arg), useMock ? 10000 : 45000)
      return print(`\x1b[32m  ✓ expect /${arg}/\x1b[0m`)
    }
    case 'log':
      return print(`日志：${logFile}`)
    case 'help':
      return print(HELP)
    case 'quit':
    case 'exit':
      return shutdown(0)
    case '':
      return
    default:
      return print(`未知命令 ${cmd}，输入 help 查看`)
  }
}

// ---------------- main ----------------

await ensureRedis()
prepare()
print(`\x1b[35m[Sandbox]\x1b[0m runtime: ${RT}`)
print(`\x1b[35m[Sandbox]\x1b[0m LLM: ${useMock ? `模拟 LLM (127.0.0.1:${PORTS.mockLLM})` : `sandbox/config.yaml（真实 API）`}`)
if (useMock) mock = startMockLLM(PORTS.mockLLM, verbose ? print : () => {})
napcat = startFakeNapCat({
  wsPort: PORTS.napcatWs,
  httpPort: PORTS.napcatHttp,
  outDir: path.join(RT, 'out'),
  print,
  reverseUrl: forwardWs ? undefined : `ws://127.0.0.1:${PORTS.yunzai}/OneBotv11`,
})
startYunzai()

// wait for the adapter to connect and the LLM plugin's command catalog to be scanned
for (let i = 0; i < 240 && !napcat.connected(); i++) await new Promise(r => setTimeout(r, 500))
if (!napcat.connected()) {
  print('\x1b[31mYunzai 未能连接到 FakeNapCat，查看日志: ' + logFile + '\x1b[0m')
  await shutdown(1)
}
// the plugin logs "指令目录: …" once its command catalog is scanned — that's the real "ready" signal
await Promise.race([catalogReady, new Promise(r => setTimeout(r, 20000))])
print(`\x1b[35m[Sandbox]\x1b[0m 就绪。群 ${GROUP_ID}，机器人 ${BOT_ID}，主人 ${MASTER_ID}，测试用户 ${USER_ID}`)

if (scriptFile) {
  const lines = fs.readFileSync(path.resolve(scriptFile), 'utf8').split(/\r?\n/)
  let failed = 0
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('//')) continue
    print(`\x1b[35m> ${line}\x1b[0m`)
    try {
      await exec(line)
    } catch (err) {
      failed++
      print(`\x1b[31m  ✗ ${err.message}\x1b[0m`)
    }
  }
  print(failed ? `\x1b[31m场景完成，${failed} 个检查失败\x1b[0m` : '\x1b[32m场景完成，全部通过\x1b[0m')
  await shutdown(failed ? 1 : 0)
} else {
  print(HELP)
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sandbox> ' })
  rl.prompt()
  rl.on('line', async line => {
    try {
      await exec(line)
    } catch (err) {
      print(`\x1b[31m${err.message}\x1b[0m`)
    }
    rl.prompt()
  })
  rl.on('close', () => shutdown(0))
}
process.on('SIGINT', () => shutdown(0))
