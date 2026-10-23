import './helpers.ts'
import assert from 'node:assert/strict'
import { it } from 'node:test'

process.env.YZ_LLM_DEBUG = '1'
const { log, recentLogs } = await import('../src/core/log.ts')
const { routes } = await import('../src/web/api.ts')

it('filters retained logs by exact level and case-insensitive literal content', async () => {
  log.info('fixture Healthy database')
  log.error('fixture Database FAILURE [a+b]')
  log.warn('fixture Network slow')
  assert.deepEqual(recentLogs(0, 'error', 'database').map(line => line.text), ['fixture Database FAILURE [a+b]'])
  assert.equal(recentLogs(0, undefined, '[a+b]').length, 1, 'search text is not treated as a regex')
  const last = recentLogs().at(-1)!.seq
  assert.deepEqual(recentLogs(last, undefined, 'fixture'), [])
  const route = routes.find(route => route.method === 'GET' && route.pattern.test('/api/logs'))!
  const result = await route.run({ params: [], query: new URLSearchParams({ level: 'warn', q: 'NETWORK' }), body: undefined })
  assert.deepEqual((result as any[]).map(line => line.text), ['fixture Network slow'])
})

it('keeps verbose debug lines at debug level in the web console', () => {
  log.debug('fixture debug detail')
  assert.equal(recentLogs(0, 'debug', 'fixture debug detail').length, 1)
  assert.equal(recentLogs(0, 'info', 'fixture debug detail').length, 0)
})
