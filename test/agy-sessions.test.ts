import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { clearSession, getSession, getAgySession, peekSession } from '../src/chat/session.ts'

it('keeps the output workspace per chat without retaining a CLI conversation', () => {
  const first = getAgySession('bot:pfirst', 60)
  assert.deepEqual(getAgySession('bot:pfirst', 60), first)
  assert.equal(first.conversationId, undefined)
  assert.notEqual(getAgySession('bot:psecond', 60).workspaceId, first.workspaceId)
})

it('replaces the output workspace on chat reset or expiry', () => {
  const old = getAgySession('bot:reset', 60)
  clearSession('bot:reset')
  const fresh = getAgySession('bot:reset', 60)
  assert.notEqual(fresh.workspaceId, old.workspaceId)
  peekSession('bot:reset')!.updatedAt = 0
  assert.notEqual(getAgySession('bot:reset', 60).workspaceId, fresh.workspaceId)
})

it('discards saved conversations from both legacy and host runtimes without changing output paths', () => {
  for (const runtime of [undefined, 'host-v1'] as const) {
    getSession('bot:legacy', 60).agy = { workspaceId: 'be7f12defe', runtime, conversationId: '12345678-1234-1234-1234-123456789abc' }
    const migrated = getAgySession('bot:legacy', 60)
    assert.deepEqual(migrated, { workspaceId: 'be7f12defe', runtime: 'host-v1' })
  }
})
