import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
// the same mount script `npm run exec-setup / computer-setup / lens-setup` installs
import { imageMountScript } from '../../cli/image-store.mjs'
import { MOVED_MARKER } from '../../cli/layout.mjs'
import { config } from './config.ts'
import { log } from './log.ts'
import { DATA_DIR, LAYOUT_NOTES } from './paths.ts'
import { IMAGE_STORE_ROOT } from '../chat/images.ts'

function wslRoot(distro: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sh', '-s'], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))))
    child.stdin.end(script)
  })
}

/**
 * After config and data moved to the Yunzai-standard folders (cli/layout.mjs): say so, and repoint the read-only
 * image mount of each WSL distro the code runner / desktop / Google Lens use, which still names the old folder.
 */
export async function finishLayoutMigration() {
  if (LAYOUT_NOTES.length) log.mark(`已按 Yunzai 插件规范迁移目录：\n- ${LAYOUT_NOTES.join('\n- ')}`)
  const marker = path.join(DATA_DIR, MOVED_MARKER)
  if (!fs.existsSync(marker) || process.platform !== 'win32') return
  const t = config.get().tools
  const distros = [...new Set([t.exec, t.computer, t.googleLens].filter(x => x.enable).map(x => x.distro))]
  const failed: string[] = []
  for (const distro of distros) {
    try {
      await wslRoot(distro, imageMountScript(path.resolve(IMAGE_STORE_ROOT), true))
      log.mark(`WSL 发行版 ${distro} 的图片库挂载已指向 ${IMAGE_STORE_ROOT}`)
    } catch (err: any) {
      failed.push(distro)
      log.warn(`WSL 发行版 ${distro} 的图片库挂载更新失败（${err?.message ?? err}），可重新运行 npm run exec-setup / computer-setup 修复`)
    }
  }
  // keep the marker until every distro is repointed, so the next start retries
  if (!failed.length) fs.rmSync(marker, { force: true })
}
