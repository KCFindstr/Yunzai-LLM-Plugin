import { spawn } from 'node:child_process'
import type { ComputerConfig } from '../core/configTypes.ts'
import type { ImagePart } from '../llm/types.ts'
import { readComputerImages } from './attachments.ts'
import type { ComputerJob } from './queue.ts'

// Trusted transport, not a model-visible tool. Run as pc, never root, and only write below its mounted /work.
// dir_fd + O_NOFOLLOW prevent the shared desktop from redirecting a later import through symlinks.
const IMPORT_IMAGES = `import base64, hashlib, json, os, re, sys, uuid
if os.geteuid() == 0:
    raise ValueError('image import must run as the desktop user')
request = json.loads(sys.stdin.buffer.read(40_000_001))
job = request['job']
images = request['images']
if not re.fullmatch(r'[a-f0-9]{10}', job) or not isinstance(images, list) or not 1 <= len(images) <= 8:
    raise ValueError('invalid attachment request')
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
root = os.open('/var/lib/llm-desktop/disk/work', flags)
try:
    for name in ('attachments', job):
        try:
            os.mkdir(name, 0o700, dir_fd=root)
        except FileExistsError:
            pass
        child = os.open(name, flags, dir_fd=root)
        os.close(root)
        root = child
    for image in images:
        name = image['name']
        if not re.fullmatch(r'image-[1-8]-[a-f0-9]{12}\\.(png|jpg|gif|webp|bmp)', name):
            raise ValueError('invalid attachment filename')
        data = base64.b64decode(image['data'], validate=True)
        if not 0 < len(data) <= 3_700_000 or hashlib.sha1(data).hexdigest()[:12] not in name:
            raise ValueError('invalid attachment bytes')
        temporary = '.' + uuid.uuid4().hex
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            os.replace(temporary, name, src_dir_fd=root, dst_dir_fd=root)
        finally:
            try:
                os.unlink(temporary, dir_fd=root)
            except FileNotFoundError:
                pass
finally:
    os.close(root)
print(json.dumps({'count': len(images)}))
`

/** The persistent desktop service must be ready (and its disk mounted) before importing. */
export async function stageComputerImages(cfg: ComputerConfig, job: ComputerJob, signal?: AbortSignal): Promise<void> {
  if (!job.inputImages?.length) return
  if (process.platform !== 'win32' || !/^[\w.-]+$/.test(cfg.distro)) throw new Error('无效的电脑环境')
  const payload = JSON.stringify({ job: job.id, images: readComputerImages(job.id, job.inputImages) })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', cfg.distro, '-u', 'pc', '-e', 'python3', '-c', IMPORT_IMAGES], { windowsHide: true, signal })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 50000)
    child.stdout.on('data', chunk => { if (Buffer.concat(chunks).length < 4096) chunks.push(chunk) })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      try {
        if (code !== 0 || JSON.parse(Buffer.concat(chunks).toString('utf8')).count !== job.inputImages!.length) throw new Error('import failed')
        resolve()
      } catch { reject(new Error('图片无法复制到电脑桌面；请检查桌面服务及 /work 磁盘空间，勿猜测图片路径')) }
    })
    child.stdin.end(payload)
  })
}

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
