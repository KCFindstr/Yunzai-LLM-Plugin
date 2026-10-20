import { config } from '../core/config.ts'
import type { Limits, ModelConfig, QuotaScope } from '../core/configTypes.ts'
import { JsonStore } from '../core/store.ts'
import type { Usage } from '../llm/types.ts'

export const WINDOW_5H = 5 * 3600_000
export const WINDOW_WEEK = 7 * 24 * 3600_000
const KEEP = WINDOW_WEEK + 3600_000

interface Totals {
  cost: number
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

interface LedgerData {
  v: 1
  /** "user:123|modelId" -> [[ts, usd], ...] ascending */
  entries: Record<string, [number, number][]>
  /** all-time per model */
  totals: Record<string, Totals>
  /** "YYYY-MM-DD" -> modelId -> usd */
  daily: Record<string, Record<string, number>>
}

const store = new JsonStore<LedgerData>('usage.json', { v: 1, entries: {}, totals: {}, daily: {} })

export interface QuotaCtx {
  userId?: string | number
  groupId?: string | number
  isAdmin?: boolean
}

export interface QuotaBlock {
  scope: QuotaScope
  window: '5h' | 'week'
  used: number
  limit: number
  resetInMs: number
}

const SCOPES: QuotaScope[] = ['user', 'group', 'global']

function scopeKey(scope: QuotaScope, ctx: QuotaCtx, modelId: string): string | undefined {
  if (scope === 'global') return `global|${modelId}`
  if (scope === 'group') return ctx.groupId != null ? `group:${ctx.groupId}|${modelId}` : undefined
  return ctx.userId != null ? `user:${ctx.userId}|${modelId}` : undefined
}

function prune(list: [number, number][], now = Date.now()) {
  let i = 0
  while (i < list.length && list[i][0] < now - KEEP) i++
  if (i) list.splice(0, i)
}

function dayKey(ts = Date.now()): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10)
}

export function limitsFor(model: ModelConfig, scope: QuotaScope): Limits {
  const q = model.quota ?? {}
  const explicit = q[scope] ?? {}
  const shorthandScope = q.scope ?? config.get().quota.defaultScope
  const short: Limits = shorthandScope === scope ? { window5h: q.window5h, weekly: q.weekly } : {}
  return { window5h: explicit.window5h ?? short.window5h, weekly: explicit.weekly ?? short.weekly }
}

export function usedIn(key: string, windowMs: number, now = Date.now()): number {
  const list = store.data.entries[key]
  if (!list) return 0
  let sum = 0
  for (let i = list.length - 1; i >= 0 && list[i][0] > now - windowMs; i--) sum += list[i][1]
  return sum
}

/** Time until usage within the window drops below `limit`. */
function resetIn(key: string, windowMs: number, limit: number, now = Date.now()): number {
  const list = store.data.entries[key] ?? []
  let used = usedIn(key, windowMs, now)
  for (const [ts, cost] of list) {
    if (ts <= now - windowMs) continue
    used -= cost
    if (used < limit) return ts + windowMs - now
  }
  return 0
}

/** First exhausted limit for this model + requester, or undefined if the call may proceed. */
export function checkQuota(model: ModelConfig, ctx: QuotaCtx): QuotaBlock | undefined {
  const exempt = ctx.isAdmin && config.get().quota.exemptAdmins
  const now = Date.now()
  for (const scope of SCOPES) {
    if (exempt && scope !== 'global') continue
    const key = scopeKey(scope, ctx, model.id)
    if (!key) continue
    const lim = limitsFor(model, scope)
    const windows: [QuotaBlock['window'], number, number | null | undefined][] = [
      ['5h', WINDOW_5H, lim.window5h],
      ['week', WINDOW_WEEK, lim.weekly],
    ]
    for (const [name, ms, limit] of windows) {
      if (!limit || limit <= 0) continue
      const used = usedIn(key, ms, now)
      if (used >= limit) return { scope, window: name, used, limit, resetInMs: resetIn(key, ms, limit, now) }
    }
  }
  return undefined
}

let lastPrune = 0

/** Hourly: drop window lists whose newest entry is older than the longest window. */
function pruneStale(now: number) {
  if (now - lastPrune < 3600_000) return
  lastPrune = now
  for (const [k, list] of Object.entries(store.data.entries)) if (!list.length || list[list.length - 1][0] < now - KEEP) delete store.data.entries[k]
}

export function record(model: ModelConfig, ctx: QuotaCtx, cost: number, usage?: Usage) {
  const now = Date.now()
  const d = store.data
  pruneStale(now)
  if (cost > 0)
    for (const scope of SCOPES) {
      const key = scopeKey(scope, ctx, model.id)
      if (!key) continue
      const list = (d.entries[key] ??= [])
      prune(list, now)
      list.push([now, cost])
    }
  const t = (d.totals[model.id] ??= { cost: 0, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  t.cost += cost
  t.calls++
  if (usage) {
    t.input += usage.input
    t.cacheRead += usage.cacheRead
    t.cacheWrite += usage.cacheWrite + usage.cacheWrite1h
    t.output += usage.output
  }
  const day = (d.daily[dayKey(now)] ??= {})
  day[model.id] = (day[model.id] ?? 0) + cost
  const days = Object.keys(d.daily).sort()
  for (const k of days.slice(0, Math.max(0, days.length - 60))) delete d.daily[k]
  store.save()
}

export interface UsageSummary {
  scope: QuotaScope
  used5h: number
  usedWeek: number
  limits: Limits
  reset5h: number
  resetWeek: number
}

export function summarize(model: ModelConfig, scope: QuotaScope, ctx: QuotaCtx): UsageSummary | undefined {
  const key = scopeKey(scope, ctx, model.id)
  if (!key) return undefined
  const limits = limitsFor(model, scope)
  return {
    scope,
    used5h: usedIn(key, WINDOW_5H),
    usedWeek: usedIn(key, WINDOW_WEEK),
    limits,
    reset5h: limits.window5h ? resetIn(key, WINDOW_5H, limits.window5h) : 0,
    resetWeek: limits.weekly ? resetIn(key, WINDOW_WEEK, limits.weekly) : 0,
  }
}

export function totals() {
  return store.data.totals
}

export function daily(days = 7) {
  const out: [string, Record<string, number>][] = []
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86400_000)
    out.push([k, store.data.daily[k] ?? {}])
  }
  return out
}

/** Top spenders in a window across all models: [[userId, usd]]. */
export function topUsers(windowMs = WINDOW_WEEK, n = 10): [string, number][] {
  const sums = new Map<string, number>()
  for (const key of Object.keys(store.data.entries)) {
    if (!key.startsWith('user:')) continue
    const uid = key.slice(5, key.indexOf('|'))
    sums.set(uid, (sums.get(uid) ?? 0) + usedIn(key, windowMs))
  }
  return [...sums.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n)
}

export function resetUsage(target: { userId?: string; all?: boolean }) {
  const d = store.data
  for (const key of Object.keys(d.entries)) {
    if (target.all || (target.userId && key.startsWith(`user:${target.userId}|`))) delete d.entries[key]
  }
  store.save()
}
