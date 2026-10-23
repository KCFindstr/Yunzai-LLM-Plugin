import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_DIR } from '../core/paths.ts'

/** Fixed-purpose VM bridge. No model-supplied commands, URLs, or host paths. */
export function lensBridge(distro: string, request: Record<string, unknown>, signal: AbortSignal): Promise<any> {
  if (!/^[\w.-]+$/.test(distro) || !/^[a-f0-9]{10}$/.test(String(request.job))) throw Error('Invalid Lens workspace')
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Error('Google Lens 操作已取消')); return }
    const script = readFileSync(path.join(PLUGIN_DIR, 'desktop/lens-bridge.py'), 'utf8')
    const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'python3', '-c', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = '', settled = false
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) { child.kill(); reject(error) } else resolve(result)
    }
    const abort = () => finish(Error('Google Lens 操作已取消或超时，请检查虚拟机浏览器后重试'))
    const timer = setTimeout(abort, 54_000)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 5_100_000) finish(Error('Google Lens 返回内容超限')) })
    child.on('error', () => finish(Error('Google Lens 虚拟机连接暂不可用')))
    child.on('close', code => {
      try { if (code !== 0) throw Error(); finish(undefined, JSON.parse(output)) }
      catch { finish(Error('Google Lens 上传未完成，请检查虚拟机浏览器后重试')) }
    })
    child.stdin.on('error', () => finish(Error('Google Lens 请求未能发送')))
    child.stdin.end(JSON.stringify(request))
  })
}
