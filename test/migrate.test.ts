import { TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import YAML from 'yaml'
import { migrateConfig } from '../cli/migrate.mjs'
import { SCHEMA, validate } from '../cli/schema.mjs'
import { config, normalize } from '../src/core/config.ts'
import { deepMerge } from '../src/core/util.ts'

const defaults = YAML.parse(fs.readFileSync(path.join(TMP, 'config', 'default_config.yaml'), 'utf8'))
const migrate = (yaml: string) => {
  const doc = YAML.parseDocument(yaml)
  const notes = migrateConfig(doc, defaults)
  return { doc, notes, user: doc.toJS() ?? {} }
}
/** the migrated user config must be valid against the current schema */
const valid = (user: any) => {
  const merged = normalize(deepMerge(structuredClone(defaults), structuredClone(user)))
  assert.equal(validate(SCHEMA, user, merged, merged), undefined)
  return merged
}

describe('config migration', () => {
  it('moves a Jev judge and its key onto the default System One provider and model', () => {
    const { user, notes } = migrate(`# 我的配置\nchat:\n  sessionScope: group # 群共享\n  thinkingJudge: { mode: systemone, apiKey: jev-secret, timeoutMs: 3000, model: utility }\n  autoThinking: { question: low, complex: medium }\n`)
    assert.ok(notes.length)
    assert.deepEqual(user.providers, { typesafe: { apiKey: 'jev-secret' } })
    assert.equal(user.systemoneModels, undefined, 'the default jev entry is reused')
    assert.deepEqual(user.autoThinking, { judge: 'jev', timeoutMs: 3000, levels: { question: 'low', complex: 'medium' } })
    assert.deepEqual(user.chat, { sessionScope: 'group' })
    const merged = valid(user)
    assert.deepEqual(merged.autoThinking.levels, { casual: 'low', question: 'low', complex: 'medium' })
  })

  it('keeps comments and is idempotent', () => {
    const { doc } = migrate(`# 我的配置\nchat:\n  sessionScope: group # 群共享\n  thinkingJudge: { mode: model, model: mini }\n`)
    const text = String(doc)
    assert.match(text, /# 我的配置/)
    assert.match(text, /# 群共享/)
    assert.deepEqual(migrateConfig(doc, defaults), [])
    assert.equal(String(doc), text)
  })

  it('a self-hosted Kev becomes its own systemone provider and model', () => {
    const { user } = migrate(`chat:\n  thinkingJudge: { mode: systemone, url: 'http://127.0.0.1:8009/v1/systemone', systemoneModel: kev-1 }\n`)
    assert.deepEqual(user.providers.systemone, { type: 'systemone', baseUrl: 'http://127.0.0.1:8009/v1' })
    assert.deepEqual(user.systemoneModels.map((m: any) => m.id), ['jev', 'kev'], 'defaults copied in before appending')
    assert.deepEqual(user.systemoneModels[1], { id: 'kev', provider: 'systemone', model: 'kev-1' })
    assert.equal(user.autoThinking.judge, 'kev')
    valid(user)
  })

  it('a chat-model judge keeps its model; the keyword heuristic falls back to the utility model', () => {
    assert.equal(migrate(`chat:\n  thinkingJudge: { mode: model, model: mini }\n`).user.autoThinking.judge, 'mini')
    const heuristic = migrate(`chat:\n  thinkingJudge: { mode: heuristic }\n`)
    assert.equal(heuristic.user.autoThinking, undefined)
    assert.ok(heuristic.notes.some((n: string) => /关键词规则/.test(n)))
    assert.equal(heuristic.user.providers, undefined, 'no System One provider without a Jev setting')
  })

  it('moves the Voyage key onto the voyage provider, keeping the vector space (and stored vectors)', () => {
    const { user } = migrate(`memory:\n  embedding: { enable: true, type: voyage, model: voyage-context-4, minScore: 0.3, apiKey: voyage-secret }\n`)
    assert.deepEqual(user.providers, { voyage: { apiKey: 'voyage-secret' } })
    assert.deepEqual(user.memory.embedding, { enable: true, model: 'voyage-context-4', minScore: 0.3 })
    const merged = valid(user)
    assert.deepEqual(merged.embeddingModels[0], { id: 'voyage-context-4', provider: 'voyage', model: 'voyage-context-4', dimensions: 512 })
  })

  it('an OpenAI-compatible embedding endpoint reuses a provider at the same address, and other dimensions get their own entry', () => {
    const { user } = migrate(`providers:\n  oa: { type: openai, baseUrl: 'https://example.invalid/v1', apiKey: chat-key }\nmemory:\n  embedding: { enable: true, type: openai, baseUrl: 'https://example.invalid/v1/', model: text-embedding-3-small, dimensions: 1024 }\n`)
    assert.deepEqual(Object.keys(user.providers), ['oa'])
    const entry = user.embeddingModels.find((m: any) => m.id === user.memory.embedding.model)
    assert.deepEqual(entry, { id: 'text-embedding-3-small', provider: 'oa', model: 'text-embedding-3-small', dimensions: 1024 })
    valid(user)
  })

  it('removes per-group judge settings', () => {
    const { user } = migrate(`groups:\n  '123':\n    chat: { autoThinking: { casual: off }, thinkingJudge: { mode: heuristic }, groupContext: 3 }\n`)
    assert.deepEqual(user.groups, { '123': { chat: { groupContext: 3 } } })
    valid(user)
  })

  it('the plugin upgrades config.yaml on load, with a backup of the original', () => {
    const old = `chat:\n  thinkingJudge: { mode: systemone, apiKey: jev-secret }\nmemory:\n  embedding: { apiKey: voyage-secret }\n`
    const dir = path.join(TMP, 'config')
    for (const f of fs.readdirSync(dir)) if (f.includes('pre-migration')) fs.rmSync(path.join(dir, f))
    writeUserConfig(old)
    config.load()
    const backups = fs.readdirSync(dir).filter(f => f.includes('pre-migration'))
    assert.equal(backups.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), old)
    const now = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'))
    assert.equal(now.chat, undefined)
    assert.equal(config.get().autoThinking.judge, 'jev')
    assert.equal(config.getProvider('typesafe')!.apiKey, 'jev-secret')
    assert.equal(config.getProvider('voyage')!.apiKey, 'voyage-secret')
    config.load()
    assert.equal(fs.readdirSync(dir).filter(f => f.includes('pre-migration')).length, 1, 'nothing left to migrate the second time')
  })
})
