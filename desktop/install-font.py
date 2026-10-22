import hashlib
import io
import pathlib
import urllib.request
import zipfile

url = 'https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.10.16/fusion-pixel-font-12px-monospaced-ttf-v2026.10.16.zip'
expected = 'c4c9e466042d76f4b37c78232b6ecd4e1f25be3a27cd0f3aacdfaf7de5bd515b'
target = pathlib.Path('/usr/local/share/fonts/fusion-pixel')
target.mkdir(parents=True, exist_ok=True)
if not (target / '.installed-2026.10.16').exists():
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(64_000_000)
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('font archive checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in archive.namelist():
            filename = pathlib.PurePosixPath(name).name
            if filename.endswith('.ttf') or filename.startswith(('LICENSE', 'OFL')):
                (target / filename).write_bytes(archive.read(name))
    (target / '.installed-2026.10.16').touch()
