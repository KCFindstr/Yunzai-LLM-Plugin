import assert from 'node:assert/strict'
import { it } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { agyOperation } from '../cli/agy-arguments.mjs'

it('accepts command and the cmd alias without silently changing or coercing commands', () => {
  assert.deepEqual(agyOperation('exec', { cmd: 'ls -la /work' }), { op: 'exec', command: 'ls -la /work' })
  assert.deepEqual(agyOperation('exec', { command: 'printf ok', cmd: 'wrong' }), { op: 'exec', command: 'printf ok' })
  for (const args of [{}, { command: '' }, { command: '  ' }, { command: 1 }, { command: ['ls'] }, { command: null, cmd: 'ls' }, null]) assert.match(agyOperation('exec', args).error, /arguments|command/i)
  assert.match(agyOperation('exec', { command: 'a'.repeat(24001) }).error, /limit/)
  assert.deepEqual(agyOperation('read_image', { path: '/work/image.png' }), { op: 'image', path: '/work/image.png' })
  assert.ok(agyOperation('read_image', {}).error)
  assert.match(agyOperation('google_image_search', { path: '/work/image.jpg' }).error, /Unknown tool/)
  assert.ok(agyOperation('google_image_search', { path: 1 }).error)
})

it('returns an actionable MCP error for missing arguments without needing the VM', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/agy-mcp.mjs', import.meta.url)), 'nonexistent-test-distro', 'aabbccddee'], { windowsHide: true })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', text => { output += text })
  const closed = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: { wrong: 'ls' } } }) + '\n')
  assert.equal(await closed, 0)
  const result = JSON.parse(output).result
  assert.equal(result.isError, true)
  assert.match(JSON.parse(result.content[0].text).error, /requires.*command/)
  assert.ok(!output.includes('Sandbox operation failed'))
})
