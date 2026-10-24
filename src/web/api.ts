import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
// shared with the terminal config editor, so both validate writes the same way
import { configProblems, modelSuggestions, PRESET_PROVIDERS, PRICING_FIELDS, SCHEMA, schemaAt, THINKING, validate, validatePath, valuesOf } from '../../cli/schema.mjs'
import { queryBalance } from '../billing/balance.ts'
import { queryUsageCalls } from '../billing/history.ts'
import { daily, incompleteUsageModels, limitsFor, resetStats, resetUsage, summarize, topUsers, totals, WINDOW_5H, WINDOW_WEEK } from '../billing/ledger.ts'
import { priceCacheInfo, refreshPrices, resolvePrice } from '../billing/pricing.ts'
import { catalogEntries, catalogInfo, scanCatalog } from '../commands/catalog.ts'
import { config, normalize, personaText, resolveKeys } from '../core/config.ts'
import { recentLogs } from '../core/log.ts'
import { CONFIG_DIR, DATA_DIR, DEFAULT_CONFIG_FILE } from '../core/paths.ts'
import { deepMerge, detectImageMime, formatDuration, isPlainObject, maskSecret, truncate } from '../core/util.ts'
import { allVectors, archiveInfo, clearSession, dayInfo, deleteArchiveEntry, listSessions, peekSession } from '../chat/session.ts'
import { recentTurns } from '../chat/turnLog.ts'
import { readRolloutImage, recentRollouts, rolloutHistory } from '../chat/rollouts.ts'
import { configuredName, recentMessages, rosterSnapshot } from '../chat/roster.ts'
import { utilityChat } from '../chat/utility.ts'
import { partsToText } from '../llm/types.ts'
import { clusterVectors, maxK, type Clustering } from '../memory/cluster.ts'
import { dot, embed, embeddingReady, embeddingTag } from '../memory/embed.ts'
import { addMemory, clearMemory, deleteMemory, listMemory, memoryOwners, memoryStats, updateMemory, usage as memUsage, type MemScope } from '../memory/store.ts'
import { indexSticker, stickerIncomplete } from '../stickers/indexer.ts'
import { addImageSticker, listStickers, removeSticker, stickerFile, updateSticker, type Sticker } from '../stickers/store.ts'
import { computerQueue } from '../tools/computer.ts'
import { agyQueue, cancelAgyJob } from '../tools/agy.ts'
import { agyHistory, agyJobView } from '../agy/history.ts'
import { computerHistory, readComputerScreenshot } from '../computer/history.ts'
import { registry } from '../tools/registry.ts'
import { deleteSkill, listSkills, parseSkillMarkdown, saveSkill, skillsForTools } from '../tools/skills.ts'
import { prepareRuntimeTools, runtimeToolReady, setupStatus } from '../core/setup.ts'

export type Reply = any
interface Req { params: string[]; query: URLSearchParams; body: any }
interface Route { method: string; pattern: RegExp; run: (r: Req) => Promise<Reply> | Reply; maxBody?: number }

const startedAt = Date.now()
/** Written the first time the setup wizard loads; until then the UI opens on the wizard. */
const SETUP_SEEN_FILE = path.join(DATA_DIR, 'web-setup-seen.json')
const MAX_STICKER_BYTES = 10 * 1024 * 1024

/** Sticker as the UI sees it: no mface payload, plus whether a preview file exists. */
function stickerView({ mface, ...s }: Sticker) {
  const f = stickerFile(s as Sticker)
  return { ...s, hasImage: Boolean(f && fs.existsSync(f)), incomplete: s.indexed && stickerIncomplete(s as Sticker) }
}
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status })

// ---------- bot / names ----------

function bots(): { uin: string; nickname: string; adapter?: string; groups: number; friends: number }[] {
  const B: any = globalThis.Bot
  if (!B) return []
  const uins: any[] = Array.isArray(B.uin) ? B.uin : B.uin != null ? [B.uin] : []
  return uins.map(uin => {
    const b = B[uin] ?? B
    return { uin: String(uin), nickname: String(b?.nickname ?? ''), adapter: b?.adapter?.name ?? b?.version?.name, groups: b?.gl?.size ?? 0, friends: b?.fl?.size ?? 0 }
  })
}

/** Display name for a user or group id from any connected bot's caches. */
function nameOf(scope: 'user' | 'group', id: string): string | undefined {
  if (scope === 'user' && configuredName(id)) return configuredName(id)
  const B: any = globalThis.Bot
  if (!B) return undefined
  const uins: any[] = Array.isArray(B.uin) ? B.uin : [B.uin]
  for (const uin of uins) {
    const b = B[uin] ?? B
    const hit = scope === 'group' ? (b?.gl?.get?.(Number(id)) ?? b?.gl?.get?.(id)) : (b?.fl?.get?.(Number(id)) ?? b?.fl?.get?.(id))
    const name = scope === 'group' ? hit?.group_name : (hit?.remark || hit?.nickname)
    if (name) return String(name)
  }
  return undefined
}

