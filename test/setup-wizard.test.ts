import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { it } from 'node:test'
import { config } from '../src/core/config.ts'
import { checkRuntime, prepareRuntimeTools, runtimeToolReady, searchReady, setupRuntime, setupStatus } from '../src/core/setup.ts'
import { registerWebTools } from '../src/tools/web.ts'
import { registry, type ToolCtx } from '../src/tools/registry.ts'
import { loadSkills, registerSkillTool, skillsForTools } from '../src/tools/skills.ts'
import { routes } from '../src/web/api.ts'
import { startWeb, stopWeb } from '../src/web/server.ts'

const base = `providers:\n  mock: { type: openai, baseUrl: 'https://example.invalid/v1', apiKey: test-model-secret }\nmodels:\n  - { id: main, provider: mock, model: example, thinking: auto }\ndefaultModel: main\nchat:\n  thinkingJudge: { mode: systemone, apiKey: test-jev-secret }\nmemory:\n  embedding: { apiKey: test-vector-secret }\n`

it('shares cached setup checks with tool offering, execution and dependent skills', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  let installed = true, probes = 0
  t.mock.method(setupRuntime, 'exec', async (file: string) => {
    probes++
    return { stdout: file === 'wsl.exe' ? JSON.stringify([installed, installed, installed]) : installed ? '--sandbox --dangerously-skip-permissions' : '', stderr: '' }
  })
  fs.mkdirSync(path.join(TMP, 'data/agy-setup'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'data/agy-setup/agy.exe'), '')
  writeUserConfig(base + 'tools:\n  exec: { enable: true, distro: wizard-test }\n  agy: { enable: true, distro: wizard-test }\n  computer: { enable: true, distro: wizard-test }\n  googleLens: { enable: true, distro: wizard-test }\n')
  config.load()
  const eff = config.effective(), status = await setupStatus(true)
  assert.ok(status.models.ready && status.embedding.ready && status.jev.ready && status.sandbox.ready && status.agy.ready)
  assert.ok(!JSON.stringify(status).includes('test-model-secret'))
  let ran = false
  for (const name of ['run_code', 'computer_task', 'google_lens', 'agy']) registry.register({ name, description: name, parameters: {}, run: async () => { ran = true; return 'ok' } })
  const ctx = { eff, model: config.getModel('main')!, isAdmin: true, e: {}, turn: { commands: 0, searches: 0, fetches: 0, images: [] } } as ToolCtx
  await prepareRuntimeTools(eff)
  const before = probes
  assert.ok(registry.forTurn(ctx).some(t => t.name === 'run_code'))
  await prepareRuntimeTools(eff)
  assert.equal(probes, before, 'normal tool turns reuse readiness checks')
  for (const [name, requirement] of [['computer-use', 'computer_task'], ['code-helper', 'run_code'], ['general', '']]) {
    const dir = path.join(TMP, 'skills', name); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n${requirement ? `requires_tools: [${requirement}]\n` : ''}---\nInstructions`)
  }
  loadSkills(); registerSkillTool()
  assert.ok(skillsForTools(registry.forTurn(ctx).map(t => t.name)).some(s => s.name === 'computer-use'))
  const offered = registry.forTurn(ctx)
  installed = false
  await Promise.all((['sandbox', 'agy', 'computer', 'lens'] as const).map(kind => checkRuntime(kind, eff, true)))
  assert.equal(runtimeToolReady('run_code', eff), false)
  const available = registry.forTurn(ctx)
  assert.ok(!available.some(t => ['run_code', 'agy', 'computer_task', 'google_lens'].includes(t.name)))
  assert.deepEqual(skillsForTools(available.map(t => t.name)).map(s => s.name), ['general'])
  const result = await registry.execute([{ id: 'stale', name: 'run_code', args: {} }], ctx, offered)
  assert.equal(result.results[0].isError, true); assert.equal(ran, false)
  const skill = await registry.get('load_skill')!.run({ name: 'computer-use' }, ctx)
  assert.equal(typeof skill === 'string' ? false : skill.isError, true)
})

it('saves wizard changes atomically and keeps stored keys when omitted', async () => {
  writeUserConfig(base); config.load()
  const route = routes.find(r => r.method === 'PUT' && r.pattern.test('/api/setup'))!
  const apply = (changes: any[]) => route.run({ params: [], query: new URLSearchParams(), body: { changes } })
  const before = config.readRaw()
  await assert.rejects(Promise.resolve().then(() => apply([{ path: 'memory.embedding.model', value: 'changed' }, { path: 'memory.embedding.dimensions', value: 1 }])) )
  assert.equal(config.readRaw(), before)
  await apply([{ path: 'memory.embedding.model', value: 'changed' }, { path: 'memory.embedding.dimensions', value: 512 }])
  assert.equal(config.get().memory.embedding.apiKey, 'test-vector-secret')
  await apply([{ path: 'providers.new', value: { type: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'new-secret' } },
    { path: 'models.1', value: { id: 'second', provider: 'new', model: 'example-2' } }, { path: 'defaultModel', value: 'second' }])
  assert.equal(config.defaultModelId(), 'second')
})

it('offers the host AGY worker without WSL or account/permission probes', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  const executable = path.join(TMP, 'host-agy.exe')
  fs.writeFileSync(executable, '')
  let probes = 0
  t.mock.method(setupRuntime, 'exec', async (file: string, args: string[], options: any) => {
    probes++
    assert.equal(file, executable)
    assert.deepEqual(args, ['--help'])
    assert.equal(options.env, undefined)
    return { stdout: '', stderr: '--sandbox --dangerously-skip-permissions' }
  })
  writeUserConfig(base + `tools:\n  agy: { enable: true, executable: '${executable.replaceAll('\\', '/')}' }\n`)
  config.load()
  const eff = config.effective(), state = await checkRuntime('agy', eff, true)
  assert.equal(state.ready, true)
  assert.equal(runtimeToolReady('agy', eff), true)
  assert.equal(probes, 1)
  assert.ok(state.checks.every(check => !/桥接|模型访问|隔离服务|桌面/.test(check.label)))
})

it('offers Lens without AGY installation, login or service', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
  const probes: string[] = []
  t.mock.method(setupRuntime, 'exec', async (file: string, args: string[]) => {
    assert.equal(file, 'wsl.exe', 'Lens must not probe an AGY executable')
    probes.push(args.at(-1)!)
    return { stdout: '[true,true]', stderr: '' }
  })
  writeUserConfig(base + 'tools:\n  googleLens: { enable: true, distro: lens-without-agy }\n  agy: { enable: false }\n')
  config.load()
  const eff = config.effective(), state = await checkRuntime('lens', eff, true)
  assert.equal(state.ready, true)
  assert.equal(runtimeToolReady('google_lens', eff), true)
  assert.equal(runtimeToolReady('agy', eff), false)
  assert.ok(probes.every(script => !script.includes('llm-agy.service') && !script.includes('exec.py')))
})

it('detects incomplete search settings and resolves search keys from the environment', async t => {
  writeUserConfig(base + 'tools:\n  webSearch: { provider: brave, apiKey: "env:WIZARD_SEARCH_TEST_KEY" }\n'); config.load()
  registerWebTools()
  const eff = config.effective()
  const previous = process.env.WIZARD_SEARCH_TEST_KEY
  delete process.env.WIZARD_SEARCH_TEST_KEY
  t.after(() => { if (previous === undefined) delete process.env.WIZARD_SEARCH_TEST_KEY; else process.env.WIZARD_SEARCH_TEST_KEY = previous })
  assert.equal(searchReady(eff), false)
  process.env.WIZARD_SEARCH_TEST_KEY = 'fixture-search-key'
  assert.equal(searchReady(eff), true)
  eff.tools.webSearch.provider = 'native'
  assert.equal(searchReady(eff, config.getModel('main')), false, 'chat-completions provider does not offer native search')
  eff.tools.webSearch.provider = 'searxng'; eff.tools.webSearch.baseUrl = ''
  assert.equal(searchReady(eff), false)
  eff.tools.webSearch.baseUrl = 'https://example.invalid'
  assert.equal(searchReady(eff), true)
})

it('walks existing configuration, saves embeddings, preserves keys and skips optional runtime setup in the browser', async t => {
  const port = await new Promise<number>(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) }) })
  writeUserConfig(base + `web: { enable: true, host: 127.0.0.1, port: ${port}, password: wizard-password }\n`)
  config.load()
  config.set('models.0.quota', { scope: 'user', window5h: 4, weekly: 8, global: { weekly: 15 } })
  t.mock.method(setupRuntime, 'exec', async () => ({ stdout: '[false,false,false]', stderr: '' }))
  if (!fs.existsSync(path.join(TMP, 'web'))) fs.symlinkSync(path.join(PLUGIN_ROOT, 'web'), path.join(TMP, 'web'), 'junction')
  const puppeteer = (await import('puppeteer')).default
  let browser: any
  try {
    startWeb()
    const origin = `http://127.0.0.1:${port}`
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'yzllm' }, body: JSON.stringify({ password: 'wizard-password' }) })
    const [name, value] = login.headers.get('set-cookie')!.split(';')[0].split('=')
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
    const page = await browser.newPage(), errors: string[] = []
    page.on('pageerror', (e: Error) => errors.push(e.message))
    await page.setCookie({ name, value, url: origin })
    await page.setViewport({ width: 1200, height: 1000 })
    await page.goto(origin + '/#/config/setup')
    await page.waitForFunction(() => document.querySelector('.setup-step')?.textContent?.includes('已配置'))
    assert.equal(await page.$eval('.setup-step', (el: Element) => el.getAttribute('data-setup-step')), 'models')
    const clickText = (text: string) => page.evaluate((text: string) => { Array.from(document.querySelectorAll('.setup-wizard button')).find((b: any) => b.textContent === text)?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }, text)
    const go = (step: string) => page.click(`[data-setup-target="${step}"]`)
    const screenshot = async (name: string) => {
      if (!process.env.YZ_LLM_UI_SCREENSHOTS) return
      fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
      await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.querySelectorAll('.toast').forEach(el => el.remove()) })
      await (await page.$('.setup-wizard'))!.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, name) })
    }
    const submit = async (selector = '.setup-form button[type=submit]') => {
      const saved = page.waitForResponse((r: any) => r.url().endsWith('/api/setup?refresh=1'))
      await page.click(selector); await saved
      await page.waitForFunction(() => !(document.querySelector('.setup-form button[type=submit]') as HTMLButtonElement)?.disabled)
    }
    await page.$eval('details:has([name=credentialProvider])', (el: HTMLDetailsElement) => { el.open = true })
    await page.select('[name=credentialProvider]', 'mock')
    assert.equal(await page.$eval('[name=credentialKey]', (el: HTMLInputElement) => el.value), '')
    await page.type('[name=credentialKey]', 'updated-provider-secret')
    await submit('details:has([name=credentialProvider]) button[type=submit]')
    assert.equal(config.getProvider('mock')!.apiKey, 'updated-provider-secret')
    await page.$eval('details:has([name=credentialProvider])', (el: HTMLDetailsElement) => { el.open = true })
    await submit('details:has([name=credentialProvider]) button[type=submit]')
    assert.equal(config.getProvider('mock')!.apiKey, 'updated-provider-secret', 'blank input preserves an existing key')
    await page.$eval('details:has([name=utilityModel])', (el: HTMLDetailsElement) => { el.open = true })
    await page.select('[name=utilityModel]', 'main'); await page.select('[name=visionModel]', 'main')
    await page.$eval('[name=fallbackModels]', (el: HTMLInputElement) => { el.value = 'main' })
    await submit('details:has([name=utilityModel]) button[type=submit]')
    assert.equal(config.get().utilityModel, 'main'); assert.equal(config.get().visionModel, 'main')
    assert.deepEqual(config.get().fallbackModels, ['main'])
    await page.$eval('details:has([aria-label="上游模型预设"])', (el: HTMLDetailsElement) => { el.open = true })
    await page.$eval('details:has([aria-label="上游模型预设"]) select', (el: HTMLSelectElement) => { el.value = '__new'; el.dispatchEvent(new Event('change')) })
    const providerPreset = 'details:has([aria-label="上游模型预设"]) fieldset select'
    await page.select(providerPreset, '1')
    assert.equal(await page.$eval('[aria-label="上游模型预设"]', (el: HTMLSelectElement) => el.value), 'gpt-6.1-sol')
    await page.select('[aria-label="上游模型预设"]', 'gpt-6-luna')
    await page.select(providerPreset, '2')
    assert.equal(await page.$eval('[aria-label="上游模型预设"]', (el: HTMLSelectElement) => el.value), 'gemini-4-argon')
    await page.select('[aria-label="上游模型预设"]', '\u0000custom')
    await page.$eval('[aria-label="自定义上游模型 ID"]', (el: HTMLInputElement) => { el.value = 'custom-model'; el.dispatchEvent(new Event('change')) })
    await page.select(providerPreset, '0')
    assert.equal(await page.$eval('[aria-label="自定义上游模型 ID"]', (el: HTMLInputElement) => el.value), 'custom-model', 'provider changes preserve a custom model name')
    await page.$eval('details:has([aria-label="上游模型预设"]) select', (el: HTMLSelectElement) => { el.value = 'mock'; el.dispatchEvent(new Event('change')) })
    await submit('details:has([aria-label="上游模型预设"]) button[type=submit]')
    assert.equal(config.getModel('custom-model')?.model, 'custom-model')
    assert.equal(config.getModel('custom-model')?.provider, 'mock')
    await page.select('[name=defaultModel]', 'main')
    await submit('form:has([name=defaultModel]) button[type=submit]')
    await go('search')
    assert.ok((await page.$eval('.setup-step', (el: Element) => el.textContent!)).includes('不支持自带搜索'))
    await page.select('[name=searchProvider]', 'brave')
    await page.type('[name=searchKey]', 'fixture-brave-secret')
    await screenshot('setup-search.png')
    await submit()
    assert.equal(config.get().tools.webSearch.provider, 'brave')
    assert.equal(config.get().tools.webSearch.apiKey, 'fixture-brave-secret')
    await go('budgets')
    assert.equal(await page.$eval('[name="user.window5h"]', (el: HTMLInputElement) => el.value), '4')
    await page.$eval('[name="user.window5h"]', (el: HTMLInputElement) => { el.value = '1.25' })
    await page.$eval('[name="group.weekly"]', (el: HTMLInputElement) => { el.value = '2.5' })
    await submit()
    assert.equal(config.getModel('main')!.quota!.user!.window5h, 1.25)
    assert.equal(config.getModel('main')!.quota!.group!.weekly, 2.5)
    assert.equal(config.getModel('main')!.quota!.global!.weekly, 15)
    await screenshot('setup-budgets.png')
    await go('embedding')
    assert.equal(await page.$eval('.setup-step', (el: Element) => el.getAttribute('data-setup-step')), 'embedding')
    const keyInput = await page.$eval('.setup-step input[type=password]', (el: HTMLInputElement) => ({ value: el.value, placeholder: el.placeholder }))
    assert.equal(keyInput.value, ''); assert.match(keyInput.placeholder, /已配置/)
    await page.$eval('.setup-step input[type=number]', (el: HTMLInputElement) => { el.value = '512' })
    await submit()
    assert.equal(config.get().memory.embedding.dimensions, 512)
    assert.equal(config.get().memory.embedding.apiKey, 'test-vector-secret')
    await go('sandbox')
    await page.waitForSelector('[data-setup-step="sandbox"]')
    assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('.setup-step button')).find(b => b.textContent === '启用')!.disabled), true)
    assert.ok((await page.$eval('.setup-install', (el: Element) => el.textContent!)).includes('exec-setup'))
    if (process.env.YZ_LLM_UI_SCREENSHOTS) {
      fs.mkdirSync(process.env.YZ_LLM_UI_SCREENSHOTS, { recursive: true })
      await (await page.$('.setup-wizard'))!.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, 'setup-desktop.png') })
      await page.setViewport({ width: 390, height: 1000 })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running').length === 0)
      assert.ok(await page.$eval('.setup-wizard', (el: Element) => el.getBoundingClientRect().right <= innerWidth))
      const overflowing = await page.$eval('.setup-wizard', (el: Element) => Array.from(el.children).filter(child => child.scrollWidth > child.clientWidth + 1).map(child => ({ className: child.className, width: child.clientWidth, content: child.scrollWidth })))
      assert.deepEqual(overflowing, [], 'wizard sections must wrap within the mobile viewport')
      await (await page.$('.setup-wizard'))!.screenshot({ path: path.join(process.env.YZ_LLM_UI_SCREENSHOTS, 'setup-mobile.png') })
    }
    for (const step of ['computer', 'lens', 'agy']) {
      await clickText('跳过此步骤'); await page.waitForSelector(`[data-setup-step="${step}"]`)
      if (step === 'lens') {
        const commands = await page.$$eval('.setup-command code', (els: Element[]) => els.map(el => el.textContent))
        assert.ok(commands.some((command: string) => command.includes('lens-setup')))
        assert.ok(commands.every((command: string) => !command.includes('agy-setup')))
      }
      if (step === 'agy') {
        const commands = await page.$$eval('.setup-command code', (els: Element[]) => els.map(el => el.textContent))
        assert.deepEqual(commands, ['npm run agy-setup'])
        assert.ok(!(await page.$eval('.setup-form', (el: Element) => el.textContent!)).includes('WSL 发行版'))
        assert.equal(await page.$eval('[data-agy-access-warning]', (el: HTMLElement) => el.hidden), true)
        await page.select('[name=agyAccess]', 'all')
        await page.waitForSelector('[data-agy-access-warning]', { visible: true })
        const warning = await page.$eval('[data-agy-access-warning]', (el: HTMLElement) => el.innerText)
        assert.match(warning, /完整访问这台机器/)
        await submit()
        assert.equal(config.get().tools.agy.access, 'all')
        await page.waitForSelector('[data-agy-access-warning]', { visible: true })
      }
    }
    await clickText('跳过此步骤'); await page.waitForFunction(() => location.hash === '#/config/basic')
    assert.equal(config.get().tools.exec.enable, false); assert.equal(config.get().tools.agy.enable, false)
    await page.goto(origin + '/#/config/tools')
    await page.waitForSelector('details.group')
    await page.evaluate(() => { const group = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.group')).find(el => el.querySelector('summary .mono')?.textContent === 'agy'); if (group) group.open = true })
    await page.waitForSelector('[data-agy-access-warning]', { visible: true })
    const access = '.ctl:has(> [data-agy-access-warning]) > select'
    for (const value of ['admin', 'all']) {
      const saved = page.waitForResponse((r: any) => r.url().endsWith('/api/config') && r.request().method() === 'PUT')
      await page.select(access, value); await saved
      await page.waitForFunction((value: string) => (document.querySelector('.ctl:has(> [data-agy-access-warning]) > select') as HTMLSelectElement)?.value === value
        && (document.querySelector('[data-agy-access-warning]') as HTMLElement)?.hidden === (value !== 'all'), {}, value)
      assert.equal(config.get().tools.agy.access, value)
    }
    assert.deepEqual(errors, [])
  } finally { await browser?.close(); stopWeb() }
})
