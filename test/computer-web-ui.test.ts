import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'
import { computerQueue } from '../src/tools/computer.ts'
import { recordComputerEvent, saveComputerScreenshot } from '../src/computer/history.ts'

it('keeps computer response, reply and report Markdown controls in shared headings on desktop/mobile', async () => {
  const port = await new Promise<number>(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const selected = (server.address() as net.AddressInfo).port
      server.close(() => resolve(selected))
    })
  })
  writeUserConfig(`web: { host: 127.0.0.1, port: ${port}, password: computer-ui-fixture }\n`)
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  config.load()
  const job = computerQueue.submit('fixture-owner', '检查桌面截图', 8)
  job.status = 'completed'; job.report = '**桌面检查完成**'
  recordComputerEvent(job.id, { kind: 'response', text: '**正在检查桌面**', step: 1, model: 'fixture-model', ms: 1200 })
  const image = saveComputerScreenshot(job.id, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'))!
  recordComputerEvent(job.id, { kind: 'reply', text: '**桌面正常**', delivery: 'sent', images: [image] })
  const origin = `http://127.0.0.1:${port}`, errors: string[] = []
  let browser: any
  try {
    startWeb()
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'yzllm' }, body: JSON.stringify({ password: 'computer-ui-fixture' }) })
    const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=')
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.setCookie({ name, value, url: origin })
    await page.setViewport({ width: 1440, height: 1050 })
    await page.goto(`${origin}/#/computer/${job.id}`)
    await page.waitForSelector('.rollout-event[data-kind=reply] .markdown-chip')
    for (const kind of ['response', 'reply']) {
      assert.ok(await page.$eval(`.rollout-event[data-kind=${kind}] .computer-event-head`, (el: Element) => {
        const title = el.querySelector('strong')!.getBoundingClientRect()
        const chip = el.querySelector('.markdown-chip')!.getBoundingClientRect()
        return Math.abs((title.top + title.bottom - chip.top - chip.bottom) / 2) < 5
      }), `${kind} chip shares its title row`)
    }
    assert.ok(await page.$('summary [data-response-control=report-text]'))
    assert.equal(await page.$('.computer-job-detail .response-controls'), null)
    await page.waitForFunction(() => {
      const image = document.querySelector('.rollout-event[data-kind=reply] img') as HTMLImageElement
      return image?.complete && image.naturalWidth === 1
    })
    const replyChip = '.rollout-event[data-kind=reply] .markdown-chip'
    await page.click(replyChip)
    assert.equal(await page.$eval(replyChip, (el: Element) => el.getAttribute('aria-pressed')), 'false')
    assert.equal(await page.$eval('.rollout-event[data-kind=response] .markdown-chip', (el: Element) => el.getAttribute('aria-pressed')), 'true')
    await page.reload(); await page.waitForSelector(replyChip)
    assert.equal(await page.$eval(replyChip, (el: Element) => el.getAttribute('aria-pressed')), 'false')
    await page.setViewport({ width: 390, height: 844 })
    await page.waitForFunction(() => document.querySelector('aside.side')!.getBoundingClientRect().right <= 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); stopWeb() }
})
