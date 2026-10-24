// Minimal stdio MCP transport; no model-controlled host paths or executable names.
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { agyOperation } from './agy-arguments.mjs'
const [distro, job] = process.argv.slice(2)
if (!/^[\w.-]+$/.test(distro ?? '') || !/^[a-f0-9]{10}$/.test(job ?? '')) process.exit(2)
const tools = [{ name: 'exec', description: 'Run Bash/Python/curl/Chromium in the isolated Linux sandbox. Pass {"command":"..."}, for example {"command":"ls -la /work"}. Only /work persists and is shared with the bot VM. Internet is available; host, other jobs, bot files and personal profiles are inaccessible. Use /opt/google/chrome/chrome --headless --no-sandbox with a profile under /work for browsing. Each command has a 55 second limit.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }]
tools.push({ name: 'read_image', description: 'View an image file in /work as native image content. Use for original attachments or browser screenshots. Image viewing consumes vision tokens. No host paths or other job folders are accessible.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to /work, or an absolute path under /work' } }, required: ['path'], additionalProperties: false } })
function execute(operation) {
  return new Promise(resolve => {
    const child = spawn('C:\\Windows\\System32\\wsl.exe', ['-d', distro, '-u', 'root', '-e', 'python3', '/opt/llm-agy/exec.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''; let done = false
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { child.kill(); finish({ error: 'Sandbox timeout' }) }, 65000)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 7100000) { child.kill(); finish({ error: 'Output limit' }) } })
    child.on('error', () => finish({ error: 'Sandbox unavailable' }))
    child.on('close', () => { try { finish(JSON.parse(output)) } catch { finish({ error: 'Invalid sandbox response' }) } })
    child.stdin.on('error', () => finish({ error: 'Sandbox request could not be sent' }))
    child.stdin.end(JSON.stringify({ ...operation, job }))
  })
}
const lines = readline.createInterface({ input: process.stdin })
for await (const line of lines) {
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  let result
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agy-sandbox', version: '1.0.0' } }
  else if (request.method === 'tools/list') result = { tools }
  else if (request.method === 'ping') result = {}
  else if (request.method === 'tools/call' && ['exec', 'read_image'].includes(request.params?.name)) {
    const image = request.params.name === 'read_image'
    const operation = agyOperation(request.params.name, request.params.arguments)
    const response = operation.error ? operation : await execute(operation)
    const { image: screenshot, ...textResponse } = response
    result = { content: image && response.data ? [{ type: 'image', data: response.data, mimeType: response.mimeType }] : [{ type: 'text', text: JSON.stringify(textResponse) }], isError: Boolean(response.error) || (typeof response.exitCode === 'number' && response.exitCode !== 0) }
    if (screenshot?.data) result.content.push({ type: 'image', data: screenshot.data, mimeType: screenshot.mimeType })
  } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }) + '\n'); continue }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