function groupList(): { id: string; name: string }[] {
  const B: any = globalThis.Bot
  const out = new Map<string, string>()
  for (const uin of Array.isArray(B?.uin) ? B.uin : B?.uin != null ? [B.uin] : []) {
    const gl = (B[uin] ?? B)?.gl
    if (gl?.forEach) gl.forEach((g: any, id: any) => out.set(String(id), String(g?.group_name ?? id)))
  }
  return [...out].map(([id, name]) => ({ id, name }))
}

/** "self:g123" / "self:g123:u456" / "self:p456" -> readable label. */
function sessionLabel(key: string): { kind: 'group' | 'member' | 'private'; label: string } {
  const [, a, b] = key.split(':')
  if (a?.startsWith('g')) {
    const g = a.slice(1)
    const gName = nameOf('group', g) ?? `群 ${g}`
    if (b?.startsWith('u')) return { kind: 'member', label: `${gName} · ${nameOf('user', b.slice(1)) ?? b.slice(1)}` }
    return { kind: 'group', label: gName }
  }
  const u = a?.slice(1) ?? key
  return { kind: 'private', label: `私聊 ${nameOf('user', u) ?? u}` }
}

// ---------- config ----------

const CONFIG_FILE_DIR = path.resolve(CONFIG_DIR)

/** Schema as JSON: value lists resolved against the current config, regexes as source strings. */
function serializeSchema(node: any, cfg: any): any {
  if (!node) return node
  const out: any = { t: node.t, label: node.label }
  for (const k of ['min', 'max', 'int', 'nullable', 'allowEmpty', 'ordered', 'keyLabel', 'required', 'create']) if (node[k] !== undefined) out[k] = node[k]
  if (node.pattern) out.pattern = node.pattern.source
  if (node.keyPattern) out.keyPattern = node.keyPattern.source
  if (node.values) out.values = valuesOf(node, cfg, undefined)
  if (node.suggest) {
    if (typeof node.suggest !== 'function') out.suggest = node.suggest
    // per-item suggestions (upstream model names) depend on the item's provider: precompute for each one
    else if (node.suggest.length >= 2) out.suggestByProvider = Object.fromEntries(Object.keys(cfg.providers ?? {}).map(p => [p, node.suggest(cfg, { provider: p })]))
    else out.suggest = node.suggest(cfg)
  }
  // `when` gates provider fields by the provider's type: send the list of types it applies to
  if (typeof node.when === 'function') out.whenTypes = ['openai', 'openai-responses', 'anthropic', 'gemini'].filter(type => node.when({ type }))
  if (node.t === 'obj') out.fields = Object.fromEntries(Object.entries(node.fields).map(([k, v]) => [k, serializeSchema(v, cfg)]))
  if (node.t === 'map') out.value = serializeSchema(node.value, cfg)
  if (node.t === 'arr') out.item = serializeSchema(node.item, cfg)
  if (node.t === 'pricing') out.fields = serializeSchema(PRICING_FIELDS, cfg).fields
  return out
}

/** Help text per key from the comments in default_config.yaml (same source as the terminal editor). */
function configDescriptions(): Record<string, string> {
  const out: Record<string, string> = {}
  const clean = (c: string) => c.split('\n').map(l => l.replace(/^\s*#?\s?/, '').trimEnd()).filter(l => l.trim() && !/^[-=]{5,}/.test(l.trim())).join('\n')
  const walk = (node: any, prefix: string, isTop: boolean) => {
    if (YAML.isMap(node))
      node.items.forEach((pair: any, i: number) => {
        const key = String(pair.key?.value ?? pair.key)
        const p = prefix ? `${prefix}.${key}` : key
        let before = pair.key?.commentBefore ?? ''
        if (isTop && i === 0) before = before.split(/^\s*=+\s*$/m).pop()
        const text = clean([i === 0 && !isTop ? node.commentBefore : null, before, YAML.isScalar(pair.value) ? (pair.value as any).comment : null].filter(Boolean).join('\n'))
        if (text) out[p] = text
        walk(pair.value, p, false)
      })
    else if (YAML.isSeq(node)) node.items.forEach((item: any) => walk(item, `${prefix}.*`, false))
  }
  walk(YAML.parseDocument(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')).contents, '', true)
  return out
}

/** Effective config with every secret replaced by its masked form, guided by the schema. */
function maskSecrets(node: any, v: any): any {
  if (v == null || !node) return v
  if (node.t === 'secret') {
    const keys = Array.isArray(v) ? v : [v]
    return { __secret: true, set: resolveKeys(v).length > 0, shown: keys.map((k: string) => (String(k).startsWith('env:') ? k : maskSecret(k))).join(', ') }
  }
  if (node.t === 'obj' && isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskSecrets(node.fields[k], x)]))
  if (node.t === 'map' && isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskSecrets(node.value, x)]))
  if (node.t === 'arr' && Array.isArray(v)) return v.map(x => maskSecrets(node.item, x))
  return v
}

