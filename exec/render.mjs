// HTML -> PNG inside the run_code sandbox (runs as the unprivileged sbx user under bwrap, cwd /work).
// Installed to /usr/local/lib/llm-render by exec/setup.sh. Arg: JSON {page, out, width, maxHeight, scale, allowNetwork}.
// Relative URLs resolve against /work, so a page can show files that earlier run_code calls saved (e.g. out/chart.png).
// Network limits come from the sandbox firewall (public addresses only); here we only restrict file:// to /work.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const opts = JSON.parse(process.argv[2])
const root = join(import.meta.dirname, 'browsers', 'chrome-headless-shell')
const build = readdirSync(root).sort().at(-1)
const executablePath = join(root, build, 'chrome-headless-shell-linux64', 'chrome-headless-shell')

const browser = await puppeteer.launch({
  executablePath,
  headless: 'shell',
  // the sandbox firewall blocks loopback, so talk to Chrome over a pipe instead of a localhost WebSocket
  pipe: true,
  // bwrap already provides the namespaces; Chrome's own sandbox can't nest inside it
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--font-render-hinting=none', '--user-data-dir=/tmp/chrome'],
})
try {
  const page = await browser.newPage()
  await page.setJavaScriptEnabled(false)
  await page.setViewport({ width: opts.width, height: 400, deviceScaleFactor: opts.scale })
  await page.setRequestInterception(true)
  page.on('request', req => {
    const url = req.url()
    const ok =
      url.startsWith('data:') ||
      url === 'about:blank' ||
      (url.startsWith('file:///work/') && !url.includes('..')) ||
      (opts.allowNetwork && /^https?:/i.test(url))
    ;(ok ? req.continue() : req.abort()).catch(() => {})
  })
  await page.goto(`file://${opts.page}`, { waitUntil: 'load', timeout: 25000 })
  const cdp = await page.createCDPSession()
  const { cssContentSize, contentSize } = await cdp.send('Page.getLayoutMetrics')
  const size = cssContentSize ?? contentSize
  const height = Math.min(Math.ceil(size?.height ?? 400), opts.maxHeight)
  const width = Math.min(Math.ceil(size?.width ?? opts.width), opts.width)
  await page.screenshot({ path: opts.out, type: 'png', clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true })
  console.log(`rendered ${width}x${height}`)
} finally {
  await browser.close()
}
