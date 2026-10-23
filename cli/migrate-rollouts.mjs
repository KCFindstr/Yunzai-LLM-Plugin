#!/usr/bin/env node
// One-time offline migration. Stop the bot before running; runtime reads only the new layout.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRolloutJson } from '../web/js/rollout-data.js'

const validId = id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)
function atomicWrite(file, text) {
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, text)
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}
function entry({ events, context, seq, reply, thinkingDecision, ...rollout }) {
  return { ...rollout, input: String(rollout.input ?? '').slice(0, 300) }
}

export function migrateRollouts(dataDirectory) {
  const source = path.join(dataDirectory, 'rollouts.json')
  const directory = path.join(dataDirectory, 'rollouts')
  const indexFile = path.join(directory, 'index.json')
  if (!fs.existsSync(source)) return { migrated: 0, alreadyMigrated: fs.existsSync(indexFile) }
  if (fs.existsSync(path.join(directory, 'pending.json'))) throw new Error('存在未完成的写入，请先正常停止机器人并恢复写入')
  const original = fs.readFileSync(source, 'utf8')
  const legacy = parseRolloutJson(original)
  if (!Array.isArray(legacy?.rollouts)) throw new Error('旧执行记录格式无效，原文件已保留')
  const ids = new Set()
  for (const rollout of legacy.rollouts) {
    if (!validId(rollout?.id) || !Array.isArray(rollout.events) || ids.has(rollout.id)) throw new Error('旧执行记录格式无效或ID重复，原文件已保留')
    ids.add(rollout.id)
  }
  const index = new Map()
  if (fs.existsSync(indexFile)) {
    const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    if (saved.v !== 2 || !Array.isArray(saved.rollouts)) throw new Error('新索引格式无效，原文件已保留')
    for (const rollout of saved.rollouts) {
      if (!validId(rollout.id)) throw new Error('新索引ID无效，原文件已保留')
      index.set(rollout.id, rollout)
    }
  }
  for (const legacyRecord of legacy.rollouts) {
    const file = path.join(directory, `${legacyRecord.id}.json`)
    let record = legacyRecord
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (existing.id !== legacyRecord.id || !Array.isArray(existing.events)) throw new Error('已有详情文件格式无效，原文件已保留')
      if (existing.updatedAt >= legacyRecord.updatedAt) record = existing
    }
    const text = JSON.stringify(record)
    atomicWrite(file, text)
    if (fs.readFileSync(file, 'utf8') !== text) throw new Error('迁移详情校验失败，原文件已保留')
    index.set(record.id, entry(record))
  }
  // Every indexed file must be valid before retiring the monolithic source.
  for (const [id] of index) {
    const record = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'))
    if (record.id !== id || !Array.isArray(record.events)) throw new Error('迁移索引校验失败，原文件已保留')
    index.set(id, entry(record))
  }
  if (fs.readFileSync(source, 'utf8') !== original) throw new Error('迁移期间旧文件发生变化，请停止机器人后重试；原文件已保留')
  const text = JSON.stringify({ v: 2, rollouts: [...index.values()].sort((a, b) => a.createdAt - b.createdAt) })
  atomicWrite(indexFile, text)
  if (fs.readFileSync(indexFile, 'utf8') !== text) throw new Error('迁移索引写入校验失败，原文件已保留')
  fs.unlinkSync(source)
  return { migrated: ids.size, indexed: index.size }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try { console.log(JSON.stringify(migrateRollouts(path.resolve(process.argv[2] ?? process.env.YZ_LLM_DATA_DIR ?? path.join(root, 'data'))))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
