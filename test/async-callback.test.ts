import { fakeEvent } from './helpers.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalize } from '../src/core/config.ts'
import { hasPendingJobs, rolloutHistory, startRollout, trackRolloutJob, updateRollout } from '../src/chat/rollouts.ts'
import { agyQueue, registerAgyTool } from '../src/tools/agy.ts'
import { registry, toolAccessError, toolUnavailable } from '../src/tools/registry.ts'
import type { ToolCtx } from '../src/tools/registry.ts'

function context(admin = true, maxChainDepth?: number): ToolCtx {
  const eff = normalize({ tools: { enable: true, agy: { enable: true, maxChainDepth } } }) as any
  return { e: fakeEvent().e, eff, isAdmin: admin, model: { id: 'original-persona' } as any, turn: { commands: 0, searches: 0, fetches: 0, images: [] } }
}
registerAgyTool()

describe('background results return to their own turn', () => {
  it('stops waiting when the job is cancelled instead of reporting back', async () => {
    const ctx = context()
    ctx.turn.rolloutId = startRollout({ conv: 'callback:cancel', source: 'chat', input: 'start it', inputImageCount: 0 })
    await registry.get('agy')!.run({ action: 'start', task: 'long task' }, ctx)
    const job = agyQueue.jobs.find(entry => entry.id === ctx.turn.agyJob)!
    assert.equal(job.rolloutId, ctx.turn.rolloutId)
    assert.equal(hasPendingJobs(ctx.turn.rolloutId), true)
    updateRollout(ctx.turn.rolloutId, { status: 'waiting_callback' })
    await registry.get('agy')!.run({ action: 'cancel', id: job.id }, context())
    assert.equal(hasPendingJobs(ctx.turn.rolloutId), false)
    assert.equal(rolloutHistory(ctx.turn.rolloutId)!.status, 'interrupted')
  })

  it('keeps waiting while another job from the same rollout is still pending', () => {
    const id = startRollout({ conv: 'callback:two', source: 'chat', input: 'two jobs', inputImageCount: 0 })
    trackRolloutJob(id, 'aaaaaaaaaa'); trackRolloutJob(id, 'bbbbbbbbbb')
    updateRollout(id, { status: 'waiting_callback' })
    agyQueue.cancel({ id: 'aaaaaaaaaa', rolloutId: id, status: 'queued' } as any)
    assert.equal(rolloutHistory(id)!.status, 'waiting_callback')
  })

  it('limits how many times result turns may chain new jobs', async () => {
    const tool = registry.get('agy')!
    const callback = (depth: number, max?: number) => {
      const ctx = context(true, max)
      ctx.turn.asyncResult = { kind: 'agy', id: 'aabbccddee' }
      ctx.turn.chainDepth = depth
      return ctx
    }
    const refused = await tool.run({ action: 'start', task: 'again' }, callback(2)) as any
    assert.equal(refused.isError, true)
    assert.match(refused.content, /上限（1 次）/)
    assert.equal((await tool.run({ action: 'start', task: 'again' }, callback(1, 0)) as any).isError, true, '0 disables chaining')
    const ctx = callback(1)
    assert.equal(typeof await tool.run({ action: 'start', task: 'again' }, ctx), 'string')
    const job = agyQueue.jobs.find(entry => entry.id === ctx.turn.agyJob)!
    assert.equal(job.chainDepth, 1)
    agyQueue.cancel(job)
  })
})

describe('tool availability messages', () => {
  it('only reports admin-only for tools whose gate admins pass', () => {
    registry.register({ name: 'always_on', description: 't', parameters: {}, run: async () => 'ok' })
    try {
      assert.equal(toolAccessError('always_on', context(false)), undefined)
      assert.equal(toolAccessError('agy', context(false))?.adminOnly, true)
      const disabled = context(false); disabled.eff.tools.disabled = ['agy']
      assert.match(toolUnavailable('agy', disabled)!.content, /配置中禁用/, 'disabled wins over the permission hint')
      assert.match(toolUnavailable('missing_tool', context())!.content, /不存在/)
    } finally {
      registry.unregisterWhere(tool => tool.name === 'always_on')
    }
  })
})
