// Live smoke test; invokes the configured host CLI, without sending a chat message.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.YZ_LLM_PLUGIN_DIR = root
const { runAgy } = await import('../src/agy/runtime.ts')
const result = await runAgy({ id: 'aabbccddee', owner: 'verify', createdAt: Date.now(), updatedAt: Date.now(), status: 'running', task: `Use your native host tools to write out/verification.json containing {"host":"Windows","native_tools":true}. Read the file back and report its exact contents and bot output alias. Do not use WSL or a VM.` }, { enable: true, access: 'admin', executable: '', maxMinutes: 2, maxQueue: 8 }, new AbortController().signal, {}, event => {
  if (event.event === 'diagnostic') console.error(event.text)
  else if (event.event === 'init') console.log('CLI initialized', event.init?.permission_mode)
})
console.log(result.report)
