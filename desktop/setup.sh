#!/bin/bash
set -euo pipefail
test -f /opt/llm-sandbox/runner.py
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb openbox tint2 xterm feh xclip scrot dbus-x11 python3-pil python3-pyautogui python3-pyperclip python3-websocket ffmpeg fonts-noto-cjk >/dev/null
id pc >/dev/null 2>&1 || useradd -r -u 2001 -m -d /home/pc -s /bin/bash pc
install -d -m 700 /opt/llm-desktop /var/lib/llm-desktop
chmod 711 /var/lib/llm-desktop
install -d -m 700 -o pc -g pc /var/lib/llm-desktop/{home,work,control}
systemctl stop llm-desktop.service 2>/dev/null || true
if [ ! -f /var/lib/llm-desktop/desktop.ext4 ]; then
  truncate -s 4G /var/lib/llm-desktop/desktop.ext4
  mkfs.ext4 -q -m 0 /var/lib/llm-desktop/desktop.ext4
fi
install -d -m 755 /var/lib/llm-desktop/disk
mountpoint -q /var/lib/llm-desktop/disk || mount -o loop,nosuid,nodev /var/lib/llm-desktop/desktop.ext4 /var/lib/llm-desktop/disk
install -d -m 700 -o pc -g pc /var/lib/llm-desktop/disk/{home,work}
if [ ! -f /var/lib/llm-desktop/disk/.initialized ]; then
  cp -a /var/lib/llm-desktop/home/. /var/lib/llm-desktop/disk/home/
  cp -a /var/lib/llm-desktop/work/. /var/lib/llm-desktop/disk/work/
  touch /var/lib/llm-desktop/disk/.initialized
fi
install -d -m 755 /usr/local/lib/llm-desktop
printf 'Amatsukaze\n' > /usr/local/lib/llm-desktop/hostname
printf '127.0.0.1 localhost\n127.0.1.1 Amatsukaze\n::1 localhost\n' > /usr/local/lib/llm-desktop/hosts
chmod 644 /usr/local/lib/llm-desktop/{hostname,hosts}
# Regular Google Chrome; its package adds Google's apt repo, so `apt-get upgrade` keeps it current
if ! dpkg -s google-chrome-stable >/dev/null 2>&1; then
  curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/google-chrome.deb >/dev/null
  rm -f /tmp/google-chrome.deb
fi
printf '/opt/google/chrome/google-chrome\n' > /usr/local/lib/llm-desktop/chrome-path
rm -rf /usr/local/lib/llm-desktop/browsers
chmod -R a+rX /usr/local/lib/llm-desktop
cat > /opt/llm-desktop/start.sh <<'START'
#!/bin/bash
set -euo pipefail
exec setpriv --reuid=pc --regid=pc --clear-groups --no-new-privs \
 bwrap --unshare-all --share-net --hostname Amatsukaze --new-session --die-with-parent \
 --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /opt/google /opt/google --ro-bind /usr/local/lib/llm-desktop/hostname /etc/hostname --ro-bind /usr/local/lib/llm-desktop/hosts /etc/hosts \
 --dir /mnt/wsl --ro-bind /usr/local/lib/llm-desktop/resolv.conf /mnt/wsl/resolv.conf --symlink usr/bin /bin --symlink usr/sbin /sbin \
 --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run \
 --bind /var/lib/llm-desktop/disk/home /home/pc --bind /var/lib/llm-desktop/disk/work /work \
 --ro-bind /var/lib/llm-images /work/attachments \
 --bind /var/lib/llm-desktop/control /control --chdir /work --clearenv \
 --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /home/pc --setenv USER pc \
 --setenv LANG C.UTF-8 --setenv DISPLAY :99 --setenv TZ Asia/Tokyo \
 python3 /usr/local/lib/llm-desktop/server.py
START
chmod 700 /opt/llm-desktop/start.sh
cat > /opt/llm-desktop/firewall.sh <<'FIREWALL'
#!/bin/sh
set -e
USER_ID=$(id -u pc)
iptables -D OUTPUT -m owner --uid-owner "$USER_ID" -j LLMPC 2>/dev/null || true
iptables -F LLMPC 2>/dev/null || iptables -N LLMPC
iptables -A OUTPUT -m owner --uid-owner "$USER_ID" -j LLMPC
DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
[ -n "$DNS" ] && for protocol in udp tcp; do iptables -A LLMPC -d "$DNS" -p "$protocol" --dport 53 -j ACCEPT; done
iptables -A LLMPC -d 127.0.0.1 -p tcp --dport 9223 -j ACCEPT
iptables -A LLMPC -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
 iptables -A LLMPC -d "$network" -j REJECT
done
iptables -A LLMPC -p tcp -m multiport --dports 25,465,587 -j REJECT
iptables -A LLMPC -j ACCEPT
ip6tables -D OUTPUT -m owner --uid-owner "$USER_ID" -j REJECT 2>/dev/null || true
ip6tables -A OUTPUT -m owner --uid-owner "$USER_ID" -j REJECT
FIREWALL
chmod 700 /opt/llm-desktop/firewall.sh
cat > /etc/systemd/system/llm-desktop.service <<'SERVICE'
[Unit]
Description=Persistent isolated pixel desktop for Yunzai
After=network-online.target
[Service]
ExecStartPre=/opt/llm-images/mount.sh
ExecStartPre=/opt/llm-desktop/firewall.sh
ExecStartPre=/bin/sh -c 'mountpoint -q /var/lib/llm-desktop/disk || mount -o loop,nosuid,nodev /var/lib/llm-desktop/desktop.ext4 /var/lib/llm-desktop/disk'
ExecStartPre=/bin/sh -c 'cat /etc/resolv.conf > /usr/local/lib/llm-desktop/resolv.conf; chmod 644 /usr/local/lib/llm-desktop/resolv.conf'
ExecStartPre=/bin/sh -c 'rm -f /var/lib/llm-desktop/disk/home/browser/SingletonLock /var/lib/llm-desktop/disk/home/browser/SingletonSocket /var/lib/llm-desktop/disk/home/browser/SingletonCookie'
ExecStart=/opt/llm-desktop/start.sh
Restart=on-failure
RestartSec=3
MemoryMax=3G
MemorySwapMax=0
# Browser tabs plus RustDesk share this budget, including all their threads.
TasksMax=2048
CPUQuota=200%
LimitFSIZE=1073741824
UMask=0077
[Install]
WantedBy=multi-user.target
SERVICE
