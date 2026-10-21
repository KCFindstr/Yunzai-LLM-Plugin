#!/usr/bin/env python3
"""
Code-execution runner for Yunzai-LLM-Plugin. Installed into the dedicated WSL distro by exec/setup.sh and
invoked as root:  wsl -d <distro> -u root -e python3 /opt/llm-sandbox/runner.py  < request.json

Isolation per run:
  - systemd scope: MemoryMax / no swap / TasksMax / CPUQuota
  - setpriv: drop to the unprivileged `sbx` user, no_new_privs
  - bubblewrap: fresh user/pid/ipc/uts/mount namespaces, read-only /usr and /etc, nothing else from the distro
  - /work is a size-capped tmpfs created per run and destroyed afterwards
  - network: shared with the distro, but iptables (owner match on the sbx uid) only allows public addresses
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

BASE = '/var/lib/llm-sandbox'
SBX_USER = 'sbx'
LANGS = {
    'python': ('main.py', ['python3', '-u', 'main.py']),
    'node': ('main.mjs', ['node', 'main.mjs']),
    'bash': ('main.sh', ['bash', 'main.sh']),
}
IMAGE_EXT = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'}


def clamp(v, lo, hi, d):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return d


def reader(stream, cap, out):
    """Keep at most `cap` bytes but drain the pipe so the child never blocks on a full buffer."""
    buf = bytearray()
    total = 0
    while True:
        chunk = stream.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if len(buf) < cap:
            buf += chunk[: cap - len(buf)]
    out['data'] = bytes(buf)
    out['total'] = total


def write_etc():
    """
    Files overlaid on the sandbox's /etc: a neutral hostname (the distro's is the Windows machine name), and
    resolv.conf, which in WSL is a symlink into /mnt/wsl (not mounted in the sandbox); search domains dropped.
    """
    etc = os.path.join(BASE, 'etc')
    os.makedirs(etc, exist_ok=True)
    os.chmod(etc, 0o755)
    try:
        with open('/etc/resolv.conf', encoding='utf-8') as f:
            resolv = ''.join(l for l in f if l.startswith(('nameserver', 'options')))
    except OSError:
        resolv = ''
    files = {
        'hostname': 'sandbox\n',
        'hosts': '127.0.0.1 localhost sandbox\n::1 localhost\n',
        'resolv.conf': resolv or 'nameserver 1.1.1.1\n',
    }
    for name, text in files.items():
        p = os.path.join(etc, name)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
        os.chmod(p, 0o644)
    return etc


def main():
    req = json.load(sys.stdin)
    lang = req.get('lang')
    if lang not in LANGS:
        print(json.dumps({'error': f'unsupported language: {lang}'}))
        return
    code = str(req.get('code', ''))
    timeout = clamp(req.get('timeout'), 1, 300, 20)
    mem = clamp(req.get('memoryMB'), 64, 4096, 512)
    disk = clamp(req.get('diskMB'), 8, 2048, 128)
    cap = clamp(req.get('maxOutput'), 256, 200_000, 8000)
    max_images = clamp(req.get('maxImages'), 0, 8, 2)

    import pwd
    pw = pwd.getpwnam(SBX_USER)
    os.makedirs(BASE, exist_ok=True)
    os.chmod(BASE, 0o711)
    etc = write_etc()
    run_id = uuid.uuid4().hex[:12]
    work = os.path.join(BASE, run_id)
    os.mkdir(work, 0o700)
    subprocess.run(['mount', '-t', 'tmpfs', '-o', f'size={disk}m,mode=0700,uid={pw.pw_uid},gid={pw.pw_gid},nosuid,nodev',
                    'tmpfs', work], check=True)
    try:
        fname, argv = LANGS[lang]
        with open(os.path.join(work, fname), 'w', encoding='utf-8') as f:
            f.write(code)
        os.makedirs(os.path.join(work, 'out'))
        mpl = os.path.join(BASE, 'mpl')
        if os.path.isdir(mpl):
            shutil.copytree(mpl, os.path.join(work, '.config', 'matplotlib'))
        for d, _, fs in os.walk(work):
            for p in [d, *(os.path.join(d, f) for f in fs)]:
                os.chown(p, pw.pw_uid, pw.pw_gid)

        unit = f'llmsbx-{run_id}'
        cmd = [
            'systemd-run', '--scope', '--quiet', '--collect', f'--unit={unit}',
            '-p', f'MemoryMax={mem}M', '-p', 'MemorySwapMax=0', '-p', 'TasksMax=128', '-p', 'CPUQuota=200%',
            'setpriv', f'--reuid={pw.pw_uid}', f'--regid={pw.pw_gid}', '--clear-groups', '--no-new-privs',
            'bwrap',
            '--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--hostname', 'sandbox',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--ro-bind', '/etc', '/etc',
            # bind onto the real path: in WSL /etc/resolv.conf is a symlink into /mnt/wsl, which bwrap can't overlay
            *[a for f in ('hostname', 'hosts', 'resolv.conf') for a in ('--ro-bind', os.path.join(etc, f), os.path.realpath(f'/etc/{f}'))],
            '--proc', '/proc', '--dev', '/dev',
            '--size', str(64 * 1024 * 1024), '--tmpfs', '/tmp',
            '--bind', work, '/work', '--chdir', '/work',
            '--clearenv',
            '--setenv', 'HOME', '/work', '--setenv', 'PATH', '/work/.local/bin:/usr/local/bin:/usr/bin:/bin',
            '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTHONIOENCODING', 'utf-8', '--setenv', 'MPLBACKEND', 'Agg',
            '--setenv', 'TZ', str(req.get('tz') or 'Asia/Shanghai'),
            '--',
            'timeout', '-s', 'KILL', str(timeout), *argv,
        ]
        started = time.time()
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        so, se = {}, {}
        ts = [threading.Thread(target=reader, args=(proc.stdout, cap, so)), threading.Thread(target=reader, args=(proc.stderr, cap, se))]
        for t in ts:
            t.start()
        timed_out = False
        try:
            proc.wait(timeout + 5)
        except subprocess.TimeoutExpired:
            timed_out = True
            subprocess.run(['systemctl', 'kill', '--signal=KILL', f'{unit}.scope'], capture_output=True)
            proc.wait(10)
        for t in ts:
            t.join(5)
        code_ = proc.returncode
        # `timeout` exits 124 when it fires; a cgroup OOM shows up as SIGKILL (137/-9) or, when systemd stops
        # the whole scope, SIGTERM (-15/143) — tell a late kill (timeout) from an early one (memory) by elapsed time
        elapsed = time.time() - started
        timed_out = timed_out or code_ == 124
        killed = code_ in (137, 143, -9, -15)
        if killed and elapsed >= timeout - 0.5:
            timed_out = True
        oom = killed and not timed_out

        images = []
        outdir = os.path.join(work, 'out')
        if max_images:
            for name in sorted(os.listdir(outdir)):
                p = os.path.join(outdir, name)
                ext = os.path.splitext(name)[1].lower()
                if ext not in IMAGE_EXT or os.path.islink(p) or not os.path.isfile(p):
                    continue
                if os.path.getsize(p) > 5 * 1024 * 1024:
                    continue
                with open(p, 'rb') as f:
                    images.append({'name': name, 'mime': IMAGE_EXT[ext], 'b64': base64.b64encode(f.read()).decode()})
                if len(images) >= max_images:
                    break

        print(json.dumps({
            'exitCode': code_,
            'timedOut': timed_out,
            'killed': oom,
            'durationMs': int((time.time() - started) * 1000),
            'stdout': so.get('data', b'').decode('utf-8', 'replace'),
            'stdoutTotal': so.get('total', 0),
            'stderr': se.get('data', b'').decode('utf-8', 'replace'),
            'stderrTotal': se.get('total', 0),
            'images': images,
        }))
    finally:
        subprocess.run(['umount', '-l', work], capture_output=True)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
