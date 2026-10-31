import { PLUGIN_ROOT, TMP, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { after, it } from 'node:test'

// judge model for the playgrounds: a category for auto thinking, a score for proactive replies
const llm = await mockServer(req => {
  // the model-name dropdown also asks the provider for its model list
  if (req.method === 'GET') return [200, { data: [{ id: 'fake' }, { id: 'fake-2' }] }]
  const system = String(req.body.messages?.[0]?.content ?? '')
  return [200, { choices: [{ message: { role: 'assistant', content: /主动接话/.test(system) ? '72' : 'question' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]
})
after(() => llm.close())

const port = await new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) }) })
writeUserConfig(`providers:
  mock: { type: openai, baseUrl: '${llm.url}', apiKey: k, maxRetries: 0 }
models:
  - { id: main, provider: mock, model: fake, thinking: auto }
defaultModel: main
utilityModel: main
fallbackModels: []
pricing: { sources: [] }
groups:
  '30001': { proactive: { enable: true } }
tools:
  disabled: [send_image]
web: { enable: true, host: 127.0.0.1, port: ${port}, password: config-ui-password }
`)

const { config } = await import('../src/core/config.ts')
const { startWeb, stopWeb } = await import('../src/web/server.ts')

it('config page: unified models, provider groups, tool switches, levels, curve and playgrounds', async () => {
  config.load()
  if (!fs.existsSync(path.join(TMP, 'web'))) fs.symlinkSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), 'junction')
  const puppeteer = (await import('puppeteer')).default
  let browser: any
  try {
    startWeb()
    const origin = `http://127.0.0.1:${port}`
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'yzllm' }, body: JSON.stringify({ password: 'config-ui-password' }) })
    const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=')
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage(), errors: string[] = []
    page.on('pageerror', (e: Error) => errors.push(e.message))
    await page.setCookie({ name, value, url: origin })
    await page.setViewport({ width: 1280, height: 1100 })
    const shot = async (file: string) => {
      if (!process.env.YZ_LLM_UI_SCREENSHOTS) return
      fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(el => el.remove()))
      await page.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, file), fullPage: true })
    }
    const open = async (section: string, ready: string) => {
      await page.goto(`${origin}/#/config/${section}`)
      await page.waitForSelector(ready)
    }
    const text = () => page.$eval('main, #app', (el: Element) => el.textContent ?? '')

    // Recent group-message age is editable through the shared config schema.
    await open('chat', '.field input[type="number"]')
    const ageValue = () => page.evaluate(() => {
      const key = Array.from(document.querySelectorAll('.field .key')).find(el => el.textContent === 'chat.groupContextMaxAgeMinutes')!
      return (key.closest('.field')!.querySelector('input') as HTMLInputElement).value
    })
    assert.equal(await ageValue(), '720')
    await page.evaluate(() => {
      const key = Array.from(document.querySelectorAll('.field .key')).find(el => el.textContent === 'chat.groupContextMaxAgeMinutes')!
      const input = key.closest('.field')!.querySelector('input') as HTMLInputElement
      input.value = '90'
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    for (let i = 0; i < 50 && config.get().chat.groupContextMaxAgeMinutes !== 90; i++) await new Promise(r => setTimeout(r, 100))
    assert.equal(config.get().chat.groupContextMaxAgeMinutes, 90)
    assert.match(fs.readFileSync(path.join(TMP, 'config', 'config.yaml'), 'utf8'), /groupContextMaxAgeMinutes: 90/)
    await page.reload()
    await page.waitForSelector('.field input[type="number"]')
    assert.equal(await ageValue(), '90', 'saved value survives a UI reload')

    // 模型: three sections, a test button on each model, nav without the nested lists
    await open('models', 'details.group')
    const titles = await page.$$eval('.card h2', (els: Element[]) => els.map(el => el.textContent))
    for (const t of ['聊天模型', '向量模型', 'System One 模型']) assert.ok(titles.includes(t), t)
    const nav = await page.$$eval('.cfg-nav a', (els: Element[]) => els.map(el => el.getAttribute('href')))
    assert.ok(!nav.includes('#/config/embeddingModels') && !nav.includes('#/config/systemoneModels'))
    assert.ok(nav.includes('#/config/autoThinking') && nav.includes('#/config/proactive'))
    assert.ok((await page.$$('details.group summary button')).length >= 3, 'test buttons beside the models')
    assert.match(await text(), /后台任务模型（utilityModel） main 的思考强度为 auto/)
    await shot('config-models.png')

    // 提供商: grouped by what they serve
    await open('providers', 'details.group')
    const providerTitles = await page.$$eval('.card h2', (els: Element[]) => els.map(el => el.textContent))
    assert.deepEqual(providerTitles.slice(0, 3), ['聊天模型提供商', '向量提供商（voyage）', 'System One 提供商'])

    // 工具: a switch beside each tool name, no separate list of disabled tools
    await open('tools', 'details.group summary .switch')
    const summaries = await page.$$eval('details.group summary', (els: Element[]) => els.map(el => ({ text: el.textContent, on: (el.querySelector('.switch input') as HTMLInputElement | null)?.checked })))
    assert.equal(summaries.find(s => s.text?.includes('sendImage'))?.on, false, 'send_image is disabled')
    assert.equal(summaries.find(s => s.text?.includes('webFetch'))?.on, true)
    assert.ok(!(await page.$('[data-key="tools.disabled"]')) && !(await text()).includes('tools.disabled'))
    // other tools load separately (none are registered in this test): wait until the list has settled
    const settled = () => page.waitForFunction(() => Array.from(document.querySelectorAll('details.group')).some(d => d.textContent?.includes('其他工具') && !d.querySelector('.spin')))
    await settled()
    await page.evaluate(() => (Array.from(document.querySelectorAll('details.group summary')).find(el => el.textContent?.includes('sendImage'))!.querySelector('.switch input') as HTMLInputElement).click())
    for (let i = 0; i < 50 && config.get().tools.disabled.includes('send_image'); i++) await new Promise(r => setTimeout(r, 100))
    assert.ok(!config.get().tools.disabled.includes('send_image'), 'switch re-enables the tool')
    await settled()
    await shot('config-tools.png')

    // 自动思考强度: categories, default levels, and the playground
    await open('autoThinking', 'textarea')
    assert.match(await text(), /试一试：自动思考强度判断/)
    const fields = await page.$$('textarea')
    await fields[fields.length - 1].type('中秋节是几号')
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '运行判断')!.click())
    await page.waitForFunction(() => document.body.textContent?.includes('类别 question'))
    assert.match(await text(), /思考强度 medium（main）/)
    await shot('config-auto-thinking.png')

    // 主动发言: the threshold curve follows its inputs; the playground scores the last message
    await open('proactive', 'svg.curve path')
    const before = await page.$eval('svg.curve path', (el: Element) => el.getAttribute('d'))
    const start = (await page.evaluateHandle(() => document.querySelector('svg.curve')!.closest('.card')!.querySelector('input[type=number]'))).asElement() as any
    await start.evaluate((el: HTMLInputElement) => { el.value = '' })
    await start.type('0.5')
    assert.notEqual(await page.$eval('svg.curve path', (el: Element) => el.getAttribute('d')), before)
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.waitForFunction(() => document.querySelectorAll('textarea').length > 0)
    await new Promise(r => setTimeout(r, 400))
    assert.equal(config.get().proactive.threshold.start, 0.5)
    const areas = await page.$$('textarea')
    await areas[areas.length - 1].type('天津风去不去')
    await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '运行判断')!.click())
    await page.waitForFunction(() => document.body.textContent?.includes('分数 0.72'))
    assert.match(await text(), /会接话|不接话/)
    assert.match(await text(), /已开启：/)
    await shot('config-proactive.png')

    // per-model levels: one select per category on the model
    await open('models', 'details.group')
    await page.evaluate(() => (document.querySelector('details.group') as HTMLDetailsElement).open = true)
    await page.waitForFunction(() => document.body.textContent?.includes('★ 第一个类别：判断失败时'))

    // mobile: no horizontal overflow on the new sections
    await page.setViewport({ width: 390, height: 900 })
    for (const section of ['proactive', 'autoThinking', 'tools']) {
      await open(section, 'details.group, svg.curve, textarea')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${section} fits a phone`)
    }
    await shot('config-proactive-mobile.png')
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); stopWeb() }
})
