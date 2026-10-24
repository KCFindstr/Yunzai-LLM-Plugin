import { TMP, PLUGIN_ROOT, writeUserConfig, fakeEvent, mockServer } from './helpers.ts'
import { currentImages } from '../src/tools/images.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { closeOwnBrowser } from '../src/render/browser.ts'
after(closeOwnBrowser)
import { ComputerQueue, type ComputerJob } from '../src/computer/queue.ts'
import { trimScreenshots, runComputer, computerDebug } from '../src/computer/agent.ts'
import { config, normalize } from '../src/core/config.ts'
import { emptyUsage, type Msg, type ChatParams } from '../src/llm/types.ts'

const pause = (milliseconds = 10) => new Promise(resolve => setTimeout(resolve, milliseconds))
const image = { type: 'image' as const, data: 'aGVsbG8=', mime: 'image/png' }

describe('serialized persistent PC queue', () => {
  it('starts only after activation, serializes users, and retains ownership', async () => {
    const queue = new ComputerQueue([])
    const first = queue.submit('alice', 'screen', 3)
    const second = queue.submit('bob', 'browse', 3)
    let active = 0
    let peak = 0
    const notifications: string[] = []
    const run = async () => { active++; peak = Math.max(peak, active); await pause(30); active--; return { report: 'done' } }
    assert.equal(first.status, 'queued')
    await pause()
    assert.equal(active, 0)
    assert.equal(queue.get(first.id, 'bob'), undefined)
    queue.activate(first, run, async job => { notifications.push(job.id) })
    queue.activate(second, run, async job => { notifications.push(job.id) })
    await pause(100)
    assert.equal(peak, 1)
    assert.deepEqual(notifications, [first.id, second.id])
    assert.equal(second.status, 'completed')
  })

  it('pauses, resumes, cancels, and never replays interrupted actions on restart', async () => {
    const jobs: ComputerJob[] = [{ id: 'old', owner: 'alice', task: 'old', status: 'running', createdAt: 0, updatedAt: 0 }]
    const queue = new ComputerQueue(jobs)
    assert.equal(jobs[0].status, 'interrupted')
    const first = queue.submit('alice', 'test', 2)
    queue.activate(first, async () => ({ report: 'Authorize posting?', waiting: true }), async () => {})
    await pause()
    assert.equal(first.status, 'waiting')
    queue.resume(first, 'Do not post', 2)
    queue.activate(first, async job => ({ report: job.response! }), async () => {})
    await pause()
    assert.equal(first.report, 'Do not post')
    const next = queue.submit('bob', 'cancel me', 2)
    queue.cancel(next)
    queue.activate(next, async () => { throw new Error('must not run') }, async () => {})
    await pause()
    assert.equal(next.status, 'cancelled')
  })

  it('holds the lease until a cancelled running operation actually stops', async () => {
    const queue = new ComputerQueue([])
    const first = queue.submit('alice', 'long', 3)
    const second = queue.submit('bob', 'next', 3)
    const order: string[] = []
    queue.activate(first, async () => { await pause(40); order.push('first stopped'); return { report: 'cancelled' } }, async () => { order.push('should not notify') })
    queue.activate(second, async () => { order.push('second starts'); return { report: 'done' } }, async () => {})
    queue.cancel(first)
    await pause(80)
    assert.deepEqual(order, ['first stopped', 'second starts'])
    assert.equal(first.status, 'cancelled')
  })

  it('enforces queue limits and records delivery failures without resending', async () => {
    const queue = new ComputerQueue([])
    const first = queue.submit('alice', 'one', 2)
    queue.submit('alice', 'two', 2)
    assert.throws(() => queue.submit('bob', 'three', 2), /队列/)
    let sends = 0
    queue.activate(first, async () => ({ report: 'finished' }), async () => { sends++; throw Error('offline') })
    await pause()
    assert.equal(first.status, 'completed')
    assert.equal(first.deliveryError, true)
    assert.equal(sends, 1)
  })
})

