"""Optional RustDesk sidecar, launched *inside* the existing isolated X11 desktop as pc."""
import fcntl
import os
import pathlib
import signal
import time
from supervisor import ProcessSupervisor

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
# The desktop has a two-core CPU quota; avoid pools sized for every host CPU.
os.environ.update(RAYON_NUM_THREADS='2', TOKIO_WORKER_THREADS='2', OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')
os.makedirs('/tmp/runtime-pc', mode=0o700, exist_ok=True)
log = (settings / 'rustdesk-launch.log').open('a')
sidecar = ProcessSupervisor(['dbus-run-session', '--', '/usr/local/bin/rustdesk', '--server'],
                            cleanup_group=True, stdout=log, stderr=log)
(settings / 'rustdesk-launch.pid').write_text(str(os.getpid()))


def terminate(signum, frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
try:
    while (settings / 'rustdesk-enabled').is_file():
        sidecar.tick()
        time.sleep(1)
finally:
    sidecar.stop()
