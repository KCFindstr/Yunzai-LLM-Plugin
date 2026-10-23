import { mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

// both judges always answer "casual", so any other outcome comes from the image rules
const llm = await mockServer(() => [200, { choices: [{ message: { role: 'assistant', content: 'casual' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }])
const s1 = await mockServer(() => [200, { model: 'jev-latest', answers: { kind: { type: 'choice', choice: 'casual' } } }])
after(() => Promise.all([llm.close(), s1.close()]))
writeUserConfig(`providers:\n  judge: { type: openai, baseUrl: ${llm.url}, apiKey: k, maxRetries: 0 }\nmodels:\n  - { id: judge, provider: judge, model: tiny }\ndefaultModel: judge\npricing: { sources: [] }\n`)

const { config } = await import('../src/core/config.ts')
config.load()
const { JUDGE_PROMPT, judgeMessage, judgeUserText, photoCount } = await import('../src/chat/thinking.ts')
const q = { userId: 1 }
const cfg = (mode: string) => ({ ...config.get().chat.thinkingJudge, mode, url: `${s1.url}/v1/systemone`, apiKey: 'sk', timeoutMs: 1000 }) as any

describe('thinking judge with images', () => {
  it('tells pictures from stickers using the message markers', () => {
    assert.equal(photoCount('这是啥[图片]', 1), 1)
    assert.equal(photoCount('哈哈[表情包]', 1), 0)
    assert.equal(photoCount('[表情包]看这个[图片]', 2), 1)
    assert.equal(photoCount('看看引用的图', 1), 1) // quoted picture: no marker in the text
    assert.equal(photoCount('没有图', 0), 0)
  })

  it('shows the judge a picture placeholder (and that it must be looked at), stickers as stickers', () => {
    assert.match(judgeUserText('这是啥[图片]', { images: 1 }), /附带 1 张图片，回复需要先看图/)
    assert.match(judgeUserText('哈哈[表情包]', { images: 1 }), /附带 1 个表情包/)
    assert.match(JUDGE_PROMPT, /看图/)
  })

  it('never shortcuts a short message with a picture to casual', async () => {
    for (const mode of ['heuristic', 'model', 'systemone']) {
      const j = await judgeMessage({ text: '这是啥[图片]', images: 1 }, cfg(mode), q)
      assert.equal(j.kind, 'question', `${mode}: ${j.source}`)
    }
  })

  it('raises a casual verdict to question when a picture is attached, but leaves stickers casual', async () => {
    for (const mode of ['model', 'systemone']) {
      const withPicture = await judgeMessage({ text: '帮我看看这个是什么东西[图片]', images: 1 }, cfg(mode), q)
      assert.deepEqual([withPicture.kind, withPicture.source], ['question', mode])
      const withSticker = await judgeMessage({ text: '哈哈哈笑死我了[表情包]', images: 1 }, cfg(mode), q)
      assert.equal(withSticker.kind, 'casual')
    }
    // SystemOne received the placeholder in its state text
    assert.ok(s1.requests.some(r => /附带 1 张图片/.test(r.body.state)))
  })

  it('a bare picture is a question, a bare sticker is chat', async () => {
    assert.equal((await judgeMessage({ text: '[图片]', images: 1 }, cfg('model'), q)).kind, 'question')
    assert.equal((await judgeMessage({ text: '[表情包]', images: 1 }, cfg('model'), q)).kind, 'casual')
  })
})
