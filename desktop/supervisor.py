"""Retry desktop sidecars after exits and temporary process/thread exhaustion."""
import os
import signal
import subprocess
import time


class ProcessSupervisor:
    def __init__(self, argv, retry_seconds=15, cleanup_group=False, **kwargs):
        self.argv = argv
        self.retry_seconds = retry_seconds
        self.cleanup_group = cleanup_group
        self.kwargs = kwargs
        self.process = None
        self.retry_at = 0

    def stop(self):
        if self.process is None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.process.wait()
        self.process = None

    def tick(self):
        if self.process is not None:
            if self.process.poll() is None:
                return
            if self.cleanup_group:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process = None
            self.retry_at = time.monotonic() + self.retry_seconds
        if time.monotonic() < self.retry_at:
            return
        try:
            self.process = subprocess.Popen(self.argv, start_new_session=True, **self.kwargs)
        except OSError:
            # EAGAIN at the cgroup task limit must not kill the supervisor too.
            self.retry_at = time.monotonic() + self.retry_seconds
