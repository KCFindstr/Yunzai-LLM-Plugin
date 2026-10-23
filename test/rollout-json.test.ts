import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseRolloutJson } from '../web/js/rollout-data.js'
import { rolloutHistory, startRollout, updateRollout } from '../src/chat/rollouts.ts'

it('recovers legacy redacted numeric tokens while leaving quoted placeholders intact', () => {
  const raw = '{"answers":{"kind":{"probabilities":{"casual":0.1,"question":0.84,"complex":0.06}}},"cost":0.[private number],"note":"0.[private number]","id":[private number],"exponent":1.2e-[private number]}'
  const parsed = parseRolloutJson(raw)
  assert.equal(parsed.cost, null)
  assert.equal(parsed.id, null)
  assert.equal(parsed.exponent, null)
  assert.equal(parsed.note, '0.[private number]')
  assert.equal(parsed.answers.kind.probabilities.question, 0.84)
  for (const invalid of [undefined, null, 42, 'complex', '{"truncated":', '{"a":function(){}}']) assert.equal(parseRolloutJson(invalid), undefined)
})

it('keeps long metric decimals parseable and repairs old records without restoring lost private values', () => {
  const id = startRollout({ conv: 'json-regression', source: 'chat', input: 'test', inputImageCount: 0 })
  const probabilities = { casual: 0.10000000012345678, question: 0.8399999998765432, complex: 0.06 }
  const response = { model: 'jev-latest', answers: { kind: { choice: 'question', confidence: 0.7654321098765432, probabilities } }, usage: { input_tokens: 612, output_tokens: 39 }, cost: 0.000025704000000000004 }
  const decision = { setting: 'auto' as const, level: 'medium' as const, source: 'systemone' as const, kind: 'question' as const, ms: 10,
    judge: { kind: 'question' as const, model: 'jev-latest', response: JSON.stringify(response), inputTokens: 612, outputTokens: 39, cost: response.cost } }
  updateRollout(id, { thinkingDecision: decision })
  let clean = JSON.parse(rolloutHistory(id)!.thinkingDecision!.judge!.response)
  assert.deepEqual(clean.answers.kind.probabilities, probabilities)
  assert.equal(clean.answers.kind.confidence, response.answers.kind.confidence)
  assert.equal(clean.cost, response.cost)
  decision.judge.response = JSON.stringify(response).replace(String(response.cost), '0.[private number]')
  updateRollout(id, { thinkingDecision: decision })
  clean = JSON.parse(rolloutHistory(id)!.thinkingDecision!.judge!.response)
  assert.deepEqual(clean.answers.kind.probabilities, probabilities)
  assert.equal(clean.cost, response.cost, 'billing metadata can recover the known cost, without guessing removed digits')
})