/** Dotted paths present in config.yaml (leaves and containers), so the UI can mark overridden keys. */
function overriddenPaths(): string[] {
  const out: string[] = []
  const walk = (v: any, p: string) => {
    if (p) out.push(p)
    if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k)
  }
  walk(YAML.parse(config.readRaw()) ?? {}, '')
  return out
}

function keysOf(p: string): (string | number)[] {
  const out: (string | number)[] = []
  for (const seg of p.split('.').filter(Boolean)) {
    const parent = schemaAt(out)
    out.push(parent?.t === 'arr' && /^\d+$/.test(seg) ? Number(seg) : seg)
  }
  return out
}

function setConfig(p: string, value: any) {
  const keys = keysOf(p)
  if (!keys.length) throw fail('缺少配置路径')
  const node = schemaAt(keys)
  if (!node) throw fail(`未知配置项：${p}`)
  const pathErr = validatePath(keys)
  if (pathErr) throw fail(pathErr)
  const cfg = config.get()
  const parent = keys.slice(0, -1).reduce((x: any, k) => x?.[k], cfg)
  const err = validate(node, value, cfg, parent)
  if (err) throw fail(`${p}: ${err}`)
  config.set(p, value)
}

// ---------- vectors ----------

/** Seeded PRNG so the projection axes are stable between refreshes. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5
}

/** Top-3 principal components by power iteration with deflation (N ≤ a few thousand, D ≤ 2048). */
function pca3(rows: Float32Array[]) {
  const n = rows.length
  const d = rows[0].length
  const mean = new Float64Array(d)
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n
  const X = rows.map(r => Float64Array.from(r, (x, j) => x - mean[j]))
  let total = 0
  for (const r of X) for (const x of r) total += x * x
  const comps: Float64Array[] = []
  const variance: number[] = []
  const rand = rng(42)
  for (let c = 0; c < Math.min(3, n); c++) {
    let v = Float64Array.from({ length: d }, rand)
    let lambda = 0
    for (let it = 0; it < 60; it++) {
      const xv = X.map(r => r.reduce((s, x, j) => s + x * v[j], 0))
      const w = new Float64Array(d)
      X.forEach((r, i) => { for (let j = 0; j < d; j++) w[j] += r[j] * xv[i] })
      for (const p of comps) {
        const k = w.reduce((s, x, j) => s + x * p[j], 0)
        for (let j = 0; j < d; j++) w[j] -= k * p[j]
      }
      const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1
      lambda = norm
      v = w.map(x => x / norm)
    }
    comps.push(v)
    variance.push(total ? lambda / total : 0)
  }
  while (comps.length < 3) comps.push(new Float64Array(d))
  const project = (r: ArrayLike<number>) => comps.map(p => { let s = 0; for (let j = 0; j < d; j++) s += (r[j] - mean[j]) * p[j]; return s })
  return { project, variance }
}

// k selection fits k-means once per candidate k: reuse the result until the archive or the request changes
let clusterCache: { sig: string; result: Clustering } | undefined

function clustersFor(points: ReturnType<typeof allVectors>, k: number | undefined): Clustering {
  const sig = [embeddingTag(), k ?? 'auto', points.length, ...points.map(p => p.id)].join('|')
  if (clusterCache?.sig !== sig) clusterCache = { sig, result: clusterVectors(points.map(p => p.vec), points.map(p => p.text), k) }
  return clusterCache.result
}

