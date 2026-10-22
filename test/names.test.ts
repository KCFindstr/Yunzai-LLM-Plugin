import { fakeEvent, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

writeUserConfig(`names:\n  '40001': 阿明\n  'A1B2C3D4E5': 小红\ngroups:\n  '50001':\n    names:\n      '40001': 明哥\n`)
const { config } = await import('../src/core/config.ts')
config.load()
const { configuredName, knownName, observeUsers, rosterLines, rosterSnapshot } = await import('../src/chat/roster.ts')
const { senderName } = await import('../src/core/yunzai.ts')
const { buildHeader } = await import('../src/chat/prompt.ts')
const { SCHEMA, schemaAt, validate, validatePath } = await import('../cli/schema.mjs')

/** An adapter that does report a member card, which configured names must still beat. */
const withCache = (over: Record<string, any>) => {
  const members = new Map([[40001, { card: '适配器名片', nickname: '适配器昵称' }]])
  return fakeEvent({ bot: { gml: new Map([[50001, members], [50002, members]]) }, ...over }).e
}

describe('configured names', () => {
  it('prefers the group name, then the global name, then the adapter, then what messages said', () => {
    assert.equal(configuredName('40001', 50001), '明哥')
    assert.equal(configuredName('40001', 50002), '阿明')
    assert.equal(configuredName('40001'), '阿明')
    assert.equal(configuredName('99999', 50001), undefined)
    assert.equal(knownName(withCache({ group_id: 50001, user_id: 40001 })), '明哥')
    assert.equal(knownName(withCache({ group_id: 50002, user_id: 40001 })), '阿明')
    // no configured name: the adapter's card still wins over the raw nickname
    config.get().names = {}
    try {
      assert.equal(knownName(withCache({ group_id: 50002, user_id: 40001 })), '适配器名片')
    } finally {
      config.load()
    }
  })

  it('names QQBot-style opaque IDs that the adapter reports nothing for', () => {
    const e = fakeEvent({ group_id: 50003, user_id: 'A1B2C3D4E5', sender: { user_id: 'A1B2C3D4E5' } }).e
    observeUsers(e)
    assert.equal(senderName(e), '小红')
    assert.match(buildHeader(e, config.effective('50003'), { text: '你好', images: [], imageSegments: [] } as any, false).sent, /小红\(平台ID A1B2C3D4E5\)/)
    assert.match(rosterLines(e, 10).join('\n'), /小红 \[at:A1B2C3D4E5\]/)
    const scope = rosterSnapshot().find(r => r.groupId === '50003')!
    assert.deepEqual(scope.people.find(p => p.id === 'A1B2C3D4E5')?.global, '小红')
  })

  it('validates names with the shared schema, including per-group names', () => {
    assert.equal(validatePath(['names', 'A1B2C3D4E5']), undefined)
    assert.ok(validatePath(['names', 'bad id with spaces']))
    assert.equal(schemaAt(['groups', '50001', 'names', '40001'])?.t, 'str')
    assert.equal(validate(SCHEMA, { names: { '40001': '阿明' }, groups: { '50001': { names: { '40001': '明哥' } } } }, config.get(), config.get()), undefined)
  })

  it('picks up names saved through config at runtime', () => {
    config.set('names.77777', '新朋友')
    try {
      assert.equal(knownName(fakeEvent({ group_id: 50009, user_id: 77777 }).e), '新朋友')
    } finally {
      config.delete('names.77777')
    }
    assert.equal(configuredName('77777'), undefined)
  })
})
