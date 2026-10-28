import { TMP, fakeEvent, mockServer, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { runTurn } from '../src/chat/agent.ts'
import { checkRuntime, setupRuntime } from '../src/core/setup.ts'
import { registerImageTools } from '../src/tools/images.ts'
import { registerSendImageTool } from '../src/tools/sendImage.ts'
import { registerExecTool } from '../src/tools/exec.ts'
import { registerComputerTool } from '../src/tools/computer.ts'
import { registerAgyTool } from '../src/tools/agy.ts'
import { registerGoogleLensTool } from '../src/tools/googleLens.ts'
import { inlineLocalImages, registerRenderTool } from '../src/tools/render.ts'
import { chatImageScope, saveImage, imageScope, readImage } from '../src/chat/images.ts'
import { registry } from '../src/tools/registry.ts'
import { closeOwnBrowser } from '../src/render/browser.ts'

const image = { type: 'image' as const, mime: 'image/png', data: Buffer.from('89504e470d0a1a0a01020000', 'hex').toString('base64') }
registerImageTools()
registerSendImageTool()
registerExecTool()
registerComputerTool()
registerAgyTool()
registerGoogleLensTool()
registerRenderTool()

for (const platform of ['linux', 'win32']) it(`chat and saved image reading work on ${platform} without any WSL runtime`, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  t.after(() => Object.defineProperty(process, 'platform', descriptor))
  let probes = 0, file = ''
  t.mock.method(setupRuntime, 'exec', async () => { probes++; throw Object.assign(new Error('WSL is not installed'), { code: 'ENOENT' }) })
  const server = await mockServer((request, n) => {
    const names = request.body.tools.map((tool: any) => tool.function.name)
    assert.ok(names.includes('read_file') && names.includes('send_image'))
    assert.ok(!names.some((name: string) => ['run_code', 'computer_task', 'agy', 'google_lens'].includes(name)))
    if (n === 1) {
      file = JSON.stringify(request.body.messages).match(/\/work\/attachments\/[a-f0-9]{10}\/image-[a-f0-9]{40}\.png/)![0]
      return [200, { choices: [{ message: { role: 'assistant', content: '图片已保存' }, finish_reason: 'stop' }] }]
    }
    if (n === 2) return [200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] }, finish_reason: 'tool_calls' }] }]
    assert.ok(JSON.stringify(request.body.messages).includes(`data:image/png;base64,${image.data}`))
    return [200, { choices: [{ message: { role: 'assistant', content: '可以读取原图' }, finish_reason: 'stop' }] }]
  })
  try {
    writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: '${server.url}', apiKey: fake, maxRetries: 0 }\nmodels:\n  - { id: no-wsl, provider: mock, model: fake, vision: true, thinking: off }\ndefaultModel: no-wsl\nfallbackModels: []\nchat: { thinking: off, summarize: false }\nmemory: { enable: false }\ntools:\n  webSearch: { enable: false }\n  exec: { enable: true, distro: missing-${platform} }\n  computer: { enable: true, distro: missing-${platform} }\n  agy: { enable: true, distro: missing-${platform} }\n  googleLens: { enable: true, distro: missing-${platform} }\n`)
    config.load()
    const eff = config.effective()
    for (const kind of ['sandbox', 'computer', 'agy', 'lens'] as const) assert.equal((await checkRuntime(kind, eff, true)).ready, false)
    const base = { e: fakeEvent().e, eff, isAdmin: true, convKey: `no-wsl:${platform}` }
    assert.equal((await runTurn({ ...base, input: { text: '保存图片', images: [image], imageSegments: [] } })).kind, 'reply')
    assert.equal((await runTurn({ ...base, input: { text: '重新看原图', images: [], imageSegments: [] } })).kind, 'reply')
    assert.equal(server.requests.length, 3)
    if (platform === 'linux') assert.equal(probes, 0)
    else assert.ok(probes > 0)
  } finally { await server.close() }
})

it('inlines the current chat\'s stored images for native rendering and shows a broken icon for anything else', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
  const eff = config.effective()
  eff.tools.exec.enable = false
  eff.tools.renderHtml.enable = true
  eff.tools.webFetch.enable = false
  const ctx: any = { e: fakeEvent().e, eff, isAdmin: true, turn: { images: [] } }
  const stored = saveImage(chatImageScope(ctx.e), { type: 'image', data: png.toString('base64') })
  const otherChat = saveImage(imageScope('native-render-other'), { type: 'image', data: png.toString('base64') })
  const native = path.join(TMP, 'native-host.png')
  fs.writeFileSync(native, png)
  const html = `<p>${stored.path}</p><img src="${stored.path}"><div style="background-image:url('${stored.path}')"></div>`
    + `<img src="${otherChat.path}"><img src="${native.replaceAll('\\', '/')}"><img src="${pathToFileURL(native).href}"><img src="/work/attachments/../config.yaml">`
  const page = await inlineLocalImages(html, ctx)
  assert.ok(page.html.includes(`<p>${stored.path}</p>`), 'a displayed path remains ordinary text')
  assert.ok(page.html.includes(`src="data:image/png;base64,${png.toString('base64')}"`))
  assert.ok(page.html.includes(`url("data:image/png;base64,${png.toString('base64')}")`))
  assert.equal(page.broken.length, 4, 'other chats, host files, file: URLs and traversal are not readable')
  assert.equal(page.html.match(/data:image\/svg\+xml;base64,/g)?.length, 4)
  try {
    const result = await registry.get('render_html')!.run({ html: `<img src="${stored.path}" width="32" height="32"><img src="${otherChat.path}">` }, ctx)
    assert.equal(typeof result, 'string')
    assert.match(String(result), /无法读取，已显示为损坏图标/)
    assert.equal(ctx.turn.images.length, 0, 'rendering does not attach images')
    const file = String(result).match(/\/work\/attachments\/[a-f0-9]{10}\/image-[a-f0-9]{40}\.png/)![0]
    const bytes = Buffer.from(readImage(file, chatImageScope(ctx.e)).part.data!, 'base64')
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    const sent: any = await registry.get('send_image')!.run({ path: file }, ctx)
    assert.equal(sent.isError, undefined, sent.content)
    assert.deepEqual(ctx.turn.images, [bytes])
    const refused: any = await registry.get('send_image')!.run({ path: native }, ctx)
    assert.equal(refused.isError, true)
    assert.equal(ctx.turn.images.length, 1, 'host files are never sent')
  } finally { await closeOwnBrowser() }
})
