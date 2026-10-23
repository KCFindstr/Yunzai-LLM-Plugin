import { PLUGIN_ROOT } from './helpers.ts'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { it } from 'node:test'

it('extracts visible Google descriptions and labeled AI sections without reading account or unrelated result text', async () => {
  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
  try {
    const page = await browser.newPage()
    const extract = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop/google-lens-text.js'), 'utf8')
    await page.setContent(`<header>PRIVATE_ACCOUNT</header><main id="search"><section><h2>AI Overview</h2><p>This displayed summary identifies a fictional character in the uploaded image.</p><a href="https://example.org/source">Source</a></section><div data-attrid="description">A displayed character description.</div><section><h2>Visual matches</h2><a href="https://example.org/match">UNRELATED_MATCH</a></section></main>`)
    let result = await page.$eval('#search', (root, script) => new Function('return (' + script + ')')()(root), extract) as any
    assert.equal(result.description, 'A displayed character description.')
    assert.match(result.ai_overview.text, /fictional character/)
    assert.deepEqual(result.ai_overview.sources, ['https://example.org/source'])
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ACCOUNT|UNRELATED_MATCH/)
    await page.setContent(`<main id="search"><section style="display:none"><h2>AI Overview</h2><p>Hidden summary must never be returned even though it is long enough.</p></section><div data-attrid="description" style="display:none">Hidden description</div><h2>Visual matches</h2><a href="https://example.org">Ordinary title with AI Overview words</a></main>`)
    result = await page.$eval('#search', (root, script) => new Function('return (' + script + ')')()(root), extract)
    assert.deepEqual(result, { description: null, ai_overview: null })
    await page.setContent(`<main id="search"><div><span>AI 摘要</span><div>This summary uses div elements instead of semantic paragraph elements.</div></div><h2>Visual matches</h2></main>`)
    result = await page.$eval('#search', (root, script) => new Function('return (' + script + ')')()(root), extract) as any
    assert.match(result.ai_overview.text, /uses div elements/)
    await page.setContent(`<main id="search"><h2>AI Overview</h2><section><h2>Visual matches</h2><p>Unrelated long visual-match text must not be mistaken for a summary.</p></section></main>`)
    result = await page.$eval('#search', (root, script) => new Function('return (' + script + ')')()(root), extract)
    assert.deepEqual(result, { description: null, ai_overview: null })
  } finally { await browser.close() }
})
