import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../core/config.ts'

let child: ChildProcess | undefined
let enabled = false
let distro = ''

export function refreshComputerKeepalive() {
  const cfg = config.get().tools.computer
  if (process.platform !== 'win32' || !cfg.enable) { stopComputerKeepalive(); return }
  if (enabled && child && distro === cfg.distro) return
  stopComputerKeepalive()
  enabled = true
  distro = cfg.distro
  child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.once('close', () => {
    child = undefined
    if (enabled) setTimeout(refreshComputerKeepalive, 10000).unref()
  })
}

export function stopComputerKeepalive() {
  enabled = false
  const previous = child
  child = undefined
  previous?.removeAllListeners('close')
  previous?.kill()
}
