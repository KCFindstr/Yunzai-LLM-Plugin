import './helpers.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const { formatExecResult, runInSandbox, renderInSandbox, cleanupSandbox } = await import('../src/tools/exec.ts')
const { wrapHtml } = await import('../src/render/browser.ts')

const base = { exitCode: 0, timedOut: false, killed: false, durationMs: 1234, stdout: '', stdoutTotal: 0, stderr: '', stderrTotal: 0, images: [] }

describe('run_code output', () => {
  it('reports exit status, streams and truncation', () => {
    const s = formatExecResult({ ...base, stdout: 'x'.repeat(100), stdoutTotal: 5000, stderr: 'warn', stderrTotal: 4 }, 3000)
    assert.match(s, /^退出码 0（1\.2s）/)
    assert.match(s, /\[stdout\]\nx{100}\n…（输出已截断，共 5000 字节）/)
    assert.match(s, /\[stderr\]\nwarn/)
  })
  it('explains timeouts, kills and missing output', () => {
    assert.match(formatExecResult({ ...base, timedOut: true, exitCode: 124 }, 1000), /超时/)
    assert.match(formatExecResult({ ...base, killed: true, exitCode: -15 }, 1000), /内存/)
    assert.match(formatExecResult(base, 1000), /print/)
  })
})

// Live checks against the real WSL sandbox; skipped where it hasn't been provisioned (npm run exec-setup).
const DISTRO = 'yunzai-sandbox'
const provisioned =
  process.platform === 'win32' &&
  spawnSync('wsl.exe', ['-d', DISTRO, '-u', 'root', '-e', 'test', '-f', '/opt/llm-sandbox/runner.py'], { timeout: 30000 }).status === 0
const cfg = { enable: true, distro: DISTRO, access: 'admin' as const, languages: ['python', 'node', 'bash'] as any, timeout: 10, memoryMB: 256, diskMB: 32, maxOutput: 2000, maxRunsPerTurn: 3 }

describe('WSL sandbox', { skip: !provisioned && `发行版 ${DISTRO} 未配置` }, () => {
  it('runs python and returns images from out/', async () => {
    const r = await runInSandbox(
      'python',
      'import struct,zlib\nprint(sum(range(101)))\n' +
        // minimal 1x1 png without third-party libs
        "raw=b'\\x00\\xff\\x00\\x00'\nc=lambda t,d:struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))\n" +
        "open('out/a.png','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))",
      cfg,
    )
    assert.equal(r.exitCode, 0, r.stderr)
    assert.equal(r.stdout.trim(), '5050')
    assert.equal(r.images.length, 1)
    assert.equal(r.images[0].name, 'a.png')
  })
  it('cannot see Windows drives, the plugin, or other runs', async () => {
    const r = await runInSandbox('bash', 'ls /mnt/c /mnt/d /var/lib/llm-sandbox /opt 2>&1; id -u; cat /etc/hostname', cfg)
    assert.doesNotMatch(r.stdout, /Yunzai|Windows|Users/)
    assert.match(r.stdout, /2000\nsandbox/)
  })
  it('blocks the host and private networks but allows DNS', async () => {
    const r = await runInSandbox(
      'python',
      [
        'import socket',
        'for h in ["127.0.0.1","10.255.255.254","172.16.0.1","192.168.1.1","169.254.169.254"]:',
        '    s=socket.socket(); s.settimeout(2)',
        '    try: s.connect((h,80)); print(h,"open")',
        '    except Exception as e: print(h,"blocked")',
        'print("dns", bool(socket.getaddrinfo("example.com",443)))',
      ].join('\n'),
      cfg,
    )
    assert.doesNotMatch(r.stdout, /open/)
    assert.match(r.stdout, /dns True/)
  })
  it('a session keeps /work across calls; render_html runs there and can use the files; cleanup wipes it', async () => {
    const session = `test-${Date.now()}`
    const code = [
      'import base64, os',
      "os.makedirs('img', exist_ok=True)",
      "open('img/dot.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))",
      "print('saved')",
    ].join('\n')
    const a = await runInSandbox('python', code, cfg, { session })
    assert.equal(a.stdout.trim(), 'saved', a.stderr)
    assert.equal(a.images.length, 0, 'img/ is not auto-sent, only out/')
    const b = await runInSandbox('bash', 'ls img', cfg, { session })
    assert.equal(b.stdout.trim(), 'dot.png')
    const html = wrapHtml('<h2>测试</h2><img src="img/dot.png" width="40"><img src="file:///etc/passwd"><script>document.title="x"</script>')
    const png = await renderInSandbox(html, cfg, { width: 400, maxHeight: 2000, allowNetwork: false, session })
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    cleanupSandbox(cfg, session)
    const c = await runInSandbox('bash', 'ls img 2>&1 || true', cfg, { session })
    assert.match(c.stdout, /No such file/)
    cleanupSandbox(cfg, session)
  })
  it('enforces the time and memory caps', async () => {
    const t = await runInSandbox('python', 'while True: pass', { ...cfg, timeout: 2 })
    assert.equal(t.timedOut, true)
    const m = await runInSandbox('python', 'x=[]\nwhile True: x.append(bytearray(10**7))', cfg)
    assert.equal(m.killed, true)
  })
})
