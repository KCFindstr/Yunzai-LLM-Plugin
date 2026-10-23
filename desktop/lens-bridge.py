#!/usr/bin/env python3
"""Fixed-purpose Lens bridge. Only stage an attachment or search it in the isolated desktop."""
import base64, json, os, re, subprocess, sys, uuid

ROOT = '/var/lib/llm-desktop/disk'


def main(request):
    if request.get('op') not in ('stage', 'google_image_search'):
        raise ValueError('Unknown Lens operation')
    job = request.get('job', '')
    if not isinstance(job, str) or not re.fullmatch(r'[a-f0-9]{10}', job):
        raise ValueError('Invalid Lens workspace')
    # Chrome runs inside the desktop's existing network boundary. No AGY account, CLI or worker is used.
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'llm-desktop.service']).returncode != 0:
        raise ValueError('Desktop unavailable')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    work_fd = os.open(ROOT, flags)
    try:
        for name in ('work', 'attachments', job):
            try:
                os.mkdir(name, 0o770 if name == job else 0o711, dir_fd=work_fd)
            except FileExistsError:
                pass
            child = os.open(name, flags, dir_fd=work_fd)
            os.close(work_fd)
            work_fd = child
        os.fchown(work_fd, 0, 2001)
        os.fchmod(work_fd, 0o770)
        if request['op'] == 'stage':
            files = request.get('files', [])
            if not isinstance(files, list) or len(files) != 1:
                raise ValueError('Expected one image')
            item = files[0]
            if not isinstance(item.get('name'), str) or not re.fullmatch(r'image-[1-8]-[a-f0-9]{12}\.(png|jpg|gif|webp|bmp)', item['name']):
                raise ValueError('Invalid attachment')
            data = base64.b64decode(item['data'], validate=True)
            if not 0 < len(data) <= 3700000:
                raise ValueError('Invalid image size')
            temporary = '.' + uuid.uuid4().hex
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o660, dir_fd=work_fd)
            os.fchown(fd, 0, 2001)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            os.replace(temporary, item['name'], src_dir_fd=work_fd, dst_dir_fd=work_fd)
            return {'ok': True}
        # Historical installation paths are shared with older installs; their names imply no AGY dependency.
        result = subprocess.run(['python3', '/opt/llm-agy/google-image-search.py', str(work_fd), request.get('path', '')],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=50, pass_fds=(work_fd,),
                                env={'PATH': '/usr/bin:/bin', 'PYTHONPATH': '/usr/local/lib/agy-browser'})
        if result.returncode != 0:
            raise ValueError('Lens search failed')
        return json.loads(result.stdout)
    finally:
        os.close(work_fd)


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({'error': 'Google Lens operation failed'}))
        sys.exit(1)
