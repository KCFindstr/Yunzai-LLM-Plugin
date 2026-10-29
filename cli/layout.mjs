/**
 * Where the plugin keeps its files, following the Yunzai plugin standard
 * (https://yunzai-bot.com/dev/standard.html#配置与数据管理):
 *
 *   Yunzai/config/Yunzai-LLM-Plugin/     user config (config.yaml, persona files, backups, own skills/ and tools/)
 *   Yunzai/data/Yunzai-LLM-Plugin/       all runtime data
 *   Yunzai/resources/Yunzai-LLM-Plugin/  files downloaded after install (the AGY CLI)
 *   Yunzai/temp/Yunzai-LLM-Plugin/       temporary files
 *
 * Static files that ship with the plugin (default_config.yaml, skills, web, desktop scripts) stay in the plugin
 * folder. The name is fixed, so a renamed clone (e.g. Yunzai-LLM-Plugin-main) still finds the same files.
 * Shared by the plugin (src/core/paths.ts) and the CLI scripts; env overrides are for tests and tooling.
 */
import fs from 'node:fs'
import path from 'node:path'

export const STORE_NAME = 'Yunzai-LLM-Plugin'

/** Yunzai root: the folder holding plugins/<this plugin>; otherwise the working directory Yunzai runs in. */
export function yunzaiRoot(pluginRoot) {
  const parent = path.dirname(pluginRoot)
  return path.basename(parent).toLowerCase() === 'plugins' ? path.dirname(parent) : process.cwd()
}

export function locations(pluginRoot) {
  const root = yunzaiRoot(pluginRoot)
  const env = process.env
  return {
    root,
    config: env.YZ_LLM_CONFIG_DIR || path.join(root, 'config', STORE_NAME),
    data: env.YZ_LLM_DATA_DIR || path.join(root, 'data', STORE_NAME),
    resources: env.YZ_LLM_RESOURCES_DIR || path.join(root, 'resources', STORE_NAME),
    temp: env.YZ_LLM_TEMP_DIR || path.join(root, 'temp', STORE_NAME),
    /** shipped with the plugin, never edited */
    defaultConfig: path.join(pluginRoot, 'config', 'default_config.yaml'),
  }
}

/** Shipped with the plugin under config/: copied (never moved) so `file:PERSONA.md` keeps working. */
const SHIPPED = new Set(['default_config.yaml', 'PERSONA.md'])
/** skills shipped in plugins/<name>/skills; any other skill folder there was added by the user */
const SHIPPED_SKILLS = new Set(['computer-use', 'genshin-team', 'google-lens'])
/** written next to the moved data so the plugin can repoint WSL image mounts (src/core/layout.ts) */
export const MOVED_MARKER = '.moved-from-plugin-folder.json'
/** in the new data folder while a move from the plugin folder is unfinished (holds the old path) */
export const PENDING = '.moving-from-plugin-folder'

const isEmptyDir = dir => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0

/**
 * Rename, or (another drive, a handle held open) copy then delete. Returns 'copied' when the copy is complete but
 * the source could not be fully deleted: the destination is the good one and the source a leftover.
 */
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
  try {
    fs.renameSync(from, to)
    return 'moved'
  } catch {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true })
    try {
      fs.rmSync(from, { recursive: true, force: true })
      return 'moved'
    } catch {
      return 'copied'
    }
  }
}

/**
 * One-time move of an install that kept its config and data inside the plugin folder (plugins/<name>/config,
 * plugins/<name>/data). Only runs when the new location is still empty, so it never overwrites anything.
 * Returns a note per change.
 */
