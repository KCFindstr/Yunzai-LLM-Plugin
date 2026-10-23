#!/usr/bin/env python3
"""Root-owned broker. Untrusted commands only execute after entering the job mount namespace."""
import base64, json, os, pathlib, re, subprocess, sys, tempfile, uuid

ROOT = pathlib.Path('/var/lib/llm-desktop/disk/work/attachments')

def main():
    request = json.load(sys.stdin)
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'llm-agy.service']).returncode != 0:
        raise ValueError('Network boundary unavailable')
    job = request.get('job', '')
    if not re.fullmatch(r'[a-f0-9]{10}', job):
        raise ValueError('Invalid job')
    # Pin every component with NOFOLLOW; the desktop must not redirect this privileged broker.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent_fd = os.open('/var/lib/llm-desktop/disk', flags)
    for name in ('work', 'attachments', job):
        try:
            os.mkdir(name, 0o770 if name == job else 0o711, dir_fd=parent_fd)
        except FileExistsError:
            pass
        child_fd = os.open(name, flags, dir_fd=parent_fd)
        os.close(parent_fd)
        parent_fd = child_fd
        if name != job:
            os.fchmod(parent_fd, 0o711)
    work_fd = parent_fd
    os.fchown(work_fd, 2002, 2001)
    os.fchmod(work_fd, 0o770)
    if request['op'] == 'stage':
        for item in request.get('files', []):
            if not re.fullmatch(r'image-[1-8]-[a-f0-9]{12}\.(png|jpg|gif|webp|bmp)', item['name']):
                raise ValueError('Invalid attachment')
            data = base64.b64decode(item['data'], validate=True)
            if len(data) > 3700000:
                raise ValueError('Attachment too large')
            temporary = '.' + uuid.uuid4().hex
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o660, dir_fd=work_fd)
            os.fchown(fd, 2002, 2001)
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
            os.replace(temporary, item['name'], src_dir_fd=work_fd, dst_dir_fd=work_fd)
        return {'ok': True, 'work': '/work'}
    if request['op'] == 'google_image_search':
        # Narrow trusted operation against the existing sandboxed desktop browser, not arbitrary agent code.
        environment = {'PATH': '/usr/bin:/bin', 'PYTHONPATH': '/usr/local/lib/agy-browser'}
        try:
            result = subprocess.run(['python3', '/opt/llm-agy/google-image-search.py', str(work_fd), request.get('path', '')],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60, pass_fds=(work_fd,), env=environment)
        except subprocess.TimeoutExpired:
            return {'provider': 'google_lens', 'status': 'timeout', 'error': 'Google Lens timed out waiting for the VM browser; no visual match is confirmed.'}
        return json.loads(result.stdout)
    if request['op'] not in ('exec', 'image'):
        raise ValueError('Unknown operation')
    command = str(request.get('command', ''))
    if request['op'] == 'exec' and (not command or len(command) > 24000):
        raise ValueError('Invalid command')
    image = request['op'] == 'image'
    if image:
        name = request.get('path', '')
        if not isinstance(name, str) or len(name) > 300 or '\x00' in name:
            raise ValueError('Invalid image path')
        script = "import pathlib,sys; p=(pathlib.Path('/work')/sys.argv[1]).resolve(); assert p.is_relative_to('/work'); assert p.stat().st_size <= 3700000; sys.stdout.buffer.write(p.read_bytes())"
        tail = ['python3', '-c', script, name]
    else:
        tail = ['timeout', '-k', '2', '55', 'bash', '-c', command]
    args = ['setpriv', '--reuid=2002', '--regid=2001', '--clear-groups', '--no-new-privs',
            'bwrap', '--unshare-all', '--share-net', '--new-session', '--die-with-parent',
            '--ro-bind', '/usr', '/usr', '--ro-bind', '/opt/google', '/opt/google',
            '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
            '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--dir', '/etc', '--ro-bind', '/etc/ssl', '/etc/ssl',
            '--ro-bind', '/etc/fonts', '/etc/fonts', '--ro-bind', '/etc/alternatives', '/etc/alternatives',
            '--ro-bind', '/usr/local/lib/llm-desktop/resolv.conf', '/etc/resolv.conf',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
            '--tmpfs', '/home', '--dir', '/home/worker', '--bind', '/proc/self/fd/' + str(work_fd), '/work',
            '--chdir', '/work', '--clearenv', '--setenv', 'HOME', '/home/worker',
            '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
            '--setenv', 'PYTHONUNBUFFERED', '1', '--setenv', 'PYTHONPATH', '/usr/local/lib/agy-browser'] + tail
    # Bound memory/process count without constraining the existing desktop session.
    args = ['systemd-run', '--quiet', '--scope', '--property=MemoryMax=2G', '--property=TasksMax=256',
            'prlimit', '--nproc=256', '--fsize=134217728', '--'] + args
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=60, pass_fds=(work_fd,))
        output.seek(0)
        data = output.read(3700001 if image else 24000)
    if image:
        if result.returncode != 0:
            raise ValueError('Image read failed')
        mime = 'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if data.startswith(b'\xff\xd8\xff') else 'image/gif' if data.startswith(b'GIF8') else 'image/webp' if data[:4] == b'RIFF' and data[8:12] == b'WEBP' else None
        if not mime or len(data) > 3700000:
            raise ValueError('Invalid image')
        return {'mimeType': mime, 'data': base64.b64encode(data).decode('ascii')}
    return {'exitCode': result.returncode, 'output': data.decode('utf-8', errors='replace')}

try:
    print(json.dumps(main()))
except Exception:
    print(json.dumps({'error': 'Sandbox operation failed'}))
    sys.exit(1)