async function vectorSpace(q: URLSearchParams) {
  const key = q.get('key') || undefined
  const text = (q.get('q') ?? '').trim()
  const kArg = Number(q.get('k')) || undefined
  const points = allVectors(key)
  const base = { ready: embeddingReady(), tag: embeddingTag(), sessions: listSessions().filter(s => s.vectors).map(s => ({ key: s.key, ...sessionLabel(s.key), vectors: s.vectors })) }
  if (points.length < 2) return { ...base, points: [], variance: [] }
  const { project, variance } = pca3(points.map(p => p.vec))
  const coords = points.map(p => project(p.vec))
  const scale = Math.max(1e-9, ...coords.flat().map(Math.abs))
  const cl = clustersFor(points, kArg && Math.min(kArg, maxK(points.length)))
  const clusters = {
    k: cl.k,
    auto: cl.auto,
    maxK: maxK(points.length),
    scores: cl.scores,
    list: cl.clusters.map(c => {
      const members = cl.assign.map((a, i) => [a, i]).filter(([a]) => a === c.id).map(([, i]) => coords[i])
      return { ...c, xyz: [0, 1, 2].map(j => members.reduce((s, m) => s + m[j], 0) / members.length / scale) }
    }),
  }
  let query: any
  if (text) {
    if (!embeddingReady()) throw fail('没有配置向量模型的 API Key')
    const [qv] = await embed([text], 'query')
    const sims = points.map(p => dot(qv, p.vec))
    const nearest = sims.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, config.get().memory.recallLimit).map(([score, i]) => ({ index: i, score }))
    query = { text, xyz: project(qv).map(x => x / scale), nearest, minScore: config.get().memory.embedding.minScore }
  }
  return {
    ...base,
    variance,
    points: points.map((p, i) => ({ key: p.key, id: p.id, at: p.at, day: p.day, kind: p.kind, text: p.text, cluster: cl.assign[i], xyz: coords[i].map(x => x / scale) })),
    clusters,
    query,
  }
}

// ---------- routes ----------

