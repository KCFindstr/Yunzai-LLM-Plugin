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

/**
 * Older desktop setups also mount <data>/shared-attachments through /opt/llm-agy/mount.sh (shown in the desktop as
 * /work/projects). After the data folder moved from `from` to `to`, repoint that script and restart the desktop so
 * it mounts the new folder. No-op when the script is absent or already current.
 */
export function legacyMountScript(from, to) {
  const q = s => "'" + String(s).replaceAll("'", "'\\''") + "'"
  return `set -eu
f=/opt/llm-agy/mount.sh
[ -f "$f" ] || exit 0
changed=$(python3 - "$f" ${q(from)} ${q(to)} <<'PY'
import sys
p, a, b = sys.argv[1:]
s = open(p).read()
t = s.replace(a.rstrip('\\\\') + '\\\\', b.rstrip('\\\\') + '\\\\')
if t != s:
    open(p, 'w').write(t)
print('yes' if t != s else 'no')
PY
)
[ "$changed" = yes ] || exit 0
umount -l /var/lib/llm-desktop/disk/work/attachments 2>/dev/null || true
umount -l /var/lib/llm-desktop/agy-share 2>/dev/null || true
systemctl restart llm-desktop.service 2>/dev/null || true
`
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
