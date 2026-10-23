import { get, post, put } from './api.js'
import { badge, h, mount, toast } from './ui.js'

const STEPS = [['models', '提供商与模型'], ['search', '联网与阅读'], ['embedding', '向量检索'], ['jev', '思考判断 / Jev'], ['budgets', '用量预算'], ['sandbox', '代码沙盒'], ['computer', '电脑操作'], ['lens', '图片反搜'], ['agy', 'AGY']]
const change = (path, value) => ({ path, value })
const keyValue = value => value.includes(',') ? value.split(',').map(s => s.trim()).filter(Boolean) : value

export function setupWizard(initialData, onChange) {
  let data = initialData, status, current = 0, busy = false
  const skipped = new Set(), root = h('div', { class: 'setup-wizard' }), feedback = h('p', { class: 'small muted', role: 'status' })
  const button = (text, onclick, kind = '', attrs = {}) => h('button', { type: 'button', class: `btn ${kind}`, onclick, ...attrs }, text)
  const field = (label, value = '', options = {}) => {
    const { options: choices, ...attributes } = options
    const control = choices ? h('select', attributes, choices.map(([v, text]) => h('option', { value: v, selected: v === value }, text)))
      : h('input', { type: 'text', value, ...attributes })
    return { control, view: h('label', { class: 'setup-field' }, h('span', label), control) }
  }
  const grid = (...children) => h('div', { class: 'setup-fields' }, children)
  const secret = (label, value) => field(label, '', { type: 'password', autocomplete: 'new-password', placeholder: value?.set ? '已配置，留空保留原值' : 'API Key 或 env:变量名' })
  async function run(action) {
    if (busy) return
    busy = true; feedback.textContent = '正在处理…'
    const buttons = Array.from(root.querySelectorAll('button')).map(el => [el, el.disabled])
    buttons.forEach(([el]) => { el.disabled = true })
    try { await action(); feedback.textContent = '' }
    catch (error) { feedback.textContent = error.message; toast(error.message, 'bad') }
    finally { busy = false; buttons.forEach(([el, disabled]) => { el.disabled = disabled }) }
  }
  async function save(changes) {
    await put('/api/setup', { changes })
    data = await onChange()
    status = await get('/api/setup?refresh=1')
    skipped.delete(STEPS[current][0]); toast('设置已保存', 'ok'); draw()
  }
  const form = (content, saveAction, label = '保存并继续配置') => h('form', { class: 'setup-form', onsubmit: e => { e.preventDefault(); void run(saveAction) } },
    content, h('button', { class: 'btn primary', type: 'submit' }, label))
  const command = text => h('div', { class: 'setup-command' }, h('code', text), button('复制', async () => {
    try { await navigator.clipboard.writeText(text); toast('已复制') } catch { toast('请选中命令后复制') }
  }, 'sm ghost'))

  function modelsStep() {
    const c = data.effective, models = c.models ?? [], providers = Object.keys(c.providers ?? {})
    const selected = field('默认聊天模型', status?.models.modelId || c.defaultModel || models[0]?.id || '', { options: models.map(m => [m.id, `${m.id} · ${m.model}`]) })
    const existing = models.length ? form(grid(selected.view), () => save([change('defaultModel', selected.control.value)]), '设为默认模型') : null
    const test = models.length ? button('测试所选模型连接', () => run(async () => {
      const result = await post(`/api/models/${encodeURIComponent(selected.control.value)}/test`)
      if (!result.ok) throw new Error(result.error || '连接失败')
      toast(`连接成功 · ${result.ms} ms`, 'ok')
    })) : null
    const provider = field('使用提供商', providers[0] || '__new', { options: [...providers.map(p => [p, p]), ['__new', '新建提供商']] })
    const presets = data.presets ?? [], preset = field('提供商预设', '0', { options: [...presets.map(([name], i) => [String(i), name]), ['custom', '自定义']] })
    let providerName = 'provider', n = 2
    while (providers.includes(providerName)) providerName = `provider${n++}`
    const name = field('提供商名称', providerName, { required: true, pattern: '[A-Za-z0-9_\\-]+' })
    const type = field('接口类型', presets[0]?.[1] || 'openai', { options: data.schema.fields.providers.value.fields.type.values.map(v => [v, v]) })
    const url = field('接口地址', presets[0]?.[2] || '', { required: true, type: 'url' })
    const key = secret('提供商 API Key')
    key.control.required = true
    const newProvider = h('fieldset', { class: 'setup-provider' }, grid(preset.view, name.view, type.view, url.view, key.view))
    const syncProvider = () => { newProvider.hidden = provider.control.value !== '__new'; newProvider.disabled = newProvider.hidden }
    provider.control.addEventListener('change', syncProvider); syncProvider()
    preset.control.addEventListener('change', () => {
      const value = presets[Number(preset.control.value)]
      if (value) { type.control.value = value[1]; url.control.value = value[2] }
    })
    const upstream = field('上游模型 ID', '', { required: true, placeholder: '填写提供商的模型名称' })
    const alias = field('模型别名', '', { placeholder: '留空自动使用模型名称' })
    return [h('p', { class: 'muted' }, '先填写提供商 API Key，再选择或添加聊天模型。测试连接会发送一次简短请求。'), providerCredentials(), existing, test, modelRoles(),
      h('details', { class: 'quiet-details', open: !status?.models.ready }, h('summary', '添加聊天模型'), form([
        provider.view, newProvider, grid(upstream.view, alias.view),
      ], async () => {
        const id = (alias.control.value.trim() || upstream.control.value.trim().replace(/^.*\//, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-'))
        if (!id || models.some(m => m.id === id)) throw new Error('请填写唯一的模型别名')
        const p = provider.control.value === '__new' ? name.control.value.trim() : provider.control.value
        if (provider.control.value === '__new' && providers.includes(p)) throw new Error('提供商名称已存在')
        const changes = provider.control.value === '__new' ? [change(`providers.${p}`, { type: type.control.value, baseUrl: url.control.value.trim(), apiKey: keyValue(key.control.value.trim()) })] : []
        changes.push(change(`models.${models.length}`, { id, provider: p, model: upstream.control.value.trim(), pricing: 'auto' }), change('defaultModel', id))
        await save(changes)
      }, '添加并设为默认模型'))]
  }

  function providerCredentials() {
    const providers = data.effective.providers ?? {}, names = Object.keys(providers)
    if (!names.length) return null
    const currentModel = data.effective.models.find(m => m.id === (status?.models.modelId || data.effective.defaultModel))
    const selected = field('提供商', currentModel?.provider || names[0], { name: 'credentialProvider', options: names.map(name => [name, `${name} · ${providers[name].apiKey?.set ? '已配置 Key' : '未配置 Key'}`]) })
    const type = field('接口类型', '', { name: 'credentialType', options: data.schema.fields.providers.value.fields.type.values.map(v => [v, v]) })
    const url = field('接口地址', '', { name: 'credentialUrl', required: true, type: 'url' })
    const key = secret('提供商 API Key')
    key.control.name = 'credentialKey'
    const sync = () => {
      const p = providers[selected.control.value]
      type.control.value = p.type; url.control.value = p.baseUrl
      key.control.value = ''; key.control.required = !p.apiKey?.set
      key.control.placeholder = p.apiKey?.set ? '已配置，留空保留原值' : 'API Key 或 env:变量名'
    }
    selected.control.addEventListener('change', sync); sync()
    return h('details', { class: 'quiet-details', open: !status?.models.ready }, h('summary', '提供商与 API Key'),
      h('p', { class: 'small muted' }, '可填写或更新已有提供商的 Key；多个 Key 用英文逗号分隔。留空保留已保存的 Key。'),
      form(grid(selected.view, type.view, url.view, key.view), () => {
        const prefix = `providers.${selected.control.value}`
        const changes = [change(`${prefix}.type`, type.control.value), change(`${prefix}.baseUrl`, url.control.value.trim())]
        if (key.control.value.trim()) changes.push(change(`${prefix}.apiKey`, keyValue(key.control.value.trim())))
        return save(changes)
      }, '保存提供商'))
  }

  function modelRoles() {
    const c = data.effective, models = c.models ?? []
    if (!models.length) return null
    const options = [['', '自动选择'], ...models.map(m => [m.id, m.id])]
    const utility = field('后台任务模型', c.utilityModel || '', { name: 'utilityModel', options })
    const vision = field('识图模型', c.visionModel || '', { name: 'visionModel', options: [['', '自动选择'], ...models.filter(m => m.vision !== false).map(m => [m.id, m.id])] })
    const fallbacks = field('备用模型（按顺序，用英文逗号分隔）', (c.fallbackModels ?? []).join(', '), { name: 'fallbackModels' })
    return h('details', { class: 'quiet-details' }, h('summary', '模型分工与备用', ' ', badge(status?.roles?.ready ? '已配置' : '可选', status?.roles?.ready ? 'ok' : '')),
      h('p', { class: 'small muted' }, '后台任务用于摘要等工作；识图模型供不支持图片的聊天模型使用。默认模型失败或额度用完时，按备用顺序尝试。'),
      form(grid(utility.view, vision.view, fallbacks.view), async () => {
        const list = [...new Set(fallbacks.control.value.split(/[,，]/).map(s => s.trim()).filter(Boolean))]
        const selected = [utility.control.value, vision.control.value, ...list].filter(Boolean)
        for (const id of selected) {
          const model = models.find(m => m.id === id)
          if (!model || !c.providers[model.provider]?.apiKey?.set) throw new Error(`请先为模型 ${id} 配置提供商密钥`)
        }
        await save([change('utilityModel', utility.control.value), change('visionModel', vision.control.value), change('fallbackModels', list)])
      }, '保存模型分工'))
  }

  function searchStep() {
    const search = data.effective.tools.webSearch, fetch = data.effective.tools.webFetch
    const provider = field('搜索服务', search.enable ? search.provider : 'none', { name: 'searchProvider', options: [
      ['none', '不使用搜索'], ['native', '模型自带搜索'], ['anysearch', 'AnySearch'], ['tavily', 'Tavily'], ['brave', 'Brave'], ['searxng', '自建 SearXNG'], ['jina', 'Jina'],
    ] })
    const key = secret('搜索 API Key', search.apiKey)
    key.control.name = 'searchKey'
    const url = field('SearXNG 地址', search.baseUrl || '', { type: 'url' })
    const reading = field('网页读取', fetch.enable ? fetch.reader : 'off', { name: 'pageReader', options: [['off', '关闭'], ['direct', '直接读取'], ['jina', 'Jina Reader']] })
    const readerKey = secret('Jina Reader Key（可选）', fetch.jinaKey)
    const calls = field('每轮最多搜索次数', search.maxPerTurn, { type: 'number', min: 1, max: 100, required: true })
    const hint = h('p', { class: 'small muted', role: 'status' })
    const sync = () => {
      const selected = provider.control.value
      key.view.hidden = ['none', 'native', 'searxng'].includes(selected)
      key.control.disabled = key.view.hidden
      key.control.required = ['tavily', 'brave'].includes(selected) && !search.apiKey?.set
      url.view.hidden = selected !== 'searxng'; url.control.disabled = url.view.hidden; url.control.required = !url.view.hidden
      readerKey.view.hidden = reading.control.value !== 'jina'; readerKey.control.disabled = readerKey.view.hidden
      const model = data.effective.models.find(m => m.id === (status?.models.modelId || data.effective.defaultModel))
      const type = data.effective.providers[model?.provider]?.type
      hint.textContent = selected === 'native'
        ? (model?.nativeSearch !== false && ['anthropic', 'openai-responses', 'gemini'].includes(type) ? '默认模型已支持自带搜索。' : '默认模型不支持自带搜索，请选择外部搜索服务。')
        : ['anysearch', 'jina'].includes(selected) ? '此服务的 Key 可选；已有 Key 留空会保留。' : selected === 'none' ? '仍可单独开启网页读取。' : '填写服务所需的密钥或地址；已有 Key 留空会保留。'
    }
    provider.control.addEventListener('change', sync); reading.control.addEventListener('change', sync); sync()
    return [h('p', { class: 'muted' }, '搜索提供实时信息，网页读取用于展开链接内容。两者可以分别开启。'), form([
      grid(provider.view, key.view, url.view, calls.view, reading.view, readerKey.view), hint,
    ], async () => {
      const selected = provider.control.value
      const changes = [change('tools.webSearch.provider', selected), change('tools.webSearch.enable', selected !== 'none'),
        change('tools.webSearch.maxPerTurn', Number(calls.control.value)), change('tools.webFetch.enable', reading.control.value !== 'off')]
      if (selected === 'searxng') changes.push(change('tools.webSearch.baseUrl', url.control.value.trim()))
      if (!key.control.disabled && key.control.value.trim()) changes.push(change('tools.webSearch.apiKey', keyValue(key.control.value.trim())))
      if (reading.control.value !== 'off') changes.push(change('tools.webFetch.reader', reading.control.value))
      if (!readerKey.control.disabled && readerKey.control.value.trim()) changes.push(change('tools.webFetch.jinaKey', keyValue(readerKey.control.value.trim())))
      await save(changes)
    }, '保存联网设置')]
  }

  function budgetsStep() {
    const c = data.effective, models = c.models ?? []
    if (!models.length) return [h('p', '请先添加聊天模型。')]
    const model = field('设置额度的模型', status?.models.modelId || c.defaultModel || models[0].id, { options: models.map(m => [m.id, m.id]) })
    const controls = []
    const groups = [['user', '每人'], ['group', '每群'], ['global', '全局']].map(([scope, label]) => h('fieldset', { class: 'setup-provider' },
      h('legend', label), grid(...[['window5h', '滚动 5 小时'], ['weekly', '滚动 7 天']].map(([key, title]) => {
        const f = field(`${title}（美元）`, 0, { name: `${scope}.${key}`, type: 'number', min: 0, step: 'any', required: true })
        controls.push({ scope, key, control: f.control }); return f.view
      }))))
    const sync = () => {
      const quota = models.find(m => m.id === model.control.value)?.quota ?? {}
      for (const f of controls) f.control.value = quota[f.scope]?.[f.key] ?? ((quota.scope || c.quota.defaultScope) === f.scope ? quota[f.key] : undefined) ?? 0
    }
    model.control.addEventListener('change', sync); sync()
    return [h('p', { class: 'muted' }, '按模型设置已上报费用的额度，0 表示不限。保存不会清空已用额度。'),
      h('p', { class: 'small muted' }, c.quota.exemptAdmins ? '管理员不受每人 / 每群额度限制；全局额度仍生效。' : '每人 / 每群额度同样适用于管理员。'),
      form([model.view, groups], () => {
        const index = models.findIndex(m => m.id === model.control.value)
        return save(controls.map(f => change(`models.${index}.quota.${f.scope}.${f.key}`, Number(f.control.value))))
      }, '保存预算')]
  }

  function embeddingStep() {
    const c = data.effective.memory.embedding
    const type = field('接口类型', c.type, { options: [['voyage', 'Voyage'], ['openai', 'OpenAI 兼容']] })
    const url = field('接口地址', c.baseUrl, { type: 'url', required: true })
    const model = field('向量模型', c.model, { required: true })
    const dimensions = field('向量维度', c.dimensions, { type: 'number', min: 64, max: 4096, required: true })
    const key = secret('向量 API Key', c.apiKey)
    key.control.required = !c.apiKey?.set
    return [h('p', { class: 'muted' }, '用于语义检索旧聊天。向量模型与维度需要匹配；可跳过，稍后配置。'), form(
      grid(type.view, url.view, model.view, dimensions.view, key.view), async () => {
        const changes = [change('memory.enable', true), change('memory.embedding.enable', true), change('memory.embedding.type', type.control.value),
          change('memory.embedding.baseUrl', url.control.value.trim()), change('memory.embedding.model', model.control.value.trim()), change('memory.embedding.dimensions', Number(dimensions.control.value))]
        if (key.control.value.trim()) changes.push(change('memory.embedding.apiKey', keyValue(key.control.value.trim())))
        await save(changes)
      }, '保存并启用向量检索')]
  }

  function jevStep() {
    const c = data.effective.chat.thinkingJudge
    const mode = field('判断方式', c.mode, { options: [['systemone', 'Jev / System One'], ['model', '聊天小模型'], ['heuristic', '关键词规则（无需接口）']] })
    const url = field('System One 接口地址', c.url, { type: 'url', required: true })
    const model = field('System One 模型', c.systemoneModel, { required: true })
    const key = secret('System One API Key', c.apiKey)
    const judgeModel = field('判断用的聊天模型', c.model || '', { options: [['', '辅助模型 / 默认模型'], ...data.effective.models.map(m => [m.id, m.id])] })
    const systemFields = h('fieldset', { class: 'setup-provider' }, grid(url.view, model.view, key.view))
    const sync = () => { systemFields.hidden = mode.control.value !== 'systemone'; systemFields.disabled = systemFields.hidden; judgeModel.view.hidden = mode.control.value !== 'model' }
    mode.control.addEventListener('change', sync); sync()
    return [h('p', { class: 'muted' }, '按消息复杂度自动选择思考强度。保存后会为默认聊天模型启用自动思考；也可以使用无需 Key 的关键词规则。'),
      form([mode.view, systemFields, judgeModel.view], async () => {
        const changes = [change('chat.thinking', 'auto'), change('chat.thinkingJudge.mode', mode.control.value)]
        if (mode.control.value === 'systemone') {
          changes.push(change('chat.thinkingJudge.url', url.control.value.trim()), change('chat.thinkingJudge.systemoneModel', model.control.value.trim()))
          if (key.control.value.trim()) changes.push(change('chat.thinkingJudge.apiKey', keyValue(key.control.value.trim())))
        } else if (mode.control.value === 'model') changes.push(change('chat.thinkingJudge.model', judgeModel.control.value))
        const index = data.effective.models.findIndex(m => m.id === (status?.models.modelId || data.effective.defaultModel))
        if (index >= 0) changes.push(change(`models.${index}.thinking`, 'auto'))
        await save(changes)
      }, '保存并启用自动思考')]
  }

  function runtimeStep(kind) {
    const section = { sandbox: 'exec', computer: 'computer', lens: 'googleLens', agy: 'agy' }[kind]
    const c = data.effective.tools[section], prefix = `tools.${section}`
    const distro = field('WSL 发行版', c.distro, { required: true, pattern: '[A-Za-z0-9_.\\-]+' })
    const access = field('允许使用的人', c.access, { options: [['admin', '仅管理员'], ['all', '所有人']] })
    const executable = field('AGY 可执行文件', c.executable || '', { placeholder: '留空使用插件安装的 CLI' })
    const model = field('电脑操作模型', c.model || '', { options: [['', '默认聊天模型（需要支持图片和工具）'], ...data.effective.models.filter(m => m.vision !== false && m.toolUse !== false).map(m => [m.id, m.id])] })
    const state = status?.[kind]
    const checks = state?.checks?.map(check => h('li', badge(check.ok ? '通过' : '待配置', check.ok ? 'ok' : 'warn'), check.label))
    const commands = kind === 'sandbox' ? [h('p', '在机器人所在电脑的插件目录运行：'), command(`npm run exec-setup -- --install --distro ${c.distro}`)] : [
      h('p', kind === 'agy' ? 'AGY 需要桌面环境和本机已登录的 Antigravity 账号。在插件目录依次运行：'
        : kind === 'lens' ? '图片反搜只需要桌面浏览器，无需 AGY CLI、登录或 AGY 服务。在插件目录运行：' : '先完成代码沙盒的发行版安装，再在插件目录配置持久桌面：'),
      command(`npm run computer-setup -- --distro ${c.distro}`), kind === 'agy' ? command(`npm run agy-setup -- ${c.distro}`) : kind === 'lens' ? command(`npm run lens-setup -- --distro ${c.distro}`) : null,
      h('p', { class: 'small muted' }, '已有正常运行的环境可直接检查。安装命令可能需要几分钟，并会短暂重启桌面服务。'),
    ]
    return [h('p', { class: 'muted' }, '此步骤可跳过。环境未就绪时，对应工具和依赖它的技能不会提供给模型。'),
      form(grid(distro.view, access.view, kind === 'agy' ? executable.view : null, kind === 'computer' ? model.view : null), () => save([
        change(`${prefix}.distro`, distro.control.value.trim()), change(`${prefix}.access`, access.control.value),
        ...(kind === 'agy' ? [change(`${prefix}.executable`, executable.control.value.trim())] : []),
        ...(kind === 'computer' ? [change(`${prefix}.model`, model.control.value)] : []),
      ]), '保存设置并检查'),
      h('div', { class: 'setup-install' }, commands), h('ul', { class: 'setup-checks' }, checks),
      h('div', { class: 'row' }, button('重新检查环境', () => run(async () => { status = await get('/api/setup?refresh=1'); draw() })),
        h('button', { type: 'button', class: 'btn primary', disabled: !state?.ready || state?.enabled, onclick: () => run(() => save([change(`${prefix}.enable`, true)])) }, state?.enabled ? '已启用' : '启用'),
        state?.enabled ? button('停用', () => run(() => save([change(`${prefix}.enable`, false)])), 'ghost') : null),
      kind === 'agy' ? h('p', { class: 'small muted' }, '环境检查不调用付费模型。要验证 CLI 登录和实际操作，可在本机运行 node cli/agy-verify.mjs（会使用 AGY 额度）。') : null]
  }

  function draw() {
    const [id, title] = STEPS[current], state = status?.[id]
    const runtime = ['sandbox', 'agy', 'computer', 'lens'].includes(id)
    const label = !state ? '检查中' : state.ready ? (runtime ? state.enabled ? '已就绪 · 已启用' : '已就绪 · 未启用' : '已配置') : skipped.has(id) ? '已跳过' : '待配置'
    const step = { models: modelsStep, search: searchStep, embedding: embeddingStep, jev: jevStep, budgets: budgetsStep }[id]
    mount(root, h('div', { class: 'setup-heading' }, h('h2', '设置向导'), h('p', { class: 'muted small' }, '先完成聊天模型，其余功能按需配置。已有设置会自动识别。')),
      h('nav', { class: 'setup-steps', 'aria-label': '设置步骤' }, STEPS.map(([key, label], index) => button(
        `${index + 1}. ${label}${status?.[key]?.ready ? ' ✓' : skipped.has(key) ? ' · 已跳过' : ''}`, () => { current = index; draw() }, index === current ? 'primary' : 'ghost', { 'data-setup-target': key, 'aria-current': index === current ? 'step' : null }))),
      h('section', { class: 'setup-step', 'data-setup-step': id }, h('div', { class: 'row' }, h('h3', title), badge(label, state?.ready ? 'ok' : 'warn'), current ? badge('可选') : null),
        state?.detail ? h('p', { class: 'small muted' }, state.detail) : null,
        step ? step() : runtimeStep(id)),
      feedback, h('div', { class: 'setup-navigation' }, current ? button('上一步', () => { current--; draw() }) : h('span'),
        h('div', { class: 'row' }, current > 0 ? button('跳过此步骤', () => { skipped.add(id); if (current < STEPS.length - 1) { current++; draw() } else location.hash = '#/config/basic' }, 'ghost') : null,
          current < STEPS.length - 1 ? button('下一步', () => { current++; draw() }, 'primary') : h('a', { class: 'btn primary', href: '#/config/basic' }, '完成'))))
  }
  draw()
  void run(async () => { status = await get('/api/setup'); draw() })
  return root
}
