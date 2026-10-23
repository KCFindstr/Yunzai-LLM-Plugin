import { TMP, PLUGIN_ROOT, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { captureComputerImages, computerImagePath, readComputerImages } from '../src/computer/attachments.ts'
import { ComputerQueue } from '../src/computer/queue.ts'
import { config } from '../src/core/config.ts'
import { emptyUsage } from '../src/llm/types.ts'
import { runComputer } from '../src/computer/agent.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64')
const image = { type: 'image' as const, data: png.toString('base64'), mime: 'image/png' }
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])

describe('computer input image snapshots', () => {
  it('keeps selected original bytes after the turn, without URLs or base64 in job metadata', () => {
    const images = captureComputerImages('a123456789', [image, { type: 'image', data: gif.toString('base64'), mime: 'wrong/type' }], [2, 2])
    assert.equal(images.length, 1)
    assert.equal(images[0].mime, 'image/gif')
    assert.equal(images[0].index, 2)
    assert.match(computerImagePath('a123456789', images[0]), /^\/work\/attachments\/a123456789\/image-2-.*\.gif$/)
    assert.deepEqual(Buffer.from(readComputerImages('a123456789', images)[0].data, 'base64'), gif)
    assert.doesNotMatch(JSON.stringify(images), /"data"|"url"|base64/)
    assert.deepEqual(captureComputerImages('a123456789', [image], []), [])
  })

  it('rejects invalid selections, missing bytes, traversal and tampered snapshots', () => {
    assert.throws(() => captureComputerImages('a123456789', [image], [2]), /编号/)
    assert.throws(() => captureComputerImages('a123456789', [image], '1'), /编号/)
    assert.throws(() => captureComputerImages('a123456789', [{ type: 'image', url: 'https://expired.test/image' }]), /未加载/)
    assert.throws(() => captureComputerImages('../outside', [image]), /编号/)
    const images = captureComputerImages('b123456789', [image])
    assert.throws(() => readComputerImages('b123456789', [{ ...images[0], name: '../../config.yaml' }]), /文件名/)
    fs.writeFileSync(path.join(TMP, 'data/computer-inputs/b123456789', images[0].name), 'changed')
    assert.throws(() => readComputerImages('b123456789', images), /损坏/)
    assert.throws(() => captureComputerImages('b123456789', [{ ...image, data: 'A'.repeat(5_000_000) }]), /过大/)
  })
})

function prepare() {
  fs.mkdirSync(path.join(TMP, 'desktop'), { recursive: true })
  fs.copyFileSync(path.join(PLUGIN_ROOT, 'desktop/SKILL.md'), path.join(TMP, 'desktop/SKILL.md'))
  writeUserConfig('providers:\n  mock:\n    type: openai\n    apiKey: fake\nmodels:\n  - id: desktop\n    provider: mock\n    model: vision\n    vision: true\ndefaultModel: desktop\n')
  config.load()
  return { ...config.get().tools.computer, enable: true, maxSteps: 3 }
}

describe('image handoff to desktop worker', () => {
  it('stages images before the model starts and preserves exact paths across checkpoints and resume', async () => {
    const cfg = prepare()
    const job = new ComputerQueue([]).submit('owner', 'Use Google Lens to identify the attached image', 2)
    job.inputImages = captureComputerImages(job.id, [image])
    const file = computerImagePath(job.id, job.inputImages[0])
    let staged = 0
    let calls = 0
    const execute = () => runComputer(job, { cfg, eff: config.effective(), signal: new AbortController().signal, quota: {},
      request: async () => ({ text: 'screen', image }),
      stageImages: async (_cfg, entry) => { assert.equal(entry, job); staged++ },
      modelCall: async params => {
        assert.ok(staged > 0)
        const context = JSON.stringify(params.messages)
        assert.ok(context.includes(file))
        assert.match(params.system, /Upload the actual image/)
        assert.doesNotMatch(context, /computer-inputs|expired.test/)
        calls++
        return { text: '', usage: emptyUsage(), stopReason: 'stop', toolCalls: [{ id: String(calls), name: calls === 1 ? 'checkpoint' : 'finish', args: calls === 1 ? { note: 'Upload is next' } : { report: 'observed result' } }] }
      },
    })
    await execute()
    job.response = 'Continue checking source pages'
    await execute()
    assert.equal(staged, 2)
    assert.equal(calls, 3)
  })

  it('does not call the model when transferring images fails', async () => {
    const cfg = prepare()
    const job = new ComputerQueue([]).submit('owner', 'image lookup', 2)
    job.inputImages = captureComputerImages(job.id, [image])
    await assert.rejects(runComputer(job, { cfg, eff: config.effective(), signal: new AbortController().signal, quota: {},
      request: async () => ({ text: 'screen' }),
      stageImages: async () => { throw Error('disk full') },
      modelCall: async () => { throw Error('model must not run') },
    }), /disk full/)
  })

  it('carries chat input images through the real tool loop without launching or replying from the worker', async () => {
    prepare()
    const { registerComputerTool, computerQueue } = await import('../src/tools/computer.ts')
    registerComputerTool()
    const server = await mockServer((_request, count) => [200, { choices: [{ message: count === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'pc', type: 'function', function: { name: 'computer_task', arguments: JSON.stringify({ action: 'start', task: 'Reverse image search in Google Images' }) } }] }
      : { role: 'assistant', content: '我去用原图搜一下。' }, finish_reason: count === 1 ? 'tool_calls' : 'stop' }] }])
    const { e, sent } = fakeEvent({ msg: '用谷歌以图搜图', group_id: 88220 })
    try {
      config.set('providers.mock.baseUrl', server.url)
      config.set('providers.mock.maxRetries', 0)
      config.set('tools.computer.enable', true)
      const eff = config.effective()
      eff.chat.thinking = 'off'
      eff.chat.summarize = false
      config.set('memory.enable', false)
      const { runTurn } = await import('../src/chat/agent.ts')
      const outcome = await runTurn({ e, eff, convKey: 'image-handoff', isAdmin: true,
        input: { text: e.msg, images: [image], imageSegments: [], quoted: { name: 'someone', fromBot: false, text: '[图片]', imageUrls: ['https://expired.test/original'] } },
      })
      assert.equal(outcome.kind, 'reply')
      assert.equal(outcome.afterReply?.length, 1)
      const job = computerQueue.jobs.at(-1)!
      assert.equal(job.status, 'queued')
      assert.equal(job.inputImages?.length, 1)
      assert.deepEqual(Buffer.from(readComputerImages(job.id, job.inputImages!)[0].data, 'base64'), png)
      assert.equal(sent.length, 0)
      const chatbotSystem = server.requests[0].body.messages.find((message: any) => message.role === 'system').content
      assert.doesNotMatch(chatbotSystem, /Google Images|Google Lens|images\.google\.com|browser.*file chooser/i)
      const computerTool = server.requests[0].body.tools.find((tool: any) => tool.function.name === 'computer_task')
      assert.doesNotMatch(computerTool.function.description, /Google|Lens|以图搜图/)
      assert.match(JSON.stringify(server.requests[1].body), /\/work\/attachments\//)
      computerQueue.cancel(job)
    } finally { await server.close() }
  })
})
