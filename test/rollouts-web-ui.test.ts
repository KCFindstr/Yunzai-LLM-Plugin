import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'
import { recordRolloutContext, recordRolloutEvent, startRollout, updateRollout } from '../src/chat/rollouts.ts'
import { log } from '../src/core/log.ts'
import { recordTurn } from '../src/chat/turnLog.ts'
import { appendTurn } from '../src/chat/session.ts'

it('serves authenticated rollout history and renders live timelines, links and safe arguments on desktop/mobile', async () => {
  const port = await new Promise<number>(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const selected = (server.address() as net.AddressInfo).port
      server.close(() => resolve(selected))
    })
  })
  writeUserConfig(`web: { port: ${port}, password: rollout-ui-test-password }\n`)
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  config.load()
  const completed = startRollout({ conv: 'bot:p20001', input: '查找这张图片的原始出处', source: 'chat', inputImageCount: 1 })
  recordRolloutEvent(completed, { kind: 'response', text: '正在核对图片来源\n' + '核对公开页面、发布日期与原始图片。'.repeat(35), step: 1, inputTokens: 4200, outputTokens: 200, ms: 1200 })
  recordRolloutEvent(completed, { kind: 'tool', tool: 'search_web', callId: 'call-1', phase: 'running', step: 1, text: '正在执行', args: '<script>window.__rollout_xss=true</script> alice@example.com password=secret-password' })
  recordRolloutEvent(completed, { kind: 'tool', tool: 'search_web', callId: 'call-1', phase: 'completed', step: 1, text: '匹配到公开图片页面', ms: 500 })
  recordRolloutEvent(completed, { kind: 'reply', text: '我找到了这张图的来源。' })
  updateRollout(completed, { status: 'completed', model: 'main-model', thinking: 'medium', thinkingDecision: {
    setting: 'auto', level: 'medium', source: 'systemone', kind: 'question', ms: 85,
    judge: { kind: 'question', model: 'jev-latest', response: JSON.stringify({ answers: { kind: { choice: 'question', confidence: 0.92, probabilities: { casual: 0.05, question: 0.92, complex: 0.03 } } } }, null, 2), inputTokens: 120, outputTokens: 1, cost: 0.00000504 },
  }, steps: 2, reply: '我找到了这张图的来源。', cost: 0.012, tokens: { input: 4200, output: 200, cacheRead: 1000 } })
  recordRolloutContext(completed, {
    system: '你是一个回答简洁的助手。password=secret-password',
    tools: [{ name: 'search_web', description: '搜索公开网页', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '上一轮消息' }] },
      { role: 'assistant', content: '上一轮回复' },
      { role: 'user', content: [{ type: 'text', text: '查找这张图片的原始出处' }, { type: 'image', data: 'private-image-bytes', mime: 'image/png' }] },
    ], nativeSearch: true,
  })
  log.info('rollout-theme-info')
  log.warn('rollout-theme-warning')
  appendTurn('bot:p20001', { role: 'user', content: [{ type: 'text', text: '查找这张图片的原始出处' }] }, { role: 'assistant', content: '我找到了这张图的来源。' })
  recordTurn({ rolloutId: completed, conv: 'bot:p20001', at: Date.now(), input: '查找这张图片的原始出处', reply: '我找到了这张图的来源。', tools: ['search_web'], cost: 0.012, ms: 1700 })
  const running = startRollout({ conv: 'bot:p20002', input: '搜索引用图片', source: 'chat', inputImageCount: 0 })
  updateRollout(running, { status: 'running', model: 'main-model' })
  recordRolloutEvent(running, { kind: 'progress', text: '等待模型响应', step: 1 })
  const base = `http://127.0.0.1:${port}`
  const errors: string[] = []
  let browser: any
  const screenshot = async (page: any, name: string) => {
    if (!process.env.YZ_LLM_UI_SCREENSHOTS) return
    fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
    await page.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement)?.blur() })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).length === 0)
    await page.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, name), fullPage: true })
  }
  try {
    startWeb()
    assert.equal((await fetch(base + '/api/rollouts')).status, 401)
    assert.equal((await fetch(base + `/api/rollouts/${completed}/history`)).status, 401)
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'yzllm' }, body: JSON.stringify({ password: 'rollout-ui-test-password' }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    assert.equal((await fetch(base + '/api/rollouts/does-not-exist/history', { headers: { cookie } })).status, 404)
    const history = await (await fetch(base + `/api/rollouts/${completed}/history`, { headers: { cookie } })).text()
    assert.ok(!history.includes('alice@example.com')); assert.ok(!history.includes('secret-password'))
    const list = await (await fetch(base + '/api/rollouts?conv=bot%3Ap20001', { headers: { cookie } })).json()
    assert.equal(list.length, 1); assert.equal(list[0].id, completed); assert.equal(list[0].events, undefined)
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.setViewport({ width: 1440, height: 1050 })
    await page.goto(base + '/#/rollouts')
    await page.waitForSelector('input[type=password]')
    await page.type('input[type=password]', 'rollout-ui-test-password')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.querySelector('.computer-task-text')?.textContent === '搜索引用图片')
    assert.ok(await page.$('nav a[data-id=rollouts]'))
    recordRolloutEvent(running, { kind: 'response', text: '已完成图片检索', step: 1 })
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('已完成图片检索'), { timeout: 10000 })
    await page.click(`a[href="#/rollouts/${completed}"]`)
    await page.waitForFunction(() => document.querySelector('.computer-task-text')?.textContent === '查找这张图片的原始出处')
    assert.equal(await page.$$eval('.rollout-detail .card > h2', (elements: Element[]) => elements.filter(el => el.textContent?.includes('思考强度')).length), 0)
    assert.equal(await page.$$eval('.rollout-event[data-kind=thinking]', (elements: Element[]) => elements.length), 1)
    assert.deepEqual(await page.$$eval('.judge-probability [role=meter]', (elements: Element[]) => elements.map(el => Number(el.getAttribute('aria-valuenow')))), [5, 92, 3])
    assert.equal(await page.$eval('.rollout-judge', (el: HTMLDetailsElement) => el.open), false)
    assert.equal(await page.$$eval('.rollout-event[data-kind=tool]', (elements: Element[]) => elements.length), 1)
    assert.equal(await page.$eval('.rollout-event[data-kind=response] .text-disclosure', (el: HTMLDetailsElement) => el.open), false)
    await page.click('.rollout-event[data-kind=response] .text-disclosure > summary')
    await page.click('.tool-disclosure > summary')
    await page.click('.computer-arguments summary')
    await page.click('.rollout-judge > summary')
    const body = await page.evaluate(() => document.body.innerText)
    for (const expected of ['最终回复', '我找到了这张图的来源', '正在核对图片来源', '匹配到公开图片页面', '输入 4,200', 'call-1', '思考 medium', '自动 → medium', 'jev-latest', 'confidence', '0.92', 'probabilities', '判断费用 $0.000005']) assert.ok(body.includes(expected), expected)
    assert.equal(await page.$eval('.rollout-detail a[href^="#/conversations/"]', (el: HTMLAnchorElement) => el.getAttribute('href')), '#/conversations/bot%3Ap20001')
    assert.equal(await page.$eval('.rollout-detail a[href^="#/vectors/"]', (el: HTMLAnchorElement) => el.getAttribute('href')), '#/vectors/bot%3Ap20001')
    assert.ok(body.includes('<script>window.__rollout_xss=true</script>'))
    assert.equal(await page.evaluate(() => (window as any).__rollout_xss), undefined)
    assert.ok(!body.includes('alice@example.com')); assert.ok(!body.includes('secret-password'))
    assert.equal(await page.$$eval('.request-inspector > details', (elements: HTMLDetailsElement[]) => elements.every(el => !el.open)), true)
    await page.click('[data-disclosure="available-tools"] > summary')
    await page.click('.tool-catalog details > summary')
    assert.ok(await page.$eval('.tool-catalog', (el: Element) => el.textContent!.includes('搜索公开网页') && el.textContent!.includes('query')))
    await page.click('[data-disclosure="chat-context"] > summary')
    await page.click('[data-disclosure="system-prompt"] > summary')
    assert.ok(await page.$eval('[data-disclosure="chat-context"]', (el: Element) => el.textContent!.includes('上一轮回复')))
    assert.equal(await page.$eval('.rollout-detail', (el: Element) => el.textContent!.includes('private-image-bytes') || el.textContent!.includes('secret-password')), false)
    recordRolloutEvent(completed, { kind: 'progress', text: '刷新记录' })
    await page.click('.page-head .btn:not(.menu-btn)')
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('刷新记录'))
    assert.ok(await page.$('.computer-arguments[open]'))
    assert.ok(await page.$('[data-disclosure="chat-context"][open]'))
    assert.ok(await page.$('.rollout-event[data-kind=response] .text-disclosure[open]'))
    await page.click('.rollout-event[data-kind=response] .text-disclosure > summary')
    await page.click('[data-disclosure="chat-context"] > summary')
    await page.click('[data-disclosure="available-tools"] > summary')
    await page.click('.rollout-judge > summary')
    await page.click('.tool-disclosure > summary')
    await screenshot(page, 'rollouts-desktop.png')
    await page.click('.side-foot button[aria-label="切换深色/浅色主题"]')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    assert.equal(await page.$eval('.side', (el: Element) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
    await screenshot(page, 'rollouts-light.png')
    await page.type('.computer-job-list input[type=search]', 'no-matching-rollout')
    await page.waitForFunction(() => document.body.textContent?.includes('没有匹配的执行记录'))
    await page.$eval('.computer-job-list input[type=search]', (el: HTMLInputElement) => { el.value = ''; el.dispatchEvent(new Event('input')) })
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('aside.side')!.getBoundingClientRect().right <= 0)
    await screenshot(page, 'rollouts-mobile.png')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.setViewport({ width: 1440, height: 1050 })
    await page.goto(base + '/#/logs')
    await page.waitForSelector('.log .warn')
    assert.equal(await page.$eval('.log', (el: Element) => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
    assert.equal(await page.$eval('.log .warn', (el: Element) => getComputedStyle(el).color), 'rgb(169, 104, 9)')
    await screenshot(page, 'logs-light.png')
    await page.click('.side-foot button[aria-label="切换深色/浅色主题"]')
    assert.equal(await page.$eval('.log', (el: Element) => getComputedStyle(el).backgroundColor), 'rgb(24, 38, 46)')
    assert.equal(await page.$eval('.log .warn', (el: Element) => getComputedStyle(el).color), 'rgb(237, 186, 101)')
    await screenshot(page, 'logs-dark.png')
    await page.click('.side-foot button[aria-label="切换深色/浅色主题"]')
    await page.reload()
    await page.waitForSelector('.log')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
    await page.goto(base + `/#/rollouts/${completed}`)
    await page.waitForSelector('.rollout-detail a[href^="#/vectors/"]')
    await page.setRequestInterception(true)
    page.on('request', (request: any) => {
      if (new URL(request.url()).pathname !== '/api/vectors') { request.continue(); return }
      request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ready: true, tag: 'fixture', variance: [0.7, 0.2, 0.1], sessions: [{ key: 'bot:p20001', label: '测试会话', vectors: 3 }],
        points: [[-.5, -.2, .2], [.5, .3, -.1], [.1, -.4, .3]].map((xyz, i) => ({ key: 'bot:p20001', id: `point-${i}`, at: Date.now(), day: '2026-10-23', kind: 'archive', text: `向量测试档案 ${i}`, xyz, cluster: 0 })),
        clusters: { k: 1, maxK: 2, auto: true, scores: [], list: [{ id: 0, size: 3, keywords: ['测试'], cohesion: 0.8, xyz: [0, 0, 0], exemplars: [0, 1] }] },
      }) })
    })
    await page.click('.rollout-detail a[href^="#/vectors/"]')
    await page.waitForSelector('.space canvas')
    assert.equal(await page.$eval('[data-page=vectors] h1', (el: HTMLElement) => el.textContent), '向量空间')
    assert.ok(await page.$eval('.space', (el: Element) => getComputedStyle(el).backgroundImage.includes('rgb(248, 250, 252)')))
    assert.equal(await page.$eval('.space .legend', (el: Element) => getComputedStyle(el).color), 'rgb(28, 43, 54)')
    await screenshot(page, 'vectors-light.png')
    await page.click('.side-foot button[aria-label="切换深色/浅色主题"]')
    assert.ok(await page.$eval('.space', (el: Element) => getComputedStyle(el).backgroundImage.includes('rgb(11, 20, 29)')))
    assert.equal(await page.$eval('.space .legend', (el: Element) => getComputedStyle(el).color), 'rgb(227, 237, 241)')
    await screenshot(page, 'vectors-dark.png')
    await page.goto(base + `/#/rollouts/${completed}`)
    await page.waitForSelector('.rollout-detail a[href^="#/conversations/"]')
    await page.click('.rollout-detail a[href^="#/conversations/"]')
    await page.waitForSelector('[data-page=conversations] .split .card')
    assert.ok(await page.$eval('[data-page=conversations]', (el: HTMLElement) => el.textContent!.includes('bot:p20001')))
    await page.goto(base + '/#/conversations/turns')
    await page.waitForSelector('tbody tr')
    await page.click('tbody tr')
    await page.click('.modal a[href^="#/rollouts/"]')
    await page.waitForSelector('.rollout-detail .computer-task-text')
    assert.equal(await page.$('.modal-bg'), null)
    await page.goto(base + '/#/rollouts/does-not-exist')
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('执行记录不存在或已清理'))
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); stopWeb() }
})
