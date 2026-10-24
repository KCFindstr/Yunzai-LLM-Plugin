import './helpers.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { desktopRequest, stageComputerImages } from '../src/computer/runtime.ts'
import { captureComputerImages, computerImagePath } from '../src/computer/attachments.ts'
import { ComputerQueue } from '../src/computer/queue.ts'
import { sha1 } from '../src/core/util.ts'
import type { ComputerConfig } from '../src/core/configTypes.ts'

const distro = 'yunzai-llm-sandbox'
const provisioned = process.platform === 'win32' && process.env.YZ_LLM_COMPUTER_LIVE === '1' && spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'test', '-f', '/opt/llm-desktop/client.py'], { timeout: 30000 }).status === 0
const cfg = { distro } as ComputerConfig

describe('real persistent desktop', { skip: !provisioned && 'Set YZ_LLM_COMPUTER_LIVE=1 after computer-setup; uses the character PC, not the host desktop' }, () => {
  it('imports original user images into the desktop as readable files and can restage them on resume', async () => {
    await desktopRequest(cfg, { operation: 'health' })
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64')
    const job = new ComputerQueue([]).submit('test', 'image transfer', 2)
    job.inputImages = captureComputerImages(job.id, [{ type: 'image', data: bytes.toString('base64'), mime: 'image/png' }])
    const file = computerImagePath(job.id, job.inputImages[0])
    try {
      await stageComputerImages(cfg, job)
      await stageComputerImages(cfg, job)
      const result = await desktopRequest(cfg, { operation: 'exec', language: 'python', code: `import pathlib,hashlib,json,os\np=pathlib.Path('${file}')\nprint(json.dumps({'hash':hashlib.sha1(p.read_bytes()).hexdigest(),'owner':p.stat().st_uid,'user':os.geteuid()}))` })
      const data = JSON.parse(result.text.slice(result.text.indexOf('{')))
      assert.equal(data.hash, sha1(bytes))
      assert.equal(data.owner, data.user)
      assert.notEqual(data.user, 0)
    } finally {
      await desktopRequest(cfg, { operation: 'exec', language: 'python', code: `import shutil\nshutil.rmtree('/work/attachments/${job.id}', ignore_errors=True)` })
    }
  })

  it('isolates the hostname/filesystem while retaining files between calls', async () => {
    const name = `.test-pc-${Date.now()}`
    const first = await desktopRequest(cfg, { operation: 'exec', language: 'python', code: `import socket,pathlib,json\npathlib.Path('/work/${name}').write_text('persistent')\nprint(json.dumps({'name':socket.gethostname(),'file':pathlib.Path('/etc/hostname').read_text().strip(),'hosts':pathlib.Path('/etc/hosts').read_text(),'drives':pathlib.Path('/mnt/c').exists(),'bot':pathlib.Path('/opt/llm-sandbox/runner.py').exists()}))` })
    const info = JSON.parse(first.text.slice(first.text.indexOf('{')))
    assert.equal(info.name, 'Amatsukaze')
    assert.equal(info.file, 'Amatsukaze')
    assert.match(info.hosts, /127\.0\.1\.1 Amatsukaze/)
    assert.equal(info.drives, false)
    assert.equal(info.bot, false)
    const second = await desktopRequest(cfg, { operation: 'exec', language: 'python', code: `from pathlib import Path\nfile=Path('/work/${name}')\nprint(file.read_text())\nfile.unlink()` })
    assert.match(second.text, /persistent/)
  })

  it('returns a real 1024×768 PNG observation', async () => {
    const result = await desktopRequest(cfg, { operation: 'screenshot' })
    assert.equal(result.image?.width, 1024)
    assert.equal(result.image?.height, 768)
    assert.equal(Buffer.from(result.image?.data ?? '', 'base64').subarray(1, 4).toString(), 'PNG')
  })
})
