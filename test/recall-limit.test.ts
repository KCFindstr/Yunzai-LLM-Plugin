import { writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

writeUserConfig('memory: { recallLimit: 2 }\n')
const { config, normalize } = await import('../src/core/config.ts')
config.load()
const { appendTurn, clearSession, peekSession, recallSession } = await import('../src/chat/session.ts')
const { registry } = await import('../src/tools/registry.ts')
const { registerMemoryTool } = await import('../src/memory/tool.ts')

/** A session whose archive has 30 entries that all match "猫". */
function seed(key: string) {
  clearSession(key)
  appendTurn(key, { role: 'user', content: [{ type: 'text', text: '开始' }] }, { role: 'assistant', content: '好' })
  const s = peekSession(key)!
  s.archive = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, at: Date.now() - i * 60_000, text: `第${i}段：聊了猫猫` }))
}

describe('recall limit', () => {
  it('caps results at memory.recallLimit, below and above the old fixed 5', async () => {
    const key = '10000:p95001'
    seed(key)
    assert.equal((await recallSession(key, '猫猫', 10)).length, 2)
    config.get().memory.recallLimit = 20
    try {
      assert.equal((await recallSession(key, '猫猫', 20)).length, 20)
      // the caller's count still applies under the limit
      assert.equal((await recallSession(key, '猫猫', 3)).length, 3)
      // a date range doesn't bypass the cap either
      const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
      assert.ok((await recallSession(key, '', 50, { range: { from: '2000-01-01', to: day } })).length <= 20)
    } finally {
      config.get().memory.recallLimit = 2
    }
  })

  it('clamps the setting to 1-100', () => {
    assert.equal(normalize({ memory: { recallLimit: 500 } }).memory.recallLimit, 100)
    assert.equal(normalize({ memory: { recallLimit: -3 } }).memory.recallLimit, 1)
    assert.equal(normalize({ memory: {} }).memory.recallLimit, 5)
  })

  it('tells the model the current limit in the recall tool description', () => {
    registerMemoryTool()
    const recall = registry.get('recall')!
    assert.match(recall.description, /最多返回2条/)
    config.get().memory.recallLimit = 40
    try {
      assert.match(recall.description, /最多返回40条/)
    } finally {
      config.get().memory.recallLimit = 2
    }
  })
})
