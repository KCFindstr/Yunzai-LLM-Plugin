import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { PluginConfig } from '../types/index.js'

const PLUGIN_PATH = path.resolve('plugins/Yunzai-LLM-Plugin')
const CONFIG_PATH = path.join(PLUGIN_PATH, 'config', 'config.yaml')
const DEFAULT_CONFIG_PATH = path.join(PLUGIN_PATH, 'config', 'default_config.yaml')

const DEFAULT_FALLBACK: PluginConfig = {
  apiUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '你是一个友好、幽默且富有智慧的 QQ 聊天助手。请用自然、亲切的中文与用户交流，回答要精炼准确，排版清晰。',
  temperature: 0.7,
  maxTokens: 2048,
  timeout: 60,
  prefix: ['#chat', '#ai', 'chat', 'ai'],
  atReply: true,
  replyQuote: true,
  historyLimit: 10,
  historyTimeout: 30,
  isolateUserInGroup: true
}

class ConfigManager {
  private config: PluginConfig = { ...DEFAULT_FALLBACK }

  constructor() {
    this.init()
  }

  private init(): void {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
      try {
        fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH)
      } catch {}
    }
    this.load()
    this.watch()
  }

  load(): void {
    try {
      let defaultConfig: Partial<PluginConfig> = {}
      if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
        const defaultContent = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')
        defaultConfig = YAML.parse(defaultContent) || {}
      }

      let userConfig: Partial<PluginConfig> = {}
      if (fs.existsSync(CONFIG_PATH)) {
        const userContent = fs.readFileSync(CONFIG_PATH, 'utf8')
        userConfig = YAML.parse(userContent) || {}
      }

      this.config = {
        ...DEFAULT_FALLBACK,
        ...defaultConfig,
        ...userConfig
      }
    } catch (err: any) {
      if (typeof logger !== 'undefined') {
        logger.error(`[Yunzai-LLM-Plugin] 加载配置文件失败: ${err.message}`)
      }
    }
  }

  private watch(): void {
    if (!fs.existsSync(CONFIG_PATH)) return
    try {
      fs.watch(CONFIG_PATH, (event) => {
        if (event === 'change') {
          setTimeout(() => {
            this.load()
            if (typeof logger !== 'undefined') {
              logger.info('[Yunzai-LLM-Plugin] 配置文件已热重载')
            }
          }, 200)
        }
      })
    } catch (err: any) {
      if (typeof logger !== 'undefined') {
        logger.warn(`[Yunzai-LLM-Plugin] 监听配置文件失败: ${err.message}`)
      }
    }
  }

  get(): PluginConfig {
    return this.config
  }

  set<K extends keyof PluginConfig>(key: K, value: PluginConfig[K]): boolean {
    this.config[key] = value
    try {
      let current: Record<string, any> = {}
      if (fs.existsSync(CONFIG_PATH)) {
        current = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
      }
      current[key] = value
      fs.writeFileSync(CONFIG_PATH, YAML.stringify(current), 'utf8')
      return true
    } catch (err: any) {
      if (typeof logger !== 'undefined') {
        logger.error(`[Yunzai-LLM-Plugin] 保存配置文件失败: ${err.message}`)
      }
      return false
    }
  }
}

export default new ConfigManager()
