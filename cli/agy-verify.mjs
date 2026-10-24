// Live smoke test; invokes the configured host CLI, without sending a chat message.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.YZ_LLM_PLUGIN_DIR = root
process.env.YZ_LLM_DATA_DIR = path.join(root, 'data')
const { runAgy } = await import('../src/agy/runtime.ts')
const result = await runAgy({ id: 'aabbccddee', owner: 'verify', createdAt: Date.now(), updatedAt: Date.now(), status: 'running', task: `Use agy-sandbox exec, and actually execute a Python script that verifies: /work is writable; /home/pc, /mnt/c, /control, /opt/llm-agy and /var/lib/llm-desktop do not exist; public HTTPS https://example.com can be fetched; http://127.0.0.1:9223 cannot be connected; Python Playwright can import and start Chromium headless and load https://example.com. Write the boolean results as /work/verification.json. Output only the boolean results; do not assume success. Do not use native tools.` }, { distro: 'yunzai-llm-sandbox', executable: '', maxMinutes: 2, maxQueue: 8 }, new AbortController().signal, {}, event => {
  if (event.event === 'diagnostic') console.error(event.text)
  else if (event.event === 'init') console.log('CLI initialized', event.init?.permission_mode)
})
console.log(result.report)
