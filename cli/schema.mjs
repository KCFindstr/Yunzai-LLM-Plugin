/**
 * Schema of every valid key in config.yaml (mirrors src/core/configTypes.ts + default_config.yaml).
 * The CLI only offers keys from here, picks the right input widget per type, and validates every write.
 *
 * Node types:
 *   bool, num {min,max,int,nullable}, str {pattern,suggest}, text, secret, any (free YAML),
 *   enum {values, allowEmpty}, multi {values, ordered}, list (free string list),
 *   obj {fields}, map {value, keyLabel, keyPattern}, arr {item, itemLabel, create}, pricing
 * `values` / `suggest` may be functions of the effective config (provider names, model ids, ...).
 */

/** Provider types that serve chat models (src/llm adapters). */
export const CHAT_PROVIDER_TYPES = ['openai', 'openai-responses', 'anthropic', 'gemini']
/** Provider types that serve embedding models: Voyage, or any OpenAI-compatible /embeddings endpoint. */
export const EMBEDDING_PROVIDER_TYPES = ['voyage', 'openai', 'openai-responses']
/** Every provider type: chat, embedding (voyage) and TypeSafe System One classifiers (Jev, self-hosted Kev). */
export const PROVIDER_TYPES = [...CHAT_PROVIDER_TYPES, 'voyage', 'systemone']
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const THINKING_SETTING = [...THINKING, 'auto']
/** model alias ids: any letters (incl. Chinese), digits, . _ -; no spaces, since commands split on whitespace */
export const MODEL_ID = /^[\p{L}\p{N}_.-]+$/u
/** auto-thinking category names: the judge model answers with one of them */
export const CATEGORY_NAME = /^[\p{L}\p{N}_-]{1,32}$/u

/** Official model ids per provider family (checked 2026-10-29). Suggestions only; any id can be typed. */
export const KNOWN_MODELS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra'],
  gemini: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
}
export const KNOWN_EMBEDDING_MODELS = {
  voyage: ['voyage-context-4', 'voyage-4-large', 'voyage-4', 'voyage-4-lite'],
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
}
export const KNOWN_SYSTEMONE_MODELS = ['jev-latest']

/**
 * Capabilities a new model entry starts with, by upstream model name. DeepSeek (2026-10, Responses API):
 * deepseek-flash takes images and tools but ignores the built-in web_search tool; deepseek-v4-pro searches but has
 * no image input.
 */
export function modelDefaults(model) {
  const m = String(model ?? '')
  if (/^deepseek-v4-pro/i.test(m)) return { vision: false, toolUse: true, nativeSearch: true }
  if (/^deepseek/i.test(m)) return { vision: true, toolUse: true, nativeSearch: false }
  return { vision: true, toolUse: true, nativeSearch: true }
}

/**
 * How each requested thinking level is actually sent to a provider (mirrors src/llm/common.ts); levels that map
 * to the same effort behave identically there. DeepSeek: low / high / max (off = effort none).
 */
export function effectiveThinking(provider) {
  const same = Object.fromEntries(THINKING.map(t => [t, t]))
  if (!provider) return same
  if (/deepseek\.com/.test(String(provider.baseUrl ?? ''))) return { ...same, minimal: 'low', medium: 'high', xhigh: 'high' }
  if (provider.type === 'gemini') return { ...same, minimal: 'low', xhigh: 'high', max: 'high' }
  if (provider.type === 'anthropic') return { ...same, minimal: 'low' }
  if (provider.type === 'openai' || provider.type === 'openai-responses') return { ...same, max: 'xhigh' }
  return same
}

