import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { decodeWslOutput, inspectWsl, requireComputerSandbox, requireWsl2, requireWslInstallSupport } from '../cli/wsl-setup.mjs'

const distro = 'yunzai-llm-sandbox'
const help = '--exec --distribution --list --quiet --verbose --install --name --location --no-launch --web-download'
const ok = (text = '', encoding: BufferEncoding = 'utf8') => ({ status: 0, stdout: Buffer.from(text, encoding), stderr: Buffer.alloc(0) })
const verbose = (version = 2) => ok(`  NAME                  STATE           VERSION\r\n* ${distro}     已停止          ${version}\r\n`, 'utf16le')

function replies(...results: any[]) {
  const calls: { args: string[], options: any }[] = []
  const run = (file: string, args: string[], options: any) => {
    assert.equal(file, 'wsl.exe')
    assert.equal(options.windowsHide, true)
    calls.push({ args, options })
    assert.ok(results.length, `Unexpected WSL call: ${args.join(' ')}`)
    return results.shift()
  }
  return { run, calls }
}

describe('WSL setup prerequisites', () => {
  it('decodes localized UTF-16LE Windows output and UTF-8 Linux output', () => {
    assert.equal(decodeWslOutput(Buffer.from('\uFEFF发行版\r\n', 'utf16le')), '发行版\r\n')
    assert.equal(decodeWslOutput(Buffer.from('\uFEFF沙盒 ready\n')), '沙盒 ready\n')
    assert.equal(decodeWslOutput(undefined), '')
  })

  it('recognizes the screenshot installation-only launcher even when it exits successfully', () => {
    const { run, calls } = replies(ok('用法: wsl.exe [Argument]\r\n--install --distribution --no-distribution --list --online --status --help', 'utf16le'))
    assert.throws(() => inspectWsl(run), /不支持 --exec[\s\S]*wsl --install --no-distribution --web-download[\s\S]*重启/)
    assert.equal(calls.length, 1, 'do not attempt Linux commands against the installation launcher')
  })

  it('reports a missing executable or failed WSL command with installation guidance', () => {
    const missing = replies({ status: null, error: new Error('spawnSync wsl.exe ENOENT') })
    assert.throws(() => inspectWsl(missing.run), /ENOENT[\s\S]*管理员 PowerShell/)
    const failed = replies({ ...ok(), status: 1, stderr: Buffer.from('需要重启', 'utf16le') })
    assert.throws(() => inspectWsl(failed.run), /需要重启[\s\S]*wsl --install/)
  })

  it('does not mistake a failed or help-only distro listing for a missing distro', () => {
    const failed = replies(ok(help), { ...ok('虚拟机平台未启用', 'utf16le'), status: 1 })
    assert.throws(() => inspectWsl(failed.run), /无法列出 WSL 发行版：虚拟机平台未启用/)
    const helpOnly = replies(ok(help), ok('用法: wsl.exe --install --help', 'utf16le'))
    assert.throws(() => inspectWsl(helpOnly.run), /未返回可用的发行版列表/)
  })

  it('accepts UTF-8 and UTF-16 distro lists, including an empty list', () => {
    for (const encoding of ['utf8', 'utf16le'] as const) {
      const { run } = replies(ok(help, encoding), ok(`\uFEFF${distro}\r\nUbuntu\r\n`, encoding))
      assert.deepEqual(inspectWsl(run).distros, [distro, 'Ubuntu'])
    }
    assert.deepEqual(inspectWsl(replies(ok(help), ok()).run).distros, [])
  })

  it('gives the full first-install command when the selected distro is absent', () => {
    const { run, calls } = replies(ok(help), ok('Ubuntu\n'))
    assert.throws(() => requireComputerSandbox(distro, run), /npm run exec-setup -- --install --distro yunzai-llm-sandbox/)
    assert.equal(calls.length, 2)
  })

  it('requires WSL2 for the exact selected distro before executing Linux setup', () => {
    const { run, calls } = replies(ok(help), ok(distro), verbose(1))
    assert.throws(() => requireComputerSandbox(distro, run), /wsl --set-version yunzai-llm-sandbox 2/)
    assert.equal(calls.length, 3)
    const dotted = replies(ok('* sandboxXtest Running 2\n  sandbox.test Stopped 1\n'))
    assert.throws(() => requireWsl2('sandbox.test', dotted.run), /必须使用 WSL2/)
  })

  it('explains a missing exec-setup installation and inactive systemd', () => {
    for (const [marker, message] of [['YZ_LLM_SANDBOX_MISSING', /尚未完成沙盒配置/], ['YZ_LLM_SYSTEMD_MISSING', /未以 systemd 启动/]] as const) {
      const { run } = replies(ok(help), ok(distro), verbose(), { ...ok(`${marker}\n`), status: 1 })
      assert.throws(() => requireComputerSandbox(distro, run), (error: Error) => {
        assert.match(error.message, message)
        assert.match(error.message, /npm run exec-setup -- --distro yunzai-llm-sandbox/)
        return true
      })
    }
  })

  it('requires a successful Linux readiness acknowledgement, not just exit zero', () => {
    for (const result of [ok('用法: wsl.exe --help', 'utf16le'), { ...ok('YZ_LLM_SANDBOX_READY\n'), status: 1 }, { status: null, error: new Error('WSL boot failed') }]) {
      const { run } = replies(ok(help), ok(distro), verbose(), result)
      assert.throws(() => requireComputerSandbox(distro, run), /无法启动 WSL 沙盒/)
    }
  })

  it('accepts a ready sandbox case-insensitively and probes without changing Linux files', () => {
    const { run, calls } = replies(ok(help), ok(distro.toUpperCase(), 'utf16le'), verbose(), ok('YZ_LLM_SANDBOX_READY\n'))
    requireComputerSandbox(distro, run)
    assert.deepEqual(calls[3].args, ['-d', distro, '-u', 'root', '-e', 'sh', '-s'])
    assert.match(calls[3].options.input, /\[ ! -f \/opt\/llm-sandbox\/runner.py \]/)
    assert.match(calls[3].options.input, /\/proc\/1\/comm/)
    assert.doesNotMatch(calls[3].options.input, /apt-get|mount |mkdir|\r/)
  })

  it('requires modern named-distro install options and explains how to update WSL', () => {
    assert.throws(() => requireWslInstallSupport('--exec --install --no-launch --web-download'), /--name, --location[\s\S]*wsl --update --web-download/)
    assert.doesNotThrow(() => requireWslInstallSupport(help))
  })
})

