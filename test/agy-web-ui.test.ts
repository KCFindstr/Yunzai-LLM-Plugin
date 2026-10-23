import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'
import { agyQueue } from '../src/tools/agy.ts'
import { recordAgyEvent } from '../src/agy/history.ts'

it('renders AGY navigation, results, safe tool history, live refresh and cancellation on desktop/mobile', async () => {
  const port = await new Promise<number>(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const selected = (server.address() as net.AddressInfo).port
      server.close(() => resolve(selected))
    })
  })
  writeUserConfig(`web: { port: ${port}, password: agy-ui-test-password }\n`)
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  config.load()
  const completed = agyQueue.submit('private-owner', '查找这张图片的原始出处', 8)
  completed.status = 'completed'; completed.modelId = 'gemini-3.8-flash-medium'; completed.steps = 2
  completed.report = '找到了图片来源：https://example.org/art'
  completed.inputTokens = 4200; completed.outputTokens = 200
  recordAgyEvent(completed.id, { kind: 'request', text: completed.task })
  recordAgyEvent(completed.id, { kind: 'response', text: '正在核对图片来源', step: 1 })
  recordAgyEvent(completed.id, { kind: 'tool', tool: 'search_web', phase: 'completed', text: '匹配到公开图片页面', args: '<script>window.__agy_xss=true</script> alice@example.com password=secret-password' })
  recordAgyEvent(completed.id, { kind: 'reply', text: '我找到了这张图的来源。', delivery: 'sent' })
  const running = agyQueue.submit('another-private-owner', '搜索引用图片', 8)
  running.status = 'running'; running.progress = '正在搜索图片'
  recordAgyEvent(running.id, { kind: 'progress', text: running.progress })
  const errors: string[] = []
  let browser: any
  const screenshots = process.env.YZ_LLM_UI_SCREENSHOTS
  const screenshot = async (page: any, name: string) => {
    if (!screenshots) return
    fs.mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: path.join(screenshots, name), fullPage: true })
  }
  try {
    startWeb()
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.setViewport({ width: 1440, height: 1050 })
    await page.goto(`http://127.0.0.1:${port}/#/agy`)
    await page.waitForSelector('input[type=password]')
    await page.type('input[type=password]', 'agy-ui-test-password')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.querySelector('.computer-task-text')?.textContent === '搜索引用图片')
    assert.ok(await page.$('nav a[data-id=agy]'))
    running.progress = '正在核对搜索结果'
    await page.click('.page-head .btn:not(.menu-btn)')
    await page.waitForFunction(() => document.querySelector('.computer-progress')?.textContent?.includes('正在核对搜索结果'))
    await page.click('.computer-job-detail button.danger')
    await page.waitForSelector('.modal button.primary.danger')
    await page.click('.modal button.primary.danger')
    await page.waitForFunction(() => document.querySelector('.computer-job-detail')?.textContent?.includes('已取消') && !document.querySelector('.computer-job-detail button.danger'))
    assert.equal(running.status, 'cancelled')
    await page.click(`a[href="#/agy/${completed.id}"]`)
    await page.waitForFunction(() => document.querySelector('.computer-task-text')?.textContent === '查找这张图片的原始出处')
    const body = await page.evaluate(() => document.body.innerText)
    assert.match(body, /执行结果/); assert.match(body, /我找到了这张图的来源/); assert.match(body, /已发送/)
    assert.ok(!body.includes('private-owner'))
    await page.click('.tool-disclosure > summary')
    await page.click('.computer-arguments summary')
    const expanded = await page.evaluate(() => document.body.innerText)
    assert.ok(expanded.includes('<script>window.__agy_xss=true</script>'))
    assert.ok(!expanded.includes('alice@example.com')); assert.ok(!expanded.includes('secret-password'))
    assert.equal(await page.evaluate(() => (window as any).__agy_xss), undefined)
    await screenshot(page, 'agy-desktop.png')
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('aside.side')!.getBoundingClientRect().right <= 0)
    await screenshot(page, 'agy-mobile.png')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    await page.goto(`http://127.0.0.1:${port}/#/agy/0000000000`)
    await page.waitForFunction(() => document.querySelector('.computer-job-detail')?.textContent?.includes('任务不存在或已清理'))
    agyQueue.jobs.length = 0
    await page.goto(`http://127.0.0.1:${port}/#/agy`)
    await page.waitForFunction(() => document.body.textContent?.includes('还没有异步代理任务'))
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); stopWeb() }
})