/** Providers offered when adding one: [name, type, baseUrl]. */
export const PRESET_PROVIDERS = [
  ['Anthropic', 'anthropic', 'https://api.anthropic.com'],
  ['OpenAI', 'openai-responses', 'https://api.openai.com/v1'],
  ['Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com'],
  ['DeepSeek', 'openai-responses', 'https://api.deepseek.com'],
  ['OpenRouter', 'openai', 'https://openrouter.ai/api/v1'],
  ['通义千问 (DashScope)', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['Moonshot / Kimi', 'openai', 'https://api.moonshot.cn/v1'],
  ['智谱 GLM', 'openai', 'https://open.bigmodel.cn/api/paas/v4'],
  ['SiliconFlow', 'openai', 'https://api.siliconflow.cn/v1'],
  ['Ollama (本地)', 'openai', 'http://127.0.0.1:11434/v1'],
  ['Voyage AI（向量）', 'voyage', 'https://api.voyageai.com/v1'],
  ['TypeSafe Jev（System One）', 'systemone', 'https://api.typesafe.ai/v1'],
  ['Kev 自建（System One）', 'systemone', 'http://127.0.0.1:8009/v1'],
]

const hasKey = p => (Array.isArray(p?.apiKey) ? p.apiKey.length > 0 : Boolean(p?.apiKey))
const isKeyless = p => p?.type === 'systemone' && !/typesafe\.ai/i.test(String(p.baseUrl ?? ''))

/** Problems that leave the config loadable but models unusable (CLI `check`, web config page). */
export function configProblems(c) {
  const problems = []
  const providers = c.providers ?? {}
  const models = c.models ?? []
  const kindOf = (list, types, label) => {
    for (const m of list) {
      const p = providers[m.provider]
      if (!p) problems.push(`${label} ${m.id} 的提供商 ${m.provider} 不存在`)
      else if (!types.includes(p.type)) problems.push(`${label} ${m.id} 的提供商 ${m.provider}（${p.type}）不能提供${label}`)
    }
  }
  kindOf(models, CHAT_PROVIDER_TYPES, '聊天模型')
  kindOf(c.embeddingModels ?? [], EMBEDDING_PROVIDER_TYPES, '向量模型')
  kindOf(c.systemoneModels ?? [], ['systemone'], 'System One 模型')
  for (const id of [...new Set([c.defaultModel, ...(c.fallbackModels ?? [])].filter(Boolean))]) {
    const m = models.find(x => x.id === id)
    if (!m) problems.push(`模型 ${id}（默认/备用）不存在`)
    else if (providers[m.provider] && !hasKey(providers[m.provider])) problems.push(`模型 ${id}（默认/备用）的提供商 ${m.provider} 未配置 Key，将被跳过`)
  }
  if (!models.some(m => hasKey(providers[m.provider]))) problems.push('没有任何可用模型（至少给一个提供商设置 Key）')
  const ids = [...models, ...(c.embeddingModels ?? []), ...(c.systemoneModels ?? [])].map(m => m.id)
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`模型别名 ${id} 在聊天 / 向量 / System One 模型中重复`)
  const em = c.memory?.embedding
  if (em?.enable && c.memory?.enable !== false) {
    const m = (c.embeddingModels ?? []).find(x => x.id === em.model)
    if (!em.model) problems.push('已启用向量检索，但没有选择向量模型（memory.embedding.model）')
    else if (!m) problems.push(`向量模型 ${em.model} 不存在`)
  }
  for (const [label, id] of [['自动思考判断模型', c.autoThinking?.judge], ['主动发言判断模型', c.proactive?.judge]]) {
    if (!id || (id === 'always' && label === '主动发言判断模型')) continue
    const so = (c.systemoneModels ?? []).find(x => x.id === id)
    if (!so && !models.some(x => x.id === id)) problems.push(`${label} ${id} 不存在`)
    else if (so && providers[so.provider] && !hasKey(providers[so.provider]) && !isKeyless(providers[so.provider]))
      problems.push(`${label} ${id} 的提供商 ${so.provider} 未配置 Key`)
  }
  if (!(c.autoThinking?.categories ?? []).length) problems.push('自动思考强度没有任何消息类别')
  return problems
}

/**
 * Not errors, but settings that probably don't do what was meant: background roles (utility, vision, sticker
 * indexing) on a model whose thinking is `auto` run at the level of its first auto-thinking category.
 * Each notice names the config paths it is shown beside ({ paths, text }): the setting and the model it concerns.
 */
export function configNotices(c) {
  const notices = []
  const models = c.models ?? []
  const first = c.autoThinking?.categories?.[0]?.name
  const defaultId = c.defaultModel || models.find(m => hasKey(c.providers?.[m.provider]))?.id || models[0]?.id
  const roles = [
    ['后台任务模型（utilityModel）', c.utilityModel || defaultId, !c.utilityModel, 'utilityModel'],
    ['识图模型（visionModel）', c.visionModel, false, 'visionModel'],
    ['表情识别模型（sticker.indexModel）', c.sticker?.indexModel, false, 'sticker.indexModel'],
  ]
  for (const [label, id, implicit, path] of roles) {
    const i = id ? models.findIndex(x => x.id === id) : -1
    const m = models[i]
    if (!m || (m.thinking ?? c.chat?.thinking) !== 'auto') continue
    const level = m.autoThinking?.[first] ?? c.autoThinking?.levels?.[first] ?? 'low'
    notices.push({ paths: [path, `models.${i}`], text: `${label}${implicit ? '未设置，使用默认模型' : ''} ${m.id} 的思考强度为 auto；后台调用不做消息判断，固定使用第一个类别「${first}」的强度 ${level}。` +
      `如需其它强度，可另外添加一个固定思考强度的模型（可以是同一个上游模型 ${m.model}）专门用于这个角色。` })
  }
  const em = c.memory?.embedding
  const j = em?.enable && c.memory?.enable !== false ? (c.embeddingModels ?? []).findIndex(x => x.id === em.model) : -1
  const vec = c.embeddingModels?.[j]
  if (vec && c.providers?.[vec.provider] && !hasKey(c.providers[vec.provider]))
    notices.push({ paths: ['memory.embedding.model', `embeddingModels.${j}`, `providers.${vec.provider}`], text: `向量模型 ${vec.id} 的提供商 ${vec.provider} 还没有设置 Key，旧聊天暂时只用关键词检索` })
  return notices
}

/** Model suggestions for a provider entry, based on its type / base URL. */
export function modelSuggestions(provider) {
  if (!provider) return []
  const url = String(provider.baseUrl ?? '')
  if (provider.type === 'anthropic') return KNOWN_MODELS.anthropic
  if (provider.type === 'gemini') return KNOWN_MODELS.gemini
  if (provider.type === 'voyage' || provider.type === 'systemone') return []
  if (/deepseek\.com/.test(url)) return KNOWN_MODELS.deepseek
  if (!url || /api\.openai\.com/.test(url)) return KNOWN_MODELS.openai
  return []
}

