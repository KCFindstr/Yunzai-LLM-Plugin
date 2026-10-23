import { TMP, fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { redact } from '../src/agy/privacy.ts'
import { isolatedEnvironment, scopedSettings, AGY_MODEL, AGY_EFFORT } from '../src/agy/runtime.ts'
import { registerAgyTool, agyQueue, completeAgyJob } from '../src/tools/agy.ts'
import { registry } from '../src/tools/registry.ts'
import type { ToolCtx } from '../src/tools/registry.ts'
import { agyHistory } from '../src/agy/history.ts'

function context(admin = true): ToolCtx {
  const eff = normalize({ tools: { agy: { enable: true } } }) as any
  return { e: fakeEvent().e, eff, isAdmin: admin, model: { id: 'original-persona' } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}
registerAgyTool()
describe('AGY isolation and async handoff', () => {
  it('uses sandbox-only approvals and no inherited personal environment', () => {
    const settings = scopedSettings('//wsl.localhost/vm/work/job', ['C:\\Users', 'D:\\Bot'])
    assert.ok(settings.permissions.allow.includes('read_file(//wsl.localhost/vm/work/job)'))
    assert.ok(settings.permissions.deny.includes('read_file(C:/Users)'))
    for (const action of ['command', 'unsandboxed', 'read_url', 'execute_url']) assert.ok(settings.permissions.deny.includes(`${action}(*)`))
    assert.equal(AGY_MODEL, 'gemini-3.8-flash-medium')
    assert.equal(AGY_EFFORT, 'medium')
    process.env.AGY_TEST_API_KEY = 'SECRET_VALUE'
    const env = isolatedEnvironment(path.join(TMP, 'private'))
    assert.equal(env.AGY_TEST_API_KEY, undefined)
    assert.equal(env.USERPROFILE, path.join(TMP, 'private'))
    delete process.env.AGY_TEST_API_KEY
  })
  it('defaults off and bounds configuration', () => {
    assert.equal(normalize({}).tools.agy.enable, false)
    const cfg = normalize({ tools: { agy: { enable: true, maxMinutes: 9999, maxQueue: -5, distro: '../escape' } } }).tools.agy
    assert.equal(cfg.maxMinutes, 30); assert.equal(cfg.maxQueue, 1); assert.equal(cfg.distro, 'yunzai-sandbox')
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
  it('does not allow worker results to trigger tools or bypass access checks', async () => {
    const ctx = context(); ctx.turn.asyncResult = { kind: 'agy', id: 'aabbccddee' }
    assert.deepEqual(registry.forTurn(ctx), [])
    assert.equal((await registry.get('agy')!.run({ action: 'start', task: 'do it' }, ctx) as any).isError, true)
    assert.equal((await registry.get('agy')!.run({ action: 'start', task: 'do it' }, context(false)) as any).isError, true)
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
})
