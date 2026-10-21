#!/usr/bin/env node
/**
 * Config tool for plugins/Yunzai-LLM-Plugin/config/config.yaml, driven by cli/schema.mjs.
 *
 *   node cli/config.mjs              interactive: browse every valid key (set or not), typed inputs, search
 *   node cli/config.mjs list|get|describe|set|unset|check ...   scriptable (see --help)
 *
 * Only keys defined in the schema can be written; every value is validated. config.yaml keeps its comments and
 * only contains what you changed. The running bot hot-reloads the file. Env: YZ_LLM_CONFIG_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { MODEL_ID, modelSuggestions, PRICING_FIELDS, PROVIDER_TYPES, schemaAt, SCHEMA, suggestKeys, THINKING, validate, validatePath, valuesOf } from './schema.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.YZ_LLM_CONFIG_DIR || path.resolve(here, '..', 'config')
const DEFAULT_FILE = path.join(CONFIG_DIR, 'default_config.yaml')
const USER_FILE = path.join(CONFIG_DIR, 'config.yaml')

const PRESET_PROVIDERS = [
  ['Anthropic', 'anthropic', 'https://api.anthropic.com'],
  ['OpenAI', 'openai-responses', 'https://api.openai.com/v1'],
  ['Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com'],
  ['DeepSeek', 'openai', 'https://api.deepseek.com'],
  ['OpenRouter', 'openai', 'https://openrouter.ai/api/v1'],
  ['通义千问 (DashScope)', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['Moonshot / Kimi', 'openai', 'https://api.moonshot.cn/v1'],
  ['智谱 GLM', 'openai', 'https://open.bigmodel.cn/api/paas/v4'],
  ['SiliconFlow', 'openai', 'https://api.siliconflow.cn/v1'],
  ['Ollama (本地)', 'openai', 'http://127.0.0.1:11434/v1'],
]

const C = { dim: s => `\x1b[90m${s}\x1b[0m`, ok: s => `\x1b[32m${s}\x1b[0m`, warn: s => `\x1b[33m${s}\x1b[0m`, err: s => `\x1b[31m${s}\x1b[0m`, h: s => `\x1b[36m${s}\x1b[0m` }
const BACK = Symbol('back')
const RESET = Symbol('reset')
const CLEAR = Symbol('clear')

// ---------------- config model ----------------

const defaults = YAML.parse(fs.readFileSync(DEFAULT_FILE, 'utf8')) ?? {}
const original = fs.existsSync(USER_FILE) ? fs.readFileSync(USER_FILE, 'utf8') : '# Yunzai-LLM-Plugin 用户配置（只写要覆盖的项）\n'
const doc = YAML.parseDocument(original)
if (!doc.contents) doc.contents = doc.createNode({})
let dirty = false

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v
  return out
}
const eff = () => merge(defaults, doc.toJS() ?? {})
const get = (o, keys) => keys.reduce((x, k) => (x == null ? undefined : x[k]), o)
const read = keys => (keys.length ? get(eff(), keys) : eff())
const pathOf = keys => keys.join('.')

/** Dotted path -> keys using the schema (array indexes become numbers; map keys like group ids stay strings). */
function keysOf(p) {
  const out = []
  let node = SCHEMA
  for (const seg of p.split('.').filter(Boolean)) {
    out.push(node?.t === 'arr' && /^\d+$/.test(seg) ? Number(seg) : seg)
    node = schemaAt(out)
  }
  return out
}

function materialize(keys) {
  for (let i = 1; i < keys.length; i++) {
    if (typeof keys[i] !== 'number') continue
    const prefix = keys.slice(0, i)
    if (!doc.hasIn(prefix)) doc.setIn(prefix, doc.createNode(structuredClone(get(eff(), prefix) ?? [])))
  }
}

/** Write (validated) or delete (value === undefined); empty parent maps are removed. */
function set(keys, value) {
  const node = schemaAt(keys)
  if (!node) throw new Error(`未知配置项：${pathOf(keys)}`)
  const pathErr = validatePath(keys)
  if (pathErr) throw new Error(pathErr)
  if (value !== undefined) {
    const err = validate(node, value, eff(), get(eff(), keys.slice(0, -1)))
    if (err) throw new Error(`${pathOf(keys)}: ${err}`)
  }
  materialize(keys)
  if (value === undefined) {
    doc.deleteIn(keys)
    for (let i = keys.length - 1; i > 0; i--) {
      const parent = doc.getIn(keys.slice(0, i), true)
      if (YAML.isMap(parent) && parent.items.length === 0) doc.deleteIn(keys.slice(0, i))
      else break
    }
  } else doc.setIn(keys, isObj(value) || Array.isArray(value) ? doc.createNode(value) : value)
  dirty = true
}

