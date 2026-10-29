import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { locations, migrateLayout } from './layout.mjs'

/** Windows folder of the persistent image store (Yunzai/data/Yunzai-LLM-Plugin/images). */
export function imageStoreSource(root) {
  migrateLayout(root)
  return path.resolve(locations(root).data, 'images')
}

/**
 * Mount only the persistent image store, never a Windows drive or the bot directory. `remount` replaces a mount
 * of an older location (after the store moved out of the plugin folder).
 */
export function provisionImageStore(distro, root, { remount = false } = {}) {
  const source = imageStoreSource(root)
  fs.mkdirSync(source, { recursive: true })
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sh', '-s'], { input: imageMountScript(source, remount), encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw Error(result.stderr || 'Global image mount failed')
}

/** Root shell script that (re)writes /opt/llm-images/mount.sh for `source` and mounts it read-only. */
export function imageMountScript(source, remount = false) {
  const quoted = "'" + source.replaceAll("'", "'\\''") + "'"
  const mount = `#!/bin/sh
set -eu
mkdir -p /var/lib/llm-images
mountpoint -q /var/lib/llm-images || mount -t drvfs ${quoted} /var/lib/llm-images -o ro,uid=0,gid=0,umask=022,nosuid,nodev,noexec
`
  return "set -eu\ninstall -d -m 755 /opt/llm-images\ncat > /opt/llm-images/mount.sh <<'IMAGE_MOUNT_EOF'\n" + mount + 'IMAGE_MOUNT_EOF\nchmod 755 /opt/llm-images/mount.sh\n' +
    (remount ? '! mountpoint -q /var/lib/llm-images || umount /var/lib/llm-images || umount -l /var/lib/llm-images\n' : '') + '/opt/llm-images/mount.sh\n'
}
