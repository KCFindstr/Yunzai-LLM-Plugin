import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'
import { startRollout, updateRollout, recordRolloutEvent } from '../src/chat/rollouts.ts'
import { log } from '../src/core/log.ts'

it('renders safe Markdown and mention chips with independent response switches, and filters paused/live logs', async () => {
  const port = await new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
  writeUserConfig(`web: { host: 127.0.0.1, port: ${port}, password: fixture-password }\n`); config.load()
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  const text = '## 核对结果\n\n[at:you] **已确认**，请 [at:A1B2](阿明) 查看。\n\n- 第一条结果\n- 第二条结果\n\n| 模型 | 结果 |\n| --- | --- |\n| 示例 | 通过 |\n\n```js\nconst id = "[at:code]";\n```\n\n[公开资料](https://example.invalid/source)\n\n[危险链接](javascript:alert(1))\n\n<img src=x onerror="window.__transcript_xss=true">\n\n![远程图片](https://example.invalid/do-not-load.png)'
  const id = startRollout({ conv: 'bot:p60001', input: '[at:you] 请向 [at:A1B2](阿明) 说明结果', source: 'chat', inputImageCount: 0 })
  recordRolloutEvent(id, { kind: 'response', text: '**检查完成** [at:A1B2]', step: 1 })
  updateRollout(id, { status: 'completed', reply: text, model: 'fixture-model' })
  log.info('fixture HEALTHY database')
  log.error('fixture Database failure')
  log.warn('fixture Network slow')
  const origin = `http://127.0.0.1:${port}`, errors: string[] = [], remote: string[] = []
  let browser: any
  const shot = async (page: any, name: string) => {
    if (!process.env.YZ_LLM_UI_SCREENSHOTS) return
    fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
    await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length === 0)
    await page.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, name), fullPage: true })
  }
  try {
    startWeb()
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'yzllm' }, body: JSON.stringify({ password: 'fixture-password' }) })
    const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=')
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    page.on('pageerror', (error: Error) => errors.push(error.message))
    page.on('request', (request: any) => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) remote.push(request.url()) })
    await page.setCookie({ name, value, url: origin })
    await page.setViewport({ width: 1440, height: 1050 })
    await page.goto(origin + `/#/rollouts/${id}`)
    await page.waitForSelector('.rollout-reply h2')
    const finalSwitch = 'button[data-response-control=reply][aria-label="渲染 Markdown"]'
    const modelSwitch = '.rollout-event[data-kind=response] button[aria-label="渲染 Markdown"]'
    assert.equal(await page.$('.page-head .markdown-chip'), null)
    assert.ok(await page.$('.computer-event-head .markdown-chip'))
    assert.ok(await page.$('h2 [data-response-control=reply]'))
    assert.equal(await page.$('.rollout-event[data-kind=response] .response-controls'), null)
    assert.ok(await page.$eval('.rollout-event[data-kind=response] .computer-event-head', (el: Element) => {
      const title = el.querySelector('strong')!.getBoundingClientRect()
      const control = el.querySelector('.markdown-chip')!.getBoundingClientRect()
      return Math.abs((title.top + title.bottom - control.top - control.bottom) / 2) < 5
    }), 'Markdown control shares the step title row')
    assert.equal(await page.$eval(modelSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), true)
    assert.equal(await page.$eval('.rollout-reply h2', (el: Element) => el.textContent), '核对结果')
    assert.equal(await page.$$eval('.rollout-reply .markdown-table tbody tr', (els: Element[]) => els.length), 1)
    assert.equal(await page.$$eval('.rollout-list strong .mention-chip', (els: Element[]) => els.length), 2)
    assert.equal(await page.$eval('.rollout-reply .mention-chip[data-user-id=A1B2]', (el: Element) => el.textContent), '@阿明')
    assert.equal(await page.$eval('.rollout-reply pre code', (el: Element) => el.textContent), 'const id = "[at:code]";')
    assert.equal(await page.$('.rollout-reply pre .mention-chip'), null)
    assert.equal(await page.$('.rollout-reply img, .rollout-reply script, .rollout-reply a[href^="javascript:"]'), null)
    assert.equal(await page.evaluate(() => (window as any).__transcript_xss), undefined)
    assert.equal(await page.$eval('[data-disclosure=reply] > summary h2', (el: Element) => el.textContent), '核对结果')
    await page.click('[data-disclosure=reply] > summary')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await shot(page, 'markdown-light.png')
    await page.click(finalSwitch)
    await page.waitForFunction(() => !document.querySelector('.rollout-reply h2'))
    assert.ok((await page.$eval('.rollout-reply', (el: Element) => el.textContent!)).includes('## 核对结果'))
    assert.equal(await page.$eval(modelSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), true)
    assert.ok(await page.$('.rollout-event[data-kind=response] .rich-text strong'))
    await page.reload(); await page.waitForSelector('.rollout-reply')
    assert.equal(await page.$eval(finalSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), false)
    assert.equal(await page.$eval(modelSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), true)
    await page.click(modelSwitch)
    assert.equal(await page.$('.rollout-event[data-kind=response] .rich-text'), null)
    await page.click(finalSwitch); await page.waitForSelector('.rollout-reply h2')
    assert.equal(await page.$eval(modelSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), false)
    recordRolloutEvent(id, { kind: 'progress', text: 'fixture refresh' })
    await page.click('.page-head .btn:not(.menu-btn)')
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('fixture refresh'))
    assert.equal(await page.$eval(modelSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), false)
    assert.equal(await page.$eval(finalSwitch, (el: Element) => el.getAttribute('aria-pressed') === 'true'), true)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await shot(page, 'markdown-dark.png')
    await page.setViewport({ width: 390, height: 1000 })
    await page.waitForFunction(() => document.querySelector('aside.side')!.getBoundingClientRect().right <= 0)
    await page.$eval('[data-disclosure=reply]', (el: HTMLDetailsElement) => { el.open = true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await shot(page, 'markdown-mobile.png')
    await page.goto(origin + '/#/logs'); await page.waitForSelector('.log .error')
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.page-head button')).find(b => b.textContent === '暂停接收')!.click())
    let polls = 0
    page.on('request', (request: any) => { if (request.url().includes('/api/logs')) polls++ })
    await page.select('select[aria-label="日志级别"]', 'error')
    await page.type('input[aria-label="搜索日志内容"]', 'DATABASE')
    assert.equal(await page.$$eval('.log .l', (els: Element[]) => els.length), 1)
    assert.equal(await page.$eval('.log mark', (el: Element) => el.textContent), 'Database')
    assert.equal(polls, 0, 'paused filtering uses retained lines without refetching')
    await page.select('select[aria-label="日志级别"]', 'warn')
    assert.ok((await page.$eval('.log', (el: Element) => el.textContent!)).includes('没有匹配的日志'))
    await page.$eval('input[aria-label="搜索日志内容"]', (el: HTMLInputElement) => { el.value = 'NETWORK'; el.dispatchEvent(new Event('input')) })
    assert.equal(await page.$$eval('.log .warn', (els: Element[]) => els.length), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await shot(page, 'logs-filter-mobile.png')
    log.warn('fixture Network new live line')
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.page-head button')).find(b => b.textContent === '继续接收')!.click())
    await page.waitForFunction(() => document.querySelector('.log')!.textContent!.includes('new live line'))
    assert.equal(await page.$$eval('.log .warn', (els: Element[]) => els.length), 2)
    assert.equal(await page.$$eval('.log .l', (els: Element[]) => new Set(els.map(el => el.getAttribute('data-seq'))).size), 2)
    assert.deepEqual(errors, []); assert.deepEqual(remote, [])
  } finally { await browser?.close(); stopWeb() }
})
