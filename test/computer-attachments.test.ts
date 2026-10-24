import { TMP, PLUGIN_ROOT, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import { saveImage, readImage, imageScope, listImages } from '../src/chat/images.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { computerImagePath, readComputerImages } from '../src/computer/attachments.ts'
import { ComputerQueue } from '../src/computer/queue.ts'
import { config } from '../src/core/config.ts'
import { emptyUsage } from '../src/llm/types.ts'
import { runComputer } from '../src/computer/agent.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=', 'base64')
const image = { type: 'image' as const, data: png.toString('base64'), mime: 'image/png' }
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])

describe('persistent conversation image references', () => {
  it('deduplicates bytes and keeps identical paths across workers and later reads', () => {
    const scope = imageScope('conversation A')
    const saved = saveImage(scope, image)
    assert.equal(saveImage(scope, image).path, saved.path)
    assert.equal(listImages(scope).length, 1)
    assert.match(saved.path, /^\/work\/attachments\/[a-f0-9]{10}\/image-[a-f0-9]{40}\.png$/)
    assert.equal(computerImagePath('a123456789', saved), saved.path)
    assert.deepEqual(Buffer.from(readComputerImages('b123456789', [saved])[0].data, 'base64'), png)
    assert.equal(readImage(saved.path, scope).part.data, image.data)
    assert.doesNotMatch(JSON.stringify(saved), /"data"|"url"|base64/)
  })
  it('reads only the current chat folder and rejects other chats, invented paths, traversal and corrupted bytes', () => {
    const scope = imageScope('conversation B'), saved = saveImage(scope, image)
    assert.equal(readImage(saved.path, scope).part.data, image.data)
    assert.throws(() => readImage(saved.path, imageScope('conversation C')), /当前对话/)
    assert.throws(() => readImage('/work/attachments/../config.yaml', scope), /当前对话/)
    assert.throws(() => saveImage('../outside', image), /来源标识/)
    assert.throws(() => saveImage(scope, { type: 'image', url: 'https://expired.test' }), /缺失/)
    fs.writeFileSync(path.join(TMP, 'data/images', scope, saved.name), 'tampered')
    assert.throws(() => readImage(saved.path, scope), /损坏|文件无效/)
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
  it('preserves global image paths across checkpoints and resume without staging', async () => {
    const cfg = prepare()
    const job = new ComputerQueue([]).submit('owner', 'Inspect the attached image on the desktop', 2)
    job.inputImages = [saveImage(imageScope('desktop-test'), image)]
    const file = computerImagePath(job.id, job.inputImages[0])
    let calls = 0
    const execute = () => runComputer(job, { cfg, eff: config.effective(), signal: new AbortController().signal, quota: {},
      request: async () => ({ text: 'screen', image }),
      modelCall: async params => {
        const context = JSON.stringify(params.messages)
        assert.ok(context.includes(file))
        assert.doesNotMatch(params.system, /Google Lens|images\.google\.com|Upload the actual image/)
        assert.doesNotMatch(context, /computer-inputs|expired.test/)
        calls++
        return { text: '', usage: emptyUsage(), stopReason: 'stop', toolCalls: [{ id: String(calls), name: calls === 1 ? 'checkpoint' : 'finish', args: calls === 1 ? { note: 'Upload is next' } : { report: 'observed result' } }] }
      },
    })
    await execute()
    job.response = 'Continue checking source pages'
    await execute()
    assert.equal(calls, 3)
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
