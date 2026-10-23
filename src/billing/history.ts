import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { DATA_DIR } from '../core/paths.ts'
import type { ModelConfig } from '../core/configTypes.ts'
import type { Usage } from '../llm/types.ts'
import { resolvePrice, type Price } from './pricing.ts'

let connection: DatabaseSync | undefined
let insert: StatementSync
function database() {
  if (connection) return connection
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(path.join(DATA_DIR, 'usage.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT OR IGNORE INTO usage_meta VALUES ('startedAt', ${Date.now()});
  CREATE TABLE IF NOT EXISTS usage_calls (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, model TEXT NOT NULL,
    provider TEXT NOT NULL, upstream_model TEXT NOT NULL, usage_json TEXT,
    price_json TEXT, cost REAL NOT NULL, input REAL NOT NULL, output REAL NOT NULL,
    cache_read REAL NOT NULL, cache_write REAL NOT NULL, cache_write_1h REAL NOT NULL,
    reasoning REAL NOT NULL, searches REAL NOT NULL, incomplete INTEGER NOT NULL,
    missing_usage INTEGER NOT NULL, input_cost REAL NOT NULL, output_cost REAL NOT NULL,
    cached_cost REAL NOT NULL, other_cost REAL NOT NULL, unattributed_cost REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls(at);
  CREATE INDEX IF NOT EXISTS usage_calls_model_at ON usage_calls(model, at);`)
  insert = db.prepare(`INSERT INTO usage_calls
  (at, model, provider, upstream_model, usage_json, price_json, cost, input, output,
   cache_read, cache_write, cache_write_1h, reasoning, searches, incomplete, missing_usage,
   input_cost, output_cost, cached_cost, other_cost, unattributed_cost)
  VALUES (${Array(21).fill('?').join(',')})`)
  connection = db
  return db
}

/** Snapshot rates and full upstream usage now; later config changes cannot rewrite past costs. */
export function recordUsageCall(model: ModelConfig, cost: number, usage?: Usage, priceOverride?: Price) {
  database()
  const price = priceOverride ?? (usage ? resolvePrice(model) : undefined)
  const attributable = usage && price && usage.cost == null
  const inputCost = attributable ? usage.input * price.input / 1e6 : 0
  const outputCost = attributable ? usage.output * price.output / 1e6 : 0
  const cachedCost = attributable ? (usage.cacheRead * (price.cacheRead ?? price.input * 0.5)
    + usage.cacheWrite * (price.cacheWrite ?? price.input * 1.25)
    + usage.cacheWrite1h * (price.cacheWrite1h ?? price.input * 2)) / 1e6 : 0
  const otherCost = attributable ? usage.webSearches * (price.perSearch ?? 0) + (price.perRequest ?? 0) : 0
  insert.run(Date.now(), model.id, model.provider, model.model, usage ? JSON.stringify(usage) : null,
    price ? JSON.stringify(price) : null, cost, usage?.input ?? 0, usage?.output ?? 0,
    usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0, usage?.cacheWrite1h ?? 0,
    usage?.reasoning ?? 0, usage?.webSearches ?? 0, usage?.inputIncomplete ? 1 : 0, usage ? 0 : 1,
    inputCost, outputCost, cachedCost, otherCost, attributable ? cost - inputCost - outputCost - cachedCost - otherCost : cost)
}

export function queryUsageCalls(from: number, to: number, model?: string) {
  const db = database()
  const where = 'at >= ? AND at < ?' + (model ? ' AND model = ?' : '')
  const rows = db.prepare(`SELECT model, COUNT(*) AS calls, SUM(cost) AS cost,
    SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
    SUM(cache_write) AS cacheWrite, SUM(cache_write_1h) AS cacheWrite1h,
    SUM(reasoning) AS reasoning, SUM(searches) AS webSearches,
    SUM(incomplete) AS incompleteCalls, SUM(missing_usage) AS missingUsageCalls,
    SUM(input_cost) AS inputCost, SUM(output_cost) AS outputCost, SUM(cached_cost) AS cachedCost,
    SUM(other_cost) AS otherCost, SUM(unattributed_cost) AS unattributedCost
    FROM usage_calls WHERE ${where} GROUP BY model ORDER BY cost DESC`)
    .all(...(model ? [from, to, model] : [from, to]))
  const models = db.prepare('SELECT DISTINCT model FROM usage_calls ORDER BY model').all().map(row => row.model)
  const startedAt = db.prepare("SELECT value FROM usage_meta WHERE key = 'startedAt'").get()!.value
  return { from, to, startedAt, models, rows }
}

export function resetUsageCalls(models?: string[]) {
  const db = database()
  if (!models) { db.exec('DELETE FROM usage_calls'); return }
  const remove = db.prepare('DELETE FROM usage_calls WHERE model = ?')
  db.exec('BEGIN')
  try { for (const model of models) remove.run(model); db.exec('COMMIT') }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
