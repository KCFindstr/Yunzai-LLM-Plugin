import fs from 'node:fs'
import path from 'node:path'

const appsDir = path.resolve('plugins/Yunzai-LLM-Plugin/apps')
const files = fs.readdirSync(appsDir).filter(file => file.endsWith('.js'))

let apps = {}

for (const file of files) {
  const name = file.replace(/\.js$/, '')
  try {
    const mod = await import(`./apps/${file}`)
    const exportKey = Object.keys(mod)[0]
    apps[name] = mod[exportKey]
  } catch (err) {
    logger.error(`[Yunzai-LLM-Plugin] 载入子模块失败: ${file}`, err)
  }
}

logger.info('-----------------')
logger.info('[Yunzai-LLM-Plugin] v1.0.0 初始化成功！')
logger.info('-----------------')

export { apps }
