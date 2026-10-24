import { provisionImageStore } from './image-store.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--distro')
const distro = index < 0 ? 'yunzai-llm-sandbox' : process.argv[index + 1]
if (process.platform !== 'win32' || !/^[\w.-]+$/.test(distro ?? '')) throw Error('Requires Windows and a dedicated WSL desktop distro')
provisionImageStore(distro, root)
function wsl(args, input) {
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 180000 })
  if (result.status !== 0) throw Error(result.stderr || 'Lens setup failed')
}
// Keep the historical paths so existing installations work without migrating browser dependencies.
wsl(['sh', '-c', 'test -r /opt/llm-desktop/client.py && test -x /opt/google/chrome/chrome'])
wsl(['sh', '-c', 'install -d -m 755 /opt/llm-agy; cat > /opt/llm-agy/google-image-search.py; chmod 644 /opt/llm-agy/google-image-search.py'], readFileSync(join(root, 'desktop/agy-google-search.py')))
wsl(['sh', '-c', 'test -d /usr/local/lib/agy-browser/playwright || python3 -m pip install --target /usr/local/lib/agy-browser playwright==1.55.0 >/tmp/lens-browser-setup.log 2>&1'])
wsl(['systemctl', 'is-active', '--quiet', 'llm-desktop.service'])
console.log('Google Lens browser support is ready. No AGY CLI, login or service is required.')