export function migrateLayout(pluginRoot, loc = locations(pluginRoot)) {
  const notes = []
  const env = process.env
  const oldConfig = path.join(pluginRoot, 'config')
  if (!env.YZ_LLM_CONFIG_DIR && path.resolve(oldConfig) !== path.resolve(loc.config) && fs.existsSync(oldConfig)) {
    const own = fs.readdirSync(oldConfig).filter(f => !SHIPPED.has(f))
    if (own.length && !fs.existsSync(path.join(loc.config, 'config.yaml'))) {
      fs.mkdirSync(loc.config, { recursive: true })
      for (const f of own) move(path.join(oldConfig, f), path.join(loc.config, f))
      notes.push(`配置 ${own.length} 个文件：${oldConfig} → ${loc.config}`)
    }
  }
  // persona example: present in the config folder so `file:PERSONA.md` resolves there
  const persona = path.join(oldConfig, 'PERSONA.md')
  if (!env.YZ_LLM_CONFIG_DIR && fs.existsSync(persona) && !fs.existsSync(path.join(loc.config, 'PERSONA.md'))) {
    fs.mkdirSync(loc.config, { recursive: true })
    fs.copyFileSync(persona, path.join(loc.config, 'PERSONA.md'))
  }
  // skills and custom JS tools the user added inside the plugin folder are user config too
  if (!env.YZ_LLM_SKILLS_DIR) {
    const dir = path.join(pluginRoot, 'skills')
    const own = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && !SHIPPED_SKILLS.has(d.name)).map(d => d.name) : []
    for (const name of own.filter(name => !fs.existsSync(path.join(loc.config, 'skills', name)))) move(path.join(dir, name), path.join(loc.config, 'skills', name))
    if (own.length) notes.push(`自建技能 ${own.join('、')} → ${path.join(loc.config, 'skills')}`)
  }
  if (!env.YZ_LLM_TOOLS_DIR) {
    const dir = path.join(pluginRoot, 'tools')
    const own = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.m?js$/.test(f)) : []
    for (const f of own.filter(f => !fs.existsSync(path.join(loc.config, 'tools', f)))) move(path.join(dir, f), path.join(loc.config, 'tools', f))
    if (own.length) notes.push(`自定义工具 ${own.join('、')} → ${path.join(loc.config, 'tools')}`)
  }

  // Data moves entry by entry, so one locked folder (an old AGY test profile, a file held by WSL) can't stop the
  // rest. While a move is unfinished, the PENDING marker sits in the new folder and the next start resumes it:
  // entries still in the old folder are the real ones and replace whatever was created meanwhile.
  const oldData = path.join(pluginRoot, 'data')
  const pending = path.join(loc.data, PENDING)
  if (!env.YZ_LLM_DATA_DIR && path.resolve(oldData) !== path.resolve(loc.data) && !isEmptyDir(oldData) && (isEmptyDir(loc.data) || fs.existsSync(pending))) {
    fs.mkdirSync(loc.data, { recursive: true })
    // names already copied in full whose source couldn't be deleted: never copy those leftovers over again
    let state = { from: oldData, copied: [] }
    try { state = { ...state, ...JSON.parse(fs.readFileSync(pending, 'utf8')) } } catch {}
    const save = () => fs.writeFileSync(pending, JSON.stringify(state))
    save()
    const failed = [], moved = []
    for (const name of fs.readdirSync(oldData)) {
      if (state.copied.includes(name)) continue
      const from = path.join(oldData, name)
      // the AGY CLI is downloaded after install: a resource, not data; a newer download already there wins
      const agy = name === 'agy-setup' && !env.YZ_LLM_RESOURCES_DIR
      if (agy && fs.existsSync(path.join(loc.resources, 'agy-setup', 'agy.exe'))) continue
      try {
        if (move(from, agy ? path.join(loc.resources, 'agy-setup') : path.join(loc.data, name)) === 'copied') { state.copied.push(name); save() }
        moved.push(name)
      } catch (err) {
        failed.push(`${name}（${err?.code ?? err?.message ?? err}）`)
      }
    }
    if (moved.includes('images')) fs.writeFileSync(path.join(loc.data, MOVED_MARKER), JSON.stringify({ from: oldData, at: Date.now() }))
    if (moved.length) notes.push(`数据 ${moved.length} 项：${oldData} → ${loc.data}`)
    const left = fs.existsSync(oldData) ? fs.readdirSync(oldData) : []
    if (failed.length) notes.push(`以下数据暂时无法移动，下次启动会继续（也可停止机器人后手动移到 ${loc.data}）：${failed.join('、')}`)
    else {
      fs.rmSync(pending, { force: true })
      if (!left.length) fs.rmSync(oldData, { recursive: true, force: true })
      else notes.push(`${oldData} 里还剩 ${left.join('、')}（已复制到新位置，或已有更新的 AGY CLI），确认无用后可以删除`)
    }
  }
  // the AGY CLI is downloaded after install: a resource, not data
  const agy = path.join(loc.data, 'agy-setup')
  if (!env.YZ_LLM_RESOURCES_DIR && fs.existsSync(agy) && isEmptyDir(path.join(loc.resources, 'agy-setup'))) {
    move(agy, path.join(loc.resources, 'agy-setup'))
    notes.push(`AGY CLI：${agy} → ${path.join(loc.resources, 'agy-setup')}`)
  }
  return notes
}
