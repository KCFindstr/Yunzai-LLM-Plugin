import { PLUGIN_ROOT, TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { saveImage, imageScope } from '../src/chat/images.ts'
import { runInSandbox } from '../src/tools/exec.ts'
import { desktopRequest } from '../src/computer/runtime.ts'
import { config } from '../src/core/config.ts'
import { sha1 } from '../src/core/util.ts'

const live = process.platform === 'win32' && process.env.YZ_LLM_COMPUTER_LIVE === '1'
it('code and desktop sandboxes read unused global images by raw path and reject writes to the store', { skip: !live }, async () => {
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
  try {
    const run = await runInSandbox('python', code, { ...config.get().tools.exec, distro, timeout: 10 })
    assert.equal(run.exitCode, 0, run.stderr)
    assert.ok(run.stdout.includes(sha1(buffer)) && run.stdout.includes('read-only'), run.stdout)
    const desktop = await desktopRequest({ ...config.get().tools.computer, distro }, { operation: 'exec', language: 'python', code })
    assert.ok(desktop.text.includes(sha1(buffer)) && desktop.text.includes('read-only'), desktop.text)
    assert.deepEqual(fs.readFileSync(path.join(fixture, image.name)), buffer)
  } finally {
    fs.unlinkSync(path.join(fixture, image.name))
    fs.unlinkSync(path.join(fixture, 'index.json'))
    fs.rmdirSync(fixture)
  }
})
