import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.YZ_LLM_PLUGIN_DIR = root
const { runAgy } = await import('../src/agy/runtime.ts')
if (!process.argv[2]) throw Error('Usage: node cli/agy-verify-image.mjs <bot image path>')
const calls = []
const result = await runAgy({ id: 'aabbccddee', owner: 'verify', createdAt: Date.now(), updatedAt: Date.now(), status: 'running', task: `Use your native image reader to view this bot image alias using the path mapping in the prompt: ${process.argv[2]}. Report what is actually visible. Do not infer from the filename.` }, { enable: true, access: 'admin', executable: '', maxMinutes: 2, maxQueue: 8 }, new AbortController().signal, {}, event => {
  if (event.event === 'step_update' && event.step_update?.step_type === 'tool' && event.step_update.state === 'DONE') {
    const step = event.step_update
    calls.push({ name: step.tool_name, state: step.state, output: String(step.tool_info?.output ?? '').replace(/[A-Za-z]:[\\/][^\s]+/g, '[path]').slice(0, 160) })
  }
})
console.log(JSON.stringify({ report: result.report, tools: calls }, null, 2))
