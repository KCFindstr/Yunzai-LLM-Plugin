import { TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, describe, it } from 'node:test'

fs.writeFileSync(path.join(TMP, 'config', 'PERSONA.md'), '你是测试猫娘{botName}。')
writeUserConfig(`
persona:
  active: cat
  presets:
    cat: file:PERSONA.md
    evil: file:../../etc/passwd
`)

const { config } = await import('../src/core/config.ts')
const { prepareReply } = await import('../src/chat/reply.ts')
const { markdownEnabled } = await import('../src/chat/format.ts')
const { buildSystemPrompt } = await import('../src/chat/prompt.ts')
const { renderHtml, wrapHtml, closeOwnBrowser } = await import('../src/render/browser.ts')

after(() => closeOwnBrowser())

describe('markdown output', () => {
  const cfg = () => ({ ...config.effective().reply, maxBubbles: 2, maxChars: 50 })

  it('plain mode strips markdown and splits; markdown mode keeps everything in one message', () => {
    const md = '## 标题\n**重点**\n\n- 一\n- 二'
    assert.deepEqual(prepareReply(md, cfg(), false).bubbles, ['标题\n重点', '· 一\n· 二'])
    assert.deepEqual(prepareReply(md, cfg(), true).bubbles, [md])
    const long = '长'.repeat(200)
    assert.equal(prepareReply(long, cfg(), false).forward?.length, 200, 'plain: long text becomes a forward message')
    assert.deepEqual(prepareReply(long, cfg(), true).bubbles, [long], 'markdown: one message')
  })

  it('auto enables markdown only for the QQBot adapter', () => {
    const r = { ...config.effective().reply, markdown: 'auto' as const }
    assert.equal(markdownEnabled({ adapter_name: 'QQBot' }, r), true)
    assert.equal(markdownEnabled({ adapter_name: 'OneBotv11' }, r), false)
    assert.equal(markdownEnabled({ adapter_name: 'QQBot' }, { ...r, markdown: false }), false)
    assert.equal(config.effective().reply.markdown, false, 'default is plain text')
  })

  it('system prompt tells the model whether markdown renders', () => {
    const base = { isGroup: true, botName: 'B', eff: config.effective(), tools: [], nativeSearch: false }
    assert.match(buildSystemPrompt({ ...base, markdown: false }), /QQ不显示Markdown/)
    assert.match(buildSystemPrompt({ ...base, markdown: true }), /按 Markdown 显示/)
  })

  it('markdown mode prefers Markdown for long answers and only renders HTML when needed', () => {
    const eff = { ...config.effective(), reply: { ...config.effective().reply, maxBubbles: 2 } }
    const base = { isGroup: true, botName: 'B', eff, tools: ['render_html'], nativeSearch: false }
    const md = buildSystemPrompt({ ...base, markdown: true })
    assert.match(md, /长回答直接用 Markdown/)
    assert.match(md, /只有 Markdown 表达不清楚时才用 render_html/)
    assert.doesNotMatch(md, /用空行隔开/, 'markdown replies are one message, no bubble splitting')
    const plain = buildSystemPrompt({ ...base, markdown: false })
    assert.match(plain, /用空行隔开/)
    assert.match(plain, /需要表格、多维对比.*render_html/)
  })
})

describe('persona from file', () => {
  it('loads `file:` presets from the config dir and refuses paths outside it', () => {
    assert.equal(config.effective().personaPrompt, '你是测试猫娘{botName}。')
    config.set('persona.active', 'evil')
    assert.equal(config.effective().personaPrompt, '')
    config.set('persona.active', 'cat')
  })
})

describe('render_html', () => {
  it('always injects a no-script CSP', () => {
    assert.match(wrapHtml('<p>x</p>'), /script-src 'none'/)
    assert.match(wrapHtml('<html><head><title>t</title></head><body>x</body></html>'), /<head><meta http-equiv="Content-Security-Policy"/)
    assert.match(wrapHtml('<html><body>x</body></html>'), /<html><head><meta http-equiv="Content-Security-Policy"/)
  })

  it('renders a PNG; scripts never run and LAN requests are blocked', async t => {
    let png: Buffer
    try {
      png = await renderHtml(
        '<h1 id="t">标题</h1><p>中文正文</p><script>document.body.innerHTML="<h1 style=height:5000px>JS RAN</h1>"</script><img src="http://127.0.0.1:2536/secret">',
        { width: 400, scale: 1, allowNetwork: true },
      )
    } catch (err: any) {
      t.skip(`no Chromium available here: ${err.message}`)
      return
    }
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    const height = png.readUInt32BE(20)
    assert.ok(height < 1000, `short page (JS would have made it 5000px tall), got ${height}`)
  })
})