export function embeddingSuggestions(provider) {
  if (provider?.type === 'voyage') return KNOWN_EMBEDDING_MODELS.voyage
  if (provider && /api\.openai\.com/.test(String(provider.baseUrl ?? 'https://api.openai.com/v1'))) return KNOWN_EMBEDDING_MODELS.openai
  return []
}

const bool = (label, o = {}) => ({ t: 'bool', label, ...o })
const num = (label, o = {}) => ({ t: 'num', label, ...o })
const int = (label, o = {}) => ({ t: 'num', int: true, label, ...o })
const str = (label, o = {}) => ({ t: 'str', label, ...o })
const text = label => ({ t: 'text', label })
const secret = label => ({ t: 'secret', label })
const any = label => ({ t: 'any', label })
const oneOf = (values, label, o = {}) => ({ t: 'enum', values, label, ...o })
const multi = (values, label, o = {}) => ({ t: 'multi', values, label, ...o })
const list = label => ({ t: 'list', label })
const obj = (fields, label, o = {}) => ({ t: 'obj', fields, label, ...o })
const map = (value, label, o = {}) => ({ t: 'map', value, label, ...o })
const arr = (item, label, o = {}) => ({ t: 'arr', item, label, ...o })

const providersOf = types => c => Object.entries(c.providers ?? {}).filter(([, p]) => types.includes(p?.type)).map(([name]) => name)
const modelIds = c => (c.models ?? []).map(m => m.id).filter(Boolean)
const embeddingIds = c => (c.embeddingModels ?? []).map(m => m.id).filter(Boolean)
/** a judge is a chat model (asked for a label) or a System One classifier */
const judgeIds = c => [...new Set([...(c.systemoneModels ?? []).map(m => m.id), ...modelIds(c)].filter(Boolean))]
const presetNames = c => Object.keys(c.persona?.presets ?? {})
const toolNames = c => [
  ...new Set(['web_search', 'web_fetch', 'run_bot_command', 'search_bot_commands', 'list_bot_commands', 'load_skill', 'memory', 'add_sticker', 'list_stickers', 'render_html', 'run_code', 'computer_task', 'agy', 'google_lens', ...(c.tools?.http ?? []).map(h => h.name).filter(Boolean), ...(c.tools?.disabled ?? [])]),
]

const limits = label => obj({ window5h: num('5小时额度（美元）', { min: 0, nullable: true }), weekly: num('每周额度（美元）', { min: 0, nullable: true }) }, label)

const provider = obj(
  {
    type: oneOf(PROVIDER_TYPES, '接口类型', { required: true }),
    baseUrl: str('接口地址', { pattern: /^https?:\/\/\S+$/ }),
    apiKey: secret('API Key（多个用英文逗号分隔，env:变量名 读取环境变量）'),
    timeout: int('超时（秒）', { min: 1 }),
    maxRetries: int('重试次数', { min: 0, max: 10 }),
    headers: map(str('值'), '额外请求头', { keyLabel: '请求头名称', keyPattern: /^[\w-]+$/ }),
    maxTokensField: oneOf(['max_tokens', 'max_completion_tokens'], '输出上限字段', { when: p => p.type === 'openai' }),
    promptCacheKey: bool('发送 prompt_cache_key', { when: p => p.type === 'openai' || p.type === 'openai-responses' }),
    authStyle: oneOf(['x-api-key', 'bearer'], '鉴权方式', { when: p => p.type === 'anthropic' }),
    cacheTtl: oneOf(['5m', '1h'], '提示缓存时长', { when: p => p.type === 'anthropic' }),
    serverState: bool('服务端会话状态', { when: p => p.type === 'gemini' || p.type === 'openai-responses' }),
    store: bool('服务端保存对话', { when: p => p.type === 'gemini' || p.type === 'openai-responses' }),
    balance: oneOf(['none', 'deepseek', 'openrouter', 'moonshot', 'siliconflow'], '余额查询接口', { when: p => CHAT_PROVIDER_TYPES.includes(p.type) }),
  },
  '提供商',
)

/** category -> thinking level; keys are autoThinking.categories names (unknown keys are kept but unused) */
const levels = label => ({ t: 'levels', label })

const model = obj(
  {
    id: str('别名 id（可用中文）', { required: true, pattern: MODEL_ID }),
    provider: oneOf(providersOf(CHAT_PROVIDER_TYPES), '提供商', { required: true }),
    model: str('上游模型名', { required: true, suggest: (c, item) => modelSuggestions(c.providers?.[item?.provider]) }),
    thinking: oneOf(THINKING_SETTING, '思考强度', { allowEmpty: true }),
    autoThinking: levels('auto 时各类消息的思考强度（留空用 autoThinking.levels）'),
    vision: bool('支持图片输入'),
    toolUse: bool('支持工具调用'),
    nativeSearch: bool('使用模型自带搜索'),
    serverState: bool('服务端会话状态（覆盖提供商设置，仅 Gemini）'),
    maxTokens: int('最大输出 token', { min: 1 }),
    temperature: num('温度', { min: 0, max: 2, nullable: true }),
    topP: num('top_p', { min: 0, max: 1, nullable: true }),
    pricing: { t: 'pricing', label: '价格' },
    pricingId: str('价格表中的模型名'),
    quota: obj(
      {
        window5h: num('简写：5小时额度（美元）', { min: 0, nullable: true }),
        weekly: num('简写：每周额度（美元）', { min: 0, nullable: true }),
        scope: oneOf(['user', 'group', 'global'], '简写额度的范围', { allowEmpty: true }),
        user: limits('每人额度'),
        group: limits('每群额度'),
        global: limits('全局额度'),
      },
      '额度',
    ),
    extraBody: any('额外请求参数（YAML 对象）'),
  },
  '模型',
)

