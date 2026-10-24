import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { clearSession, getSession, getAgySession, peekSession, rememberAgyConversation } from '../src/chat/session.ts'
import { agyConversationFlags } from '../src/agy/runtime.ts'

it('keeps one AGY thread/workspace per chat session and never shares another session thread', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const first = getAgySession('bot:pfirst', 60)
  assert.equal(rememberAgyConversation('bot:pfirst', first.workspaceId, id), true)
  const again = getAgySession('bot:pfirst', 60)
  assert.equal(again.workspaceId, first.workspaceId)
  assert.equal(again.conversationId, id)
  const other = getAgySession('bot:psecond', 60)
  assert.notEqual(other.workspaceId, first.workspaceId)
  assert.equal(other.conversationId, undefined)
  assert.equal(rememberAgyConversation('bot:psecond', first.workspaceId, id), false)
  assert.deepEqual(agyConversationFlags(), ['--new-project'])
  assert.deepEqual(agyConversationFlags(id), ['--conversation', id])
  assert.throws(() => agyConversationFlags('injected --continue'), /无效/)
})

it('starts a new AGY conversation on chat reset/expiry and ignores late updates for the old session', () => {
  const old = getAgySession('bot:reset', 60)
  clearSession('bot:reset')
  const fresh = getAgySession('bot:reset', 60)
  assert.notEqual(fresh.workspaceId, old.workspaceId)
  assert.equal(rememberAgyConversation('bot:reset', old.workspaceId, '12345678-1234-1234-1234-123456789abc'), false)
  peekSession('bot:reset')!.updatedAt = 0
  const expired = getAgySession('bot:reset', 60)
  assert.notEqual(expired.workspaceId, fresh.workspaceId)
  assert.equal(expired.conversationId, undefined)
})

it('migrates a legacy private-profile conversation once while retaining its output folder', () => {
  getSession('bot:legacy', 60).agy = { workspaceId: 'be7f12defe', conversationId: '12345678-1234-1234-1234-123456789abc' }
  const migrated = getAgySession('bot:legacy', 60)
  assert.equal(migrated.workspaceId, 'be7f12defe')
  assert.equal(migrated.runtime, 'host-v1')
  assert.equal(migrated.conversationId, undefined)
  assert.equal(rememberAgyConversation('bot:legacy', migrated.workspaceId, '22345678-1234-1234-1234-123456789abc'), true)
  assert.equal(getAgySession('bot:legacy', 60).conversationId, '22345678-1234-1234-1234-123456789abc')
})
