import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'
import { addTask, cancelTask, getTask, listTasks } from '../src/chat/schedule.ts'

it('lists scheduled tasks with pagination, and edits and cancels them', async () => {
  const port = await new Promise<number>(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const selected = (server.address() as net.AddressInfo).port
      server.close(() => resolve(selected))
    })
  })
  writeUserConfig(`web: { port: ${port}, password: schedule-ui-test-password }\n`)
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  config.load()
  const owner = { createdBy: 'chat' as const, selfId: '10000', userId: '20001', userName: '岛风', groupId: '30001', groupName: '测试群', admin: false, chain: 0 }
  for (let i = 0; i < 24; i++) addTask(owner, { task: `提醒岛风第 ${i + 1} 件事`, nextAt: Date.now() + (i + 1) * 3600_000, repeat: i % 3 ? 'none' : 'daily' })
  const first = listTasks()[0]
  cancelTask(addTask({ ...owner, groupId: undefined, groupName: undefined }, { task: '已经取消的提醒', nextAt: Date.now() + 3600_000, repeat: 'none' }))

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
    await page.goto(`http://127.0.0.1:${port}/#/schedules`)
    await page.waitForSelector('input[type=password]')
    await page.type('input[type=password]', 'schedule-ui-test-password')
    await page.click('button[type=submit]')
    await page.waitForSelector('nav a[data-id=schedules]')
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 20)
    assert.match(await page.$eval('.pager', (el: Element) => el.textContent), /共 24 条/)
    await screenshot(page, 'schedules-desktop.png')

    await page.click('.pager button[aria-label=下一页]')
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4)
    await page.goto(`http://127.0.0.1:${port}/#/schedules/ended`)
    await page.waitForFunction(() => document.querySelector('tbody')?.textContent?.includes('已经取消的提醒'))

    // edit the soonest task
    await page.goto(`http://127.0.0.1:${port}/#/schedules`)
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 20)
    await page.click('tbody tr:first-child button.ghost:not(.danger)')
    await page.waitForSelector('.modal textarea')
    await page.$eval('.modal textarea', (el: HTMLTextAreaElement) => { el.value = '提醒岛风去开会' })
    await page.select('.modal select', 'weekly')
    await screenshot(page, 'schedules-edit.png')
    await page.click('.modal button.primary')
    await page.waitForFunction(() => document.querySelector('tbody tr:first-child')?.textContent?.includes('提醒岛风去开会'))
    assert.equal(getTask(first.id)!.task, '提醒岛风去开会')
    assert.equal(getTask(first.id)!.repeat, 'weekly')

    await page.click('tbody tr:first-child button.danger')
    await page.waitForSelector('.modal button.primary.danger')
    await page.click('.modal button.primary.danger')
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 20 && !document.querySelector('tbody')?.textContent?.includes('提醒岛风去开会'))
    assert.equal(getTask(first.id)!.status, 'cancelled')

    await page.setViewport({ width: 390, height: 844, isMobile: true })
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll on mobile')
    await screenshot(page, 'schedules-mobile.png')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    stopWeb()
  }
})