const R = (method: string, pattern: string, run: Route['run'], maxBody?: number): Route => ({
  method,
  maxBody,
  pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, '([^/]+)')}$`),
  run,
})

export const routes: Route[] = [
  R('GET', '/api/overview', () => {
    const c = config.get()
    const def = config.defaultModelId()
    const mem = memoryStats()
    const sessions = listSessions()
    const stickers = listStickers()
    const ci = catalogInfo()
    const pc = priceCacheInfo()
    const turns = recentTurns({ limit: 300 })
    const day = Date.now() - 86400_000
    const today = turns.filter(t => t.at > day)
    return {
      enable: c.enable,
      version: '2',
      uptime: Date.now() - startedAt,
      node: process.version,
      rss: process.memoryUsage().rss,
      bots: bots(),
      defaultModel: def,
      defaultModelReady: config.hasKey(config.getProvider(config.getModel(def)?.provider ?? '')),
      persona: c.persona.active,
      counts: {
        models: c.models.length, providers: Object.keys(c.providers).length, sessions: sessions.length,
        archive: sessions.reduce((a, s) => a + s.archive, 0), days: sessions.reduce((a, s) => a + s.days, 0), vectors: sessions.reduce((a, s) => a + s.vectors, 0),
        memoryEntries: mem.entries, memoryUsers: mem.users, memoryGroups: mem.groups,
        stickers: stickers.length, skills: listSkills().length, tools: registry.all().length, groups: Object.keys(c.groups).length,
      },
      today: { turns: today.length, errors: today.filter(t => t.error).length, cost: today.reduce((a, t) => a + t.cost, 0), avgMs: today.length ? Math.round(today.reduce((a, t) => a + t.ms, 0) / today.length) : 0 },
      embedding: { ready: embeddingReady(), model: c.memory.embedding.model },
      catalog: ci,
      prices: { count: pc.count, age: pc.fetchedAt ? formatDuration(Date.now() - pc.fetchedAt) : '' },
      recentErrors: recentLogs(0, 'error').slice(-5),
      firstRun: !fs.existsSync(SETUP_SEEN_FILE),
    }
  }),

  R('GET', '/api/usage', () => {
    const c = config.get()
    return {
      totals: totals(),
      incompleteModels: incompleteUsageModels(),
      daily: daily(14),
      topUsers: topUsers(WINDOW_WEEK, 15).map(([id, usd]) => ({ id, name: nameOf('user', id), usd })),
      topUsers5h: topUsers(WINDOW_5H, 10).map(([id, usd]) => ({ id, name: nameOf('user', id), usd })),
      models: c.models.map(m => ({
        id: m.id,
        global: summarize(m, 'global', {}),
        limits: { user: limitsFor(m, 'user'), group: limitsFor(m, 'group'), global: limitsFor(m, 'global') },
      })),
    }
  }),
  R('GET', '/api/usage/history', ({ query }) => {
    const from = Number(query.get('from')), to = Number(query.get('to'))
    if (!query.has('from') || !query.has('to') || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > 8640000000000000) throw fail('需要有效的起止时间')
    return queryUsageCalls(from, to, query.get('model') || undefined)
  }),
  R('GET', '/api/usage/user/:id', ({ params }) => ({
    id: params[0],
    name: nameOf('user', params[0]),
    models: config.get().models.map(m => ({ id: m.id, user: summarize(m, 'user', { userId: params[0] }) })),
  })),
  R('POST', '/api/usage/reset', ({ body }) => {
    if (!body.all && !body.userId) throw fail('需要 userId 或 all')
    resetUsage(body.all ? { all: true } : { userId: String(body.userId) })
  }),
  // cumulative statistics (calls, tokens, cost); models: list of model ids, omitted = every model
  R('POST', '/api/usage/reset-stats', ({ body }) => {
    const models = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : undefined
    if (!models && body.all !== true) throw fail('需要 models 或 all')
    return { reset: resetStats(models) }
  }),

  R('GET', '/api/config', () => {
    const cfg = config.get()
    return { schema: serializeSchema(SCHEMA, cfg), effective: maskSecrets(SCHEMA, cfg), overridden: overriddenPaths(), descriptions: configDescriptions(), groups: groupList(),
      presets: PRESET_PROVIDERS, presetModels: PRESET_PROVIDERS.map(([, type, baseUrl]) => modelSuggestions({ type, baseUrl })), thinking: THINKING, problems: configProblems(cfg) }
  }),
  R('PUT', '/api/config', ({ body }) => setConfig(String(body.path ?? ''), body.value)),
  R('GET', '/api/setup', ({ query }) => {
    if (!fs.existsSync(SETUP_SEEN_FILE)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(SETUP_SEEN_FILE, JSON.stringify({ at: Date.now() }))
    }
    return setupStatus(query.get('refresh') === '1')
  }),
  R('PUT', '/api/setup', ({ body }) => {
    if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 30) throw fail('请提供有效的设置项')
    const doc = YAML.parseDocument(config.readRaw())
    for (const change of body.changes) {
      const p = String(change.path ?? ''), keys = keysOf(p)
      if (!/^(providers\.|models\.|defaultModel$|utilityModel$|visionModel$|fallbackModels$|memory\.(enable$|embedding\.)|chat\.(thinking$|thinkingJudge\.)|tools\.(exec|agy|computer|googleLens|webSearch|webFetch)\.)/.test(p) || !schemaAt(keys)) throw fail('设置向导不支持此配置项')
      const error = validatePath(keys)
      if (error) throw fail(error)
      for (let i = 1; i < keys.length; i++) {
        if (typeof keys[i] === 'number' && !doc.hasIn(keys.slice(0, i))) doc.setIn(keys.slice(0, i), config.read(keys.slice(0, i).join('.')) ?? [])
      }
      doc.setIn(keys, change.value)
    }
    const user = doc.toJS(), merged = normalize(deepMerge(YAML.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')) ?? {}, structuredClone(user)))
    const error = validate(SCHEMA, user, merged, merged)
    if (error) throw fail(error)
    config.writeRaw(String(doc))
    return { ok: true }
  }),
  R('DELETE', '/api/config', ({ query }) => {
    const p = query.get('path') ?? ''
    if (!schemaAt(keysOf(p))) throw fail(`未知配置项：${p}`)
    config.delete(p)
  }),
  R('GET', '/api/config/raw', () => ({ text: config.readRaw() })),
  R('PUT', '/api/config/raw', ({ body }) => {
    const text = String(body.text ?? '')
    const doc = YAML.parseDocument(text)
    if (doc.errors.length) throw fail(`YAML 语法错误：${doc.errors[0].message}`)
    const user = doc.toJS() ?? {}
    if (!isPlainObject(user)) throw fail('配置顶层应为对象')
    // enum choices (model ids, presets) come from the config being written, not the current one
    const merged = normalize(deepMerge(YAML.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')) ?? {}, structuredClone(user)))
    const err = validate(SCHEMA, user, merged, merged)
    if (err) throw fail(err)
    config.writeRaw(text)
  }),

  R('GET', '/api/models', () => {
    const c = config.get()
    return {
      defaultModel: config.defaultModelId(),
      providers: Object.entries(c.providers).map(([name, p]) => ({ name, type: p.type, baseUrl: p.baseUrl, hasKey: config.hasKey(p), balance: p.balance })),
      models: c.models.map(m => ({ ...m, hasKey: config.hasKey(c.providers[m.provider]), price: resolvePrice(m) })),
    }
  }),
  R('POST', '/api/models/:id/test', async ({ params }) => {
    const m = config.getModel(params[0])
    if (!m) throw fail('没有这个模型', 404)
    const start = Date.now()
    try {
      const { text } = await utilityChat({ candidates: [m.id], system: '你是一个测试助手。', user: [{ type: 'text', text: '请只回复：OK' }], maxTokens: 50, quotaCtx: { isAdmin: true } })
      return { ok: true, ms: Date.now() - start, text: truncate(text, 200) }
    } catch (err: any) {
      return { ok: false, ms: Date.now() - start, error: truncate(err?.message ?? String(err), 500) }
    }
  }),
  R('POST', '/api/providers/:name/balance', async ({ params }) => {
    const p = config.getProvider(params[0])
    if (!p) throw fail('没有这个提供商', 404)
    try {
      return { text: (await queryBalance(p)) ?? '该提供商不支持余额查询' }
    } catch (err: any) {
      return { text: `查询失败：${truncate(err?.message ?? String(err), 200)}` }
    }
  }),

  R('GET', '/api/personas', () => {
    const p = config.get().persona
    const groups = config.get().groups
    return {
      active: p.active,
      botName: p.botName,
      presets: Object.entries(p.presets).map(([name, raw]) => ({
        name,
        file: /^file:\s*(.+)$/.exec(String(raw).trim())?.[1]?.trim(),
        text: personaText(raw),
        groups: Object.entries(groups).filter(([, g]) => g.persona === name).map(([id]) => ({ id, name: nameOf('group', id) })),
      })),
    }
  }),
  R('PUT', '/api/personas/:name', ({ params, body }) => {
    const name = params[0]
    const text = String(body.text ?? '')
    if (!text.trim()) throw fail('人设内容不能为空')
    const raw = config.get().persona.presets[name]
    const file = raw && /^file:\s*(.+)$/.exec(String(raw).trim())?.[1]?.trim()
    if (file) {
      // file-backed preset: edit the file, keep the reference
      const f = path.resolve(CONFIG_FILE_DIR, file)
      if (!f.startsWith(CONFIG_FILE_DIR + path.sep)) throw fail('人设文件必须在配置目录内')
      fs.writeFileSync(f, text, 'utf8')
      config.load()
      return
    }
    setConfig(`persona.presets.${name}`, text)
  }),
  R('POST', '/api/personas/:name/activate', ({ params, body }) => {
    if (!config.get().persona.presets[params[0]]) throw fail('没有这个人设', 404)
    if (body.groupId) setConfig(`groups.${body.groupId}.persona`, params[0])
    else setConfig('persona.active', params[0])
  }),
  R('DELETE', '/api/personas/:name', ({ params }) => {
    if (params[0] === config.get().persona.active) throw fail('不能删除正在使用的默认人设')
    config.delete(`persona.presets.${params[0]}`)
  }),

  R('GET', '/api/sessions', () => listSessions().map(s => ({ ...s, ...sessionLabel(s.key), summary: s.summary && truncate(s.summary, 200) }))),
  R('GET', '/api/sessions/:key', ({ params }) => {
    const s = peekSession(params[0])
    if (!s) throw fail('没有这个会话', 404)
    return {
      key: params[0],
      ...sessionLabel(params[0]),
      updatedAt: s.updatedAt,
      summary: s.summary,
      messages: s.messages.map(m => ({ role: m.role, text: m.role === 'user' ? partsToText(m.content) : m.role === 'assistant' ? m.content : '' })),
      archive: archiveInfo(params[0]),
      days: dayInfo(params[0]),
      turns: recentTurns({ conv: params[0], limit: 50 }),
    }
  }),
  R('DELETE', '/api/sessions/:key', ({ params }) => { clearSession(params[0]) }),
  R('DELETE', '/api/sessions/:key/archive/:id', ({ params }) => {
    if (!deleteArchiveEntry(params[0], params[1])) throw fail('没有这条档案', 404)
  }),
  R('GET', '/api/roster', () => rosterSnapshot()
    .map(r => ({ ...r, label: r.groupId ? (nameOf('group', r.groupId) ?? `群 ${r.groupId}`) : '私聊' }))
    .sort((a, b) => Math.max(0, ...b.people.map(p => p.seen)) - Math.max(0, ...a.people.map(p => p.seen)))),
  R('GET', '/api/roster/:scope/:id', ({ params }) => {
    const [scope, id] = params
    const groupId = scope.split(':')[1]?.startsWith('g') ? scope.split(':')[1].slice(1) : undefined
    // their own messages here, plus their recent conversations with the bot (in this group, or anywhere for private)
    const turns = recentTurns({ limit: 300 }).filter(t => t.userId === id && (groupId ? t.groupId === groupId : !t.groupId)).slice(0, 10)
    return { id, messages: recentMessages(scope, id), turns: turns.map(t => ({ at: t.at, input: t.input, reply: t.reply })) }
  }),
  R('GET', '/api/turns', ({ query }) => recentTurns({ limit: Math.min(300, Number(query.get('limit')) || 100) }).map(t => ({ ...t, label: sessionLabel(t.conv).label }))),
  R('GET', '/api/rollouts', ({ query }) => recentRollouts(query.get('conv') || undefined).map(r => ({ ...r, label: sessionLabel(r.conv).label }))),
  R('GET', '/api/rollouts/:id/history', ({ params }) => {
    const history = rolloutHistory(params[0])
    if (!history) throw fail('执行记录不存在或已清理', 404)
    return { ...history, label: sessionLabel(history.conv).label }
  }),

  R('GET', '/api/vectors', ({ query }) => vectorSpace(query)),

  R('GET', '/api/memory', () => {
    const row = (scope: MemScope) => (key: string) => ({ key, name: nameOf(scope, key), entries: listMemory(scope, key), usage: memUsage(scope, key) })
    return { stats: memoryStats(), users: memoryOwners('user').map(row('user')), groups: memoryOwners('group').map(row('group')) }
  }),
  R('POST', '/api/memory/:scope/:key', ({ params, body }) => {
    const r = addMemory(params[0] as MemScope, params[1], String(body.text ?? ''), 'web')
    if (!r.ok) throw fail(r.reason)
    return r.entry
  }),
  R('PUT', '/api/memory/:scope/:key/:id', ({ params, body }) => {
    const r = updateMemory(params[0] as MemScope, params[1], params[2], String(body.text ?? ''))
    if (!r.ok) throw fail(r.reason)
    return r.entry
  }),
  R('DELETE', '/api/memory/:scope/:key/:id', ({ params }) => {
    if (!deleteMemory(params[0] as MemScope, params[1], params[2])) throw fail('没有这条记忆', 404)
  }),
  R('DELETE', '/api/memory/:scope/:key', ({ params }) => ({ removed: clearMemory(params[0] as MemScope, params[1]) })),

  R('GET', '/api/stickers', () => listStickers().map(stickerView)),
  R('GET', '/api/stickers/:id/image', ({ params }) => {
    const s = listStickers().find(x => x.id === params[0])
    const f = s && stickerFile(s)
    if (!f || !fs.existsSync(f)) throw fail('没有图片', 404)
    return { raw: fs.readFileSync(f), type: s!.mime ?? 'image/png' }
  }),
  R('POST', '/api/stickers', async ({ body }) => {
    const buf = Buffer.from(String(body.data ?? '').replace(/^data:[^,]*,/, ''), 'base64')
    if (!buf.length) throw fail('没有图片数据')
    if (buf.length > MAX_STICKER_BYTES) throw fail(`图片超过 ${MAX_STICKER_BYTES >> 20} MB`)
    if (!detectImageMime(buf)) throw fail('不支持的图片格式（支持 PNG / JPEG / GIF / WebP / BMP）')
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 20) : undefined
    const desc = typeof body.desc === 'string' && body.desc.trim() ? body.desc.trim().slice(0, 40) : undefined
    const [s, isNew] = addImageSticker(buf, { addedBy: 'web', name, desc })
    // same rule as #llm添加表情: a given name (and description) is kept, vision fills the rest
    if (!isNew || body.index === false) return { sticker: stickerView(s), isNew }
    try {
      return { sticker: stickerView(await indexSticker(s, { hint: typeof body.hint === 'string' ? body.hint.trim() || name : name, mode: name ? 'fill' : 'full' })), isNew }
    } catch (err: any) {
      return { sticker: stickerView(s), isNew, indexError: truncate(err?.message ?? String(err), 200) }
    }
  }, MAX_STICKER_BYTES * 1.4 + 64 * 1024),
  R('POST', '/api/stickers/:id/index', async ({ params, body }) => {
    const s = listStickers().find(x => x.id === params[0])
    if (!s) throw fail('没有这个表情', 404)
    try {
      // mode=fill keeps filled-in fields; dryRun only returns the suggestion (the editor fills its form with it)
      const r = await indexSticker(s, { hint: typeof body.hint === 'string' ? body.hint.trim() || undefined : undefined, mode: body.mode === 'fill' ? 'fill' : 'full', dryRun: body.dryRun === true })
      return stickerView(r)
    } catch (err: any) {
      throw fail(`识别失败：${truncate(err?.message ?? String(err), 200)}`, 502)
    }
  }),
  R('PUT', '/api/stickers/:id', ({ params, body }) => {
    if (!listStickers().some(s => s.id === params[0])) throw fail('没有这个表情', 404)
    const patch: any = {}
    for (const k of ['name', 'desc', 'use', 'text'] as const) if (typeof body[k] === 'string') patch[k] = body[k].trim()
    if (body.tags !== undefined)
      patch.tags = (Array.isArray(body.tags) ? body.tags : String(body.tags).split(/[,，、\s]+/)).map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8)
    if (patch.name === '') throw fail('名称不能为空')
    if (patch.name && listStickers().some(s => s.name === patch.name && s.id !== params[0])) throw fail('已有同名表情')
    // a hand-filled name + description counts as recognised
    if (patch.name && patch.desc) patch.indexed = true
    updateSticker(params[0], patch)
  }),
  R('DELETE', '/api/stickers/:id', ({ params }) => {
    if (!removeSticker(params[0])) throw fail('没有这个表情', 404)
  }),

  R('GET', '/api/skills', async () => {
    const eff = config.effective()
    await prepareRuntimeTools(eff)
    const available = new Set(config.get().skills.enable && eff.tools.enable
      ? skillsForTools(registry.all().filter(t => !eff.tools.disabled.includes(t.name) && runtimeToolReady(t.name, eff)).map(t => t.name)).map(s => s.name) : [])
    return listSkills().map(s => ({ name: s.name, description: s.description, body: s.body, requiresTools: s.requiresTools, available: available.has(s.name) }))
  }),
  R('PUT', '/api/skills/:name', ({ params, body }) => {
    let md = String(body.markdown ?? '').trim()
    if (!md) throw fail('内容不能为空')
    if (!md.startsWith('---')) {
      const parsed = parseSkillMarkdown(md, params[0])
      md = `---\nname: ${params[0]}\ndescription: ${JSON.stringify(parsed.description)}\n---\n${md}\n`
    }
    const s = saveSkill(params[0], md)
    return { name: s.name, description: s.description }
  }),
  R('DELETE', '/api/skills/:name', ({ params }) => {
    if (!deleteSkill(params[0])) throw fail('没有这个技能', 404)
  }),

  R('GET', '/api/tools', async () => {
    const eff = config.effective()
    await prepareRuntimeTools(eff)
    const disabled = new Set(config.get().tools.disabled)
    return registry.all().map(t => ({ name: t.name, source: t.source ?? 'builtin', description: t.description, parameters: t.parameters, enabled: !disabled.has(t.name), runtimeReady: runtimeToolReady(t.name, eff) }))
  }),
  R('PUT', '/api/tools/:name', ({ params, body }) => {
    if (!registry.get(params[0])) throw fail('没有这个工具', 404)
    const set = new Set(config.get().tools.disabled)
    if (body.enabled) set.delete(params[0])
    else set.add(params[0])
    setConfig('tools.disabled', [...set])
  }),

  R('GET', '/api/commands', () => ({ info: catalogInfo(), entries: catalogEntries() })),

  R('GET', '/api/computer', () => [...computerQueue.jobs].reverse()),
  R('GET', '/api/rollouts/:id/images/:image', ({ params }) => {
    const image = readRolloutImage(params[0], params[1])
    if (!image) throw fail('图片不存在或已清理', 404)
    return image
  }),
  R('GET', '/api/computer/:id/history', ({ params }) => {
    if (!computerQueue.jobs.some(job => job.id === params[0])) throw fail('任务不存在', 404)
    return computerHistory(params[0])
  }),
  R('GET', '/api/computer/:id/images/:image', ({ params }) => {
    if (!computerQueue.jobs.some(job => job.id === params[0])) throw fail('任务不存在', 404)
    const image = readComputerScreenshot(params[0], params[1])
    if (!image) throw fail('截图不存在或已清理', 404)
    return image
  }),
  R('POST', '/api/computer/:id/cancel', ({ params }) => {
    const job = computerQueue.jobs.find(j => j.id === params[0])
    if (!job) throw fail('没有这个任务', 404)
    computerQueue.cancel(job)
  }),

  R('GET', '/api/logs', ({ query }) => recentLogs(Number(query.get('after')) || 0, query.get('level') || undefined, query.get('q') || '')),

  R('GET', '/api/agy', () => [...agyQueue.jobs].reverse().map(agyJobView)),
  R('GET', '/api/agy/:id/history', ({ params }) => {
    if (!agyQueue.jobs.some(job => job.id === params[0])) throw fail('任务不存在', 404)
    return agyHistory(params[0])
  }),
  R('POST', '/api/agy/:id/cancel', ({ params }) => {
    const job = agyQueue.jobs.find(entry => entry.id === params[0])
    if (!job) throw fail('没有这个任务', 404)
    cancelAgyJob(job)
  }),

  R('POST', '/api/actions/:name', async ({ params }) => {
    switch (params[0]) {
      case 'reload':
        if (!config.load()) throw fail('重载失败，请查看日志')
        return { message: '配置已重载' }
      case 'enable':
      case 'disable':
        setConfig('enable', params[0] === 'enable')
        return { message: params[0] === 'enable' ? '插件已全局开启' : '插件已全局关闭' }
      case 'refresh-prices':
        await refreshPrices(true)
        return { message: `价格表已刷新（${priceCacheInfo().count} 个模型）` }
      case 'scan-commands': {
        const r = await scanCatalog()
        return { message: `指令目录：${r.verified}/${r.entries} 条已验证，${r.rules} 条规则` }
      }
      default:
        throw fail('未知操作', 404)
    }
  }),
]
