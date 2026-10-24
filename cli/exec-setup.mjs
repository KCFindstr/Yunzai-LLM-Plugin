#!/usr/bin/env node
// Provision (or update) the WSL distro used by the run_code tool.
//   npm run exec-setup                       # distro "yunzai-llm-sandbox", must already exist
//   npm run exec-setup -- --distro <name>
//   npm run exec-setup -- --install          # also create the distro (Ubuntu 26.04) under ~/WSL/<name>
//   npm run exec-setup -- --install --location <dir>
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = n => args.includes(n)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const distro = opt('--distro', 'yunzai-llm-sandbox')

if (process.platform !== 'win32') {
  console.error('仅支持 Windows（WSL2）')
  process.exit(1)
}

function wsl(argv, input) {
  const r = spawnSync('wsl.exe', argv, { input, stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] })
  return r.status ?? 1
}

const listed = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' }).stdout ?? ''
const exists = listed.split(/\r?\n/).map(s => s.replace(/\0/g, '').trim()).includes(distro)
if (!exists) {
  if (!flag('--install')) {
    console.error(`WSL 发行版 ${distro} 不存在。加 --install 自动创建（Ubuntu 26.04），或用 --distro 指定已有的专用发行版。`)
    process.exit(1)
  }
  // Only creation needs the location; everything else reaches the distro by name (wsl -d <name>)
  const loc = opt('--location', join(homedir(), 'WSL', distro))
  if (wsl(['--install', 'Ubuntu-26.04', '--name', distro, '--location', loc, '--no-launch', '--web-download'])) process.exit(1)
}

const script =
  readFileSync(join(root, 'exec', 'setup.sh'), 'utf8') +
  "cat > /opt/llm-sandbox/runner.py <<'RUNNER_EOF'\n" +
  readFileSync(join(root, 'exec', 'runner.py'), 'utf8') +
  'RUNNER_EOF\nchmod 700 /opt/llm-sandbox/runner.py\n' +
  "cat > /usr/local/lib/llm-render/render.mjs <<'RENDER_EOF'\n" +
  readFileSync(join(root, 'exec', 'render.mjs'), 'utf8') +
  'RENDER_EOF\nchmod 644 /usr/local/lib/llm-render/render.mjs\necho "sandbox ready"\n'

console.log(`配置 ${distro} …（首次需要安装软件包，可能要几分钟）`)
if (wsl(['-d', distro, '-u', 'root', '-e', 'bash', '-s'], script.replace(/\r\n/g, '\n'))) process.exit(1)
// wsl.conf changes (no Windows mounts / interop) only apply after the distro restarts
wsl(['--terminate', distro])
console.log(`完成。启用：npm run config -- set tools.exec.enable true（发行版：${distro}）`)
