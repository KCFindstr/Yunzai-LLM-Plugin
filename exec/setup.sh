#!/bin/bash
# Provision the dedicated WSL distro used by the run_code tool. Idempotent; run as root inside the distro.
# Normally invoked by `npm run exec-setup`, which appends runner.py to this script via the RUNNER heredoc.
set -euo pipefail

# 1. Cut the distro off from Windows: no C:/D: mounts, no running .exe, no Windows PATH.
cat > /etc/wsl.conf <<'EOF'
[boot]
systemd=true
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[user]
default=root
EOF

# 2. Runtimes and tools available to sandboxed code.
export DEBIAN_FRONTEND=noninteractive
PKGS="bubblewrap iptables python3 python3-pip python3-venv python3-requests python3-numpy python3-bs4 python3-matplotlib
  python3-pandas nodejs npm curl ca-certificates jq bc fonts-noto-cjk unzip libnss3 libasound2t64"
MISSING=$(for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 || echo "$p"; done)
if [ -n "$MISSING" ]; then
  apt-get update -qq
  apt-get install -y -qq $MISSING >/dev/null
fi

# 3. Unprivileged user the code runs as.
id sbx >/dev/null 2>&1 || useradd -r -u 2000 -M -d /nonexistent -s /usr/sbin/nologin sbx
install -d -m 700 /opt/llm-sandbox
install -d -m 711 /var/lib/llm-sandbox  # sbx may traverse into its own run dir, not list others

# matplotlib: CJK-capable default font, font cache prebuilt (runner copies it into each run's HOME)
grep -q 'Noto Sans CJK' /etc/matplotlibrc 2>/dev/null ||
  printf '\nfont.sans-serif: Noto Sans CJK SC, Noto Sans CJK JP, DejaVu Sans\naxes.unicode_minus: False\n' >> /etc/matplotlibrc
install -d -m 755 /var/lib/llm-sandbox/mpl
MPLCONFIGDIR=/var/lib/llm-sandbox/mpl python3 -c 'import matplotlib.font_manager' 2>/dev/null || true
chmod -R a+rX /var/lib/llm-sandbox/mpl

# 4. Firewall for the sbx uid: public internet only. No host/LAN/loopback/metadata, no SMTP, rate-limited new connections.
cat > /opt/llm-sandbox/firewall.sh <<'EOF'
#!/bin/sh
UID_SBX=$(id -u sbx)
DNS=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
iptables -D OUTPUT -m owner --uid-owner "$UID_SBX" -j LLMSBX 2>/dev/null || true
iptables -F LLMSBX 2>/dev/null || iptables -N LLMSBX
iptables -A OUTPUT -m owner --uid-owner "$UID_SBX" -j LLMSBX
[ -n "$DNS" ] && for p in udp tcp; do iptables -A LLMSBX -d "$DNS" -p $p --dport 53 -j ACCEPT; done
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 \
           198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -A LLMSBX -d $net -j REJECT
done
iptables -A LLMSBX -p tcp -m multiport --dports 25,465,587 -j REJECT
iptables -A LLMSBX -m conntrack --ctstate NEW -m hashlimit --hashlimit-name llmsbx --hashlimit-mode srcip \
  --hashlimit-above 20/second --hashlimit-burst 40 -j REJECT
iptables -A LLMSBX -j ACCEPT
ip6tables -D OUTPUT -m owner --uid-owner "$UID_SBX" -j REJECT 2>/dev/null || true
ip6tables -A OUTPUT -m owner --uid-owner "$UID_SBX" -j REJECT
EOF
chmod 755 /opt/llm-sandbox/firewall.sh

cat > /etc/systemd/system/llm-sandbox-firewall.service <<'EOF'
[Unit]
Description=Firewall for Yunzai-LLM-Plugin code sandbox
After=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/llm-sandbox/firewall.sh
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable llm-sandbox-firewall.service >/dev/null 2>&1
/opt/llm-sandbox/firewall.sh

# 5. HTML renderer for render_html: puppeteer-core (same version as Yunzai's) + Chrome headless shell, under /usr
#    so the sandbox (which only sees /usr and /etc) can run it. render.mjs is appended by cli/exec-setup.mjs.
install -d -m 755 /usr/local/lib/llm-render
cd /usr/local/lib/llm-render
[ -f package.json ] || echo '{"private":true,"type":"module"}' > package.json
[ -d node_modules/puppeteer-core ] || npm install --silent --no-audit --no-fund puppeteer-core@25.14.0 @puppeteer/browsers >/dev/null
ls browsers/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell >/dev/null 2>&1 ||
  npx @puppeteer/browsers install chrome-headless-shell@stable --path /usr/local/lib/llm-render/browsers >/dev/null
chmod -R a+rX /usr/local/lib/llm-render
cd /

# 6. Runner and renderer (heredocs appended by cli/exec-setup.mjs).
