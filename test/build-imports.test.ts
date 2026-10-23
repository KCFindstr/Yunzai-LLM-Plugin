import { PLUGIN_ROOT } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'

it('ships a runnable native SQLite import instead of requesting an npm sqlite package', async () => {
  const bundle = fs.readFileSync(path.join(PLUGIN_ROOT, 'dist/index.js'), 'utf8')
  const imports = [...bundle.matchAll(/from\s+["']((?:node:)?sqlite)["']/g)].map(match => match[1])
  assert.deepEqual(imports, ['node:sqlite'])
  // Resolve the exact shipped specifier without importing the bot's side-effectful startup module.
  const { DatabaseSync } = await import(imports[0])
  const db = new DatabaseSync(':memory:')
  try { assert.equal(db.prepare('SELECT 42 AS value').get().value, 42) }
  finally { db.close() }
})
