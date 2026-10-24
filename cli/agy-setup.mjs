import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distro = process.argv[2] || 'yunzai-llm-sandbox'
if (!/^[\w.-]+$/.test(distro)) throw Error('Invalid distro')
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
function wsl(args, input) {
  const result = spawnSync('wsl.exe', ['-d', distro, '-u', 'root', '-e', ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 180000 })
  if (result.status !== 0) throw Error(result.stderr || 'WSL setup failed')
  return result.stdout
}
const share = path.join(root, 'data', 'shared-attachments')
fs.mkdirSync(share, { recursive: true })
// Share exactly this folder; WSL drive automount and Windows interop remain disabled.
const source = share.replaceAll("'", "'\\''")
const mount = `#!/bin/sh
set -eu
mkdir -p /var/lib/llm-desktop/agy-share /var/lib/llm-desktop/disk/work/attachments
mountpoint -q /var/lib/llm-desktop/agy-share || mount -t drvfs '${source}' /var/lib/llm-desktop/agy-share -o metadata,uid=2001,gid=2001,umask=007,nosuid,nodev
if [ ! -f /var/lib/llm-desktop/agy-share/.initialized ]; then
  cp -a /var/lib/llm-desktop/disk/work/attachments/. /var/lib/llm-desktop/agy-share/
  touch /var/lib/llm-desktop/agy-share/.initialized
fi
mountpoint -q /var/lib/llm-desktop/disk/work/attachments || mount --bind /var/lib/llm-desktop/agy-share /var/lib/llm-desktop/disk/work/attachments
`
wsl(['sh', '-c', 'install -d -m 755 /opt/llm-agy; cat > /opt/llm-agy/mount.sh; chmod 755 /opt/llm-agy/mount.sh'], mount)
wsl(['sh', '-c', 'mkdir -p /etc/systemd/system/llm-desktop.service.d; cat > /etc/systemd/system/llm-desktop.service.d/agy-share.conf'], '[Service]\nExecStartPre=/opt/llm-agy/mount.sh\n')
wsl(['sh', '-c', 'install -d -m 755 /opt/llm-agy; cat > /opt/llm-agy/exec.py; chmod 644 /opt/llm-agy/exec.py'], fs.readFileSync(path.join(root, 'desktop/agy-exec.py')))
wsl(['sh', '-c', 'cat > /opt/llm-agy/google-image-search.py; chmod 644 /opt/llm-agy/google-image-search.py'], fs.readFileSync(path.join(root, 'desktop/agy-google-search.py')))
wsl(['sh', '-c', 'test -d /usr/local/lib/agy-browser/playwright || python3 -m pip install --target /usr/local/lib/agy-browser playwright==1.55.0 >/tmp/agy-browser-setup.log 2>&1'])
const firewall = `#!/bin/sh
set -e
id agy-worker >/dev/null 2>&1 || useradd -u 2002 -M -s /usr/sbin/nologin agy-worker
iptables -D OUTPUT -m owner --uid-owner 2002 -j LLMAGY 2>/dev/null || true
iptables -F LLMAGY 2>/dev/null || iptables -N LLMAGY
iptables -A OUTPUT -m owner --uid-owner 2002 -j LLMAGY
DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
[ -z "$DNS" ] || { iptables -A LLMAGY -d "$DNS" -p udp --dport 53 -j ACCEPT; iptables -A LLMAGY -d "$DNS" -p tcp --dport 53 -j ACCEPT; }
iptables -A LLMAGY -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do iptables -A LLMAGY -d "$network" -j REJECT; done
iptables -A LLMAGY -p tcp -m multiport --dports 25,465,587 -j REJECT
iptables -A LLMAGY -j ACCEPT
ip6tables -D OUTPUT -m owner --uid-owner 2002 -j REJECT 2>/dev/null || true
ip6tables -A OUTPUT -m owner --uid-owner 2002 -j REJECT
`
wsl(['sh', '-c', 'cat > /opt/llm-agy/firewall.sh; chmod 755 /opt/llm-agy/firewall.sh'], firewall)
const service = `[Unit]
Description=AGY scoped sandbox firewall
After=network.target llm-desktop.service
Requires=llm-desktop.service
[Service]
Type=oneshot
ExecStart=/opt/llm-agy/firewall.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
`
wsl(['sh', '-c', 'cat > /etc/systemd/system/llm-agy.service; systemctl daemon-reload; systemctl enable --now llm-agy.service'], service)
wsl(['sh', '-c', '/opt/llm-agy/mount.sh; systemctl restart llm-desktop.service; systemctl restart llm-agy.service'])
console.log('AGY filesystem broker and public-network firewall installed in the existing bot VM.')
