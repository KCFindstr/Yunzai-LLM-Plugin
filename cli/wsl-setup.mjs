import { spawnSync } from 'node:child_process'
import { isUtf8 } from 'node:buffer'

const installHelp = '在管理员 PowerShell 中运行 wsl --install --no-distribution --web-download，按提示重启 Windows，然后运行 wsl --update --web-download。'
const options = { windowsHide: true, timeout: 60000 }

// Windows WSL messages can be UTF-16LE, while Linux output is UTF-8.
export function decodeWslOutput(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '').replaceAll('\0', '')
  const utf16 = (value[0] === 0xff && value[1] === 0xfe) || value.includes(0) || !isUtf8(value)
  return value.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replaceAll('\0', '')
}

function detail(result) {
  return result.error?.message || [decodeWslOutput(result.stderr), decodeWslOutput(result.stdout)].filter(Boolean).join('\n').trim()
}

export function inspectWsl(run = spawnSync) {
  const result = run('wsl.exe', ['--help'], options)
  if (result.error || result.status !== 0) throw Error(`无法运行 WSL：${detail(result)}\n${installHelp}`)
  const help = decodeWslOutput(result.stdout)
  // The Windows installation-only launcher prints help (sometimes with exit 0)
  // for distro execution arguments. Merely finding wsl.exe is not sufficient.
  if (!/--exec\b/.test(help)) throw Error(`WSL 尚未就绪：当前 wsl.exe 不支持 --exec，可能尚未完成安装。\n${installHelp}`)
  const listed = run('wsl.exe', ['--list', '--quiet'], options)
  if (listed.error || listed.status !== 0) throw Error(`无法列出 WSL 发行版：${detail(listed)}\n${installHelp}`)
  const output = decodeWslOutput(listed.stdout)
  if (/--(?:install|help)\b/.test(output)) throw Error(`WSL 未返回可用的发行版列表。\n${installHelp}`)
  return { help, distros: output.split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
}

export function requireWslInstallSupport(help) {
  const missing = ['--name', '--location', '--no-launch', '--web-download'].filter(option => !help.includes(option))
  if (missing.length) throw Error(`当前 WSL 不支持创建专用发行版所需的参数：${missing.join(', ')}。\n请在管理员 PowerShell 中运行 wsl --update --web-download，然后重试 exec-setup -- --install。`)
}

export function requireWsl2(distro, run = spawnSync) {
  const result = run('wsl.exe', ['--list', '--verbose'], options)
  if (result.error || result.status !== 0) throw Error(`无法检查 WSL2 发行版：${detail(result)}`)
  const escaped = distro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const version = decodeWslOutput(result.stdout).match(new RegExp(`^\\s*\\*?\\s*${escaped}\\s+.+?\\s+([12])\\s*$`, 'im'))?.[1]
  if (version !== '2') throw Error(`发行版 ${distro} 必须使用 WSL2。请先运行 wsl --set-version ${distro} 2，再重试。`)
}

export function requireComputerSandbox(distro, run = spawnSync) {
  const { distros } = inspectWsl(run)
  if (!distros.some(name => name.toLowerCase() === distro.toLowerCase())) {
    throw Error(`WSL 发行版 ${distro} 不存在。请先运行 npm run exec-setup -- --install --distro ${distro}，再运行 computer-setup。`)
  }
  requireWsl2(distro, run)
  const script = `set -eu
if [ ! -f /opt/llm-sandbox/runner.py ]; then
  echo YZ_LLM_SANDBOX_MISSING
  exit 1
fi
if [ "$(cat /proc/1/comm)" != systemd ]; then
  echo YZ_LLM_SYSTEMD_MISSING
  exit 1
fi
echo YZ_LLM_SANDBOX_READY
`
  const result = run('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sh', '-s'], { ...options, input: script })
  const output = decodeWslOutput(result.stdout).trim()
  if (output === 'YZ_LLM_SANDBOX_MISSING') throw Error(`发行版 ${distro} 尚未完成沙盒配置。请先运行 npm run exec-setup -- --distro ${distro}，再运行 computer-setup。`)
  if (output === 'YZ_LLM_SYSTEMD_MISSING') throw Error(`发行版 ${distro} 未以 systemd 启动。请更新 WSL，运行 npm run exec-setup -- --distro ${distro}，并确认发行版已重启后再运行 computer-setup。`)
  if (result.error || result.status !== 0 || output !== 'YZ_LLM_SANDBOX_READY') throw Error(`无法启动 WSL 沙盒 ${distro}：${detail(result) || '未收到就绪确认'}\n请检查 wsl --status 和 wsl --list --verbose。`)
}
