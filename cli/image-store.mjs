import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Mount only the persistent image store, never a Windows drive or the bot directory. */
export function provisionImageStore(distro, root) {
  const source = path.resolve(process.env.YZ_LLM_DATA_DIR || path.join(root, 'data'), 'images')
  fs.mkdirSync(source, { recursive: true })
  const quoted = "'" + source.replaceAll("'", "'\\''") + "'"
  const mount = `#!/bin/sh
set -eu
mkdir -p /var/lib/llm-images
mountpoint -q /var/lib/llm-images || mount -t drvfs ${quoted} /var/lib/llm-images -o ro,uid=0,gid=0,umask=022,nosuid,nodev,noexec
`
  const script = "set -eu\ninstall -d -m 755 /opt/llm-images\ncat > /opt/llm-images/mount.sh <<'IMAGE_MOUNT_EOF'\n" + mount + 'IMAGE_MOUNT_EOF\nchmod 755 /opt/llm-images/mount.sh\n/opt/llm-images/mount.sh\n'
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', 'sh', '-s'], { input: script, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw Error(result.stderr || 'Global image mount failed')
}
