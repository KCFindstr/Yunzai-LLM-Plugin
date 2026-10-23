import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { RolloutFileStore } from '../src/chat/rolloutStore.ts'
import { migrateRollouts } from '../cli/migrate-rollouts.mjs'
import type { Rollout } from '../src/chat/rollouts.ts'

function fixture(id: string): Rollout {
  return { id, conv: 'store-test', source: 'chat', input: 'input', reply: 'reply', status: 'completed',
    createdAt: 1, updatedAt: 2, steps: 1, cost: 0, ms: 1, inputImageCount: 0, seq: 1, dropped: 0,
    events: [{ seq: 1, at: 2, kind: 'reply', text: 'detail-only-result' }],
    context: { system: 'detail-only-system', tools: [], messages: [], nativeSearch: false, omittedMessages: 0, omittedTools: 0, truncated: false } }
}
function summary({ events, context, seq, reply, thinkingDecision, ...entry }: Rollout) { return entry }
function location(name: string) {
  const directory = path.join(TMP, name, 'rollouts'), legacy = path.join(TMP, name, 'rollouts.json')
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  return { directory, legacy }
}

it('migrates complete records to individual files and reads only the requested detail', t => {
  const { directory, legacy } = location('migration')
  const records = [fixture('0123456789abcdef'), fixture('fedcba9876543210')]
  fs.writeFileSync(legacy, JSON.stringify({ v: 1, rollouts: records }))
  assert.equal(migrateRollouts(path.dirname(legacy)).migrated, 2)
  let store = new RolloutFileStore(directory, summary)
  assert.ok(!fs.existsSync(legacy))
  const index = JSON.parse(fs.readFileSync(store.indexFile, 'utf8'))
  assert.equal(index.v, 2)
  assert.equal(index.rollouts.length, 2)
  assert.ok(!JSON.stringify(index).includes('detail-only'))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${records[0].id}.json`), 'utf8')), records[0])
  store.dispose()

  const reads: string[] = [], original = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0]))
    return (original as any)(...args)
  })
  store = new RolloutFileStore(directory, summary)
  try {
    assert.equal(store.list().length, 2)
    assert.deepEqual(reads, [store.indexFile])
    assert.deepEqual(store.get(records[0].id), records[0])
    assert.equal(reads.length, 2)
    assert.equal(store.get('../config'), undefined)
    store.get(records[0].id)
    assert.equal(reads.length, 2, 'cached detail should not be read twice')
    const writes: string[] = [], write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      writes.push(String(args[0]))
      return (write as any)(...args)
    })
    const changed = store.get(records[0].id)!
    changed.reply = 'updated'
    store.put(changed)
    store.flush()
    assert.ok(writes.includes(path.join(directory, `${changed.id}.json.tmp`)))
    assert.ok(!writes.some(file => file.includes(records[1].id)), 'unchanged details must not be rewritten')
    assert.ok(!fs.existsSync(path.join(directory, 'pending.json')))
  } finally { store.dispose() }
})

it('preserves the migration source on failure and supports an explicit retry', () => {
  const { directory, legacy } = location('retry')
  const good = fixture('1111111111111111')
  fs.writeFileSync(legacy, JSON.stringify({ rollouts: [good, { ...good, id: '../invalid' }] }))
  assert.throws(() => migrateRollouts(path.dirname(legacy)), /原文件已保留/)
  assert.ok(fs.existsSync(legacy))
  fs.writeFileSync(legacy, JSON.stringify({ rollouts: [good, fixture('2222222222222222')] }))
  migrateRollouts(path.dirname(legacy))
  const store = new RolloutFileStore(directory, summary)
  try { assert.equal(store.list().length, 2); assert.deepEqual(store.get(good.id), good) }
  finally { store.dispose() }
})

it('recovers interrupted detail/index writes and deletions from the small pending journal', () => {
  const { directory, legacy } = location('recovery')
  let store = new RolloutFileStore(directory, summary)
  const first = fixture('3333333333333333'), deleted = fixture('4444444444444444')
  store.put(first); store.put(deleted); store.dispose()
  const changed = { ...first, status: 'failed' as const, updatedAt: 3 }
  const fresh = fixture('5555555555555555')
  fs.writeFileSync(path.join(directory, `${first.id}.json`), JSON.stringify(changed))
  fs.writeFileSync(path.join(directory, `${fresh.id}.json`), JSON.stringify(fresh))
  fs.writeFileSync(path.join(directory, 'pending.json'), JSON.stringify({ updated: [first.id, fresh.id], removed: [deleted.id] }))
  store = new RolloutFileStore(directory, summary)
  try {
    assert.equal(store.list().find(r => r.id === first.id)!.status, 'failed')
    assert.deepEqual(store.get(fresh.id), fresh)
    assert.equal(store.get(deleted.id), undefined)
    assert.ok(!fs.existsSync(path.join(directory, `${deleted.id}.json`)))
    assert.ok(!fs.existsSync(path.join(directory, 'pending.json')))
  } finally { store.dispose() }
})

it('keeps a bounded detail cache and removes expired detail files without loading them', t => {
  const { directory, legacy } = location('cache')
  const store = new RolloutFileStore(directory, summary)
  try {
    for (let n = 0; n < 80; n++) store.put(fixture(n.toString(16).padStart(16, '0')))
    store.flush()
    assert.ok((store as any).cache.size <= 64)
    assert.equal(store.get('0000000000000000')!.id, '0000000000000000')
    const original = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      assert.ok(!String(args[0]).endsWith('0000000000000001.json'))
      return (original as any)(...args)
    })
    store.remove('0000000000000001')
    store.flush()
    assert.ok(!fs.existsSync(path.join(directory, '0000000000000001.json')))
    assert.equal(store.list().length, 79)
  } finally { store.dispose() }
})

it('runtime uses only the new layout and never reads or migrates the old file', () => {
  const { directory, legacy } = location('no-fallback')
  fs.writeFileSync(legacy, JSON.stringify({ rollouts: [fixture('6666666666666666')] }))
  const store = new RolloutFileStore(directory, summary)
  try {
    assert.deepEqual(store.list(), [])
    assert.ok(fs.existsSync(legacy))
    assert.equal(store.get('6666666666666666'), undefined)
  } finally { store.dispose() }
})

it('can retry an interrupted offline migration without replacing a newer detail', t => {
  const { directory, legacy } = location('interrupted-migration')
  const first = fixture('7777777777777777'), second = fixture('8888888888888888')
  fs.writeFileSync(legacy, JSON.stringify({ rollouts: [first, second] }))
  const write = fs.writeFileSync
  const failure = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).includes(second.id)) throw new Error('simulated write failure')
    return (write as any)(...args)
  })
  assert.throws(() => migrateRollouts(path.dirname(legacy)), /simulated write failure/)
  assert.ok(fs.existsSync(legacy))
  failure.mock.restore()
  const updated = { ...first, updatedAt: 5, reply: 'newer detail' }
  fs.writeFileSync(path.join(directory, `${first.id}.json`), JSON.stringify(updated))
  assert.deepEqual(migrateRollouts(path.dirname(legacy)), { migrated: 2, indexed: 2 })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${first.id}.json`), 'utf8')), updated)
  assert.ok(!fs.existsSync(legacy))
  assert.deepEqual(migrateRollouts(path.dirname(legacy)), { migrated: 0, alreadyMigrated: true })
})
