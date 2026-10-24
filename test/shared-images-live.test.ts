import { PLUGIN_ROOT, TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { saveImage, imageScope } from '../src/chat/images.ts'
import { runInSandbox } from '../src/tools/exec.ts'
import { desktopRequest } from '../src/computer/runtime.ts'
import { stageAgy } from '../src/agy/runtime.ts'
import { config } from '../src/core/config.ts'
import { sha1 } from '../src/core/util.ts'
import type { ComputerJob } from '../src/computer/queue.ts'

const live = process.platform === 'win32' && process.env.YZ_LLM_COMPUTER_LIVE === '1'
it('all sandboxes read unused global images by raw path and reject writes to the store', { skip: !live }, async () => {
  config.load()
  const id = randomBytes(5).toString('hex'), scope = imageScope(id)
  const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64')
  const image = saveImage(scope, { type: 'image', data: buffer.toString('base64') })
  const fixture = path.join(PLUGIN_ROOT, 'data/images', scope)
  assert.ok(!fs.existsSync(fixture))
  fs.cpSync(path.join(TMP, 'data/images', scope), fixture, { recursive: true })
  const distro = 'yunzai-llm-sandbox'
  const code = [
    'import pathlib,hashlib',
    "p=pathlib.Path('" + image.path + "')",
    'print(hashlib.sha1(p.read_bytes()).hexdigest())',
    'try: p.write_bytes(b"changed"); raise AssertionError("store was writable")',
    'except OSError: print("read-only")',
  ].join('\n')
  const job = { id, inputImages: [] } as unknown as ComputerJob
  try {
    const run = await runInSandbox('python', code, { ...config.get().tools.exec, distro, timeout: 10 })
    assert.equal(run.exitCode, 0, run.stderr)
    assert.ok(run.stdout.includes(sha1(buffer)) && run.stdout.includes('read-only'), run.stdout)
    const desktop = await desktopRequest({ ...config.get().tools.computer, distro }, { operation: 'exec', language: 'python', code })
    assert.ok(desktop.text.includes(sha1(buffer)) && desktop.text.includes('read-only'), desktop.text)
    await stageAgy(job, { ...config.get().tools.agy, distro }, new AbortController().signal)
    const command = 'python3 -c ' + "'" + code.replaceAll("'", "'\\''") + "'"
    const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'python3', '/opt/llm-agy/exec.py'], { input: JSON.stringify({ op: 'exec', job: id, command }), encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stdout)
    const output = JSON.parse(result.stdout)
    assert.equal(output.exitCode, 0, output.output)
    assert.ok(output.output.includes(sha1(buffer)) && output.output.includes('read-only'), output.output)
    assert.deepEqual(fs.readFileSync(path.join(fixture, image.name)), buffer)
  } finally {
    fs.unlinkSync(path.join(fixture, image.name))
    fs.unlinkSync(path.join(fixture, 'index.json'))
    fs.rmdirSync(fixture)
  }
})