const embeddingModel = obj(
  {
    id: str('别名 id', { required: true, pattern: MODEL_ID }),
    provider: oneOf(providersOf(EMBEDDING_PROVIDER_TYPES), '提供商（voyage 或 OpenAI 兼容）', { required: true }),
    model: str('上游模型名', { required: true, suggest: (c, item) => embeddingSuggestions(c.providers?.[item?.provider]) }),
    dimensions: int('向量维度（改动后旧向量自动重建）', { min: 64, max: 4096 }),
  },
  '向量模型',
)

const systemoneModel = obj(
  {
    id: str('别名 id', { required: true, pattern: MODEL_ID }),
    provider: oneOf(providersOf(['systemone']), '提供商（systemone）', { required: true }),
    model: str('上游模型名', { required: true, suggest: () => KNOWN_SYSTEMONE_MODELS }),
  },
  'System One 模型',
)

const autoThinking = obj(
  {
    judge: oneOf(judgeIds, '判断模型（聊天模型或 System One 模型；空=后台任务模型→默认模型）', { allowEmpty: true }),
    timeoutMs: int('超时（毫秒，超时或出错使用第一个类别）', { min: 200, max: 10000 }),
    context: int('附带最近消息条数（判断模型只评估最后一条）', { min: 0, max: 30 }),
    levels: levels('各类消息的默认思考强度（每个模型可单独覆盖）'),
    categories: arr(
      obj({ name: str('类别名（判断模型输出它）', { required: true, pattern: CATEGORY_NAME }), description: text('描述（给判断模型看）') }, '消息类别'),
      '消息类别（第一个也是出错时的后备类别）',
      { itemLabel: k => k.name, create: ['name', 'description'] },
    ),
  },
  '自动思考强度',
)

const proactiveFields = {
  probability: num('抽签概率（抽中后进入模型判断）', { min: 0, max: 1 }),
  window: int('判断窗口（秒）：窗口内有抽中时评估一次', { min: 5, max: 3600 }),
  judge: oneOf(c => ['always', ...judgeIds(c)], '判断模型（always=仅按概率；空=继承思考判断模型）', { allowEmpty: true }),
  context: int('附带最近群聊条数', { min: 1, max: 50 }),
  criteria: obj({ reply: text('适合插话的情况'), skip: text('不该插话的情况') }, '判断标准（给判断模型看）'),
  threshold: obj(
    {
      start: num('刚回复时的初始阈值', { min: 0, max: 1 }),
      end: num('久未回复时的最低阈值', { min: 0, max: 1 }),
      halfLife: int('衰减半衰期（秒）', { min: 1, max: 86400 }),
    },
    '回复阈值曲线（随距上次回复的时间衰减）',
  ),
}
const proactive = obj(proactiveFields, '主动发言')

const chat = obj(
  {
    sessionScope: oneOf(['user', 'group'], '记忆范围'),
    sessionTimeout: int('会话过期（分钟）', { min: 1 }),
    historyMaxTurns: int('最多保留对话轮数（一轮含用户消息和机器人回复各一条）', { min: 1 }),
    maxPending: int('每会话最多待处理消息', { min: 1, max: 100 }),
    rosterSize: int('最近群友资料条数', { min: 0, max: 30 }),
    historyMaxTokens: int('最多保留 token', { min: 100 }),
    summarize: bool('压缩旧对话为摘要'),
    summaryMaxTokens: int('摘要输出 token 上限（含思考；滚动摘要、群聊档案和每日概要）', { min: 64, max: 131072 }),
    groupContext: int('附带最近群聊条数', { min: 0, max: 100 }),
    groupContextMaxChars: int('群聊每条最多字数', { min: 10 }),
    maxToolRounds: int('工具轮数上限（含只调用辅助工具的轮次；0关闭工具）', { min: 0, max: 100 }),
    maxToolCalls: int('普通工具合计次数上限（并行分别计数；不含发送/读取图片、加载技能、表情列表）', { min: 0, max: 1000 }),
    maxOutputTokens: int('最大输出 token', { min: 64 }),
    temperature: num('温度', { min: 0, max: 2, nullable: true }),
    thinking: oneOf(THINKING_SETTING, '默认思考强度'),
    includeImages: bool('识别图片'),
    maxImages: int('每次最多图片数', { min: 0, max: 5 }),
    includeQuoted: bool('读取引用的消息'),
  },
  '对话与上下文',
)

const rate = label => obj({ count: int('条数', { min: 1 }), perSeconds: int('秒数', { min: 1 }) }, label)

