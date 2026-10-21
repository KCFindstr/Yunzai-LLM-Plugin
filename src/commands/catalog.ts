import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { PLUGIN_NAME } from '../core/paths.ts'
import { similarity } from '../core/util.ts'
import { getLoader, getYunzaiCfg, ownClasses, pluginsDir } from '../core/yunzai.ts'
import { PLACEHOLDER, PRESETS } from './presets.ts'

export interface RuleInfo {
  plugin: string
  dsc: string
  reg: RegExp
  fnc: string
  permission?: string
  event?: string
  pluginEvent?: string
  catchAll: boolean
  own: boolean
  /** loader.priority entry (for event filtering) */
  entry: any
}

export interface CommandEntry {
  cmd: string
  desc: string
  source: 'preset' | 'hint' | 'help'
  plugin?: string
  verified: boolean
  /** concrete command used for validation (placeholder substituted) */
  example?: string
  game?: string
  /** synonym: searchable but not listed in the prompt */
  hidden?: boolean
}

let rules: RuleInfo[] = []
let entries: CommandEntry[] = []
export let catalogVersion = 0
let scannedAt = 0

const NONSENSE = ['zq9x随机测试文本qq', '你好呀今天天气不错', 'abc', '']
const SKIP_DIRS = new Set([PLUGIN_NAME, 'adapter', 'system', 'other', 'example'])
const DEFAULT_EXAMPLE = '刻晴'

function cloneReg(r: any): RegExp {
  const re = r instanceof RegExp ? r : new RegExp(String(r))
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ''))
}

/** Apply the same normalisation PluginsLoader.deal does before matching rules. */
export function normalizeCommand(loader: any, cmd: string): string {
  let msg = String(cmd ?? '').trim()
  try {
    if (typeof loader?.dealText === 'function') msg = loader.dealText(msg)
  } catch {}
  if (loader?.srReg?.test?.(msg)) msg = msg.replace(loader.srReg, '#星铁')
  else if (loader?.zzzReg?.test?.(msg)) msg = msg.replace(loader.zzzReg, '#绝区零')
  return msg
}

async function collectRules(): Promise<RuleInfo[]> {
  const loader = await getLoader()
  const out: RuleInfo[] = []
  for (const p of loader?.priority ?? []) {
    const own = ownClasses.has(p.class)
    for (const r of p.plugin?.rule ?? []) {
      let reg: RegExp
      try {
        reg = cloneReg(r.reg)
      } catch {
        continue
      }
      out.push({
        plugin: p.name ?? p.key,
        dsc: p.plugin?.dsc ?? '',
        reg,
        fnc: r.fnc,
        permission: r.permission,
        event: r.event,
        pluginEvent: p.plugin?.event,
        catchAll: NONSENSE.some(s => reg.test(s)),
        own,
        entry: p,
      })
    }
  }
  return out
}

/** First foreign, non-catch-all rule that would handle `cmd` for this event (priority order). */
export async function matchRule(cmd: string, e?: any): Promise<RuleInfo | undefined> {
  const loader = await getLoader()
  if (!rules.length) rules = await collectRules()
  const msg = normalizeCommand(loader, cmd)
  let groupCfg: any
  if (e?.group_id) {
    try {
      groupCfg = (await getYunzaiCfg())?.getGroup?.(e.self_id, e.group_id)
    } catch {}
  }
  for (const r of rules) {
    if (r.own || r.catchAll) continue
    if (!r.reg.test(msg)) continue
    if (e && loader?.filtEvent) {
      if (!loader.filtEvent(e, { event: r.pluginEvent ?? 'message' })) continue
      if (r.event && !loader.filtEvent(e, r)) continue
    }
    if (groupCfg?.disable?.length && groupCfg.disable.includes(r.plugin)) continue
    if (groupCfg?.enable?.length && !groupCfg.enable.includes(r.plugin)) continue
    return r
  }
  return undefined
}

// ---------- help file scraping ----------

