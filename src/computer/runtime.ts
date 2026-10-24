import { spawn } from 'node:child_process'
import type { ComputerConfig } from '../core/configTypes.ts'
import type { ImagePart } from '../llm/types.ts'

export interface Observation {
  text: string
  image?: ImagePart & { width?: number; height?: number }
  error?: string
}

export async function desktopRequest(cfg: ComputerConfig, request: Record<string, any>, signal?: AbortSignal): Promise<Observation> {
  if (process.platform !== 'win32') throw new Error('电脑环境需要 Windows 上的专用 WSL 发行版')
  if (!/^[\w.-]+$/.test(cfg.distro)) throw new Error('无效的 WSL 发行版')
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', cfg.distro, '-u', 'root', '-e', 'python3', '/opt/llm-desktop/client.py'], { windowsHide: true, signal })
    const chunks: Buffer[] = []
    let bytes = 0
    const timer = setTimeout(() => child.kill(), 50000)
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 12_000_000) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdin.on('error', () => {})
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (result.error) throw new Error(result.error)
        resolve({ text: String(result.text ?? ''), ...(result.image ? { image: { ...result.image, type: 'image', detail: 'original' } } : {}) })
      } catch (error) {
        reject(new Error(`电脑环境未就绪或请求失败：${error instanceof SyntaxError ? '请检查 llm-desktop 服务' : (error as Error).message}`))
      }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
