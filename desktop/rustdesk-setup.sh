#!/bin/bash
# Install the client for the existing isolated desktop. Do not install RustDesk's root system service.
set -euo pipefail
test "$(id -u)" = 0
test -f /opt/llm-desktop/client.py
version=1.5.0
checksum=4e2b9701d25a7ef373f3d09bda584a37d6902f97a6ab15f2e86d4a5783e2a0ec
package="/var/lib/llm-desktop/rustdesk-${version}-x86_64.deb"
test "$(dpkg --print-architecture)" = amd64
if ! test -f "$package"; then
  curl -fsSL --retry 2 --max-time 120 -o "$package" "https://github.com/rustdesk/rustdesk/releases/download/${version}/rustdesk-${version}-x86_64.deb"
fi
printf '%s  %s\n' "$checksum" "$package" | sha256sum --check
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends libxdo3 libva-drm2 libva-x11-2 libgstreamer-plugins-base1.0-0 gstreamer1.0-pipewire libayatana-appindicator3-1 >/dev/null
# Extract only the application files. Package post-install hooks and the privileged service are not run.
unpacked=$(mktemp -d /var/lib/llm-desktop/rustdesk-unpack.XXXXXX)
trap 'rm -rf -- "$unpacked"' EXIT
dpkg-deb -x "$package" "$unpacked"
test -f "$unpacked/usr/share/rustdesk/rustdesk"
cp -a "$unpacked/usr/share/rustdesk" /usr/share/
ln -sfn /usr/share/rustdesk/rustdesk /usr/local/bin/rustdesk
install -d -m 755 /usr/local/lib/llm-desktop
printf '%s\n' "$version" > /usr/local/lib/llm-desktop/rustdesk-version
chmod 644 /usr/local/lib/llm-desktop/rustdesk-version
# Safe staging state: registration is stopped and there is no fallback to public rendezvous servers.
home=/var/lib/llm-desktop/disk/home
mountpoint -q /var/lib/llm-desktop/disk
install -d -m 700 -o pc -g pc "$home/.config/rustdesk" "$home/.config/llm-desktop"
if ! test -e "$home/.config/rustdesk/RustDesk2.toml"; then
  cat > "$home/.config/rustdesk/RustDesk2.toml" <<'CONFIG'
rendezvous_server = 'pending.invalid:21116'
nat_type = 0
serial = 0

[options]
custom-rendezvous-server = 'pending.invalid:21116'
relay-server = 'pending.invalid:21117'
stop-service = 'Y'
enable-lan-discovery = 'N'
CONFIG
  chown pc:pc "$home/.config/rustdesk/RustDesk2.toml"
  chmod 600 "$home/.config/rustdesk/RustDesk2.toml"
fi
touch "$home/.config/llm-desktop/rustdesk-enabled"
chown pc:pc "$home/.config/llm-desktop/rustdesk-enabled"
printf 'RustDesk %s application installed; custom server configuration pending.\n' "$version"
