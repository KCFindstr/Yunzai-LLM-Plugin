import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { contextView, initialPromptText, splitPromptMessage } from '../web/js/context-view.js'

it('separates old assembled user messages without parsing markers inside the actual message', () => {
  const raw = '【2026-10-23｜群「测试」｜发言人 A】\n【最近群友·仅身份参考】\nA\nB\n【最近群聊】\nA: 先前发言\nB: 接话\n【相关旧聊天·参考】\n回忆\n【引用 B 消息】引用内容\n【消息】\n当前问题\n【最近群聊】\n这是用户原文'
  const parsed = splitPromptMessage(raw)
  assert.equal(parsed.text, '当前问题\n【最近群聊】\n这是用户原文')
  assert.deepEqual(parsed.recent, ['A: 先前发言', 'B: 接话'])
  assert.equal(parsed.roster.length, 2)
  assert.match(parsed.memory, /回忆/); assert.match(parsed.quote, /引用内容/)
  const view = contextView({ messages: [
    { role: 'user', text: '【长期记忆】\n称呼' }, { role: 'user', text: '【之前对话的摘要】\n旧事' },
    { role: 'user', text: '之前的问题' }, { role: 'assistant', text: '之前的回复' }, { role: 'user', text: raw },
  ] })
  assert.equal(view.memory.length, 1); assert.equal(view.summary.length, 1)
  assert.equal(view.history.length, 2); assert.equal(view.current.text, parsed.text)
  assert.equal(splitPromptMessage('<img onerror=alert(1)>').text, '<img onerror=alert(1)>')
})

it('prefers explicit source metadata and handles empty snapshots', () => {
  const current = { heading: '', text: '原始输入', roster: [], recent: ['1. A: 内容'], memory: '', quote: '' }
  const view = contextView({ current, messages: [
    { role: 'user', text: '【长期记忆】用户确实说过这句话', source: 'history' },
    { role: 'user', text: '截短的请求', source: 'current', imageCount: 1 },
  ] })
  assert.equal(view.history.length, 1); assert.equal(view.memory.length, 0)
  assert.equal(view.current.text, '原始输入'); assert.equal(view.current.imageCount, 1)
  assert.equal(contextView({ messages: [] }).current.text, '')
})

it('splits the combined message identity header immediately before the actual text and preserves body markers', () => {
  const heading = '【消息｜2026-10-23 周五 18:32｜群「1」｜发言人 会长(平台ID 2)】'
  const parsed = splitPromptMessage(`【最近群聊】\nA: 先前发言\n【引用 B 消息】引用内容\n${heading}\n当前正文\n【最近群聊】\n用户原文`)
  assert.equal(parsed.heading, heading)
  assert.deepEqual(parsed.recent, ['A: 先前发言'])
  assert.equal(parsed.quote, '【引用 B 消息】引用内容')
  assert.equal(parsed.text, '当前正文\n【最近群聊】\n用户原文')
  assert.equal(splitPromptMessage(`${heading}\n正文`).text, '正文')
  assert.equal(splitPromptMessage('【消息｜2026-10-23｜私聊｜对方 A】\n正文').text, '正文')
})

it('formats the saved initial prompt as plain text in request order with explicit truncation and image omissions', () => {
  const value = initialPromptText({ system: '系统提示', tools: [{ name: 'test', description: '工具说明', parameters: '{"type":"object"}' }],
    messages: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }, { role: 'user', text: '<script>原样保留</script>', imageCount: 1 }],
    nativeSearch: true, truncated: true, omittedMessages: 2, omittedTools: 1 })
  assert.ok(value.indexOf('[system]') < value.indexOf('[tools]'))
  assert.ok(value.indexOf('历史问题') < value.indexOf('历史回答'))
  assert.ok(value.indexOf('历史回答') < value.indexOf('<script>原样保留</script>'))
  assert.match(value, /不是完整请求/); assert.match(value, /message 3 · user/)
  assert.match(value, /未保存原始图片字节/); assert.match(value, /native search/)
})
