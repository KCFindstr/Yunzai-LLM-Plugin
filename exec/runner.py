#!/usr/bin/env python3
"""
Code-execution runner for Yunzai-LLM-Plugin. Installed into the dedicated WSL distro by exec/setup.sh and
invoked as root:  wsl -d <distro> -u root -e python3 /opt/llm-sandbox/runner.py  < request.json

Actions (request "action", default "run"):
  run      run code (python / node / bash)
  render   render HTML to PNG with headless Chrome, in the same workspace (so pages can use files the code made)
  cleanup  delete a session's workspace

Workspace: with a "session" id, /work persists across calls until cleanup (or an idle sweep after SESSION_TTL);
without one it is created for the call and destroyed afterwards.

Isolation per call:
  - systemd scope: MemoryMax / no swap / TasksMax / CPUQuota
  - setpriv: drop to the unprivileged `sbx` user, no_new_privs
  - bubblewrap: fresh user/pid/ipc/uts/mount namespaces, read-only /usr and /etc, nothing else from the distro
  - /work is a size-capped tmpfs
  - network: shared with the distro, but iptables (owner match on the sbx uid) only allows public addresses
"""
import base64
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

BASE = '/var/lib/llm-sandbox'
SBX_USER = 'sbx'
SESSION_TTL = 3600
RENDER_DIR = '/usr/local/lib/llm-render'
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


def destroy(work):
    subprocess.run(['umount', '-l', work], capture_output=True)
    shutil.rmtree(work, ignore_errors=True)
    try:
        os.remove(work + '.last')
    except OSError:
        pass


def sweep():
    """Remove session workspaces nobody cleaned up (plugin restarted mid-reply, etc.)."""
    now = time.time()
    for name in os.listdir(BASE):
        if not name.startswith('s-') or name.endswith('.last'):
            continue
        work = os.path.join(BASE, name)
        try:
            last = os.path.getmtime(work + '.last')
        except OSError:
            last = 0
        if now - last > SESSION_TTL:
            destroy(work)


def open_workspace(session, disk, pw):
    """Return (path, created, ephemeral). Session workspaces live at BASE/s-<id>; others get a random name."""
    if session:
        work = os.path.join(BASE, f's-{session}')
        ephemeral = False
    else:
        work = os.path.join(BASE, uuid.uuid4().hex[:12])
        ephemeral = True
    created = not os.path.ismount(work)
    if created:
        os.makedirs(work, 0o700, exist_ok=True)
        subprocess.run(['mount', '-t', 'tmpfs', '-o', f'size={disk}m,mode=0700,uid={pw.pw_uid},gid={pw.pw_gid},nosuid,nodev',
                        'tmpfs', work], check=True)
        os.makedirs(os.path.join(work, 'out'))
        mpl = os.path.join(BASE, 'mpl')
        if os.path.isdir(mpl):
            shutil.copytree(mpl, os.path.join(work, '.config', 'matplotlib'))
        for d, _, fs in os.walk(work):
            for p in [d, *(os.path.join(d, f) for f in fs)]:
                os.chown(p, pw.pw_uid, pw.pw_gid)
    if not ephemeral:
        with open(work + '.last', 'w'):
            pass
    return work, ephemeral


def put_file(work, name, text, pw):
    p = os.path.join(work, name)
    if os.path.islink(p):
        os.remove(p)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chown(p, pw.pw_uid, pw.pw_gid)
    return p


def sandboxed(work, argv, *, timeout, mem, tasks, cap, pw, tz):
    """Run argv in /work inside the sandbox; returns exit status and captured output."""
    etc = write_etc()
    unit = f'llmsbx-{uuid.uuid4().hex[:12]}'
    cmd = [
        'systemd-run', '--scope', '--quiet', '--collect', f'--unit={unit}',
        '-p', f'MemoryMax={mem}M', '-p', 'MemorySwapMax=0', '-p', f'TasksMax={tasks}', '-p', 'CPUQuota=200%',
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
        '--size', str(64 * 1024 * 1024), '--tmpfs', '/dev/shm',
        '--bind', work, '/work', '--chdir', '/work',
        '--clearenv',
        '--setenv', 'HOME', '/work', '--setenv', 'PATH', '/work/.local/bin:/usr/local/bin:/usr/bin:/bin',
        '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTHONIOENCODING', 'utf-8', '--setenv', 'MPLBACKEND', 'Agg',
        '--setenv', 'TZ', tz,
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
    code = proc.returncode
    # `timeout` exits 124 when it fires; a cgroup OOM shows up as SIGKILL (137/-9) or, when systemd stops
    # the whole scope, SIGTERM (-15/143) — tell a late kill (timeout) from an early one (memory) by elapsed time
    elapsed = time.time() - started
    timed_out = timed_out or code == 124
    killed = code in (137, 143, -9, -15)
    if killed and elapsed >= timeout - 0.5:
        timed_out = True
    return {
        'exitCode': code,
        'timedOut': timed_out,
        'killed': killed and not timed_out,
        'durationMs': int(elapsed * 1000),
        'stdout': so.get('data', b'').decode('utf-8', 'replace'),
        'stdoutTotal': so.get('total', 0),
        'stderr': se.get('data', b'').decode('utf-8', 'replace'),
        'stderrTotal': se.get('total', 0),
    }


def read_image(p, name):
    ext = os.path.splitext(name)[1].lower()
    if ext not in IMAGE_EXT or os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) > 5 * 1024 * 1024:
        return None
    with open(p, 'rb') as f:
        return {'name': name, 'mime': IMAGE_EXT[ext], 'b64': base64.b64encode(f.read()).decode()}