const reply = obj(
  {
    quote: oneOf(['auto', 'always', 'never'], '引用回复'),
    atUser: bool('不引用时 @ 对方'),
    maxBubbles: int('最多分几条发送', { min: 1, max: 5 }),
    maxChars: int('长文字数阈值', { min: 50 }),
    longText: oneOf(['forward', 'truncate'], '长文处理'),
    stripMarkdown: bool('去除 Markdown'),
    markdown: oneOf([false, true, 'auto'], '以 Markdown 输出'),
    typing: obj({ charsPerSecond: num('打字速度（字/秒）', { min: 1 }), minDelay: int('最小延迟 ms', { min: 0 }), maxDelay: int('最大延迟 ms', { min: 0 }) }, '模拟打字'),
    groupRate: rate('每群发送上限'),
    globalRate: rate('全局发送上限'),
    concurrency: int('并发请求数', { min: 1, max: 20 }),
    errorNotice: bool('出错时提示'),
    errorCooldown: int('出错提示冷却（秒）', { min: 0 }),
    privateTyping: bool('私聊显示正在输入'),
  },
  '回复与风控',
)

const sticker = obj(
  {
    enable: bool('启用表情包'),
    probability: num('发送概率', { min: 0, max: 1 }),
    cooldown: int('冷却（秒）', { min: 0 }),
    maxInPrompt: int('提示词中最多列出', { min: 0 }),
    indexModel: oneOf(modelIds, '识别用视觉模型', { allowEmpty: true }),
    sendAs: oneOf(['sticker', 'image'], '发送形式'),
    maxSendSize: int('发送时最大尺寸（像素，0=原图）', { min: 0, max: 2000 }),
  },
  '表情包',
)

