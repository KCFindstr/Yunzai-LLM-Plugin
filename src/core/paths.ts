import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Plugin root, located from this file so the clone folder name does not matter. */
export const PLUGIN_DIR = process.env.YZ_LLM_PLUGIN_DIR || PLUGIN_ROOT
export const CONFIG_DIR = process.env.YZ_LLM_CONFIG_DIR || path.join(PLUGIN_DIR, 'config')
export const DATA_DIR = process.env.YZ_LLM_DATA_DIR || path.join(PLUGIN_DIR, 'data')
export const SKILLS_DIR = process.env.YZ_LLM_SKILLS_DIR || path.join(PLUGIN_DIR, 'skills')
export const TOOLS_DIR = process.env.YZ_LLM_TOOLS_DIR || path.join(PLUGIN_DIR, 'tools')
export const STICKER_DIR = path.join(DATA_DIR, 'stickers')

export const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, 'default_config.yaml')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml')