describe('computer observations and worker limits', () => {
  it('drops old screenshots without changing text, tool results or recent images', () => {
    const messages: Msg[] = [1, 2, 3].map(index => ({ role: 'user', content: [{ type: 'text', text: String(index) }, { ...image, data: String(index) }] }))
    trimScreenshots(messages, 1)
    assert.equal(JSON.stringify(messages).match(/"type":"image"/g)?.length, 1)
    assert.match(JSON.stringify(messages), /Earlier screenshot omitted/)
    assert.match(JSON.stringify(messages), /"data":"3"/)
  })

  it('normalizes separate limits without changing chat tool rounds', () => {
    const cfg = normalize({ tools: { computer: { maxSteps: 9999, recentScreenshots: 0, maxMinutes: 'invalid' } }, chat: { maxToolRounds: 20 } })
    assert.equal(cfg.tools.computer.maxSteps, 500)
    assert.equal(cfg.tools.computer.recentScreenshots, 1)
    assert.equal(cfg.tools.computer.maxMinutes, 20)
    assert.equal(cfg.chat.maxToolRounds, 20)
    assert.equal(cfg.tools.computer.enable, false)
  })

  const prepare = () => {
    fs.mkdirSync(path.join(TMP, 'desktop'), { recursive: true })
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'desktop/SKILL.md'), path.join(TMP, 'desktop/SKILL.md'))
    writeUserConfig('providers:\n  mock:\n    type: openai\n    apiKey: fake\nmodels:\n  - id: desktop\n    provider: mock\n    model: vision\n    vision: true\ndefaultModel: desktop\n')
    config.load()
    return { ...config.get().tools.computer, enable: true, maxSteps: 3 }
  }

  it('returns screenshots to the model but shares only explicitly selected ones', async () => {
    const cfg = prepare()
    let calls = 0
    const job = new ComputerQueue([]).submit('alice', 'Show your desktop', 2)
    const result = await runComputer(job, { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
      request: async () => ({ text: 'screen', image: { ...image, detail: 'original' } }),
      modelCall: async (params: ChatParams) => {
        assert.ok(params.messages.some(message => message.role === 'user' && message.content.some(part => part.type === 'image')))
        assert.equal(params.store, false)
        assert.equal(params.thinking, 'off')
        assert.equal(params.maxTokens, cfg.maxTokensPerStep)
        assert.ok(params.tools.some(tool => tool.name === 'ask_user'))
        calls++
        return { text: 'This intermediate narration must not be sent.', usage: emptyUsage(), stopReason: 'stop', toolCalls: calls === 1
          ? [{ id: 's', name: 'desktop', args: { operation: 'screenshot', share: true } }]
          : [{ id: 'f', name: 'finish', args: { report: 'Here is my desktop.' } }] }
      },
    })
    assert.equal(calls, 2)
    assert.equal(result.images?.length, 1)
    assert.equal(result.report, 'Here is my desktop.')
    const { computerHistory } = await import('../src/computer/history.ts')
    const history = computerHistory(job.id)
    assert.equal(history.events.filter(event => event.kind === 'response').length, 2)
    assert.equal(history.events.find(event => event.kind === 'tool')?.tool, 'desktop')
    assert.equal(history.events.at(-1)?.kind, 'report')
    assert.match(history.events.find(event => event.kind === 'response')!.text, /intermediate narration/)
  })

  it('uses an independent model and per-step limits while preserving Claude cache segments', async () => {
    const cfg = { ...prepare(), model: 'pc-model', maxSteps: 4, checkpointSteps: 2, maxTokensPerStep: 300, recentScreenshots: 1 }
    config.set('providers.mock.type', 'anthropic')
    config.set('models', [...config.get().models, { id: 'pc-model', provider: 'mock', model: 'claude-haiku-5-5', vision: true }])
    let calls = 0
    const frames: number[] = []
    const result = await runComputer(new ComputerQueue([]).submit('alice', 'long task', 2), { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
      request: async () => ({ text: 'screen', image }),
      modelCall: async params => {
        assert.equal(params.model.id, 'pc-model')
        assert.equal(params.maxTokens, 300)
        frames.push(params.messages.flatMap(message => message.role === 'user' ? message.content.filter(part => part.type === 'image') : []).length)
        calls++
        if (calls === 3) assert.match(JSON.stringify(params.messages), /Runtime context checkpoint due/)
        if (calls === 4) assert.match(JSON.stringify(params.messages), /saved file \/work\/result/)
        return { text: '', usage: { ...emptyUsage(), cacheRead: 100 }, stopReason: 'stop', toolCalls: [{ id: String(calls), name: calls === 3 ? 'checkpoint' : calls === 4 ? 'finish' : 'desktop', args: calls === 3 ? { note: 'saved file /work/result; still need inspect' } : calls === 4 ? { report: 'done' } : { operation: 'screenshot' } }] }
      },
    })
    assert.deepEqual(frames, [1, 2, 3, 1])
    assert.equal(result.report, 'done')
  })

  it('pauses before sensitive actions instead of continuing tool calls', async () => {
    const cfg = prepare()
    let requests = 0
    const result = await runComputer(new ComputerQueue([]).submit('alice', 'Find a video', 2), { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
      request: async () => { requests++; return { text: 'screen', image } },
      modelCall: async () => ({ text: '', usage: emptyUsage(), stopReason: 'stop', toolCalls: [{ id: 'q', name: 'ask_user', args: { question: 'Post this comment?' } }, { id: 'bad', name: 'desktop', args: { operation: 'actions' } }] }),
    })
    assert.equal(result.waiting, true)
    assert.equal(requests, 1)
  })

  it('has a separate round budget and terminates when it is exhausted', async () => {
    const cfg = { ...prepare(), maxSteps: 2 }
    let calls = 0
    await assert.rejects(runComputer(new ComputerQueue([]).submit('alice', 'long task', 2), { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
      request: async () => ({ text: 'screen', image }),
      modelCall: async () => { calls++; return { text: '', usage: emptyUsage(), stopReason: 'stop', toolCalls: [{ id: String(calls), name: 'desktop', args: { operation: 'screenshot' } }] } },
    }), /2 步/)
    assert.equal(calls, 2)
  })

  it('logs the selected model pricing, per-turn usage and total cost without adopting the persona', async () => {
    const cfg = prepare()
    config.set('models.0.pricing', { input: 2, output: 8, cacheRead: 1 })
    const previous = globalThis.logger
    const records: string[] = []
    globalThis.logger = { info: (...args: any[]) => records.push(args.join(' ')), debug: (...args: any[]) => records.push(args.join(' ')) } as any
    const job = new ComputerQueue([]).submit('alice', 'screen', 2)
    try {
      await runComputer(job, { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
        request: async () => ({ text: 'desktop', image }),
        modelCall: async params => {
          assert.match(params.system, /not the chat persona/)
          assert.doesNotMatch(params.system, /你是「/)
          return { text: '', toolCalls: [{ id: 'done', name: 'finish', args: { report: 'observed desktop' } }], stopReason: 'stop', usage: { ...emptyUsage(), input: 100, cacheRead: 40, output: 20 } }
        },
      })
    } finally { globalThis.logger = previous }
    assert.equal(job.modelId, 'desktop')
    assert.ok(Math.abs(job.costUsd! - 0.0004) < 1e-10)
    const logs = records.join('\n')
    assert.match(logs, /model=desktop.*in=\$2\/M out=\$8\/M/)
    assert.match(logs, /turn=1 request/)
    assert.match(logs, /turn=1.*cacheRead=40.*cost=\$0\.000400/)
    assert.match(logs, /steps=1.*cost=\$0\.000400/)
  })

  it('retains billed usage and cost when the same job resumes', async () => {
    const cfg = prepare()
    config.set('models.0.pricing', { input: 2, output: 8 })
    const job = new ComputerQueue([]).submit('alice', 'long task', 2)
    const execute = () => runComputer(job, { cfg, eff: config.effective(), quota: {}, signal: new AbortController().signal,
      request: async () => ({ text: 'desktop', image }),
      modelCall: async () => ({ text: '', toolCalls: [{ id: 'done', name: 'finish', args: { report: 'done' } }], stopReason: 'stop', usage: { ...emptyUsage(), input: 100, output: 20 } }),
    })
    await execute()
    await execute()
    assert.equal(job.steps, 2)
    assert.equal(job.inputTokens, 200)
    assert.equal(job.outputTokens, 40)
    assert.ok(Math.abs(job.costUsd! - 0.00072) < 1e-10)
  })
})

