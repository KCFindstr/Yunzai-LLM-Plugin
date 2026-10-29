import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// shared with the CLI scripts, so both resolve (and migrate) the same folders
import { locations, migrateLayout } from '../../cli/layout.mjs'

/** Nearest package.json above this module: the plugin root whether running from dist/index.js or src/core/paths.ts. */
function findPluginRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve('plugins', 'Yunzai-LLM-Plugin')
    dir = parent
  }
  return dir
}

const PLUGIN_ROOT = findPluginRoot()
/** Folder name under plugins/ (e.g. Yunzai-LLM-Plugin-main for a zip download), not a fixed string. */
export const PLUGIN_NAME = path.basename(PLUGIN_ROOT)

/** Plugin root, located from this file so the clone folder name does not matter. Shipped files only. */
export const PLUGIN_DIR = process.env.YZ_LLM_PLUGIN_DIR || PLUGIN_ROOT

const loc = locations(PLUGIN_ROOT)
/**
 * Config and data used to live inside the plugin folder; they move to the Yunzai-standard folders before anything
 * reads them. Logged once the logger is up (src/core/layout.ts).
 */
export const LAYOUT_NOTES: string[] = (() => {
  try {
    return migrateLayout(PLUGIN_ROOT, loc)
  } catch (err: any) {
    return [`迁移旧目录失败，请手动移动：${err?.message ?? err}`]
  }
})()

/** Yunzai/config/Yunzai-LLM-Plugin: config.yaml, persona files, backups */
export const CONFIG_DIR = loc.config
/** Yunzai/data/Yunzai-LLM-Plugin: every runtime file */
export const DATA_DIR = loc.data
/** Yunzai/resources/Yunzai-LLM-Plugin: files downloaded after install */
export const RESOURCES_DIR = loc.resources
/** Yunzai/temp/Yunzai-LLM-Plugin */
export const TEMP_DIR = loc.temp
/** skills shipped with the plugin */
export const SHIPPED_SKILLS_DIR = path.join(PLUGIN_DIR, 'skills')
/** skills written by the user (web panel, by hand): they override shipped ones of the same name */
export const SKILLS_DIR = process.env.YZ_LLM_SKILLS_DIR || path.join(CONFIG_DIR, 'skills')
/** the user's custom JS tools (tools/README.md in the plugin explains the format) */
export const TOOLS_DIR = process.env.YZ_LLM_TOOLS_DIR || path.join(CONFIG_DIR, 'tools')
export const STICKER_DIR = path.join(DATA_DIR, 'stickers')
/** AGY host CLI installed by `npm run agy-setup` */
export const AGY_EXECUTABLE = path.join(RESOURCES_DIR, 'agy-setup', 'agy.exe')

/** shipped with the plugin; user overrides go to CONFIG_FILE */
export const DEFAULT_CONFIG_FILE = path.join(PLUGIN_DIR, 'config', 'default_config.yaml')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml')
