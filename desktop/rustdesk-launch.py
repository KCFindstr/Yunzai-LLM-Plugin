"""Optional RustDesk sidecar, launched *inside* the existing isolated X11 desktop as pc."""
import fcntl
import os
import pathlib
import subprocess
import time

home = pathlib.Path('/home/pc')
settings = home / '.config/llm-desktop'
if os.geteuid() == 0 or not (settings / 'rustdesk-enabled').is_file():
    raise SystemExit('RustDesk must be enabled and launched as the desktop user')
settings.mkdir(parents=True, exist_ok=True)
lock = (settings / 'rustdesk-launch.lock').open('w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
os.environ.update(HOME=str(home), USER='pc', DISPLAY=':99', XDG_RUNTIME_DIR='/tmp/runtime-pc', XDG_SESSION_TYPE='x11', LIBGL_ALWAYS_SOFTWARE='1')
os.makedirs('/tmp/runtime-pc', mode=0o700, exist_ok=True)
log = (settings / 'rustdesk-launch.log').open('a')
while (settings / 'rustdesk-enabled').is_file():
    process = subprocess.Popen(['dbus-run-session', '--', '/usr/local/bin/rustdesk', '--server'], stdout=log, stderr=log)
    (settings / 'rustdesk-launch.pid').write_text(str(os.getpid()))
    process.wait()
    log.write('RustDesk exited; retrying in 15 seconds.\n')
    log.flush()
    time.sleep(15)
