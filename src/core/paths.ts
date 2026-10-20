import path from 'node:path'

export const PLUGIN_NAME = 'Yunzai-LLM-Plugin'

/** Plugin root. Yunzai runs with cwd = bot root, so this matches how other plugins locate themselves. */
export const PLUGIN_DIR = process.env.YZ_LLM_PLUGIN_DIR || path.resolve('plugins', PLUGIN_NAME)
export const CONFIG_DIR = process.env.YZ_LLM_CONFIG_DIR || path.join(PLUGIN_DIR, 'config')
export const DATA_DIR = process.env.YZ_LLM_DATA_DIR || path.join(PLUGIN_DIR, 'data')
export const SKILLS_DIR = process.env.YZ_LLM_SKILLS_DIR || path.join(PLUGIN_DIR, 'skills')
export const TOOLS_DIR = process.env.YZ_LLM_TOOLS_DIR || path.join(PLUGIN_DIR, 'tools')
export const STICKER_DIR = path.join(DATA_DIR, 'stickers')

export const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, 'default_config.yaml')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml')
