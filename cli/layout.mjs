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

const isEmptyDir = dir => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
  try {
    fs.renameSync(from, to)
  } catch {
    // another drive, or a file briefly held open: copy, then remove what was copied
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true })
    fs.rmSync(from, { recursive: true, force: true })
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

  const oldData = path.join(pluginRoot, 'data')
  if (!env.YZ_LLM_DATA_DIR && path.resolve(oldData) !== path.resolve(loc.data) && !isEmptyDir(oldData) && isEmptyDir(loc.data)) {
    move(oldData, loc.data)
    fs.writeFileSync(path.join(loc.data, MOVED_MARKER), JSON.stringify({ from: oldData, at: Date.now() }))
    notes.push(`数据：${oldData} → ${loc.data}`)
  }
  // the AGY CLI is downloaded after install: a resource, not data
  const agy = path.join(loc.data, 'agy-setup')
  if (!env.YZ_LLM_RESOURCES_DIR && fs.existsSync(agy) && isEmptyDir(path.join(loc.resources, 'agy-setup'))) {
    move(agy, path.join(loc.resources, 'agy-setup'))
    notes.push(`AGY CLI：${agy} → ${path.join(loc.resources, 'agy-setup')}`)
  }
  return notes
}
