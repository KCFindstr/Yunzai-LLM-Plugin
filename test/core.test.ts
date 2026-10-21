import { TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

writeUserConfig(`# 用户注释必须保留
defaultModel: haiku
models:
  - id: cheap
    provider: anthropic
    model: claude-haiku-5-5
    quota: { window5h: 0.01, weekly: 0.02 }
  - id: big
    provider: anthropic
    model: claude-sonnet-5-5
    quota:
      global: { window5h: 5 }
`)

const { config } = await import('../src/core/config.ts')
const { computeCost, normalizeModelId, resolvePrice } = await import('../src/billing/pricing.ts')
const { checkQuota, limitsFor, record, summarize } = await import('../src/billing/ledger.ts')
const { prepareReply, stripMarkdown } = await import('../src/chat/reply.ts')
const { extractStickerMarkers } = await import('../src/stickers/picker.ts')
const { isPrivateIp } = await import('../src/tools/ssrf.ts')
const { htmlToText } = await import('../src/tools/web.ts')
const { estimateTokens, KeyedLock, sleep } = await import('../src/core/util.ts')

describe('config', () => {
  it('merges user config over defaults', () => {
    const c = config.get()
    assert.equal(c.models.length, 2)
    assert.equal(c.chat.historyMaxTurns, 20, 'default kept')
    assert.equal(config.getModel('CHEAP')?.model, 'claude-haiku-5-5')
  })

  it('set() keeps comments and treats numeric group ids as map keys', () => {
    config.set('groups.123456.enable', false)
    const text = fs.readFileSync(path.join(TMP, 'config', 'config.yaml'), 'utf8')
    assert.match(text, /用户注释必须保留/)
    assert.equal(config.get().groups['123456'].enable, false)
    assert.ok(!Array.isArray(config.get().groups), 'groups must stay a map')
    assert.equal(config.effective(123456).enable, false)
    assert.equal(config.effective(999).enable, true)
  })

  it('set() on array index paths materializes the array', () => {
    config.set('models.1.thinking', 'high')
    assert.equal(config.getModel('big')?.thinking, 'high')
    assert.equal(config.get().models.length, 2)
    config.set('reply.maxBubbles', 1)
    assert.equal(config.effective().reply.maxBubbles, 1)
    config.delete('reply.maxBubbles')
    assert.equal(config.effective().reply.maxBubbles, 2)
  })

  it('group overrides apply to effective config', () => {
    config.set('groups.555.sticker', { probability: 0.1 })
    config.set('groups.555.persona', '你是一只猫，说话句尾带喵，喜欢晒太阳和睡觉。')
    const eff = config.effective(555)
    assert.equal(eff.sticker.probability, 0.1)
    assert.equal(eff.sticker.cooldown, 180)
    assert.match(eff.personaPrompt, /喵/)
  })
})

describe('pricing', () => {
  it('normalizes ids across price lists', () => {
    assert.equal(normalizeModelId('anthropic/claude-sonnet-4.5:beta'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
    assert.equal(normalizeModelId('gemini-flash-latest'), 'gemini-flash')
  })

  it('computes cost from usage incl. cache and search', () => {
    const price = resolvePrice(config.getModel('big')!)!
    assert.equal(price.source, 'builtin')
    const cost = computeCost(
      { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 0, output: 1_000_000, reasoning: 0, webSearches: 2 },
      price,
    )
    // 2 + 0.2 + 2.5 + 10 + 2*0.01
    assert.ok(Math.abs(cost - 14.72) < 1e-9, String(cost))
    assert.equal(computeCost({ input: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 5, reasoning: 0, webSearches: 0, cost: 0.5 }, price), 0.5)
  })

  it('resolves builtin pricing for DeepSeek and Gemini models', () => {
    const ds = resolvePrice({ id: 'ds', provider: 'deepseek', model: 'deepseek-chat', pricing: 'auto' })!
    assert.equal(ds.source, 'builtin')
    assert.equal(ds.input, 0.28)
    assert.equal(ds.output, 0.42)

    const dsFlash = resolvePrice({ id: 'dsf', provider: 'deepseek', model: 'deepseek-flash', pricing: 'auto' })!
    assert.equal(dsFlash.source, 'builtin')
    assert.equal(dsFlash.input, 0.3)

    const argon = resolvePrice({ id: 'arg', provider: 'gemini', model: 'gemini-4-argon', pricing: 'auto' })!
    assert.equal(argon.source, 'builtin')
    assert.equal(argon.input, 2)
    assert.equal(argon.output, 10)
  })
})

describe('quota ledger', () => {
  it('shorthand applies to default scope, explicit scopes are separate', () => {
    const cheap = config.getModel('cheap')!
    assert.deepEqual(limitsFor(cheap, 'user'), { window5h: 0.01, weekly: 0.02 })
    assert.deepEqual(limitsFor(cheap, 'global'), { window5h: undefined, weekly: undefined })
    assert.deepEqual(limitsFor(config.getModel('big')!, 'global'), { window5h: 5, weekly: undefined })
  })

  it('blocks after spending the 5h budget and reports a reset time', () => {
    const cheap = config.getModel('cheap')!
    const ctx = { userId: 'u1', groupId: 'g1' }
    assert.equal(checkQuota(cheap, ctx), undefined)
    record(cheap, ctx, 0.006)
    assert.equal(checkQuota(cheap, ctx), undefined)
    record(cheap, ctx, 0.006)
    const block = checkQuota(cheap, ctx)!
    assert.equal(block.scope, 'user')
    assert.equal(block.window, '5h')
    assert.ok(block.resetInMs > 4.9 * 3600_000 && block.resetInMs <= 5 * 3600_000)
    assert.equal(checkQuota(cheap, { userId: 'u2', groupId: 'g1' }), undefined, 'other users unaffected')
    assert.equal(checkQuota(cheap, { ...ctx, isAdmin: true }), undefined, 'admins exempt from user scope')
    const s = summarize(cheap, 'user', ctx)!
    assert.ok(Math.abs(s.used5h - 0.012) < 1e-9)
  })
})

describe('reply formatting', () => {
  it('strips markdown', () => {
    const out = stripMarkdown('## 标题\n**加粗** 和 `代码`\n- 项目一\n- 项目二\n[链接](https://a.com)')
    assert.equal(out, '标题\n加粗 和 代码\n· 项目一\n· 项目二\n链接 https://a.com')
  })

  it('extracts sticker markers', () => {
    const r = extractStickerMarkers('好耶！\n[表情:狗头保命]')
    assert.equal(r.text, '好耶！')
    assert.deepEqual(r.names, ['狗头保命'])
    assert.deepEqual(extractStickerMarkers('【表情：开心】哈哈').names, ['开心'])
  })

  it('splits short multi-paragraph replies into bubbles, long ones become forward', () => {
    const base = config.effective().reply
    const cfg = { ...base, maxBubbles: 2, maxChars: 100 }
    assert.deepEqual(prepareReply('在的\n\n怎么啦', cfg).bubbles, ['在的', '怎么啦'])
    assert.deepEqual(prepareReply('一\n\n二\n\n三', cfg).bubbles, ['一', '二\n三'])
    const long = prepareReply('长'.repeat(150), cfg)
    assert.equal(long.bubbles.length, 0)
    assert.equal(long.forward?.length, 150)
    assert.deepEqual(prepareReply('a\n\nb', { ...cfg, maxBubbles: 1 }).bubbles, ['a\n\nb'])
  })
})

describe('web helpers', () => {
  it('blocks private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1'])
      assert.ok(isPrivateIp(ip), ip)
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip)
  })

  it('extracts readable text from html', () => {
    const r = htmlToText('<html><head><title>T &amp; T</title><script>x()</script></head><body><nav>menu</nav><p>你好&nbsp;世界</p><ul><li>a</li><li>b</li></ul></body></html>')
    assert.equal(r.title, 'T & T')
    assert.match(r.text, /你好 世界/)
    assert.match(r.text, /- a/)
    assert.doesNotMatch(r.text, /menu|x\(\)/)
  })
})

