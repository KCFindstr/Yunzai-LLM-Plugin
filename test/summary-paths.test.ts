import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { CHATTER_PROMPT, DAY_PROMPT, SUMMARY_PROMPT } from '../src/chat/prompt.ts'

it('summaries describe images instead of keeping their stored paths', () => {
  for (const prompt of [SUMMARY_PROMPT, CHATTER_PROMPT, DAY_PROMPT]) {
    assert.doesNotMatch(prompt, /保留.{0,6}路径/)
    assert.match(prompt, /不写路径/)
  }
})
