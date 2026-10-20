#!/usr/bin/env node
/**
 * Install common game plugins into the SANDBOX runtime only (sandbox/.runtime/plugins), for testing
 * natural-language -> command dispatch against real rules. Does not touch the production plugins/ dir.
 *
 *   node sandbox/install-plugins.mjs            install/update all
 *   node sandbox/install-plugins.mjs miao-plugin genshin
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGINS = path.join(here, '.runtime', 'plugins')

const REPOS = {
  'miao-plugin': 'https://github.com/yoimiya-kokomi/miao-plugin',
  genshin: 'https://github.com/TimeRainStarSky/Yunzai-genshin',
  'StarRail-plugin': 'https://github.com/hewang1an/StarRail-plugin',
  'ZZZ-Plugin': 'https://github.com/ZZZure/ZZZ-Plugin',
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REPOS)
fs.mkdirSync(PLUGINS, { recursive: true })

for (const name of want) {
  const url = REPOS[name]
  if (!url) {
    console.error(`未知插件 ${name}，可选：${Object.keys(REPOS).join(', ')}`)
    continue
  }
  const dir = path.join(PLUGINS, name)
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      console.log(`[更新] ${name}`)
      execFileSync('git', ['-C', dir, 'pull', '--ff-only', '--depth', '1'], { stdio: 'inherit' })
    } else {
      console.log(`[克隆] ${name} <- ${url}`)
      execFileSync('git', ['clone', '--depth', '1', url, dir], { stdio: 'inherit' })
    }
    const pkg = path.join(dir, 'package.json')
    if (fs.existsSync(pkg)) {
      const deps = Object.keys(JSON.parse(fs.readFileSync(pkg, 'utf8')).dependencies ?? {})
      if (deps.length) {
        console.log(`[依赖] ${name}: ${deps.join(', ')}`)
        execFileSync('pnpm', ['install', '--prod', '--ignore-workspace', '--config.node-linker=hoisted'], { cwd: dir, stdio: 'inherit', shell: true })
      }
    }
  } catch (err) {
    console.error(`[失败] ${name}: ${err.message}`)
  }
}
console.log('完成。运行 node sandbox/run.mjs 后发送 p #llm扫描指令 / p #llm指令列表 查看识别到的指令。')
