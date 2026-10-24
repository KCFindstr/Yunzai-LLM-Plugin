import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32') throw Error('AGY requires a Windows host')
const executable = path.join(root, 'data/agy-setup/agy.exe')
if (!fs.existsSync(executable)) {
  const manifest = await (await fetch('https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json')).json()
  const url = new URL(manifest.url)
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || !String(manifest.sha512).match(/^[a-f0-9]{128}$/i)) throw Error('Invalid official CLI manifest')
  const response = await fetch(url)
  if (!response.ok) throw Error('CLI download failed')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha512').update(bytes).digest('hex') !== manifest.sha512.toLowerCase()) throw Error('CLI checksum mismatch')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, bytes)
}
console.log('Host AGY CLI ready: ' + executable)
console.log('Jobs use native --sandbox + --dangerously-skip-permissions (turbo), with full host access.')
console.log('Sign in to Antigravity using the Windows account that runs the bot. No WSL or desktop setup is needed.')
