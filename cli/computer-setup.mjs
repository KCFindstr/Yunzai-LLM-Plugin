import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--distro')
const distro = index < 0 ? 'yunzai-sandbox' : process.argv[index + 1]
if (process.platform !== 'win32' || !/^[\w.-]+$/.test(distro ?? '')) throw new Error('Requires Windows and a dedicated WSL sandbox distro')
let script = readFileSync(join(root, 'desktop/setup.sh'), 'utf8')
for (const [source, target] of [['server.py', '/usr/local/lib/llm-desktop/server.py'], ['client.py', '/opt/llm-desktop/client.py'], ['theme.py', '/opt/llm-desktop/theme.py'], ['install-font.py', '/opt/llm-desktop/install-font.py'], ['rustdesk-launch.py', '/usr/local/lib/llm-desktop/rustdesk-launch.py']]) {
  script += `\ncat > ${target} <<'DESKTOP_FILE_EOF'\n${readFileSync(join(root, 'desktop', source), 'utf8')}\nDESKTOP_FILE_EOF\n`
}
script += '\npython3 /opt/llm-desktop/install-font.py\nfc-cache -f\npython3 /opt/llm-desktop/theme.py\nchown -R pc:pc /var/lib/llm-desktop/disk/home\nchmod 644 /usr/local/lib/llm-desktop/server.py\nsystemctl daemon-reload\nsystemctl enable llm-desktop.service\nsystemctl restart llm-desktop.service\nsleep 4\nsystemctl is-active llm-desktop.service\n'
const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'bash', '-s'], { input: script.replace(/\r\n/g, '\n'), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
process.exitCode = result.status ?? 1