function walkHelpFiles(dir: string, depth: number, out: string[]) {
  if (depth < 0 || out.length > 40) return
  let ents: fs.Dirent[]
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of ents) {
    if (ent.name.startsWith('.') || ['node_modules', 'data', 'temp', 'logs'].includes(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walkHelpFiles(p, depth - 1, out)
    else if (/help/i.test(ent.name) && /\.(js|ya?ml|json)$/i.test(ent.name)) {
      try {
        if (fs.statSync(p).size < 512 * 1024) out.push(p)
      } catch {}
    }
  }
}

const CMD_START = /^[#*%＃]/

function pushPair(out: { cmd: string; desc: string }[], title: any, desc: any) {
  if (typeof title !== 'string' || typeof desc !== 'string') return
  // "#深渊 / #上期深渊", "#五星 #武器" split; "*跃迁分析(角色/光锥)" must not
  const parts = title
    .split(/\s*(?:、|\||｜|，|,|\s+或\s+)\s*|\s+(?=[#*%＃])|\s*\/\s*(?=[#*%＃])/)
    .map(s => s.trim())
    .filter(s => CMD_START.test(s) && s.length <= 30)
  for (const cmd of parts) out.push({ cmd, desc: desc.trim().slice(0, 60) })
}

function scrapeObject(v: any, out: { cmd: string; desc: string }[], depth = 0) {
  if (depth > 8 || v == null) return
  if (Array.isArray(v)) return v.forEach(x => scrapeObject(x, out, depth + 1))
  if (typeof v !== 'object') return
  const title = v.title ?? v.name ?? v.cmd ?? v.command
  const desc = v.desc ?? v.dsc ?? v.description
  if (title && desc) pushPair(out, title, desc)
  for (const x of Object.values(v)) if (typeof x === 'object') scrapeObject(x, out, depth + 1)
}

export function scrapeHelpText(file: string, text: string): { cmd: string; desc: string }[] {
  const out: { cmd: string; desc: string }[] = []
  if (/\.json$/i.test(file)) {
    try {
      scrapeObject(JSON.parse(text), out)
    } catch {}
  } else if (/\.ya?ml$/i.test(file)) {
    try {
      scrapeObject(YAML.parse(text), out)
    } catch {}
  } else {
    const re1 = /['"`]?(?:title|name|cmd|command)['"`]?\s*:\s*(['"`])((?:(?!\1)[^\n])+)\1\s*,\s*(?:\/\/[^\n]*)?\s*['"`]?(?:desc|dsc|description)['"`]?\s*:\s*(['"`])((?:(?!\3)[^\n])+)\3/g
    for (let m = re1.exec(text); m; m = re1.exec(text)) pushPair(out, m[2], m[4])
    const re2 = /['"`]?(?:desc|dsc|description)['"`]?\s*:\s*(['"`])((?:(?!\1)[^\n])+)\1\s*,\s*(?:\/\/[^\n]*)?\s*['"`]?(?:title|name|cmd|command)['"`]?\s*:\s*(['"`])((?:(?!\3)[^\n])+)\3/g
    for (let m = re2.exec(text); m; m = re2.exec(text)) pushPair(out, m[4], m[2])
  }
  return out
}

function scanHelpFiles(): { cmd: string; desc: string; plugin: string }[] {
  const out: { cmd: string; desc: string; plugin: string }[] = []
  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(pluginsDir(), { withFileTypes: true })
  } catch {
    return out
  }
  for (const d of dirs) {
    if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue
    const files: string[] = []
    walkHelpFiles(path.join(pluginsDir(), d.name), 4, files)
    for (const f of files) {
      try {
        for (const p of scrapeHelpText(f, fs.readFileSync(f, 'utf8'))) out.push({ ...p, plugin: d.name })
      } catch {}
    }
  }
  return out
}

/** Replace typical placeholders in help titles with an example so the command can be validated. */
export function concretize(cmd: string, example = DEFAULT_EXAMPLE): string {
  return (
    cmd
      .replace(PLACEHOLDER, example)
      // bracketed placeholders: #【角色名】面板, #<uid>
      .replace(/[【\[<{(（]\s*([^】\]>})）]{1,8}?)\s*[】\]>})）]/g, (m, w: string) =>
        /uid/i.test(w) ? '100000001' : /角色|武器|名|xx/i.test(w) ? example : m,
      )
      // "+"-joined placeholders: #角色名+面板 (bare "#角色" is a real command, so only with "+")
      .replace(/(角色名?|武器名?|xx|XX)\s*\+\s*/g, example)
      .replace(/\s*\+\s*(角色名?|武器名?|xx|XX)/g, example)
      .replace(/\s*\+\s*/g, '')
  )
}

export async function scanCatalog(): Promise<{ rules: number; entries: number; verified: number }> {
  rules = await collectRules()
  const loader = await getLoader()
  const seen = new Set<string>()
  const list: CommandEntry[] = []
  const add = async (
    cmd: string,
    desc: string,
    source: CommandEntry['source'],
    opts: { example?: string; test?: string; plugin?: string; game?: string; hidden?: boolean } = {},
  ) => {
    const key = normalizeCommand(loader, cmd)
    if (!cmd || seen.has(key)) return
    seen.add(key)
    const concrete = opts.test ?? concretize(cmd, opts.example)
    const verified = Boolean(await matchRule(concrete))
    list.push({
      cmd,
      desc,
      source,
      plugin: opts.plugin,
      verified,
      example: concrete !== cmd ? concrete : undefined,
      game: opts.game,
      hidden: opts.hidden,
    })
  }
  for (const h of config.get().tools.botCommand.hints ?? []) if (h?.cmd) await add(h.cmd, h.desc ?? '', 'hint')
  for (const p of PRESETS) await add(p.cmd, p.desc, 'preset', { example: p.example, test: p.test, game: p.game, hidden: p.hidden })
  for (const h of scanHelpFiles()) await add(h.cmd, h.desc, 'help', { plugin: h.plugin })
  entries = list
  catalogVersion++
  scannedAt = Date.now()
  const verified = list.filter(x => x.verified).length
  log.info(`指令目录: ${rules.length} 条规则，${list.length} 条说明（${verified} 条已验证）`)
  return { rules: rules.length, entries: list.length, verified }
}

export function catalogEntries(): CommandEntry[] {
  return entries
}

export function catalogInfo() {
  return { rules: rules.length, entries: entries.length, verified: entries.filter(e => e.verified).length, scannedAt }
}

/** Display form for prompts: placeholders shown as 角色名 with an example. */
export function displayCmd(c: CommandEntry): string {
  return c.cmd.includes(PLACEHOLDER) ? `${c.cmd.replace(PLACEHOLDER, '角色名')}（如 ${c.example}）` : c.cmd
}

export function resolveGame(e: CommandEntry): string {
  if (e.game) return e.game
  const cmd = e.cmd
  if (cmd.startsWith('*') || /starrail/i.test(e.plugin ?? '')) return 'sr'
  if (cmd.startsWith('%') || /zzz/i.test(e.plugin ?? '')) return 'zzz'
  if (/genshin|原神/i.test(e.desc) || /genshin/i.test(e.plugin ?? '')) return 'gs'
  if (/星铁|崩铁/i.test(e.desc)) return 'sr'
  if (/绝区零/i.test(e.desc)) return 'zzz'
  if (cmd.startsWith('#')) return 'gs'
  return 'common'
}

export interface CatalogFilter {
  game?: string
  plugin?: string
}

export function formatCommandCatalog(opts: CatalogFilter = {}): string {
  const ok = entries.filter(e => e.verified && !e.hidden)
  const targetGame = opts.game?.toLowerCase()?.trim()
  const targetPlugin = opts.plugin?.toLowerCase()?.trim()

  let filtered = ok
  if (targetPlugin) {
    filtered = filtered.filter(e => e.plugin?.toLowerCase().includes(targetPlugin))
  }
  if (targetGame && targetGame !== 'all') {
    filtered = filtered.filter(e => resolveGame(e) === targetGame)
  }

  if (!filtered.length) {
    return `未找到匹配的指令（已扫描验证 ${ok.length} 条可用指令）。可尝试不传参数获取全部指令列表。`
  }

  const groups = new Map<string, CommandEntry[]>()
  for (const e of filtered) {
    const g = resolveGame(e)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(e)
  }

  const GAME_NAMES: Record<string, string> = {
    sr: '星穹铁道 (* 或 #星铁 开头)',
    gs: '原神 (# 开头)',
    zzz: '绝区零 (% 或 #绝区零 开头)',
    common: '通用/系统指令 (# 开头)',
  }

  const sections: string[] = []
  for (const [g, list] of groups) {
    const title = GAME_NAMES[g] ?? `分类 [${g}]`
    const lines = list.map(c => `- ${displayCmd(c)} — ${c.desc}${c.plugin ? ` [${c.plugin}]` : ''}`)
    sections.push(`【${title}】（${list.length} 条）：\n${lines.join('\n')}`)
  }

  const note =
    '\n【角色与别名使用说明】\n' +
    '1. 凡带有「角色名」的指令（如 *{角色}面板、#{角色}面板、*{角色}伤害、*{角色}攻略 等），插件已内嵌海量官方全名、二创别称及SP角色（如星铁的火花、狼尊、老泉、卡芙卡；原神的雷神、帝君等）。\n' +
    '2. 用户询问角色时，直接使用用户提到的角色名代入指令即可（例如用户说“火花面板”执行「*火花面板」，用户说“狼尊面板”执行「*狼尊面板」），严禁自行纠正或替换角色名！'

  return `=== 机器人已安装指令列表（共 ${filtered.length} 条可用） ===\n\n${sections.join('\n\n')}\n${note}`
}

/**
 * Entries for the system prompt: verified hints first, then presets round-robin across games (so a small limit
 * still covers 原神/星铁/绝区零), then scraped help entries. Deterministic for a given catalog.
 */
export function promptEntries(limit: number): CommandEntry[] {
  const ok = entries.filter(e => e.verified && !e.hidden)
  const hints = ok.filter(e => e.source === 'hint')
  const byGame = new Map<string, CommandEntry[]>()
  for (const e of ok.filter(x => x.source === 'preset')) {
    const g = e.game ?? 'other'
    if (!byGame.has(g)) byGame.set(g, [])
    byGame.get(g)!.push(e)
  }
  const presets: CommandEntry[] = []
  const queues = [...byGame.values()]
  for (let i = 0; queues.some(q => i < q.length); i++) for (const q of queues) if (i < q.length) presets.push(q[i])
  const help = ok.filter(e => e.source === 'help')
  return [...hints, ...presets, ...help].slice(0, Math.max(0, limit))
}

/** Lexical search over descriptions and rule regexes (Chinese-friendly bigram similarity). */
export function searchCommands(query: string, n = 8): string[] {
  const q = query.trim()
  if (!q) return []
  if (['all', '全部', '所有', 'list', 'help'].includes(q.toLowerCase())) {
    return [formatCommandCatalog()]
  }

  const scored: [number, string][] = []

  // Check direct live rule match for query and candidate prefixes (e.g. *火花面板, #火花面板)
  const seenMatches = new Set<string>()
  const candidates = [
    q,
    q.startsWith('#') || q.startsWith('*') || q.startsWith('%') ? q : `*${q}`,
    q.startsWith('#') || q.startsWith('*') || q.startsWith('%') ? q : `#${q}`,
  ]
  for (const cand of candidates) {
    if (seenMatches.has(cand)) continue
    for (const r of rules) {
      if (r.own || r.catchAll) continue
      if (r.reg.test(cand)) {
        seenMatches.add(cand)
        scored.push([
          1.5,
          `${cand} — 可直接执行（匹配插件「${r.plugin}」：${r.dsc || r.fnc}）`,
        ])
        break
      }
    }
  }

  for (const c of entries) {
    let s = Math.max(similarity(q, c.desc), similarity(q, c.cmd) * 0.9)
    if (c.cmd.includes(PLACEHOLDER)) {
      const concretized = c.cmd.replace(PLACEHOLDER, q)
      s = Math.max(s, similarity(q, concretized) * 0.95)
      const m = /(.*?)(?:面板|伤害|攻略|材料|天赋|命座|图鉴|圣遗物|遗器)$/.exec(q)
      if (m && m[1]) {
        const withRole = c.cmd.replace(PLACEHOLDER, m[1].replace(/^[#*%]/, ''))
        s = Math.max(s, similarity(q, withRole) * 0.95)
      }
    }
    s += (c.verified ? 0.05 : -0.2)
    if (s > 0.15) scored.push([s, `${displayCmd(c)} — ${c.desc}${c.verified ? '' : '（未验证）'}`])
  }

  const seenSrc = new Set<string>()
  for (const r of rules) {
    if (r.own || r.catchAll || seenSrc.has(r.reg.source)) continue
    seenSrc.add(r.reg.source)
    const s = Math.max(similarity(q, r.reg.source), similarity(q, r.dsc) * 0.8, similarity(q, r.plugin) * 0.6)
    if (s > 0.2) scored.push([s * 0.85, `正则 /${r.reg.source}/ — ${r.plugin}${r.dsc ? `：${r.dsc}` : ''}`])
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, n)
    .map(x => x[1])
}
