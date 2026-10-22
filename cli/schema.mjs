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

export const PROVIDER_TYPES = ['openai', 'openai-responses', 'anthropic', 'gemini']
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const THINKING_SETTING = [...THINKING, 'auto']
/** model alias ids: any letters (incl. Chinese), digits, . _ -; no spaces, since commands split on whitespace */
export const MODEL_ID = /^[\p{L}\p{N}_.-]+$/u

/** Official model ids per provider (checked 2026-10). Suggestions only; any id can be typed. */
export const KNOWN_MODELS = {
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra'],
  gemini: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
}

/** Model suggestions for a provider entry, based on its type / base URL. */
export function modelSuggestions(provider) {
  if (!provider) return []
  const url = String(provider.baseUrl ?? '')
  if (provider.type === 'anthropic') return KNOWN_MODELS.anthropic
  if (provider.type === 'gemini') return KNOWN_MODELS.gemini
  if (/deepseek\.com/.test(url)) return KNOWN_MODELS.deepseek
  if (!url || /api\.openai\.com/.test(url)) return KNOWN_MODELS.openai
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

const providerNames = c => Object.keys(c.providers ?? {})
const modelIds = c => (c.models ?? []).map(m => m.id).filter(Boolean)
const presetNames = c => Object.keys(c.persona?.presets ?? {})
const toolNames = c => [
  ...new Set(['web_search', 'web_fetch', 'run_bot_command', 'search_bot_commands', 'list_bot_commands', 'load_skill', 'memory', 'add_sticker', 'list_stickers', 'render_html', 'run_code', 'computer_task', ...(c.tools?.http ?? []).map(h => h.name).filter(Boolean), ...(c.tools?.disabled ?? [])]),
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
    balance: oneOf(['none', 'deepseek', 'openrouter', 'moonshot', 'siliconflow'], '余额查询接口'),
  },
  '提供商',
)

const model = obj(
  {
    id: str('别名 id（可用中文）', { required: true, pattern: MODEL_ID }),
    provider: oneOf(providerNames, '提供商', { required: true }),
    model: str('上游模型名', { required: true, suggest: (c, item) => modelSuggestions(c.providers?.[item?.provider]) }),
    thinking: oneOf(THINKING_SETTING, '思考强度', { allowEmpty: true }),
    vision: bool('支持图片输入'),
    toolUse: bool('支持工具调用'),
    nativeSearch: bool('使用模型自带搜索'),
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

const chat = obj(
  {
    sessionScope: oneOf(['user', 'group'], '记忆范围'),
    sessionTimeout: int('会话过期（分钟）', { min: 1 }),
    historyMaxTurns: int('最多保留轮数', { min: 1 }),
    maxPending: int('每会话最多待处理消息', { min: 1, max: 100 }),
    rosterSize: int('最近群友资料条数', { min: 0, max: 30 }),
    historyMaxTokens: int('最多保留 token', { min: 100 }),
    summarize: bool('压缩旧对话为摘要'),
    groupContext: int('附带最近群聊条数', { min: 0, max: 30 }),
    groupContextMaxChars: int('群聊每条最多字数', { min: 10 }),
    maxToolRounds: int('工具调用轮数上限', { min: 0, max: 100 }),
    maxOutputTokens: int('最大输出 token', { min: 64 }),
    temperature: num('温度', { min: 0, max: 2, nullable: true }),
    thinking: oneOf(THINKING_SETTING, '默认思考强度'),
    autoThinking: obj(
      { casual: oneOf(THINKING, '闲聊'), question: oneOf(THINKING, '普通提问'), complex: oneOf(THINKING, '复杂问题') },
      'auto 模式的思考强度',
    ),
    thinkingJudge: obj(
      {
        mode: oneOf(['heuristic', 'model', 'systemone'], '判断方式（heuristic=关键词 / model=小模型 / systemone=Jev 或 Kev）'),
        model: str('判断用的模型 id（空=utilityModel→默认模型）', { suggest: c => (c.models ?? []).map(m => m.id) }),
        url: str('System One 接口地址', { pattern: /^https?:\/\/\S+$/ }),
        apiKey: secret('System One API Key'),
        systemoneModel: str('System One 模型名'),
        timeoutMs: int('超时（毫秒，超时退回关键词规则）', { min: 200, max: 10000 }),
      },
      'auto 模式的消息判断',
    ),
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
    webSearch: obj(
      {
        enable: bool('联网搜索'),
        provider: oneOf(['native', 'anysearch', 'tavily', 'brave', 'searxng', 'jina', 'none'], '搜索服务'),
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
        reader: oneOf(['direct', 'jina'], '读取方式'),
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
        checkpointSteps: int('Claude 上下文检查点间隔', { min: 2, max: 30 }),
      },
      '持久电脑代理',
    ),
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
    embedding: obj(
      {
        enable: bool('旧聊天向量检索（需 API Key）'),
        type: oneOf(['voyage', 'openai'], '接口类型'),
        baseUrl: str('接口地址', { pattern: /^https?:\/\/\S+$/ }),
        apiKey: secret('API Key（env:变量名 读取环境变量）'),
        model: str('向量模型'),
        dimensions: int('向量维度', { min: 64, max: 4096 }),
        timeout: int('超时（秒）', { min: 1, max: 120 }),
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
  },
  '群设置',
)

export const SCHEMA = obj(
  {
    enable: bool('总开关'),
    admins: list('插件管理员 QQ'),
    providers: map(provider, '提供商', { keyLabel: '提供商名称（英文）', keyPattern: /^[\w-]+$/ }),
    models: arr(model, '模型', { itemLabel: m => `${m.id}  ${m.provider}/${m.model}`, create: ['provider', 'model', 'id'] }),
    defaultModel: oneOf(modelIds, '默认模型', { allowEmpty: true }),
    fallbackModels: multi(modelIds, '备用模型', { ordered: true }),
    utilityModel: oneOf(modelIds, '后台任务模型', { allowEmpty: true }),
    visionModel: oneOf(modelIds, '识图模型', { allowEmpty: true }),
    persona: obj(
      { botName: str('机器人名字（空=QQ昵称）'), active: oneOf(presetNames, '当前人设'), presets: map(text('人设内容'), '人设', { keyLabel: '人设名称' }) },
      '人设',
    ),
    groups: map(groupOverride, '分群设置', { keyLabel: '群号', keyPattern: /^\d{5,}$/ }),
    trigger: obj(
      {
        at: bool('@机器人触发'),
        replyToBot: bool('回复机器人消息触发'),
        alias: bool('Yunzai 别名前缀触发'),
        prefixes: list('额外触发前缀'),
        private: oneOf(['off', 'master', 'all'], '私聊'),
        emptyAtReply: bool('只@时回一句'),
        groupWhitelist: list('群白名单'),
        groupBlacklist: list('群黑名单'),
        userBlacklist: list('用户黑名单'),
        priority: int('插件优先级（保持最低）', { min: 0 }),
        userCooldown: num('同一用户触发间隔（秒）', { min: 0 }),
      },
      '触发方式',
    ),
    chat,
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

/** Schema node for a key path, or undefined if the path isn't a valid config key. */
export function schemaAt(keys) {
  let node = SCHEMA
  for (const k of keys) {
    if (!node) return undefined
    if (node.t === 'obj') node = node.fields[k]
    else if (node.t === 'map') node = node.value
    else if (node.t === 'arr') node = typeof k === 'number' || /^\d+$/.test(String(k)) ? node.item : undefined
    else if (node.t === 'pricing') node = PRICING_FIELDS.fields[k]
    else return undefined
  }
  return node
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
