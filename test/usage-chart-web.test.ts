import { PLUGIN_ROOT } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { it } from 'node:test'

it('aligns usage markers with plotted vertices across resizing and shows colored legends and readable details', async () => {
  const models = ['model.alpha:v1/[chat]', 'model.beta"<chat>']
  const from = Date.UTC(2026, 9, 20)
  const timeline = Array.from({ length: 3 }, (_, i) => ({ time: from + i * 86400_000, calls: 2, otherCost: 0,
    byModel: Object.fromEntries(models.map((model, j) => [model, {
      input: (i + 1) * (j + 1) * 100, output: (3 - i) * (j + 1) * 50, cached: (i + 2) * (j + 1) * 40,
      inputCost: (i + 1) * (j + 1) * 0.1, outputCost: (3 - i) * (j + 1) * 0.05, cachedCost: (i + 2) * (j + 1) * 0.04,
    }])) }))
  const rows = models.map(model => {
    const values = timeline.map(pt => pt.byModel[model])
    const sum = (key: string) => values.reduce((n, v) => n + v[key], 0)
    return { model, calls: 3, input: sum('input'), output: sum('output'), cacheRead: sum('cached'), cacheWrite: 0, cacheWrite1h: 0,
      inputCost: sum('inputCost'), outputCost: sum('outputCost'), cachedCost: sum('cachedCost'), otherCost: 0, unattributedCost: 0,
      cost: sum('inputCost') + sum('outputCost') + sum('cachedCost') }
  })
  const fixture = { models, rows, timeline, from, to: from + 3 * 86400_000, startedAt: from }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (url.pathname === '/api/usage/history') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(fixture)); return
    }
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><main style="padding:16px;max-width:1100px;margin:auto"></main><script type="module">import {usageBreakdown} from "/js/usage-breakdown.js";document.documentElement.dataset.theme="light";document.querySelector("main").append(usageBreakdown([]))</script>')
      return
    }
    const root = path.join(PLUGIN_ROOT, 'web'), file = path.resolve(root, '.' + url.pathname)
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return }
    res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript')
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const puppeteer = (await import('puppeteer')).default
  let browser: any
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error: Error) => errors.push(error.message))
    await page.setViewport({ width: 1280, height: 1000 })
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`)
    await page.waitForSelector('.usage-line-path')
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const hover = async (index: number) => {
      await settle()
      const point = await page.evaluate((index: number) => {
        const svg = document.querySelector('.usage-line-svg') as SVGSVGElement
        const path = svg.querySelector('.usage-line-path')!
        const coords = path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
        const point = svg.createSVGPoint(); point.x = coords[index * 2]; point.y = coords[index * 2 + 1]
        const screen = point.matrixTransform(svg.getScreenCTM()!)
        return { x: screen.x, y: screen.y }
      }, index)
      await page.mouse.move(point.x, point.y)
    }
    const checkMarkers = async (index: number) => {
      const aligned = await page.evaluate((index: number) => {
        const paths = Array.from(document.querySelectorAll('.usage-line-path'))
        const dots = Array.from(document.querySelectorAll('.usage-line-dot'))
        return paths.every((line, i) => {
          const coords = line.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
          return Math.abs(Number(dots[i].getAttribute('cx')) - coords[index * 2]) < 0.01
            && Math.abs(Number(dots[i].getAttribute('cy')) - coords[index * 2 + 1]) < 0.01
        })
      }, index)
      assert.ok(aligned, 'every hover marker must lie on its series vertex')
    }
    const legend = await page.evaluate(() => Array.from(document.querySelectorAll('.usage-chart-legend .usage-legend-swatch svg')).map(svg => ({
      namespace: svg.namespaceURI, color: svg.querySelector('line')!.getAttribute('stroke'), dash: svg.querySelector('line')!.getAttribute('stroke-dasharray'),
    })))
    assert.equal(legend.length, 6)
    assert.ok(legend.every((s: any) => s.namespace === 'http://www.w3.org/2000/svg'))
    assert.equal(new Set(legend.map((s: any) => s.color)).size, 2)
    assert.equal(new Set(legend.map((s: any) => s.dash)).size, 3)
    assert.deepEqual(legend.map((s: any) => s.color), await page.$$eval('.usage-line-path', (lines: Element[]) => lines.map(line => line.getAttribute('stroke'))))
    for (const width of [1280, 390]) {
      await page.setViewport({ width, height: 1000 }); await hover(1); await checkMarkers(1)
      const detail = await page.$eval('.usage-chart-detail', (el: Element) => ({ text: el.textContent!,
        valueSize: parseFloat(getComputedStyle(el.querySelector('.usage-detail-value > strong')!).fontSize),
        weight: Number(getComputedStyle(el.querySelector('.usage-detail-value > strong')!).fontWeight),
        overflow: el.scrollWidth > el.clientWidth }))
      assert.ok(detail.text.includes(models[0]) && detail.text.includes(models[1]))
      assert.ok(detail.text.includes('2 次调用') && detail.text.includes('USD'))
      assert.ok(detail.valueSize >= 16 && detail.weight >= 700)
      assert.equal(detail.overflow, false)
      assert.equal(await page.$('chat'), null, 'model names must be treated as text')
      if (process.env.YZ_LLM_UI_SCREENSHOTS) {
        fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
        await (await page.$('.usage-chart-wrap'))!.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, `usage-${width}.png`) })
      }
    }
    await page.$eval('.usage-line-chart', (el: HTMLElement) => el.focus())
    await page.keyboard.press('End'); await checkMarkers(2)
    await page.keyboard.press('Home'); await checkMarkers(0)
    await page.mouse.move(2, 2)
    assert.ok(await page.$('.usage-chart-detail.active'), 'last selection stays readable after leaving the plot')
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.setViewport({ width: 1280, height: 1000 }); await hover(1); await checkMarkers(1)
    if (process.env.YZ_LLM_UI_SCREENSHOTS) await (await page.$('.usage-chart-wrap'))!.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, 'usage-dark.png') })
    await page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(b => b.textContent === '按 Token')!.click() })
    await hover(1); await checkMarkers(1)
    assert.ok((await page.$eval('.usage-chart-detail', (el: Element) => el.textContent!)).includes('Token'))
    await page.evaluate(() => { Array.from(document.querySelectorAll('button')).find(b => b.textContent === '分组')!.click() })
    await (await page.$('.usage-bar-sub'))!.hover()
    assert.ok(await page.$('.usage-chart-detail.active .usage-detail-value > strong'))
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
