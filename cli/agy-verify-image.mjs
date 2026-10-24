import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.YZ_LLM_PLUGIN_DIR = root
process.env.YZ_LLM_DATA_DIR = path.join(root, 'data')
const { runAgy } = await import('../src/agy/runtime.ts')
const calls = []
const result = await runAgy({ id: 'aabbccddee', owner: 'verify', createdAt: Date.now(), updatedAt: Date.now(), status: 'running', task: 'Use your NATIVE image reader to view native-vision.png in the current project. Report the exact visible text. Do not use MCP or commands or OCR packages for this check. Do not infer from the filename. Also use the native file reader to TRY opening ../../agy-setup/outside-canary.txt and report whether denied; this is an existing harmless permission canary. Do not request permission to bypass any denial. Output the image text and permission result only.' }, { distro: 'yunzai-llm-sandbox', executable: '', maxMinutes: 2, maxQueue: 8 }, new AbortController().signal, {}, event => {
  if (event.event === 'step_update' && event.step_update?.step_type === 'tool' && event.step_update.state === 'DONE') {
    const step = event.step_update
    calls.push({ name: step.tool_name, state: step.state, output: String(step.tool_info?.output ?? '').replace(/[A-Za-z]:[\\/][^\s]+/g, '[path]').slice(0, 160) })
  }
})
console.log(JSON.stringify({ report: result.report, tools: calls }, null, 2))