describe('rate limiting', () => {
  it('token bucket caps bursts and refills over time', async () => {
    const { RateLimiter } = await import('../src/chat/ratelimit.ts')
    const rl = new RateLimiter()
    const rate = { count: 2, perSeconds: 0.2 } // 2 per 200ms
    assert.ok(rl.tryTake('g', rate))
    assert.ok(rl.tryTake('g', rate))
    assert.ok(!rl.tryTake('g', rate), 'third message in the burst is refused')
    assert.ok(rl.tryTake('other', rate), 'buckets are per key')
    assert.ok(await rl.take('g', rate, 500), 'waits for refill within the deadline')
    const slow = { count: 1, perSeconds: 60 }
    assert.ok(await rl.take('s', slow, 50))
    assert.ok(!(await rl.take('s', slow, 50)), 'gives up instead of waiting past the deadline')
  })
})

describe('utils', () => {
  it('estimates tokens', () => {
    assert.ok(estimateTokens('你好世界') >= 4)
    assert.ok(estimateTokens('hello world, this is a test') < 12)
  })

  it('KeyedLock serializes per key', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    await Promise.all([
      lock.run('a', async () => {
        await sleep(30)
        order.push('a1')
      }),
      lock.run('a', async () => {
        order.push('a2')
      }),
      lock.run('b', async () => {
        order.push('b1')
      }),
    ])
    assert.deepEqual(order, ['b1', 'a1', 'a2'])
  })
})
