import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = process.argv.indexOf('--distro')
const distro = index < 0 ? 'yunzai-sandbox' : process.argv[index + 1]
if (process.platform !== 'win32' || !/^[\w.-]+$/.test(distro ?? '')) throw new Error('Requires Windows and the existing dedicated WSL desktop distro')
const launcher = readFileSync(join(root, 'desktop/rustdesk-launch.py'), 'utf8').replace(/\r\n/g, '\n')
let script = readFileSync(join(root, 'desktop/rustdesk-setup.sh'), 'utf8').replace(/\r\n/g, '\n')
script += `\ncat > /usr/local/lib/llm-desktop/rustdesk-launch.py <<'RUSTDESK_LAUNCH_EOF'\n${launcher}\nRUSTDESK_LAUNCH_EOF\nchmod 644 /usr/local/lib/llm-desktop/rustdesk-launch.py\n`
script += `python3 - <<'RUSTDESK_HOOK_EOF'
import pathlib, py_compile
server = pathlib.Path('/usr/local/lib/llm-desktop/server.py')
source = server.read_text()
if 'rustdesk-launch.py' not in source:
    backup = pathlib.Path('/var/lib/llm-desktop/server.before-rustdesk.py')
    if not backup.exists():
        backup.write_text(source)
    anchor = 'chrome = pathlib.Path('
    if anchor not in source:
        raise RuntimeError('existing desktop startup anchor not found')
    hook = "if pathlib.Path('/home/pc/.config/llm-desktop/rustdesk-enabled').is_file() and pathlib.Path('/usr/local/lib/llm-desktop/rustdesk-launch.py').is_file():\\n    start(['python3', '/usr/local/lib/llm-desktop/rustdesk-launch.py'])\\n"
    server.write_text(source.replace(anchor, hook + anchor, 1))
py_compile.compile(str(server), doraise=True)
py_compile.compile('/usr/local/lib/llm-desktop/rustdesk-launch.py', doraise=True)
RUSTDESK_HOOK_EOF
`
const install = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'bash', '-s'], { input: script, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
if (install.status !== 0) process.exit(install.status ?? 1)
// This uses the existing desktop control socket: no setup, service restart or replacement display.
const request = { operation: 'exec', language: 'python', code: "import subprocess,os\np=subprocess.Popen(['python3','/usr/local/lib/llm-desktop/rustdesk-launch.py'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\nprint('RustDesk launcher started inside existing display :99 as UID',os.geteuid())" }
const start = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'python3', '/opt/llm-desktop/client.py'], { input: JSON.stringify(request), encoding: 'utf8', timeout: 50000, windowsHide: true })
if (start.error || start.status !== 0) throw new Error('RustDesk installed; existing desktop is not ready for launch')
const result = JSON.parse(start.stdout)
if (result.error || !result.text?.startsWith('Exit 0')) throw new Error('RustDesk installed; desktop launch failed')
console.log(result.text)
