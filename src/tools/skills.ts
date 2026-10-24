import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { SKILLS_DIR } from '../core/paths.ts'
import { truncate } from '../core/util.ts'
import { registry } from './registry.ts'
import type { ToolCtx } from './registry.ts'
import { runtimeToolReady } from '../core/setup.ts'

export interface Skill {
  name: string
  description: string
  body: string
  dir: string
  requiresTools?: string[]
}

let skills: Skill[] = []
export let skillsVersion = 0

export function parseSkillMarkdown(text: string, fallbackName: string): { name: string; description: string; body: string; requiresTools?: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  let meta: any = {}
  let body = text
  if (m) {
    try {
      meta = YAML.parse(m[1]) ?? {}
    } catch {}
    body = m[2]
  }
  const name = String(meta.name ?? fallbackName).trim()
  const description = String(meta.description ?? body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ?? '').trim()
  const required = Array.isArray(meta.requires_tools) ? meta.requires_tools.filter((name: unknown) => typeof name === 'string') : []
  return { name, description, body: body.trim(), ...(required.length ? { requiresTools: required } : {}) }
}

export function loadSkills(): Skill[] {
  const out: Skill[] = []
  try {
    if (fs.existsSync(SKILLS_DIR))
      for (const ent of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const dir = path.join(SKILLS_DIR, ent.name)
        const file = path.join(dir, 'SKILL.md')
        if (!fs.existsSync(file)) continue
        const s = parseSkillMarkdown(fs.readFileSync(file, 'utf8'), ent.name)
        if (s.name && s.description) out.push({ ...s, dir })
      }
  } catch (err: any) {
    log.warn(`加载技能失败: ${err.message}`)
  }
  skills = out.sort((a, b) => a.name.localeCompare(b.name))
  skillsVersion++
  return skills
}

export function listSkills(): Skill[] {
  return skills
}
const bundledDependencies: Record<string, string[]> = { 'computer-use': ['computer_task'], 'google-lens': ['google_lens'], agy: ['agy'], 'run-code': ['run_code'] }
export function skillsForTools(toolNames: Iterable<string>) {
  const tools = new Set(toolNames)
  return skills.filter(s => (s.requiresTools ?? bundledDependencies[s.name] ?? []).every(name => tools.has(name)))
}
function skillsForTurn(ctx: ToolCtx) {
  const disabled = new Set(ctx.eff.tools.disabled)
  const names = registry.all().filter(t => t.name !== 'load_skill' && !disabled.has(t.name) && (t.available?.(ctx) ?? true) && runtimeToolReady(t.name, ctx.eff)).map(t => t.name)
  return !config.get().skills.enable ? [] : skillsForTools(names)
}

export function safeSkillName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48)
}

export function saveSkill(name: string, markdown: string): Skill {
  const dirName = safeSkillName(name)
  if (!dirName) throw new Error('技能名不合法')
  const dir = path.join(SKILLS_DIR, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8')
  loadSkills()
  const s = skills.find(x => x.dir === dir)
  if (!s) throw new Error('技能缺少 description（frontmatter 或正文第一行）')
  return s
}

export function deleteSkill(name: string): boolean {
  const s = skills.find(x => x.name === name || path.basename(x.dir) === name)
  if (!s) return false
  fs.rmSync(s.dir, { recursive: true, force: true })
  loadSkills()
  return true
}

export function registerSkillTool() {
  registry.register({
    name: 'load_skill', budgetExempt: true,
    source: 'builtin',
    description: '加载一个技能的完整说明。系统提示里只列出了技能名和简介，需要使用某个技能时先调用它获取详细步骤。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        file: { type: 'string', description: '可选：技能目录下的附加文件名（技能说明中提到时才用）' },
      },
      required: ['name'],
    },
    available: ctx => skillsForTurn(ctx).length > 0,
    async run(args, ctx) {
      const available = skillsForTurn(ctx)
      const s = available.find(x => x.name === args.name)
      if (!s) return { content: `技能不可用。可用: ${available.map(x => x.name).join(', ')}`, isError: true }
      if (args.file) {
        const f = path.resolve(s.dir, String(args.file))
        if (!f.startsWith(s.dir + path.sep) || !fs.existsSync(f)) return { content: '文件不存在', isError: true }
        return truncate(fs.readFileSync(f, 'utf8'), 12000)
      }
      return truncate(s.body, 12000)
    },
  })
}
