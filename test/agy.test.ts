import { TMP, fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import { describe, it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { redact } from '../src/agy/privacy.ts'
import { agyLaunchArgs, agyRuntime, runAgy, hostAgyEnvironment, AGY_MODEL, AGY_EFFORT } from '../src/agy/runtime.ts'
import { agyOutputFile, agyPathInstructions, agyWorkspace } from '../src/agy/paths.ts'
import { readLocalImage } from '../src/tools/imageFiles.ts'
import { getAgySession, sessionKey } from '../src/chat/session.ts'
import { registerAgyTool, agyQueue, completeAgyJob } from '../src/tools/agy.ts'
import { registry } from '../src/tools/registry.ts'
import type { ToolCtx } from '../src/tools/registry.ts'
import { agyHistory } from '../src/agy/history.ts'

function context(admin = true): ToolCtx {
  const eff = normalize({ tools: { enable: true, agy: { enable: true } } }) as any
  return { e: fakeEvent().e, eff, isAdmin: admin, model: { id: 'original-persona' } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}
registerAgyTool()
describe('AGY host worker and async handoff', () => {
  it('launches native sandbox + turbo without a permission policy', () => {
    const flags = agyLaunchArgs('host task', 5)
    assert.ok(flags.includes('--sandbox'))
    assert.ok(flags.includes('--dangerously-skip-permissions'))
    assert.ok(flags.includes('--new-project'))
    assert.equal(AGY_MODEL, 'gemini-3.8-flash-medium')
    assert.equal(AGY_EFFORT, 'medium')
  })
  it('uses the real host profile even when launched inside an old AGY terminal', () => {
    const env = hostAgyEnvironment({ USERPROFILE: 'old-private-home', HOME: 'old-private-home', ANTIGRAVITY_APP_DATA_DIR: 'old-private-profile',
      ANTIGRAVITY_CONFIG_REL_DIR: 'old-config', ANTIGRAVITY_LS_ADDRESS: 'old-backend', ANTIGRAVITY_PROJECT_ID: 'old-project',
      PATH: 'normal-host-tools', TEST_API_KEY: 'host-key' }, 'C:\\Users\\Host')
    assert.equal(env.USERPROFILE, 'C:\\Users\\Host')
    assert.equal(env.ANTIGRAVITY_APP_DATA_DIR, path.join('C:\\Users\\Host', '.gemini', 'antigravity-cli'))
    assert.equal(env.ANTIGRAVITY_LS_ADDRESS, undefined)
    assert.equal(env.ANTIGRAVITY_CONFIG_REL_DIR, undefined)
    assert.equal(env.ANTIGRAVITY_PROJECT_ID, undefined)
    assert.equal(env.PATH, 'normal-host-tools')
    assert.equal(env.TEST_API_KEY, 'host-key')
  })
  it('runs without a VM/private profile and accepts turbo init events', async t => {
    let launches = 0
    const workspaceId = 'aabbcc1234', alias = `/work/agy/${workspaceId}/out/result.png`
    t.mock.method(agyRuntime, 'spawn', (file: string, args: string[], options: any) => {
      launches++
      assert.equal(file, path.join(TMP, 'data/agy-setup/agy.exe'))
      assert.equal(options.cwd, agyWorkspace(workspaceId))
      assert.equal(options.env.USERPROFILE, os.userInfo().homedir)
      assert.equal(options.env.ANTIGRAVITY_APP_DATA_DIR, path.join(os.userInfo().homedir, '.gemini', 'antigravity-cli'))
      assert.ok(fs.existsSync(path.join(options.cwd, 'out')))
      assert.ok(args.includes('--sandbox') && args.includes('--dangerously-skip-permissions'))
      assert.ok(args.includes('--new-project'))
      assert.ok(!args.includes('--conversation'))
      const prompt = args[args.indexOf('--print') + 1]
      assert.ok(prompt.includes(agyPathInstructions(workspaceId)))
      assert.ok(prompt.includes('/work/attachments/aabbccddee/image-ref.png'))
      assert.ok(!prompt.includes('agy-sandbox'))
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ event: 'init', init: { permission_mode: 'turbo' } }) + '\n')
        child.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: alias } }) + '\n')
        child.emit('close', 0)
      })
      return child as any
    })
    const job: any = { id: 'aabbccddee', task: 'process /work/attachments/aabbccddee/image-ref.png', agyWorkspaceId: workspaceId }
    assert.deepEqual(await runAgy(job, normalize({}).tools.agy, new AbortController().signal, {}), { report: alias })
    assert.deepEqual(await runAgy(job, normalize({}).tools.agy, new AbortController().signal, {}), { report: alias })
    assert.equal(launches, 2)
    assert.ok(!fs.existsSync(path.join(TMP, 'data/agy-setup/profile')))
  })
  it('makes host output images readable through bot aliases without WSL', async () => {
    const ctx = context(), session = getAgySession(sessionKey(ctx.e, ctx.eff.chat.sessionScope), 60)
    const out = path.join(agyWorkspace(session.workspaceId), 'out')
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
    fs.mkdirSync(path.join(out, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(out, 'nested', 'result.png'), png)
    const alias = `/work/agy/${session.workspaceId}/out/nested/result.png`
    const saved = await readLocalImage(alias, ctx)
    assert.deepEqual(Buffer.from(saved.part.data!, 'base64'), png)
    assert.ok(saved.image.path.startsWith('/work/attachments/'))
    assert.throws(() => agyOutputFile(`/work/agy/${session.workspaceId}/out/../../secret.png`, session.workspaceId))
    assert.throws(() => agyOutputFile('/work/agy/aabbccddee/out/result.png', session.workspaceId))
    const other = context(); other.e.user_id = 777
    await assert.rejects(readLocalImage(alias, other), /AGY/)
    assert.equal(redact(alias), alias)
    const numericAlias = '/work/agy/1234567890/out/result.png'
    assert.equal(redact(numericAlias), numericAlias)
    assert.ok(!redact('phone 1234567890').includes('1234567890'))
  })
  it('accepts a successful final record without a trailing newline or init banner and keeps streamed reply text', async t => {
    const events: any[] = []
    t.mock.method(agyRuntime, 'spawn', () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
      queueMicrotask(() => {
        const data = [
          { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'ACTIVE', text_delta: 'Generated ' } },
          { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', text: '', text_delta: '/work/agy/aabbccddee/out/image.jpg' } },
          { event: 'result', result: { status: 'SUCCESS', response: '' } },
        ].map(value => JSON.stringify(value)).join('\n')
        child.stdout.write(data.slice(0, 31)); child.stdout.write(data.slice(31))
        child.emit('close', 0)
      })
      return child as any
    })
    const result = await runAgy({ id: 'aabbccddee', task: 'generate an image' } as any, normalize({}).tools.agy, new AbortController().signal, {}, event => events.push(event))
    assert.equal(result.report, 'Generated /work/agy/aabbccddee/out/image.jpg')
    assert.equal(events.at(-1).event, 'runtime_exit')
    assert.equal(events.at(-1).success, true)
  })
  for (const scenario of [{ status: 'ERROR', code: 1 }, { status: 'SUCCESS', code: 1 }, { status: '', code: 0 }])
    it(`preserves partial work and terminal diagnostics when status=${scenario.status || 'missing'} exit=${scenario.code}`, async t => {
      const events: any[] = []
      t.mock.method(agyRuntime, 'spawn', () => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', text: 'Output exists: /work/agy/aabbccddee/out/image.jpg' } }) + '\n')
          if (scenario.status) child.stdout.write(JSON.stringify({ event: 'result', result: { status: scenario.status } }))
          child.emit('close', scenario.code)
        })
        return child as any
      })
      await assert.rejects(runAgy({ id: 'aabbccddee', task: 'generate an image' } as any, normalize({}).tools.agy, new AbortController().signal, {}, event => events.push(event)), (error: any) => {
        assert.match(error.message, new RegExp(`exit=${scenario.code}; status=${scenario.status || 'missing-result'}`))
        assert.match(error.report, /Output exists:/)
        assert.match(error.report, /不代表启动失败/)
        return true
      })
      assert.equal(events.at(-1).success, false)
    })
  it('defaults off and bounds configuration', () => {
    assert.equal(normalize({}).tools.agy.enable, false)
    const cfg = normalize({ tools: { agy: { enable: true, maxMinutes: 9999, maxQueue: -5, distro: '../escape' } } }).tools.agy
    assert.equal(cfg.maxMinutes, 30); assert.equal(cfg.maxQueue, 1); assert.equal('distro' in cfg, false)
  })
  it('defers execution until after the acknowledgement, prevents duplicates and hides other owners', async () => {
    const ctx = context(), tool = registry.get('agy')!
    const result = await tool.run({ action: 'start', task: 'Identify the quoted image' }, ctx)
    assert.equal(typeof result, 'string')
    const job = agyQueue.get(ctx.turn.agyJob!, JSON.stringify(['10000', '20001', '30001']))!
    assert.equal(job.status, 'queued'); assert.equal(ctx.turn.afterReply?.length, 1)
    await tool.run({ action: 'start', task: 'duplicate' }, ctx)
    assert.equal(ctx.turn.afterReply?.length, 1)
    const other = context(); other.e.user_id = 999
    assert.equal((await tool.run({ action: 'status', id: job.id }, other) as any).isError, true)
    await tool.run({ action: 'cancel', id: job.id }, ctx)
    assert.equal(job.status, 'cancelled')
  })
  it('allows worker results to invoke tools while maintaining access checks', async () => {
    registry.register({ name: 'custom_tool', description: 'test', parameters: {}, budgetExempt: true, run: async () => 'ok' })
    try {
      const ctx = context(); ctx.turn.asyncResult = { kind: 'agy', id: 'aabbccddee' }
      assert.ok(registry.forTurn(ctx).some(t => t.name === 'custom_tool'))
      assert.equal((await registry.get('agy')!.run({ action: 'start', task: 'do it' }, context(false)) as any).isError, true)
    } finally {
      registry.unregisterWhere(t => t.name === 'custom_tool')
    }
  })
  it('preserves normal declarations, and delivers images', async () => {
    for (const name of ['read_image', 'send_image', 'custom_tool']) registry.register({ name, description: name, parameters: {}, budgetExempt: true, run: async () => 'ok' })
    const ctx = context(); ctx.turn.asyncResult = { kind: 'agy', id: 'aabbccddee' }
    const offered = registry.forTurn(ctx)
    assert.deepEqual(offered.map(tool => tool.name), ['custom_tool', 'read_image', 'send_image'])
    const allowed = registry.get('custom_tool')!
    assert.ok(!(await registry.execute([{ id: 'side-effect', name: 'custom_tool', args: {} }], ctx, [allowed])).results[0].isError)
    registry.unregisterWhere(tool => ['read_image', 'send_image', 'custom_tool'].includes(tool.name))
    const image = Buffer.from('selected-image')
    const job: any = { id: 'aabbccddee', task: 'draw a chart', status: 'completed' }
    await completeAgyJob(job, { report: '/work/agy/aabbccddee/out/chart.png' }, ctx, {
      runTurn: async request => {
        assert.equal(request.eff, ctx.eff)
        assert.equal(request.sessionConfig, ctx.turn.sessionConfig)
        assert.ok(request.input.text.includes('/work/agy/aabbccddee/out/chart.png'))
        return { kind: 'reply', text: 'Here is the chart', images: [image], cost: 0, modelId: 'original-persona', thinking: 'off' }
      },
      deliver: async (_event, _text, _eff, opts) => { assert.deepEqual(opts.images, [image]) },
    })
  })
  it('filters secrets, identities and paths on both sides of the main-model summary', async () => {
    const ctx = context(); let delivered = ''
    const job = { id: 'aabbccddee', owner: '', task: '', status: 'completed' as const, createdAt: 0, updatedAt: 0 }
    await completeAgyJob(job, { report: 'Found https://example.org/art. account alice@example.com path C:\\Users\\Alice\\secret.txt' }, ctx, {
      runTurn: async request => {
        assert.equal(request.modelId, 'original-persona')
        assert.ok(request.asyncResult)
        assert.ok(!request.input.text.includes('alice@example.com'))
        assert.ok(!request.input.text.includes('C:\\Users'))
        return { kind: 'reply', text: 'Answer alice@example.com password=supersecret https://example.org/?token=private', images: [], cost: 0, modelId: 'original-persona', thinking: 'off' }
      },
      deliver: async (_event, text) => { delivered = text },
    })
    assert.ok(!delivered.includes('alice@example.com')); assert.ok(!delivered.includes('supersecret')); assert.ok(!delivered.includes('token=private'))
    assert.ok(delivered.includes('https://example.org/'))
    const reply = agyHistory(job.id).events.at(-1)!
    assert.equal(reply.kind, 'reply'); assert.equal(reply.delivery, 'sent')
    assert.equal(reply.text, delivered)
  })
  it('records failed delivery without falling back to raw worker output', async () => {
    const ctx = context()
    ctx.e.reply = async () => false
    const job = { id: 'abcdef1234', owner: '', task: '', status: 'completed' as const, createdAt: 0, updatedAt: 0 }
    await assert.rejects(completeAgyJob(job, { report: 'private worker report' }, ctx, {
      runTurn: async () => ({ kind: 'reply', text: 'Final answer', images: [], cost: 0, modelId: 'original-persona', thinking: 'off' }),
      deliver: async event => { await event.reply('Final answer') },
    }), /发送失败/)
    const reply = agyHistory(job.id).events.at(-1)!
    assert.equal(reply.delivery, 'failed'); assert.equal(reply.text, 'Final answer')
  })
  it('redacts known values in plain, URL encoded and base64 forms', () => {
    const secret = 'example/private-secret'
    const output = redact([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'Bearer abc123', '10.1.2.3', '+1 415 555 1234', '"password":"json-secret"', 'SID=cookie-secret'].join(' '), [secret])
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'abc123', '10.1.2.3', '555 1234', 'json-secret', 'cookie-secret']) assert.ok(!output.includes(value))
  })
  it('keeps public Pixiv artwork evidence URLs usable while redacting private numbers', () => {
    const url = 'https://www.pixiv.net/en/artworks/123456789'
    assert.equal(redact(url), url)
    assert.ok(!redact('phone 123456789').includes('123456789'))
    assert.ok(!redact(url, ['123456789']).includes('123456789'))
  })
})