const tools = obj(
  {
    enable: bool('工具总开关'),
    sendImage: obj({ maxPerTurn: int('每次回复最多发送图片请求数（0禁用）', { min: 0, max: 32 }) }, '发送图片 send_image'),
    readFile: obj({ maxPerTurn: int('每次回复最多读取文件次数（图片、视频、音频、PDF、文本；0禁用）', { min: 0, max: 32 }) }, '读取文件 read_file'),
    loadSkill: obj({ maxPerTurn: int('每次回复最多加载技能次数（0禁用）', { min: 0, max: 32 }) }, '加载技能 load_skill'),
    listStickers: obj({ maxPerTurn: int('每次回复最多查看表情列表次数（0禁用）', { min: 0, max: 32 }) }, '表情列表 list_stickers'),
    webSearch: obj(
      {
        enable: bool('联网搜索'),
        provider: oneOf(['native', 'deepseek', 'anysearch', 'tavily', 'brave', 'searxng', 'jina', 'none'], '搜索服务'),
        apiKey: secret('搜索 API Key'),
        baseUrl: str('SearXNG 地址', { pattern: /^https?:\/\/\S+$/ }),
        maxResults: int('结果数', { min: 1, max: 10 }),
        maxPerTurn: int('每轮最多搜索次数', { min: 1, max: 100 }),
      },
      '联网搜索',
    ),
    webFetch: obj(
      {
        enable: bool('网页读取'),
        maxChars: int('最多字符', { min: 500 }),
        timeout: int('超时（秒）', { min: 1 }),
        reader: oneOf(['direct', 'jina', 'deepseek'], '读取方式'),
        jinaKey: secret('Jina Key'),
        allowPrivateNetwork: bool('允许访问内网（危险）'),
        maxPerTurn: int('每轮最多打开网页次数', { min: 1, max: 100 }),
      },
      '网页读取',
    ),
    botCommand: obj(
      {
        enable: bool('自然语言转指令'),
        inPrompt: int('提示词中的指令数', { min: 0, max: 200 }),
        ack: bool('执行指令后附带文字'),
        allowMasterCommands: bool('允许执行主人指令'),
        blacklist: list('禁止的指令（正则）'),
        hints: arr(obj({ cmd: str('指令', { required: true }), desc: str('说明', { required: true }) }, '指令说明'), '补充指令说明', {
          itemLabel: h => `${h.cmd} — ${h.desc}`,
          create: ['cmd', 'desc'],
        }),
      },
      '指令调用',
    ),
    http: arr(
      obj(
        {
          name: str('工具名', { required: true, pattern: /^[\w-]{1,64}$/ }),
          description: str('说明（给模型看）', { required: true }),
          url: str('URL（{参数} 会被替换）', { required: true, pattern: /^https?:\/\/\S+$/ }),
          method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], '请求方法'),
          parameters: any('参数 JSON Schema（YAML）'),
          headers: map(str('值'), '请求头', { keyLabel: '请求头名称', keyPattern: /^[\w-]+$/ }),
          body: any('请求体模板（YAML，{{参数}} 会被替换）'),
          maxChars: int('返回最多字符', { min: 100 }),
        },
        'HTTP 工具',
      ),
      'HTTP 工具',
      { itemLabel: h => `${h.name}  ${h.url ?? ''}`, create: ['name', 'description', 'url'] },
    ),
    renderHtml: obj(
      {
        enable: bool('HTML 渲染成图片'),
        width: int('页面宽度（像素）', { min: 200, max: 1600 }),
        maxHeight: int('最大高度（像素）', { min: 100, max: 16000 }),
        allowNetwork: bool('允许加载公网图片/字体'),
      },
      'HTML 渲染',
    ),
    exec: obj(
      {
        enable: bool('运行代码（需先 npm run exec-setup）'),
        distro: str('WSL 发行版名称', { pattern: /^[\w.-]+$/ }),
        access: oneOf(['admin', 'all'], '谁可以触发（admin=仅管理员）'),
        languages: multi(['python', 'node', 'bash'], '允许的语言'),
        timeout: int('每次最多秒数', { min: 1, max: 50 }),
        memoryMB: int('内存上限（MB）', { min: 64, max: 4096 }),
        diskMB: int('磁盘上限（MB）', { min: 8, max: 2048 }),
        maxOutput: int('返回给模型的输出字符数', { min: 256, max: 20000 }),
        maxRunsPerTurn: int('每轮最多运行次数', { min: 1, max: 100 }),
      },
      '运行代码',
    ),
    computer: obj(
      {
        enable: bool('持久像素电脑（需先 npm run computer-setup）'),
        distro: str('专用 WSL 发行版', { pattern: /^[\w.-]+$/ }),
        access: oneOf(['admin', 'all'], '谁可以使用共享电脑'),
        model: oneOf(modelIds, '独立电脑代理模型', { allowEmpty: true }),
        maxSteps: int('每个任务的模型轮数上限', { min: 1, max: 500 }),
        maxMinutes: int('每个任务最多分钟数', { min: 1, max: 120 }),
        maxInputTokens: int('累计输入 token（含缓存）', { min: 1000, max: 2000000 }),
        maxOutputTokens: int('累计输出 token', { min: 256, max: 500000 }),
        maxQueue: int('全局排队任务上限', { min: 1, max: 50 }),
        recentScreenshots: int('工作上下文保留截图数', { min: 1, max: 4 }),
        maxTokensPerStep: int('每步输出 token 上限', { min: 128, max: 32768 }),
        thinking: oneOf(THINKING, '电脑代理思考强度（默认关闭以节省输出）'),
        maxChainDepth: int('后台结果回复中可连续新建任务的次数（0 为禁止）', { min: 0, max: 10 }),
        checkpointSteps: int('Claude 上下文检查点间隔', { min: 2, max: 30 }),
      },
      '持久电脑代理',
    ),
    googleLens: obj({
      enable: bool('Google Lens 原图反搜（使用现有 VM 浏览器）'),
      access: oneOf(['admin', 'all'], '谁可以上传图片到 Google Lens'),
      distro: str('现有机器人 WSL 发行版', { pattern: /^[\w.-]+$/ }),
    }, 'Google Lens'),
    agy: obj({
      enable: bool('宿主机异步工作进程 AGY（sandbox + turbo）'),
      access: oneOf(['admin', 'all'], '谁可以使用 AGY（all 将向所有人开放主机完整访问）'),
      executable: str('宿主机 AGY CLI 路径（留空使用 npm run agy-setup 安装的 CLI）', { allowEmpty: true }),
      maxMinutes: int('任务最多分钟数', { min: 1, max: 1440 }),
      maxQueue: int('排队上限', { min: 1, max: 50 }),
      maxChainDepth: int('后台结果回复中可连续新建任务的次数（0 为禁止）', { min: 0, max: 10 }),
    }, '异步代理'),
    disabled: multi(toolNames, '禁用的工具'),
  },
  '工具',
)

const memory = obj(
  {
    enable: bool('启用长期记忆'),
    userMaxEntries: int('每人最多条数', { min: 1, max: 200 }),
    userMaxChars: int('每人最多字数', { min: 50 }),
    groupMaxEntries: int('每群最多条数', { min: 1, max: 200 }),
    groupMaxChars: int('每群最多字数', { min: 50 }),
    entryMaxChars: int('每条最多字数', { min: 10, max: 500 }),
    groupWrite: oneOf(['all', 'admin', 'off'], '群记忆写入'),
    autoCompact: bool('自动整理'),
    maxWritesPerTurn: int('每次回复最多修改次数', { min: 0, max: 100 }),
    dailyDays: int('每日概要保留天数', { min: 1, max: 3650 }),
    crossChatRecall: bool('私聊可检索对方所在群的旧聊天'),
    groupChatArchive: bool('整理群里没有@机器人的聊天'),
    recallLimit: int('每次检索旧聊天最多返回几条', { min: 1, max: 100 }),
    embedding: obj(
      {
        enable: bool('旧聊天向量检索（需向量模型及其提供商 Key）'),
        model: oneOf(embeddingIds, '向量模型（在「模型」中管理）', { allowEmpty: true }),
        minScore: num('相似度阈值', { min: 0, max: 1 }),
      },
      '向量检索',
    ),
  },
  '长期记忆',
)

