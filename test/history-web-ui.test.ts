import { mockServer, PLUGIN_ROOT, TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { it } from 'node:test'

it('edits and regenerates history from the authenticated web UI, refreshes vectors and fits mobile', async () => {
  let finish = 'stop'
  const upstream = await mockServer(async request => {
    if (request.url.endsWith('/embeddings')) return [200, { data: request.body.input.map((_: string, index: number) => ({ index, embedding: [1, 0.1, 0.2] })) }]
    await new Promise(resolve => setTimeout(resolve, 100))
    return [200, { choices: [{ message: { content: `模型 ${request.body.model} 重新生成的完整历史概要。` }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20 } }]
  })
  const port = await new Promise<number>(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
  writeUserConfig(`providers:
  mock: { type: openai, baseUrl: '${upstream.url}', apiKey: fixture, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: fixture-default, thinking: off }
  - { id: selected, provider: mock, model: fixture-selected, thinking: off }
defaultModel: main
utilityModel: main
web: { port: ${port}, password: history-ui-password }
memory:
  embedding: { enable: true, type: openai, baseUrl: '${upstream.url}', apiKey: fixture, model: fixture-vector }
`)
  fs.cpSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), { recursive: true })
  const { config } = await import('../src/core/config.ts')
  const { startWeb, stopWeb } = await import('../src/web/server.ts')
  const { appendTurn, archiveInfo, dayInfo, peekSession } = await import('../src/chat/session.ts')
  const { addDays, localDay } = await import('../src/chat/dates.ts')
  config.load()
  const key = '10000:g19881', yesterday = addDays(localDay(), -1)
  appendTurn(key, { role: 'user', content: [{ type: 'text', text: '周日去看猫展' }] }, { role: 'assistant', content: '好，周日见' })
  const s = peekSession(key)!
  s.summary = '已有的滚动摘要'
  s.archive = [
    { id: 'legacy', day: yesterday, at: Date.now() - 86460000, text: '旧版截断的档案，仅剩人物称呼' },
    { id: 'episode', day: yesterday, at: Date.now() - 86400000, text: '阿明和小红约好周日看猫展', sourceText: '原始聊天：阿明问周日看猫展，小红答应了。' },
  ]
  s.days = [{ id: 'digest', day: yesterday, at: Date.now(), sources: ['episode'], text: `${yesterday}，群内要事及闲聊如下：\n1.` }]
  const base = `http://127.0.0.1:${port}`
  let browser: any
  const errors: string[] = []
  try {
    startWeb()
    for (const route of [`/api/sessions/${key}/summary`, `/api/sessions/${key}/archive/digest`, `/api/sessions/${key}/messages/0`]) {
      assert.equal((await fetch(base + route, { method: 'PUT', headers: { 'x-requested-with': 'yzllm' } })).status, 401)
    }
    assert.equal((await fetch(`${base}/api/sessions/${key}/archive/digest/regenerate`, { method: 'POST', headers: { 'x-requested-with': 'yzllm' } })).status, 401)
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.setViewport({ width: 1440, height: 1050 })
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    await page.goto(`${base}/#/conversations/${encodeURIComponent(key)}`)
    await page.waitForSelector('input[type=password]')
    await page.type('input[type=password]', 'history-ui-password')
    await page.click('button[type=submit]')
    await page.waitForFunction(() => document.body.innerText.includes('摘要输出预算：8192'))
    assert.equal(await page.evaluate(() => {
      const entry = Array.from(document.querySelectorAll('.list-item')).find(el => el.textContent?.includes('旧版截断的档案，仅剩人物称呼'))
      const regenerate = Array.from(entry?.querySelectorAll('button') ?? []).find(button => button.textContent === '重新生成')
      return Boolean(entry?.textContent?.includes('原文未保留') && regenerate?.disabled && regenerate.title.includes('未保留聊天原文'))
    }), true)
    const action = async (title: string, label: string) => {
      await page.evaluate((title: string, label: string) => {
        const card = Array.from(document.querySelectorAll('.card')).find(el => el.querySelector('h2')?.textContent?.includes(title))
        const button = Array.from(card?.querySelectorAll('button') ?? []).find(el => el.textContent === label)
        if (!button) throw new Error(`Missing ${title} ${label}`)
        button.click()
      }, title, label)
      await page.waitForSelector('.modal-bg')
    }
    const submit = async (label: string) => {
      await page.evaluate((label: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.modal footer button')).find(el => el.textContent === label)
        if (!button) throw new Error(`Missing submit ${label}`)
        button.click()
      }, label)
      await page.waitForSelector('.modal-bg', { hidden: true })
    }
    const edit = async (title: string, text: string) => {
      await action(title, '编辑')
      await page.$eval('.modal textarea', (el: HTMLTextAreaElement, value: string) => { el.value = value }, text)
      await submit('保存')
      await page.waitForFunction((text: string) => document.querySelector('.rollout-detail')?.textContent?.includes(text), {}, text)
    }
    await edit('每日概要', '修正后的完整每日概要：阿明和小红约好周日看猫展。')
    assert.ok(dayInfo(key)[0].vector)
    await action('每日概要', '重新生成')
    await page.select('.modal select', 'selected')
    await submit('重新生成')
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('模型 fixture-selected 重新生成的完整历史概要。'))
    assert.ok(dayInfo(key)[0].vector)
    assert.equal(upstream.requests.find(r => r.body.model === 'fixture-selected')!.body.max_tokens, 8192)
    await edit('旧聊天档案', '修正档案：改约周六看猫展。')
    assert.ok(archiveInfo(key)[0].vector)
    await action('旧聊天档案', '重新生成')
    await page.select('.modal select', 'main')
    await submit('重新生成')
    await page.waitForFunction(() => document.querySelector('.rollout-detail')?.textContent?.includes('模型 fixture-default 重新生成的完整历史概要。'))
    assert.ok(archiveInfo(key)[0].vector)
    await edit('滚动摘要', '手动修改的滚动摘要')
    await action('滚动摘要', '重新生成')
    await page.select('.modal select', 'selected')
    await submit('重新生成')
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.card')).find(el => el.querySelector('h2')?.textContent?.includes('滚动摘要'))?.textContent?.includes('fixture-selected'))
    await edit('当前上下文', '手动修正上下文 <script>window.__history_xss=true</script>')
    assert.equal(await page.evaluate(() => (window as any).__history_xss), undefined)
    assert.equal(s.state, undefined)
    // Failed regeneration retains the good summary and makes the error visible.
    finish = 'length'
    await action('每日概要', '重新生成')
    await submit('重新生成')
    await page.waitForFunction(() => document.querySelector('.toast.bad')?.textContent?.includes('输出上限'))
    assert.match(dayInfo(key)[0].text, /fixture-selected/)
    assert.deepEqual(errors, [])
    const screenshot = async (name: string) => {
      if (!process.env.YZ_LLM_UI_SCREENSHOTS) return
      fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
      await page.evaluate(() => document.getElementById('toasts')?.replaceChildren())
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).length === 0)
      await page.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, name), fullPage: true })
    }
    await screenshot('history-desktop.png')
    await page.setViewport({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    const offscreen = await page.$$eval('.rollout-detail button', (buttons: HTMLButtonElement[]) => buttons.filter(button => {
      const r = button.getBoundingClientRect()
      return r.width && (r.left < 0 || r.right > innerWidth + 1)
    }).map(button => button.textContent))
    assert.deepEqual(offscreen, [])
    await screenshot('history-mobile.png')
    await page.evaluate(() => { location.hash = '#/config/chat' })
    await page.waitForFunction(() => document.body.innerText.includes('摘要输出 token 上限'))
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    stopWeb()
    await upstream.close()
  }
})