def new_images(work, since, limit):
    """Images in out/ created or changed by this call (earlier ones in a session were already sent)."""
    images = []
    outdir = os.path.join(work, 'out')
    # the runner reads as root: never follow a symlinked out/ out of the workspace
    if not limit or os.path.islink(outdir) or not os.path.isdir(outdir):
        return images
    for name in sorted(os.listdir(outdir)):
        p = os.path.join(outdir, name)
        try:
            if os.path.getmtime(p) < since:
                continue
        except OSError:
            continue
        img = read_image(p, name)
        if img:
            images.append(img)
        if len(images) >= limit:
            break
    return images


def main():
    req = json.load(sys.stdin)
    action = req.get('action', 'run')
    session = str(req.get('session') or '')
    if session and not re.fullmatch(r'[a-z0-9-]{1,40}', session):
        print(json.dumps({'error': 'bad session id'}))
        return
    os.makedirs(BASE, exist_ok=True)
    os.chmod(BASE, 0o711)
    sweep()

    if action == 'cleanup':
        if session:
            destroy(os.path.join(BASE, f's-{session}'))
        print(json.dumps({'ok': True}))
        return
    if action not in ('run', 'render'):
        print(json.dumps({'error': f'unknown action: {action}'}))
        return
    lang = req.get('lang')
    if action == 'run' and lang not in LANGS:
        print(json.dumps({'error': f'unsupported language: {lang}'}))
        return

    timeout = clamp(req.get('timeout'), 1, 300, 20)
    mem = clamp(req.get('memoryMB'), 64, 4096, 512)
    disk = clamp(req.get('diskMB'), 8, 2048, 128)
    cap = clamp(req.get('maxOutput'), 256, 200_000, 8000)
    max_images = clamp(req.get('maxImages'), 0, 8, 2)
    tz = str(req.get('tz') or 'Asia/Shanghai')
    pw = pwd.getpwnam(SBX_USER)

    work, ephemeral = open_workspace(session, disk, pw)
    try:
        started = time.time() - 1  # mtime granularity
        if action == 'run':
            fname, argv = LANGS[lang]
            put_file(work, fname, str(req.get('code', '')), pw)
            res = sandboxed(work, argv, timeout=timeout, mem=mem, tasks=128, cap=cap, pw=pw, tz=tz)
            res['images'] = new_images(work, started, max_images)
        else:
            # Chrome needs more threads and memory than typical scripts
            put_file(work, '.render.html', str(req.get('html', '')), pw)
            out = os.path.join(work, '.render.png')
            if os.path.lexists(out):
                os.remove(out)
            argv = ['node', f'{RENDER_DIR}/render.mjs', json.dumps({
                'page': '/work/.render.html', 'out': '/work/.render.png',
                'width': clamp(req.get('width'), 200, 1600, 720), 'maxHeight': clamp(req.get('maxHeight'), 100, 16000, 6000),
                'scale': 2, 'allowNetwork': bool(req.get('allowNetwork', True)),
            })]
            res = sandboxed(work, argv, timeout=max(timeout, 30), mem=max(mem, 1024), tasks=512, cap=cap, pw=pw, tz=tz)
            img = read_image(out, 'render.png') if os.path.isfile(out) else None
            res['images'] = [img] if img else []
            for p in (out, os.path.join(work, '.render.html')):
                if os.path.lexists(p):
                    os.remove(p)
        print(json.dumps(res))
    finally:
        if ephemeral:
            destroy(work)


if __name__ == '__main__':
    main()