const groupOverride = obj(
  {
    enable: bool('在本群启用'),
    model: oneOf(modelIds, '本群模型', { allowEmpty: true }),
    persona: oneOf(presetNames, '本群人设', { allowEmpty: true }),
    thinking: oneOf(THINKING_SETTING, '本群思考强度', { allowEmpty: true }),
    chat: { ...chat, label: '对话（覆盖）' },
    reply: { ...reply, label: '回复（覆盖）' },
    sticker: { ...sticker, label: '表情包（覆盖）' },
    proactive: obj({ enable: bool('在本群启用主动发言'), ...proactiveFields }, '主动发言（本群）'),
    names: map(str('称呼'), '本群称呼（覆盖全局称呼）', { keyLabel: '平台ID', keyPattern: /^[\w-]{1,64}$/ }),
  },
  '群设置',
)

export const SCHEMA = obj(
  {
    enable: bool('总开关'),
    admins: list('插件管理员 QQ'),
    providers: map(provider, '提供商', { keyLabel: '提供商名称（英文）', keyPattern: /^[\w-]+$/ }),
    models: arr(model, '聊天模型', { itemLabel: m => `${m.id}  ${m.provider}/${m.model}`, create: ['provider', 'model', 'id'] }),
    embeddingModels: arr(embeddingModel, '向量模型', { itemLabel: m => `${m.id}  ${m.provider}/${m.model}`, create: ['provider', 'model', 'id'] }),
    systemoneModels: arr(systemoneModel, 'System One 模型', { itemLabel: m => `${m.id}  ${m.provider}/${m.model}`, create: ['provider', 'model', 'id'] }),
    defaultModel: oneOf(modelIds, '默认模型', { allowEmpty: true }),
    fallbackModels: multi(modelIds, '备用模型', { ordered: true }),
    utilityModel: oneOf(modelIds, '后台任务模型', { allowEmpty: true }),
    visionModel: oneOf(modelIds, '识图模型', { allowEmpty: true }),
    persona: obj(
      { botName: str('机器人名字（空=QQ昵称）'), active: oneOf(presetNames, '当前人设'), presets: map(text('人设内容'), '人设', { keyLabel: '人设名称' }) },
      '人设',
    ),
    groups: map(groupOverride, '分群设置', { keyLabel: '群号', keyPattern: /^\d+$/ }),
    names: map(str('称呼'), '群友称呼', { keyLabel: '平台ID（QQ号，或 QQBot 的用户ID）', keyPattern: /^[\w-]{1,64}$/ }),
    trigger: obj(
      {
        at: bool('@机器人触发'),
        replyToBot: bool('回复机器人消息触发'),
        alias: bool('Yunzai 别名前缀触发'),
        prefixes: list('额外触发前缀'),
        private: oneOf(['off', 'master', 'all'], '私聊'),
        groupWhitelist: list('群白名单'),
        groupBlacklist: list('群黑名单'),
        userBlacklist: list('用户黑名单'),
        priority: int('插件优先级（保持最低）', { min: 0 }),
        userCooldown: num('同一用户触发间隔（秒）', { min: 0 }),
      },
      '触发方式',
    ),
    chat,
    autoThinking,
    proactive,
    quota: obj(
      { defaultScope: oneOf(['user', 'group', 'global'], '简写额度的默认范围'), exemptAdmins: bool('管理员不受个人/群额度限制'), notifyCooldown: int('额度提示冷却（秒）', { min: 0 }) },
      '额度',
    ),
    reply,
    sticker,
    tools,
    memory,
    skills: obj({ enable: bool('启用技能') }, '技能'),
    pricing: obj({ sources: multi(['litellm', 'openrouter'], '价格表来源', { ordered: true }), refreshHours: num('刷新间隔（小时）', { min: 1 }) }, '价格表'),
    web: obj(
      {
        enable: bool('启用网页管理面板'),
        host: str('监听地址（127.0.0.1 仅本机）'),
        port: int('端口', { min: 1, max: 65535 }),
        password: secret('登录密码（空=自动生成）'),
      },
      '网页管理',
    ),
  },
  '全部配置',
)

export const PRICING_FIELDS = obj(
  {
    input: num('输入 $/百万token', { min: 0, required: true }),
    output: num('输出 $/百万token', { min: 0, required: true }),
    cacheRead: num('缓存读取 $/百万token', { min: 0 }),
    cacheWrite: num('缓存写入 $/百万token', { min: 0 }),
    cacheWrite1h: num('1小时缓存写入 $/百万token', { min: 0 }),
    perSearch: num('每次联网搜索 $', { min: 0 }),
    perRequest: num('每次请求 $', { min: 0 }),
  },
  '手动价格',
)

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const LEVEL = oneOf(THINKING, '思考强度')

/** Schema node for a key path, or undefined if the path isn't a valid config key. */
export function schemaAt(keys) {
  let node = SCHEMA
  for (const k of keys) {
    if (!node) return undefined
    if (node.t === 'obj') node = node.fields[k]
    else if (node.t === 'map') node = node.value
    else if (node.t === 'arr') node = typeof k === 'number' || /^\d+$/.test(String(k)) ? node.item : undefined
    else if (node.t === 'pricing') node = PRICING_FIELDS.fields[k]
    else if (node.t === 'levels') node = CATEGORY_NAME.test(String(k)) ? LEVEL : undefined
    else return undefined
  }
  return node
}

