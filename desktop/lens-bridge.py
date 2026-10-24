#!/usr/bin/env python3
"""Fixed-purpose Lens bridge. Read the global image store and search it in the isolated desktop."""
import json, os, re, subprocess, sys

ROOT = '/var/lib/llm-desktop/disk'


def main(request):
    if request.get('op') not in ('google_image_search',):
        raise ValueError('Unknown Lens operation')
    job = request.get('job', '')
    if not isinstance(job, str) or not re.fullmatch(r'[a-f0-9]{10}', job):
        raise ValueError('Invalid Lens workspace')
    # Chrome runs inside the desktop's existing network boundary. No AGY account, CLI or worker is used.
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'llm-desktop.service']).returncode != 0:
        raise ValueError('Desktop unavailable')
    subprocess.run(['/opt/llm-images/mount.sh'], check=True, stdout=subprocess.DEVNULL)
    image_path = request.get('path', '')
    if not isinstance(image_path, str) or not re.fullmatch(r'/work/attachments/[a-f0-9]{10}/image-(?:[a-f0-9]{40}|[1-8]-[a-f0-9]{12})\.(png|jpg|gif|webp|bmp)', image_path):
        raise ValueError('Invalid global image path')
    work_fd = os.open('/var/lib/llm-images', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Historical installation paths are shared with older installs; their names imply no AGY dependency.
        result = subprocess.run(['python3', '/opt/llm-agy/google-image-search.py', str(work_fd), image_path.removeprefix('/work/attachments/')],
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