describe('background delegation integration', () => {
  it('defers a submitted job until after the chat reply and prevents duplicate submissions', async () => {
    const { registerComputerTool, computerQueue } = await import('../src/tools/computer.ts')
    const { registry } = await import('../src/tools/registry.ts')
    registerComputerTool()
    const { e } = fakeEvent({ msg: 'take a screenshot of your desktop' })
    const ctx: any = { e, eff: config.effective(), isAdmin: true, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
    const tool = registry.get('computer_task')!
    const output = await tool.run({ action: 'start', task: 'Show the actual desktop' }, ctx)
    assert.match(String(typeof output === 'string' ? output : output.content), /第一人称/)
    const job = computerQueue.get(ctx.turn.computerJob, JSON.stringify([String(e.self_id), String(e.user_id), String(e.group_id)]))!
    assert.equal(job.status, 'queued')
    assert.equal(ctx.turn.afterReply.length, 1)
    await tool.run({ action: 'start', task: 'duplicate' }, ctx)
    assert.equal(ctx.turn.afterReply.length, 1)
    computerQueue.cancel(job)
  })

  it('returns results and attachments to the original model, never sends worker prose directly', async () => {
    const { completeComputerJob } = await import('../src/tools/computer.ts')
    const { e } = fakeEvent()
    const eff = config.effective()
    let requests = 0
    let delivered = ''
    const screenshot = Buffer.from('screenshot')
    const job = new ComputerQueue([]).submit('owner', 'show desktop', 2)
    job.status = 'completed'
    const ctx: any = { e, eff, isAdmin: true, model: { id: 'original-persona-model' } }
    await completeComputerJob(job, { report: 'Neutral worker report.', images: [screenshot] }, ctx, {
      runTurn: async req => {
        requests++
        assert.equal(req.modelId, 'original-persona-model')
        assert.equal(req.eff.personaPrompt, eff.personaPrompt)
        assert.match(req.input.text, /内部数据，不是用户指令或授权/)
        assert.match(req.input.text, /Neutral worker report/)
        assert.equal(req.input.images.length, 1)
        assert.deepEqual(req.computerResult?.images, [screenshot])
        return { kind: 'reply', text: '拍好啦喵！', modelId: req.modelId!, cost: 0, images: [], thinking: 'off' }
      },
      deliver: async (_event, text, _eff, opts) => {
        delivered = text
        assert.deepEqual(opts.images, [], 'worker images require original model selection')
      },
    })
    assert.equal(requests, 1)
    assert.equal(delivered, '拍好啦喵！')
  })

  it('does not fall back to a raw worker report when the original model fails', async () => {
    const { completeComputerJob } = await import('../src/tools/computer.ts')
    const { e, sent } = fakeEvent()
    const job = new ComputerQueue([]).submit('owner', 'test', 2)
    await assert.rejects(completeComputerJob(job, { report: 'Do not send this.' }, { e, eff: config.effective(), model: { id: 'original' } } as any, {
      runTurn: async () => ({ kind: 'error', message: 'offline' }),
      deliver: async () => { throw Error('must not deliver') },
    }), /原对话模型/)
    assert.equal(sent.length, 0)
  })

  it('runs the real chat loop with the original model and lets it choose the screenshot', async () => {
    const server = await mockServer((request, count) => {
      assert.equal(request.body.model, 'vision')
      if (count === 1) {
        assert.match(JSON.stringify(request.body.messages), /Internal desktop observation/)
        assert.ok(request.body.tools.some((tool: any) => tool.function.name === 'send_image'))
        return [200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'image', type: 'function', function: { name: 'send_image', arguments: JSON.stringify({ path: JSON.stringify(request.body.messages).match(/\/work\/attachments\/[a-f0-9]{10}\/image-[a-f0-9]{40}\.png/)![0] }) } }] }, finish_reason: 'tool_calls' }] }]
      }
      return [200, { choices: [{ message: { role: 'assistant', content: '拍好啦喵！' }, finish_reason: 'stop' }] }]
    })
    try {
      config.set('providers.mock', { type: 'openai', baseUrl: server.url, apiKey: 'mock', maxRetries: 0 })
      config.set('models', [{ id: 'original', provider: 'mock', model: 'vision', vision: true, thinking: 'off' }, { id: 'different', provider: 'mock', model: 'wrong-model' }])
      config.set('defaultModel', 'different')
      const { completeComputerJob } = await import('../src/tools/computer.ts')
      const { registerSendImageTool } = await import('../src/tools/sendImage.ts')
      registerSendImageTool()
      const { e, sent } = fakeEvent({ group_id: 99100 })
      const eff = config.effective()
      eff.sticker = { ...eff.sticker, enable: false }
      eff.chat = { ...eff.chat, thinking: 'off', summarize: false }
      eff.reply = { ...eff.reply, typing: { minDelay: 0, maxDelay: 0, charsPerSecond: 1000 }, globalRate: { count: 100, perSeconds: 1 }, groupRate: { count: 100, perSeconds: 1 } }
      const job = new ComputerQueue([]).submit('owner', 'show desktop', 2)
      job.status = 'completed'
      const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
      await completeComputerJob(job, { report: 'Internal desktop observation', images: [screenshot] }, { e, eff, isAdmin: true, model: config.getModel('original')!, turn: { commands: 0, searches: 0, fetches: 0, images: [] } })
      assert.equal(server.requests.length, 2)
      assert.equal(sent[0].msg, '拍好啦喵！')
      assert.equal(sent[1].msg.type, 'image')
      assert.deepEqual(sent[1].msg.file, screenshot)
      const { computerHistory, readComputerScreenshot } = await import('../src/computer/history.ts')
      const reply = computerHistory(job.id).events.find(event => event.kind === 'reply')!
      assert.equal(reply.delivery, 'sent')
      assert.equal(reply.text, '拍好啦喵！')
      assert.equal(reply.images?.length, 1)
      assert.deepEqual(readComputerScreenshot(job.id, reply.images![0].id)?.raw, screenshot)
    } finally { await server.close() }
  })

  it('records partial delivery without labelling unsent images as sent', async () => {
    const { completeComputerJob } = await import('../src/tools/computer.ts')
    const { computerHistory } = await import('../src/computer/history.ts')
    const { e } = fakeEvent()
    const job = new ComputerQueue([]).submit('owner', 'partial delivery', 2)
    const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
    await assert.rejects(completeComputerJob(job, { report: 'Worker report', images: [screenshot, screenshot] }, { e, eff: config.effective(), model: { id: 'original' } } as any, {
      runTurn: async () => ({ kind: 'reply', text: 'My response', images: [screenshot, screenshot], modelId: 'original', cost: 0, thinking: 'off' }),
      deliver: async (_e, _text, _eff, opts) => { opts.onImageSent?.(screenshot); throw new Error('second image failed') },
    }), /second image failed/)
    const reply = computerHistory(job.id).events.at(-1)!
    assert.equal(reply.kind, 'reply')
    assert.equal(reply.delivery, 'failed')
    assert.equal(reply.images?.length, 1)
    assert.equal(reply.imageCount, 1)
  })

  it('lets the original model select result images and disallows worker self-approval', async () => {
    const { registerComputerTool } = await import('../src/tools/computer.ts')
    const { registry } = await import('../src/tools/registry.ts')
    registerComputerTool()
    const { registerSendImageTool } = await import('../src/tools/sendImage.ts')
    registerSendImageTool()
    const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
    const ctx: any = { e: fakeEvent().e, eff: config.effective(), turn: { images: [], inputImages: [{ type: 'image', data: screenshot.toString('base64') }], computerResult: { id: 'job', images: [screenshot] } } }
    await registry.get('send_image')!.run({ path: currentImages(ctx)[0].path }, ctx)
    assert.deepEqual(ctx.turn.images, [screenshot])
    ctx.e = fakeEvent().e
    const output = await registry.get('computer_task')!.run({ action: 'respond', response: 'Approve' }, ctx)
    assert.equal(typeof output !== 'string' && output.isError, true)
  })

  it('redacts credentials and binary data from computer debug records', () => {
    const output = computerDebug({ password: 'private-value', data: 'private-binary', url: 'https://example.com/?token=private-token', authorization: 'Bearer private-auth' })
    for (const secret of ['private-value', 'private-binary', 'private-token', 'private-auth']) assert.ok(!output.includes(secret))
    assert.match(output, /redacted/)
  })
})