/** Settings removed from the plugin. Older config.yaml files may still have them; they are dropped, not rejected. */
export const RETIRED_PATHS = [
  ['tools', 'agy', 'distro'], // AGY runs on the host since it stopped using the WSL sandbox
  ['tools', 'readImage'], // renamed to tools.readFile with the read_file tool; config.ts carries the old value over
  ['trigger', 'emptyAtReply'], // an empty @ now goes to the model (it may ask the bot to answer an earlier message)
]

/** Remove retired settings from a YAML document in place. Returns the dotted paths that were removed. */
export function dropRetired(doc) {
  return RETIRED_PATHS.filter(keys => doc.hasIn(keys)).map(keys => { doc.deleteIn(keys); return keys.join('.') })
}

/** Check user-chosen keys along a path (map keys like group ids / provider names). Returns an error or undefined. */
export function validatePath(keys) {
  let node = SCHEMA
  for (let i = 0; i < keys.length; i++) {
    if (node?.t === 'map' && node.keyPattern && !node.keyPattern.test(String(keys[i])))
      return `${keys.slice(0, i).join('.')} 的键名格式不正确：${keys[i]}（${node.keyLabel ?? ''}）`
    node = schemaAt(keys.slice(0, i + 1))
    if (!node) return `未知配置项：${keys.slice(0, i + 1).join('.')}`
  }
  return undefined
}

export const valuesOf =(node, cfg, ctx) => (typeof node.values === 'function' ? node.values(cfg, ctx) : node.values) ?? []

/** Validate a value against a schema node. Returns an error message or undefined. */
export function validate(node, v, cfg, ctx) {
  if (v === undefined) return undefined
  switch (node.t) {
    case 'bool':
      return typeof v === 'boolean' ? undefined : '应为 true / false'
    case 'num':
      if (v === null) return node.nullable ? undefined : '不能为空'
      if (typeof v !== 'number' || !Number.isFinite(v)) return '应为数字'
      if (node.int && !Number.isInteger(v)) return '应为整数'
      if (node.min != null && v < node.min) return `不能小于 ${node.min}`
      if (node.max != null && v > node.max) return `不能大于 ${node.max}`
      return undefined
    case 'str':
    case 'text':
      if (typeof v !== 'string') return '应为文本'
      if (node.pattern && v && !node.pattern.test(v)) return `格式不正确（${node.pattern}）`
      return undefined
    case 'secret':
      return typeof v === 'string' || (Array.isArray(v) && v.every(x => typeof x === 'string')) ? undefined : '应为字符串或字符串列表'
    case 'enum': {
      if ((v === '' || v === null) && node.allowEmpty) return undefined
      const vals = valuesOf(node, cfg, ctx)
      return vals.includes(v) ? undefined : `可选值：${vals.join(' / ') || '（暂无可选项）'}`
    }
    case 'multi': {
      if (!Array.isArray(v)) return '应为列表'
      const vals = valuesOf(node, cfg, ctx)
      const bad = v.filter(x => !vals.includes(x))
      return bad.length ? `无效的值：${bad.join(', ')}（可选：${vals.join(' / ')}）` : undefined
    }
    case 'list':
      return Array.isArray(v) && v.every(x => ['string', 'number'].includes(typeof x)) ? undefined : '应为列表'
    case 'any':
      return undefined
    case 'pricing':
      if (v === 'auto') return undefined
      if (!isObj(v)) return '应为 auto 或价格对象'
      return validate(PRICING_FIELDS, v, cfg, ctx)
    case 'levels': {
      if (!isObj(v)) return '应为 类别: 思考强度 的对象'
      for (const [k, x] of Object.entries(v)) {
        if (!CATEGORY_NAME.test(k)) return `类别名格式不正确：${k}`
        if (!THINKING.includes(x)) return `${k}: 可选值：${THINKING.join(' / ')}`
      }
      return undefined
    }
    case 'obj': {
      if (!isObj(v)) return '应为对象'
      for (const [k, x] of Object.entries(v)) {
        const f = node.fields[k]
        if (!f) return `未知配置项：${k}`
        const err = validate(f, x, cfg, v)
        if (err) return `${k}: ${err}`
      }
      return undefined
    }
    case 'map': {
      if (!isObj(v)) return '应为对象'
      for (const [k, x] of Object.entries(v)) {
        if (node.keyPattern && !node.keyPattern.test(k)) return `键名格式不正确：${k}`
        const err = validate(node.value, x, cfg, x)
        if (err) return `${k}.${err}`
      }
      return undefined
    }
    case 'arr': {
      if (!Array.isArray(v)) return '应为列表'
      for (let i = 0; i < v.length; i++) {
        const err = validate(node.item, v[i], cfg, v[i])
        if (err) return `[${i}] ${err}`
      }
      return undefined
    }
  }
  return undefined
}

/** Closest valid keys for an unknown path segment (for helpful errors). */
export function suggestKeys(keys) {
  const parent = schemaAt(keys.slice(0, -1))
  const last = String(keys.at(-1) ?? '').toLowerCase()
  if (parent?.t !== 'obj') return []
  return Object.keys(parent.fields)
    .map(k => [k, k.toLowerCase().includes(last) || last.includes(k.toLowerCase()) ? 0 : levenshtein(k.toLowerCase(), last)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .filter(([, d]) => d <= 3)
    .map(([k]) => k)
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}
