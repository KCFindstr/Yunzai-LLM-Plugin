import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const PLUGIN_PATH = path.resolve('plugins/Yunzai-LLM-Plugin')
const CONFIG_PATH = path.join(PLUGIN_PATH, 'config', 'config.yaml')
const DEFAULT_CONFIG_PATH = path.join(PLUGIN_PATH, 'config', 'default_config.yaml')

class ConfigManager {
  constructor() {
    this.config = {}
    this.init()
  }

  init() {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
      fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH)
    }
    this.load()
    this.watch()
  }

  load() {
    try {
      const defaultContent = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')
      const defaultConfig = YAML.parse(defaultContent) || {}

      let userConfig = {}
      if (fs.existsSync(CONFIG_PATH)) {
        const userContent = fs.readFileSync(CONFIG_PATH, 'utf8')
        userConfig = YAML.parse(userContent) || {}
      }

      this.config = { ...defaultConfig, ...userConfig }
    } catch (err) {
      logger.error(`[Yunzai-LLM-Plugin] 加载配置文件失败: ${err.message}`)
    }
  }

  watch() {
    if (!fs.existsSync(CONFIG_PATH)) return
    try {
      fs.watch(CONFIG_PATH, (event) => {
        if (event === 'change') {
          setTimeout(() => {
            this.load()
            logger.info('[Yunzai-LLM-Plugin] 配置文件已热重载')
          }, 200)
        }
      })
    } catch (err) {
      logger.warn(`[Yunzai-LLM-Plugin] 监听配置文件失败: ${err.message}`)
    }
  }

  get() {
    return this.config
  }

  set(key, value) {
    this.config[key] = value
    try {
      let current = {}
      if (fs.existsSync(CONFIG_PATH)) {
        current = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
      }
      current[key] = value
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(current), 'utf8')
      return true
    } catch (err) {
      logger.error(`[Yunzai-LLM-Plugin] 保存配置文件失败: ${err.message}`)
      return false
    }
  }
}

export default new ConfigManager()