// Mock only WSL at the process boundary; exercise the actual npm entry scripts.
function runSetup(entry: string, launcherHelp: string, names = '', args: string[] = [], installStatus?: number) {
  const url = new URL(`../cli/${entry}.mjs`, import.meta.url).href
  const code = `
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    const calls = []
    childProcess.spawnSync = (file, args) => {
      calls.push(args)
      if (file !== 'wsl.exe') throw Error('Unexpected executable: ' + file)
      let output
      if (args[0] === '--help') output = ${JSON.stringify(launcherHelp)}
      else if (args.join(' ') === '--list --quiet') output = ${JSON.stringify(names)}
      else if (args[0] === '--install' && ${installStatus !== undefined}) return { status: ${installStatus ?? 1} }
      else throw Error('Unexpected WSL mutation: ' + args.join(' '))
      return { status: 0, stdout: Buffer.from(output, 'utf16le'), stderr: Buffer.alloc(0) }
    }
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.argv = [process.execPath, ${JSON.stringify(url)}, ...${JSON.stringify(args)}]
    process.on('exit', () => console.log('WSL_CALLS=' + JSON.stringify(calls)))
    await import(${JSON.stringify(url)})
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
}

describe('setup command regression', () => {
  for (const entry of ['computer-setup', 'exec-setup']) {
    it(`${entry} fails clearly on the screenshot launcher without attempting installation`, () => {
      const result = runSetup(entry, '--install --no-distribution --list --online --help')
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /WSL 尚未就绪[\s\S]*wsl --install --no-distribution --web-download/)
      assert.doesNotMatch(result.stderr, /\n\s+at /)
      assert.equal(result.stdout.trim(), 'WSL_CALLS=[["--help"]]')
    })
  }

  it('computer-setup directs a first-time user to exec-setup before any mounts', () => {
    const result = runSetup('computer-setup', help, '', ['--distro', 'new-sandbox'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /npm run exec-setup -- --install --distro new-sandbox/)
    assert.equal(result.stdout.trim(), 'WSL_CALLS=[["--help"],["--list","--quiet"]]')
  })

  it('exec-setup rejects unsupported named installs before calling --install', () => {
    const result = runSetup('exec-setup', '--exec --install --no-launch --web-download', '', ['--install'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--name, --location[\s\S]*wsl --update/)
    assert.equal(result.stdout.trim(), 'WSL_CALLS=[["--help"],["--list","--quiet"]]')
  })

  it('exec-setup passes an explicit distribution and preserves the named install location', () => {
    const location = 'C:\\WSL Sandboxes\\new-sandbox'
    // Deliberately fail the mocked install so no provisioning runs.
    const result = runSetup('exec-setup', help, '', ['--install', '--distro', 'new-sandbox', '--location', location], 1)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    const calls = JSON.parse(result.stdout.trim().slice('WSL_CALLS='.length))
    assert.deepEqual(calls.at(-1), ['--install', '--distribution', 'Ubuntu-26.04', '--name', 'new-sandbox', '--location', location, '--no-launch', '--web-download'])
    assert.equal(calls.length, 3)
  })
})
