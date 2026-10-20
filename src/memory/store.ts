import { config } from '../core/config.ts'
import type { MemorySection } from '../core/configTypes.ts'
import { JsonStore } from '../core/store.ts'
import { sha1, similarity } from '../core/util.ts'

/**
 * Long-term memory. Bounded by construction: every write is checked against per-scope entry/char limits, so the
 * store can never grow past them; consolidation (compact.ts) keeps headroom for new facts.
 */
export type MemScope = 'user' | 'group'

export interface MemEntry {
  id: string
  text: string
  /** QQ of the person whose conversation produced it */
  by?: string
  createdAt: number
  updatedAt: number
}

interface MemData {
  v: 1
  user: Record<string, MemEntry[]>
  group: Record<string, MemEntry[]>
  seq: number
}

const store = new JsonStore<MemData>('memory.json', { v: 1, user: {}, group: {}, seq: 0 })

export interface MemLimits {
  maxEntries: number
  maxChars: number
  entryMaxChars: number
}

export function limitsOf(scope: MemScope, cfg: MemorySection = config.get().memory): MemLimits {
  return scope === 'user'
    ? { maxEntries: cfg.userMaxEntries, maxChars: cfg.userMaxChars, entryMaxChars: cfg.entryMaxChars }
    : { maxEntries: cfg.groupMaxEntries, maxChars: cfg.groupMaxChars, entryMaxChars: cfg.entryMaxChars }
}

const SENSITIVE = [
  /密码|口令|password|passwd|验证码|token|cookie|stoken|ltoken|api[-_ ]?key|sk-[a-z0-9]{6,}/i,
  /身份证|护照|银行卡|信用卡|卡号/,
  /\b\d{17}[\dxX]\b/, // ID card
  /\b1[3-9]\d{9}\b/, // CN mobile
  /\b\d{16,19}\b/, // card numbers
]

export function isSensitive(text: string): boolean {
  return SENSITIVE.some(r => r.test(text))
}

export function listMemory(scope: MemScope, key: string): MemEntry[] {
  return store.data[scope][key] ?? []
}

export function usage(scope: MemScope, key: string) {
  const list = listMemory(scope, key)
  const lim = limitsOf(scope)
  const chars = list.reduce((a, m) => a + m.text.length, 0)
  return { entries: list.length, chars, ...lim, ratio: Math.max(list.length / lim.maxEntries, chars / lim.maxChars) }
}

export type WriteResult = { ok: true; entry: MemEntry; merged?: boolean } | { ok: false; reason: string; full?: boolean }

function clean(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*·•\d.、\s]+/, '')
    .trim()
}

function check(scope: MemScope, list: MemEntry[], text: string, replacingId?: string): string | undefined {
  const lim = limitsOf(scope)
  if (!text) return '内容为空'
  if (text.length > lim.entryMaxChars) return `每条最多 ${lim.entryMaxChars} 字，请精简后重试`
  if (isSensitive(text)) return '不能记录密码、证件号、手机号、Cookie 等敏感信息'
  const others = list.filter(m => m.id !== replacingId)
  if (!replacingId && others.length >= lim.maxEntries) return `记忆已满（${others.length}/${lim.maxEntries} 条），请先用 update 合并或 delete 删除不重要的条目`
  const chars = others.reduce((a, m) => a + m.text.length, 0) + text.length
  if (chars > lim.maxChars) return `记忆总字数将超过上限（${lim.maxChars} 字），请先合并或删除旧条目`
  return undefined
}

function nextId(): string {
  store.data.seq = (store.data.seq ?? 0) + 1
  return `m${store.data.seq.toString(36)}`
}

export function addMemory(scope: MemScope, key: string, raw: string, by?: string): WriteResult {
  const text = clean(raw)
  const list = (store.data[scope][key] ??= [])
  // near-duplicate: rewrite the existing entry instead of adding a second copy
  const dup = list.find(m => similarity(m.text, text) >= 0.7 || m.text.includes(text))
  if (dup) {
    if (dup.text.includes(text)) return { ok: true, entry: dup, merged: true }
    const r = updateMemory(scope, key, dup.id, text)
    return r.ok ? { ...r, merged: true } : r
  }
  const err = check(scope, list, text)
  if (err) return { ok: false, reason: err, full: /已满|上限/.test(err) }
  const now = Date.now()
  const entry: MemEntry = { id: nextId(), text, by, createdAt: now, updatedAt: now }
  list.push(entry)
  store.save()
  return { ok: true, entry }
}

export function updateMemory(scope: MemScope, key: string, id: string, raw: string): WriteResult {
  const text = clean(raw)
  const list = store.data[scope][key] ?? []
  const entry = list.find(m => m.id === id)
  if (!entry) return { ok: false, reason: `没有编号为 ${id} 的记忆` }
  const err = check(scope, list, text, id)
  if (err) return { ok: false, reason: err, full: /已满|上限/.test(err) }
  entry.text = text
  entry.updatedAt = Date.now()
  store.save()
  return { ok: true, entry }
}

export function deleteMemory(scope: MemScope, key: string, id: string): boolean {
  const list = store.data[scope][key]
  if (!list) return false
  const n = list.length
  store.data[scope][key] = list.filter(m => m.id !== id)
  if (!store.data[scope][key].length) delete store.data[scope][key]
  store.save()
  return n !== (store.data[scope][key]?.length ?? 0)
}

export function clearMemory(scope: MemScope, key: string): number {
  const n = store.data[scope][key]?.length ?? 0
  delete store.data[scope][key]
  store.save()
  return n
}

/** Replace a whole list (used by consolidation). Caller validates limits. */
export function replaceMemory(scope: MemScope, key: string, texts: string[], by?: string) {
  const now = Date.now()
  store.data[scope][key] = texts.map(text => ({ id: nextId(), text, by, createdAt: now, updatedAt: now }))
  if (!store.data[scope][key].length) delete store.data[scope][key]
  store.save()
}

/**
 * Lines for the prompt. If limits were lowered after the fact, only the newest entries that fit are shown —
 * the prompt never exceeds the configured budget.
 */
export function renderMemory(scope: MemScope, key: string): string[] {
  const lim = limitsOf(scope)
  const list = [...listMemory(scope, key)].sort((a, b) => b.updatedAt - a.updatedAt)
  const out: MemEntry[] = []
  let chars = 0
  for (const m of list) {
    if (out.length >= lim.maxEntries || chars + m.text.length > lim.maxChars) break
    out.push(m)
    chars += m.text.length
  }
  return out.sort((a, b) => a.createdAt - b.createdAt).map(m => `[${m.id}] ${m.text}`)
}

export function memoryHash(parts: string[]): string {
  return sha1(parts.join('\n')).slice(0, 10)
}

export function memoryStats() {
  const count = (o: Record<string, MemEntry[]>) => Object.values(o).reduce((a, l) => a + l.length, 0)
  return { users: Object.keys(store.data.user).length, groups: Object.keys(store.data.group).length, entries: count(store.data.user) + count(store.data.group) }
}