const mask = s => (!s ? '未配置' : String(s).length <= 10 ? '****' : `${String(s).slice(0, 5)}****${String(s).slice(-4)}`)
const keyState = k => (Array.isArray(k) ? (k.length ? `${k.length} 个 Key` : '未配置') : k ? mask(k) : '未配置')
const parseKeys = raw => (raw.includes(',') ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw)
function hideSecrets(v, key = '') {
  if (typeof v === 'string' && /(apikey|key|token|secret|password)$/i.test(key)) return mask(v)
  if (Array.isArray(v)) return v.map(x => hideSecrets(x, key))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideSecrets(x, k)]))
  return v
}
const yamlOf = v => YAML.stringify(v ?? null, { lineWidth: 0 }).trimEnd()

/** [已修改] = set in config.yaml; [新增] = set in config.yaml and absent from the defaults. */
function mark(keys) {
  if (!keys.length || !doc.hasIn(keys)) return ''
  return get(defaults, keys) === undefined ? C.warn(' [新增]') : C.warn(' [已修改]')
}

function preview(node, v) {
  if (node?.t === 'secret') return keyState(v)
  if (v === undefined) return C.dim('(未设置)')
  if (v === null || v === '') return C.dim('(空)')
  if (typeof v === 'boolean') return v ? C.ok('开') : C.dim('关')
  if (Array.isArray(v)) {
    if (node?.t === 'arr') return `[${v.length} 项]`
    return v.length ? v.join(', ') : C.dim('(空列表)')
  }
  if (isObj(v)) return node?.t === 'map' ? `{${Object.keys(v).length} 项}` : node?.t === 'pricing' ? '手动' : '{…}'
  const s = String(v).replace(/\s+/g, ' ')
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

const isContainer = node => node && ['obj', 'map', 'arr'].includes(node.t)

// ---------------- descriptions from default_config.yaml comments ----------------

const DESC = new Map()
;(function collect(node, prefix, isTop) {
  const clean = c =>
    (c ?? '')
      .split('\n')
      .map(l => l.replace(/^\s*#?\s?/, '').trimEnd())
      .filter(l => l.trim() && !/^[-=]{5,}/.test(l.trim()))
      .join('\n')
  if (YAML.isMap(node))
    node.items.forEach((pair, i) => {
      const key = String(pair.key?.value ?? pair.key)
      const p = prefix ? `${prefix}.${key}` : key
      let before = pair.key?.commentBefore ?? ''
      if (isTop && i === 0) before = before.split(/^\s*=+\s*$/m).pop()
      const text = clean([i === 0 && !isTop ? node.commentBefore : null, before, YAML.isScalar(pair.value) ? pair.value.comment : null].filter(Boolean).join('\n'))
      if (text) DESC.set(p, text)
      collect(pair.value, p, false)
    })
  else if (YAML.isSeq(node)) node.items.forEach(item => collect(item, `${prefix}.*`, false))
})(YAML.parseDocument(fs.readFileSync(DEFAULT_FILE, 'utf8')).contents, '', true)

/** Longer help text for a key: the comment above it in default_config.yaml (dynamic keys use the template). */
function commentFor(keys) {
  const generic = keys.map(k => (typeof k === 'number' ? '*' : k))
  const tries = [generic.join('.')]
  if (keys[0] === 'providers' || keys[0] === 'groups') {
    // providers.<name>.x -> any provider's x ; groups.<id>.chat.x -> chat.x
    for (const [k, v] of DESC) if (new RegExp(`^${keys[0]}\\.[^.]+\\.${generic.slice(2).join('\\.')}$`).test(k)) return v
    if (keys[0] === 'groups' && keys.length > 2) tries.push(generic.slice(2).join('.'))
  }
  for (const t of tries) if (DESC.has(t)) return DESC.get(t)
  return ''
}

function describeNode(node, keys) {
  const out = []
  const cfg = eff()
  const ctx = get(cfg, keys.slice(0, -1))
  if (node.t === 'enum') out.push(`可选：${valuesOf(node, cfg, ctx).join(' / ') || '（暂无可选项）'}${node.allowEmpty ? ' / (空)' : ''}`)
  if (node.t === 'multi') out.push(`可多选：${valuesOf(node, cfg, ctx).join(' / ')}`)
  if (node.t === 'num') {
    const range = [node.min != null && `≥ ${node.min}`, node.max != null && `≤ ${node.max}`].filter(Boolean).join('，')
    out.push(`${node.int ? '整数' : '数字'}${range ? `（${range}）` : ''}${node.nullable ? '，可为空' : ''}`)
  }
  return out.join('\n')
}

// ---------------- prompts (@inquirer/prompts) ----------------

let prompts
async function initIO() {
  try {
    prompts = await import('@inquirer/prompts')
  } catch {
    console.error(C.err('缺少依赖 @inquirer/prompts，请在插件目录执行 pnpm install'))
    process.exit(1)
  }
}

async function guard(p) {
  try {
    return await p
  } catch (err) {
    if (err?.name === 'ExitPromptError' || err?.name === 'AbortPromptError') {
      console.log(C.warn(dirty ? '\n已退出，未保存的修改已丢弃' : '\n已退出'))
      process.exit(0)
    }
    throw err
  }
}

const lastPick = new Map()
/** Arrow-key list. choices: [{name, value, description?}]. Remembers the cursor per menu. */
async function select(message, choices, { back = true, defaultValue } = {}) {
  const list = [...choices]
  if (back) list.push({ name: C.dim('← 返回'), value: BACK })
  const key = message.replace(/\x1b\[[0-9;]*m/g, '')
  const remembered = lastPick.get(key)
  const def = defaultValue !== undefined ? defaultValue : list.some(c => c.value === remembered) ? remembered : undefined
  const v = await guard(prompts.select({ message, choices: list, pageSize: 18, loop: false, default: def }))
  lastPick.set(key, v)
  return v
}
const input = (message, o = {}) => guard(prompts.input({ message, ...o })).then(v => String(v ?? '').trim())
const confirm = (message, def = false) => guard(prompts.confirm({ message, default: def }))
const editor = (message, def = '', ext = '.txt') =>
  guard(prompts.editor({ message, default: def, postfix: ext, waitForUserInput: true })).then(v => String(v ?? '').replace(/\s+$/, ''))

/**
 * Ask for a value of the given schema type. `extra` adds radio entries (恢复默认 / 清空).
 * Returns the new value, BACK, RESET or CLEAR.
 */
async function promptFor(node, label, cur, { ctx, overridden = false, def } = {}) {
  const cfg = eff()
  const resetChoice = overridden ? [{ name: C.warn(`↺ 恢复默认（${def === undefined ? '无' : preview(node, def).replace(/\x1b\[[0-9;]*m/g, '')}）`), value: RESET }] : []
  switch (node.t) {
    case 'bool': {
      const v = await select(label, [{ name: '开', value: true }, { name: '关', value: false }, ...resetChoice], { defaultValue: cur ?? undefined })
      return v
    }
    case 'enum': {
      const vals = valuesOf(node, cfg, ctx)
      if (!vals.length && !node.allowEmpty) {
        console.log(C.warn('暂无可选项（例如先添加模型/提供商/人设）'))
        return BACK
      }
      const choices = vals.map(v => ({ name: v === cur ? `${v} ${C.dim('← 当前')}` : String(v), value: v }))
      if (node.allowEmpty) choices.push({ name: C.dim('(空：不设置)'), value: CLEAR })
      return select(label, [...choices, ...resetChoice], { defaultValue: vals.includes(cur) ? cur : undefined })
    }
    case 'multi': {
      const vals = valuesOf(node, cfg, ctx)
      const curArr = Array.isArray(cur) ? cur : []
      const picked = await guard(
        prompts.checkbox({
          message: `${label}（空格勾选，回车确认${node.ordered ? '；保持原有顺序，新勾选的排在后面' : ''}）`,
          choices: vals.map(v => ({ name: String(v), value: v, checked: curArr.includes(v) })),
          pageSize: 18,
          loop: false,
        }),
      )
      return node.ordered ? [...curArr.filter(x => picked.includes(x)), ...picked.filter(x => !curArr.includes(x))] : picked
    }
    case 'num': {
      if (node.nullable || overridden) {
        const a = await select(label, [
          { name: '输入数值', value: 'edit' },
          ...(node.nullable ? [{ name: C.dim('(空：不发送该参数)'), value: CLEAR }] : []),
          ...resetChoice,
        ])
        if (a !== 'edit') return a
      }
      const v = await guard(
        prompts.number({ message: label, default: typeof cur === 'number' ? cur : undefined, min: node.min, max: node.max, step: node.int ? 1 : 'any', required: false }),
      )
      return v === undefined ? BACK : v
    }
    case 'str': {
      const sugg = typeof node.suggest === 'function' ? node.suggest(cfg, ctx) : (node.suggest ?? [])
      if (sugg.length || overridden) {
        const a = await select(label, [
          ...sugg.map(s => ({ name: s === cur ? `${s} ${C.dim('← 当前')}` : s, value: s })),
          { name: sugg.length ? '自定义输入…' : '输入新值', value: 'edit' },
          ...resetChoice,
        ], { defaultValue: sugg.includes(cur) ? cur : undefined })
        if (a !== 'edit') return a
      }
      const v = await input(label, {
        default: cur ?? undefined,
        validate: x => (!x.trim() && node.required ? '必填' : node.pattern && x.trim() && !node.pattern.test(x.trim()) ? `格式不正确（${node.pattern}）` : true),
      })
      return v === '' && !node.required ? CLEAR : v
    }
    case 'text': {
      if (overridden) {
        const a = await select(label, [{ name: '编辑', value: 'edit' }, ...resetChoice])
        if (a !== 'edit') return a
      }
      const v = await editor(label, cur ?? '', '.md')
      return v === '' ? BACK : v
    }
    case 'secret': {
      const a = await select(`${label}（当前 ${keyState(cur)}）`, [{ name: '输入新 Key', value: 'edit' }, ...resetChoice])
      if (a !== 'edit') return a
      const v = await guard(prompts.password({ message: label, mask: '*' }))
      return v ? parseKeys(String(v).trim()) : BACK
    }
    case 'any': {
      if (overridden) {
        const a = await select(label, [{ name: '编辑 YAML', value: 'edit' }, ...resetChoice])
        if (a !== 'edit') return a
      }
      for (;;) {
        const t = await editor(`${label}（YAML）`, cur === undefined ? '' : `${yamlOf(cur)}\n`, '.yaml')
        if (!t.trim()) return BACK
        try {
          return YAML.parse(t)
        } catch (err) {
          console.log(C.err(`YAML 解析失败：${err.message}`))
          if (!(await confirm('重新编辑？', true))) return BACK
        }
      }
    }
  }
  throw new Error(`不支持的类型 ${node.t}`)
}

/** Edit one leaf in place: prompt -> validate -> write. */
async function editLeaf(keys) {
  const node = schemaAt(keys)
  const cur = read(keys)
  const label = `${pathOf(keys)}  ${C.dim(node.label ?? '')}`
  const help = [commentFor(keys), describeNode(node, keys)].filter(Boolean).join('\n')
  if (help) console.log(C.dim(help))
  try {
    if (node.t === 'list') return await editList(keys, node)
    if (node.t === 'pricing') return await editPricing(keys)
    const v = await promptFor(node, label, cur, { ctx: get(eff(), keys.slice(0, -1)), overridden: doc.hasIn(keys), def: get(defaults, keys) })
    if (v === BACK) return
    if (v === RESET) set(keys, undefined)
    else if (v === CLEAR) set(keys, node.t === 'num' ? null : '')
    else set(keys, v)
    console.log(C.ok(`✓ ${pathOf(keys)} = ${preview(node, read(keys)).replace(/\x1b\[[0-9;]*m/g, '')}`))
  } catch (err) {
    console.log(C.err(err.message))
  }
}

async function editList(keys, node) {
  for (;;) {
    const cur = read(keys) ?? []
    const a = await select(`${pathOf(keys)}：${cur.length ? cur.join(', ') : '(空列表)'}`, [
      { name: C.ok('+ 添加'), value: 'add' },
      ...(cur.length ? [{ name: '删除（勾选）', value: 'del' }] : []),
      ...(doc.hasIn(keys) ? [{ name: C.warn('↺ 恢复默认'), value: 'reset' }] : []),
    ])
    if (a === BACK) return
    if (a === 'add') {
      const v = await input(`添加到 ${node.label}`)
      if (v) set(keys, [...cur, ...v.split(/[,，]\s*/).filter(Boolean)])
    } else if (a === 'del') {
      const rm = await guard(prompts.checkbox({ message: '勾选要删除的项', choices: cur.map((x, i) => ({ name: String(x), value: i })) }))
      set(keys, cur.filter((_, i) => !rm.includes(i)))
    } else set(keys, undefined)
  }
}

async function editPricing(keys) {
  const cur = read(keys)
  const a = await select(`${pathOf(keys)}（当前：${cur === 'auto' || cur === undefined ? '自动' : '手动'}）`, [
    { name: '自动（LiteLLM / OpenRouter 价格表）', value: 'auto' },
    { name: '手动设置…', value: 'manual' },
    ...(doc.hasIn(keys) ? [{ name: C.warn('↺ 恢复默认'), value: 'reset' }] : []),
  ])
  if (a === BACK) return
  if (a === 'auto') return set(keys, 'auto')
  if (a === 'reset') return set(keys, undefined)
  const base = isObj(cur) ? { ...cur } : {}
  for (const [k, f] of Object.entries(PRICING_FIELDS.fields)) {
    const v = await guard(prompts.number({ message: f.label, default: base[k], min: 0, step: 'any', required: Boolean(f.required) }))
    if (v === undefined) delete base[k]
    else base[k] = v
  }
  set(keys, base)
  console.log(C.ok(`✓ ${pathOf(keys)} = ${JSON.stringify(base)}`))
}

// ---------------- creating map entries / array items ----------------

async function addMapEntry(keys, node) {
  const existing = Object.keys(read(keys) ?? {})
  if (keys.length === 1 && keys[0] === 'providers') return addProvider()
  const k = await input(node.keyLabel ?? '键名', {
    validate: x => (!x.trim() ? '必填' : node.keyPattern && !node.keyPattern.test(x.trim()) ? '格式不正确' : existing.includes(x.trim()) ? '已存在' : x.includes('.') ? '不能包含 .' : true),
  })
  const childKeys = [...keys, k]
  if (node.value.t === 'obj') {
    doc.setIn(childKeys, doc.createNode({}))
    dirty = true
    await browse(childKeys)
    // nothing set inside: don't leave an empty entry behind
    const n = doc.getIn(childKeys, true)
    if (YAML.isMap(n) && !n.items.length) set(childKeys, undefined)
  } else {
    const v = await promptFor(node.value, `${pathOf(childKeys)}`, undefined, {})
    if (v !== BACK && v !== CLEAR && v !== RESET) set(childKeys, v)
  }
}

async function addProvider() {
  const existing = Object.keys(read(['providers']) ?? {})
  const pick = await select('选择提供商', [...PRESET_PROVIDERS.map(([n, t, u]) => ({ name: `${n} ${C.dim(`${t}  ${u}`)}`, value: [n, t, u] })), { name: '自定义…', value: 'custom' }])
  if (pick === BACK) return
  let type, baseUrl, suggestion
  if (pick === 'custom') {
    type = await select('接口类型', PROVIDER_TYPES.map(t => ({ name: t, value: t })), { back: false })
    baseUrl = await input('接口地址', { validate: x => (/^https?:\/\/\S+$/.test(x.trim()) ? true : '请输入 http(s) 地址') })
  } else [suggestion, type, baseUrl] = pick
  const defName = (suggestion ?? 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'custom'
  const name = await input('名称（英文，用于模型配置）', {
    default: existing.includes(defName) ? undefined : defName,
    validate: x => (!/^[\w-]+$/.test(x.trim()) ? '只能包含字母数字下划线横线' : existing.includes(x.trim()) ? '已存在' : true),
  })
  const key = await guard(prompts.password({ message: 'API Key（可留空稍后设置）', mask: '*' }))
  const p = { type, baseUrl }
  if (key) p.apiKey = parseKeys(String(key).trim())
  if (/deepseek\.com/.test(baseUrl)) p.balance = 'deepseek'
  set(['providers', name], p)
  console.log(C.ok(`✓ 已添加提供商 ${name}`))
  if (modelSuggestions(p).length && (await confirm('现在为它添加一个模型？', true))) await addModel(name)
}

async function addModel(providerName) {
  const cfg = eff()
  const providers = Object.keys(cfg.providers ?? {})
  if (!providers.length) return console.log(C.err('请先添加提供商'))
  const provider = providerName ?? (await select('使用哪个提供商', providers.map(p => ({ name: `${p} ${C.dim(cfg.providers[p].type)}`, value: p }))))
  if (provider === BACK) return
  const sugg = modelSuggestions(cfg.providers[provider])
  let model = sugg.length ? await select('上游模型', [...sugg.map(s => ({ name: s, value: s })), { name: '自定义输入…', value: 'custom' }]) : 'custom'
  if (model === BACK) return
  if (model === 'custom') model = await input('上游模型名（官方 API 的模型 ID）', { validate: x => (x.trim() ? true : '必填') })
  const ids = (cfg.models ?? []).map(m => m.id)
  const defId = model.replace(/^.*\//, '').replace(/[^\w.-]+/g, '-')
  const id = await input('别名 id（在指令里使用）', {
    default: ids.includes(defId) ? undefined : defId,
    validate: x => (!MODEL_ID.test(x.trim()) ? '只能包含中英文、数字和 . _ -（不能有空格）' : ids.includes(x.trim()) ? '已存在' : true),
  })
  const thinking = await select('思考强度', THINKING.map(t => ({ name: t, value: t })), { back: false, defaultValue: 'low' })
  const vision = await confirm('支持图片输入？', !/deepseek/.test(model))
  const entry = { id, provider, model, thinking, pricing: 'auto', ...(vision ? {} : { vision: false }) }
  set(['models'], [...(cfg.models ?? []), entry])
  console.log(C.ok(`✓ 已添加模型 ${id}`))
  if (await confirm('设为默认模型？', !cfg.defaultModel)) set(['defaultModel'], id)
}

async function addArrayItem(keys, node) {
  if (pathOf(keys) === 'models') return addModel()
  const item = {}
  for (const f of node.create ?? []) {
    const v = await promptFor(node.item.fields[f], node.item.fields[f].label, undefined, { ctx: item })
    if (v === BACK) return
    if (v !== CLEAR) item[f] = v
  }
  set(keys, [...(read(keys) ?? []), item])
  console.log(C.ok('✓ 已添加'))
}

// ---------------- tree browser ----------------

async function browse(keys = []) {
  for (;;) {
    const node = keys.length ? schemaAt(keys) : SCHEMA
    const val = read(keys)
    if (!isContainer(node)) return editLeaf(keys)
    const choices = []
    let entries = []
    if (node.t === 'obj') {
      const ctx = val ?? {}
      entries = Object.entries(node.fields).filter(([, f]) => !f.when || f.when(ctx))
      for (const [k, f] of entries) {
        const v = val?.[k]
        choices.push({
          name: `${f.label.padEnd(14)} ${preview(f, v)}${isContainer(f) || f.t === 'pricing' ? C.h(' ›') : ''}${mark([...keys, k])}  ${C.dim(k)}`,
          value: { go: k },
          description: commentFor([...keys, k]).split('\n')[0] || undefined,
        })
      }
      const bools = entries.filter(([, f]) => f.t === 'bool')
      if (bools.length >= 2) choices.push({ name: C.h('☑ 批量开关'), value: { batch: bools } })
    } else if (node.t === 'map') {
      for (const k of Object.keys(val ?? {})) choices.push({ name: `${k}${mark([...keys, k])}`, value: { go: k } })
      choices.push({ name: C.ok(`+ 新增${node.keyLabel ?? ''}`), value: { add: true } })
    } else {
      ;(val ?? []).forEach((item, i) => choices.push({ name: `${node.itemLabel?.(item) ?? `#${i}`}${mark([...keys, i])}`, value: { go: i } }))
      choices.push({ name: C.ok('+ 新增一项'), value: { add: true } })
    }
    const parent = keys.length ? schemaAt(keys.slice(0, -1)) : undefined
    if (parent?.t === 'map' || parent?.t === 'arr') choices.push({ name: C.err('✕ 删除此项'), value: { remove: true } })
    else if (keys.length && doc.hasIn(keys)) choices.push({ name: C.warn('↺ 整节恢复默认'), value: { reset: true } })

    const title = keys.length ? `${pathOf(keys)}${mark(keys)}  ${C.dim(node.label ?? '')}` : '全部配置'
    const pick = await select(title, choices)
    if (pick === BACK) return
    try {
      if ('go' in pick) await browse([...keys, pick.go])
      else if (pick.add) node.t === 'map' ? await addMapEntry(keys, node) : await addArrayItem(keys, node)
      else if (pick.batch) {
        const on = await guard(
          prompts.checkbox({
            message: '勾选 = 开（空格切换，回车确认）',
            choices: pick.batch.map(([k, f]) => ({ name: `${f.label} ${C.dim(k)}`, value: k, checked: Boolean(val?.[k]) })),
            loop: false,
          }),
        )
        for (const [k] of pick.batch) if (Boolean(val?.[k]) !== on.includes(k)) set([...keys, k], on.includes(k))
        console.log(C.ok('✓ 已更新开关'))
      } else if (pick.remove) {
        if (await confirm(`删除 ${pathOf(keys)}？`)) {
          if (parent.t === 'arr') {
            const listKeys = keys.slice(0, -1)
            set(listKeys, (read(listKeys) ?? []).filter((_, i) => i !== keys.at(-1)))
          } else set(keys, undefined)
          return
        }
      } else if (pick.reset && (await confirm(`把 ${pathOf(keys)} 整节恢复为默认？`))) set(keys, undefined)
    } catch (err) {
      console.log(C.err(err.message))
    }
  }
}

// ---------------- search ----------------

function walkPaths(node, keys, val, out) {
  if (keys.length) out.push(keys)
  if (node.t === 'obj') for (const [k, f] of Object.entries(node.fields)) walkPaths(f, [...keys, k], val?.[k], out)
  else if (node.t === 'map') for (const k of Object.keys(val ?? {})) walkPaths(node.value, [...keys, k], val[k], out)
  else if (node.t === 'arr') (val ?? []).forEach((x, i) => walkPaths(node.item, [...keys, i], x, out))
  return out
}

async function search() {
  const all = walkPaths(SCHEMA, [], eff(), [])
  const keys = await guard(
    prompts.search({
      message: '搜索配置项（键名、中文名或说明；↑↓ 选择，回车打开）',
      pageSize: 15,
      source: async term => {
        const q = (term ?? '').toLowerCase().trim()
        const cfg = eff()
        return all
          .map(k => [k, schemaAt(k)])
          .filter(([k, n]) => !q || pathOf(k).toLowerCase().includes(q) || (n.label ?? '').toLowerCase().includes(q) || commentFor(k).toLowerCase().includes(q))
          .slice(0, 60)
          .map(([k, n]) => ({ name: `${pathOf(k).padEnd(34)} ${n.label ?? ''}  ${preview(n, get(cfg, k))}${mark(k)}`, value: k, description: commentFor(k).split('\n')[0] || undefined }))
      },
    }),
  )
  if (keys) await browse(keys)
}

// ---------------- checks / save ----------------

function check() {
  const c = eff()
  const problems = []
  const userErr = validate(SCHEMA, doc.toJS() ?? {}, c, undefined)
  if (userErr) problems.push(`config.yaml 中有无效配置：${userErr}`)
  const providers = c.providers ?? {}
  const models = c.models ?? []
  const hasKey = p => (Array.isArray(p?.apiKey) ? p.apiKey.length > 0 : Boolean(p?.apiKey))
  for (const m of models) if (!providers[m.provider]) problems.push(`模型 ${m.id} 的提供商 ${m.provider} 不存在`)
  for (const id of [...new Set([c.defaultModel, ...(c.fallbackModels ?? [])].filter(Boolean))]) {
    const m = models.find(x => x.id === id)
    if (!m) problems.push(`模型 ${id}（默认/备用）不存在`)
    else if (providers[m.provider] && !hasKey(providers[m.provider])) problems.push(`模型 ${id}（默认/备用）的提供商 ${m.provider} 未配置 Key，将被跳过`)
  }
  if (!models.some(m => hasKey(providers[m.provider]))) problems.push('没有任何可用模型（至少给一个提供商设置 Key）')
  return problems
}

function save() {
  if (fs.existsSync(USER_FILE)) fs.copyFileSync(USER_FILE, `${USER_FILE}.bak`)
  fs.writeFileSync(USER_FILE, doc.toString({ lineWidth: 0 }), 'utf8')
  dirty = false
  console.log(C.ok(`✓ 已保存 ${USER_FILE}`))
  console.log(C.dim('运行中的机器人会自动热重载配置'))
}

// ---------------- subcommands ----------------

const USAGE = `用法：
  node cli/config.mjs                       交互式配置（浏览全部可用配置项、搜索、添加提供商/模型）
  node cli/config.mjs list [路径]           列出某一层的全部可用配置项（含未设置的）
  node cli/config.mjs get <路径>            输出生效值
  node cli/config.mjs describe <路径>       说明、类型、可选值、默认值、当前值
  node cli/config.mjs set <路径> <值>       修改并保存（按类型校验；列表用逗号分隔，对象用 YAML）
  node cli/config.mjs unset <路径>          删除覆盖项（恢复默认）并保存
  node cli/config.mjs check                 检查配置（有问题时退出码 2）
路径示例：chat.groupContext  models.0.thinking  providers.deepseek.apiKey  groups.123456.enable
加 --show-secrets 显示完整密钥`

function requireKeys(p) {
  const keys = keysOf(p)
  const node = keys.length ? schemaAt(keys) : SCHEMA
  if (!node) {
    const bad = keys.findIndex((_, i) => !schemaAt(keys.slice(0, i + 1)))
    const sug = suggestKeys(keys.slice(0, bad + 1))
    throw new Error(`未知配置项：${p}${sug.length ? `（你是不是想找：${sug.map(s => [...keys.slice(0, bad), s].join('.')).join(' / ')}）` : ''}`)
  }
  return { keys, node }
}

function parseCli(node, raw, keys) {
  const t = raw.trim()
  switch (node.t) {
    case 'bool':
      if (/^(true|yes|y|on|1|开|是)$/i.test(t)) return true
      if (/^(false|no|n|off|0|关|否)$/i.test(t)) return false
      throw new Error('应为 true / false')
    case 'num':
      if (t === '' || t === 'null') return null
      if (!Number.isFinite(Number(t))) throw new Error('应为数字')
      return Number(t)
    case 'enum':
      // enums may mix booleans with strings (reply.markdown: false / true / auto)
      if ((t === 'true' || t === 'false') && valuesOf(node, eff(), undefined).includes(t === 'true')) return t === 'true'
      return t
    case 'str':
    case 'text':
      return t
    case 'secret':
      return parseKeys(t)
    case 'multi':
    case 'list':
      return t ? t.split(/[,，]\s*/).filter(Boolean) : []
    case 'pricing':
      return t === 'auto' ? 'auto' : YAML.parse(t)
    default:
      return YAML.parse(t)
  }
}

function printDescribe(keys, node) {
  const cur = read(keys)
  console.log(`${C.h(pathOf(keys) || '全部配置')}${mark(keys)}  ${node.label ?? ''}  ${C.dim(`[${node.t}]`)}`)
  const help = [commentFor(keys), describeNode(node, keys)].filter(Boolean).join('\n')
  if (help) console.log(C.dim(help))
  if (!isContainer(node)) {
    console.log(`当前值：${node.t === 'secret' ? keyState(cur) : cur === undefined ? '(未设置)' : typeof cur === 'object' && cur !== null ? JSON.stringify(cur) : String(cur)}`)
    const def = get(defaults, keys)
    if (node.t !== 'secret') console.log(`默认值：${def === undefined ? '(无)' : typeof def === 'object' && def !== null ? JSON.stringify(def) : String(def)}`)
  }
}

function runSubcommand(argv) {
  const showSecrets = argv.includes('--show-secrets')
  const [cmd, p = '', ...rest] = argv.filter(a => a !== '--show-secrets')
  switch (cmd) {
    case 'list': {
      const { keys, node } = requireKeys(p)
      if (!isContainer(node)) return printDescribe(keys, node)
      const val = read(keys)
      const rows =
        node.t === 'obj'
          ? Object.entries(node.fields)
              .filter(([, f]) => !f.when || f.when(val ?? {}))
              .map(([k, f]) => [k, f])
          : node.t === 'map'
            ? Object.keys(val ?? {}).map(k => [k, node.value])
            : (val ?? []).map((_, i) => [i, node.item])
      for (const [k, f] of rows) {
        const ck = [...keys, k]
        const v = val?.[k]
        const shown = showSecrets && f.t === 'secret' ? JSON.stringify(v ?? null) : preview(f, v)
        console.log(`${pathOf(ck).padEnd(36)} ${shown}${mark(ck)}  ${C.dim(f.label ?? '')}`)
      }
      return
    }
    case 'get': {
      const { keys, node } = requireKeys(p)
      const v = read(keys)
      if (node.t === 'secret' && !showSecrets) return console.log(keyState(v))
      if (v === undefined) return console.log('(未设置)')
      return console.log(v !== null && typeof v === 'object' ? yamlOf(showSecrets ? v : hideSecrets(v, String(keys.at(-1) ?? ''))) : String(v))
    }
    case 'describe': {
      const { keys, node } = requireKeys(p)
      return printDescribe(keys, node)
    }
    case 'set': {
      if (!p || !rest.length) throw new Error(USAGE)
      const { keys, node } = requireKeys(p)
      set(keys, parseCli(node, rest.join(' '), keys))
      save()
      return console.log(`${p} = ${node.t === 'secret' ? keyState(read(keys)) : JSON.stringify(read(keys))}`)
    }
    case 'unset': {
      const { keys } = requireKeys(p)
      if (!doc.hasIn(keys)) return console.log('该项没有被覆盖，已是默认值')
      set(keys, undefined)
      save()
      return console.log(`${p} 已恢复默认`)
    }
    case 'check': {
      const pr = check()
      console.log(pr.length ? pr.map(x => C.warn(`⚠ ${x}`)).join('\n') : C.ok('✓ 配置看起来没问题'))
      return process.exit(pr.length ? 2 : 0)
    }
    default:
      console.log(USAGE)
      return process.exit(cmd && !['help', '-h', '--help'].includes(cmd) ? 1 : 0)
  }
}

// ---------------- main ----------------

if (process.argv.length > 2) {
  try {
    runSubcommand(process.argv.slice(2))
  } catch (err) {
    console.error(C.err(err.message))
    process.exit(1)
  }
  process.exit(0)
}

await initIO()
console.log(C.h('Yunzai-LLM-Plugin 配置工具'))
console.log(C.dim(`配置文件：${USER_FILE}`))
console.log(C.dim('[已修改] = config.yaml 覆盖了默认值；(未设置) = 可以配置但目前没有值。修改在「保存」后才写入。'))
for (;;) {
  const pick = await select(
    `主菜单${dirty ? C.warn(' （有未保存的修改）') : ''}`,
    [
      { name: '浏览 / 编辑配置', value: 'browse' },
      { name: '搜索配置项', value: 'search' },
      { name: '添加提供商', value: 'provider' },
      { name: '添加模型', value: 'model' },
      { name: '检查配置', value: 'check' },
      { name: '查看将写入 config.yaml 的内容', value: 'show' },
      { name: '保存（继续编辑）', value: 'save' },
      { name: C.ok('保存并退出'), value: 'saveExit' },
      { name: '不保存退出', value: 'quit' },
    ],
    { back: false },
  )
  if (pick === 'browse') await browse()
  else if (pick === 'search') await search()
  else if (pick === 'provider') await addProvider()
  else if (pick === 'model') await addModel()
  else if (pick === 'check') {
    const p = check()
    console.log(p.length ? p.map(x => C.warn(`⚠ ${x}`)).join('\n') : C.ok('✓ 配置看起来没问题'))
  } else if (pick === 'show') console.log(`\n${yamlOf(hideSecrets(doc.toJS() ?? {}))}`)
  else if (pick === 'save') dirty ? save() : console.log('没有修改')
  else if (pick === 'saveExit') {
    const p = check()
    if (p.length) console.log(p.map(x => C.warn(`⚠ ${x}`)).join('\n'))
    if (dirty) save()
    else console.log('没有修改')
    break
  } else if (pick === 'quit') {
    if (!dirty || (await confirm('放弃所有修改？'))) break
  }
}
process.exit(0)
