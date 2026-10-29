/**
 * Upgrades an older config.yaml (a YAML Document, edited in place so comments survive) to the current schema.
 * Shared by the plugin (on load), the terminal editor and the web editor's raw YAML save.
 *
 *  - chat.thinkingJudge (mode/url/apiKey/systemoneModel)  -> a systemone provider + systemoneModels entry,
 *                                                            autoThinking.judge / timeoutMs
 *  - chat.autoThinking {casual, question, complex}        -> autoThinking.levels
 *  - memory.embedding {type, baseUrl, apiKey, model, ...} -> a voyage/openai provider + embeddingModels entry,
 *                                                            memory.embedding.model (an embedding model id)
 *  - groups.*.chat.{thinkingJudge, autoThinking}          -> removed (judging is no longer per group)
 *
 * Returns a human-readable note per change; an empty list means the document was already current.
 */
import YAML from 'yaml'

/** What the removed settings defaulted to (default_config.yaml before the migration). */
const OLD_JUDGE_URL = 'https://api.typesafe.ai/v1/systemone'
const OLD_EMBEDDING = { enable: true, type: 'voyage', baseUrl: 'https://api.voyageai.com/v1', model: 'voyage-context-4', dimensions: 512, timeout: 10 }

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const js = v => (YAML.isNode(v) ? v.toJSON() : v)
const sameUrl = (a, b) => String(a ?? '').replace(/\/+$/, '').toLowerCase() === String(b ?? '').replace(/\/+$/, '').toLowerCase()
const keyList = k => (Array.isArray(k) ? k : k ? [k] : []).map(String)
const sameKey = (a, b) => JSON.stringify(keyList(a)) === JSON.stringify(keyList(b))
const slugId = s => String(s ?? '').replace(/^.*\//, '').replace(/[^\p{L}\p{N}_.-]+/gu, '-') || 'model'

export function migrateConfig(doc, defaults = {}) {
  const notes = []
  if (!YAML.isMap(doc.contents)) return notes
  const get = keys => js(doc.getIn(keys))

  const providers = () => {
    const out = structuredClone(isObj(defaults.providers) ? defaults.providers : {})
    for (const [name, p] of Object.entries(get(['providers']) ?? {})) out[name] = isObj(out[name]) && isObj(p) ? { ...out[name], ...p } : p
    return out
  }
  const freeName = (taken, base) => { let name = base, i = 2; while (name in taken) name = `${base}${i++}`; return name }
  /** delete a key, then any map it leaves empty (`chat: {}` says nothing) */
  const drop = keys => {
    doc.deleteIn(keys)
    for (let n = keys.length - 1; n > 0; n--) {
      const parent = doc.getIn(keys.slice(0, n))
      if (!YAML.isMap(parent) || parent.items.length) break
      doc.deleteIn(keys.slice(0, n))
    }
  }

  /** A provider of `type` at `baseUrl`; reuses one with the same endpoint (filling in its missing key). */
  const ensureProvider = (types, spec, base) => {
    const all = providers()
    for (const [name, p] of Object.entries(all)) {
      if (!isObj(p) || !types.includes(p.type) || !sameUrl(p.baseUrl, spec.baseUrl)) continue
      if (!keyList(spec.apiKey).length || sameKey(p.apiKey, spec.apiKey)) return name
      if (!keyList(p.apiKey).length) {
        doc.setIn(['providers', name, 'apiKey'], spec.apiKey)
        notes.push(`providers.${name}.apiKey 已从旧设置迁移`)
        return name
      }
    }
    const name = freeName(all, base)
    doc.setIn(['providers', name], doc.createNode(Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined && v !== ''))))
    notes.push(`新建提供商 providers.${name}（${spec.type}）`)
    return name
  }

  /** Id of a `list` entry matching `spec`; appended (with the defaults copied in first) when none matches. */
  const ensureModel = (list, spec, base) => {
    const own = doc.hasIn([list])
    const entries = (own ? get([list]) : defaults[list]) ?? []
    const hit = entries.find(m => isObj(m) && m.provider === spec.provider && m.model === spec.model && (spec.dimensions == null || (m.dimensions ?? OLD_EMBEDDING.dimensions) === spec.dimensions))
    if (hit) return String(hit.id ?? hit.model)
    const taken = Object.fromEntries([...(get(['models']) ?? defaults.models ?? []), ...entries].map(m => [String(m?.id ?? m?.model), true]))
    const id = freeName(taken, slugId(base))
    if (!own) doc.setIn([list], doc.createNode(structuredClone(entries)))
    doc.addIn([list], doc.createNode({ id, ...spec }))
    notes.push(`新建 ${list} 项 ${id}（${spec.provider}/${spec.model}）`)
    return id
  }

  // ---- chat.thinkingJudge -> autoThinking.judge (+ System One provider/model) ----
  const tj = get(['chat', 'thinkingJudge'])
  if (doc.hasIn(['chat', 'thinkingJudge'])) {
    if (isObj(tj)) {
      let judge
      const url = typeof tj.url === 'string' && tj.url ? tj.url : OLD_JUDGE_URL
      if (tj.mode === 'systemone' || keyList(tj.apiKey).length || !sameUrl(url, OLD_JUDGE_URL) || tj.systemoneModel) {
        const baseUrl = url.replace(/\/systemone\/?$/i, '')
        const name = ensureProvider(['systemone'], { type: 'systemone', baseUrl, apiKey: tj.apiKey }, /typesafe\.ai/i.test(baseUrl) ? 'typesafe' : 'systemone')
        const id = ensureModel('systemoneModels', { provider: name, model: tj.systemoneModel || 'jev-latest' }, /typesafe\.ai/i.test(baseUrl) ? 'jev' : 'kev')
        if (tj.mode === 'systemone') judge = id
      }
      if (tj.mode === 'model' && tj.model) judge = String(tj.model)
      if (tj.mode === 'heuristic') notes.push('关键词规则判断已移除：自动思考强度改由后台任务模型判断（可在 autoThinking.judge 指定）')
      if (judge) doc.setIn(['autoThinking', 'judge'], judge)
      if (tj.timeoutMs != null) doc.setIn(['autoThinking', 'timeoutMs'], tj.timeoutMs)
    }
    drop(['chat', 'thinkingJudge'])
    notes.push('chat.thinkingJudge → autoThinking')
  }

  // ---- chat.autoThinking -> autoThinking.levels ----
  if (doc.hasIn(['chat', 'autoThinking'])) {
    const at = get(['chat', 'autoThinking'])
    if (isObj(at)) for (const [k, v] of Object.entries(at)) doc.setIn(['autoThinking', 'levels', k], v)
    drop(['chat', 'autoThinking'])
    notes.push('chat.autoThinking → autoThinking.levels')
  }

  // ---- per-group judge settings: no longer per group ----
  for (const [gid, g] of Object.entries(get(['groups']) ?? {})) {
    if (!isObj(g?.chat)) continue
    for (const k of ['thinkingJudge', 'autoThinking'])
      if (doc.hasIn(['groups', gid, 'chat', k])) {
        drop(['groups', gid, 'chat', k])
        notes.push(`groups.${gid}.chat.${k} 已移除（改为全局 autoThinking 与每个模型的设置）`)
      }
  }

  // ---- memory.embedding {type, baseUrl, apiKey, model, dimensions, timeout} -> embeddingModels ----
  const em = get(['memory', 'embedding'])
  const legacy = ['type', 'baseUrl', 'apiKey', 'dimensions', 'timeout']
  if (isObj(em) && legacy.some(k => k in em)) {
    const old = { ...OLD_EMBEDDING, ...em }
    const voyage = old.type !== 'openai'
    const baseUrl = em.baseUrl || (voyage ? OLD_EMBEDDING.baseUrl : 'https://api.openai.com/v1')
    const spec = { type: voyage ? 'voyage' : 'openai', baseUrl, apiKey: em.apiKey, ...(voyage && em.timeout != null ? { timeout: em.timeout } : {}) }
    const provider = ensureProvider(voyage ? ['voyage'] : ['openai', 'openai-responses'], spec, voyage ? 'voyage' : 'embedding')
    const id = ensureModel('embeddingModels', { provider, model: old.model, dimensions: Number(old.dimensions) || OLD_EMBEDDING.dimensions }, old.model)
    for (const k of legacy) doc.deleteIn(['memory', 'embedding', k])
    doc.setIn(['memory', 'embedding', 'model'], id)
    notes.push(`memory.embedding → embeddingModels.${id}`)
  }
  return notes
}
