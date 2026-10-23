import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'node:test'
import { record, resetStats, resetUsage } from '../src/billing/ledger.ts'
import { queryUsageCalls } from '../src/billing/history.ts'
import { computeCost, resolvePrice } from '../src/billing/pricing.ts'
import { emptyUsage } from '../src/llm/types.ts'

it('queries indexed per-call usage by half-open time range and model, preserves prices and separates reported totals', () => {
  const original = Date.now
  const model = { id: 'priced', provider: 'test', model: 'original-upstream', pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, perSearch: 0.01, perRequest: 0.02 } }
  const usage = { ...emptyUsage(), input: 1000, output: 200, cacheRead: 300, cacheWrite: 40, cacheWrite1h: 10, reasoning: 80, webSearches: 2 }
  try {
    Date.now = () => 1000
    const cost = computeCost(usage, resolvePrice(model))
    record(model, {}, cost, usage)
    Date.now = () => 2000
    record(model, {}, 0.5, { ...usage, cost: 0.5, inputIncomplete: true })
    record({ ...model, id: 'other' }, {}, 0.3)
    model.pricing.input = 99
    const first: any = queryUsageCalls(1000, 2000, 'priced').rows[0]
    assert.equal(first.calls, 1); assert.equal(first.inputCost, 0.002)
    assert.equal(first.outputCost, 0.0016); assert.equal(first.reasoning, 80)
    assert.equal(first.cacheRead, 300); assert.equal(first.cacheWrite1h, 10)
    assert.ok(Math.abs(first.cost - first.inputCost - first.outputCost - first.cachedCost - first.otherCost - first.unattributedCost) < 1e-12)
    const both: any = queryUsageCalls(1000, 2001, 'priced').rows[0]
    assert.equal(both.calls, 2); assert.equal(both.incompleteCalls, 1)
    assert.ok(Math.abs(both.unattributedCost - 0.5) < 1e-12)
    assert.equal(queryUsageCalls(0, 1000).rows.length, 0)
    const db = new DatabaseSync(path.join(TMP, 'data/usage.sqlite'))
    const raw = db.prepare('SELECT usage_json, price_json, upstream_model FROM usage_calls WHERE at = 1000').get()!
    assert.deepEqual(JSON.parse(String(raw.usage_json)), usage)
    assert.equal(JSON.parse(String(raw.price_json)).input, 2)
    assert.equal(raw.upstream_model, 'original-upstream')
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM usage_calls WHERE model = ? AND at >= ? AND at < ?').all('priced', 1000, 2000)
    assert.ok(plan.some(row => String(row.detail).includes('usage_calls_model_at')))
    db.close()
    resetUsage({ all: true })
    assert.equal(queryUsageCalls(0, 3000).rows.length, 2)
    resetStats(['priced'])
    assert.deepEqual(queryUsageCalls(0, 3000).rows.map(row => row.model), ['other'])
    resetStats()
    assert.equal(queryUsageCalls(0, 3000).rows.length, 0)
  } finally { Date.now = original }
})
