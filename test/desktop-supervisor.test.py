import errno
import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('desktop_supervisor', pathlib.Path(__file__).resolve().parents[1] / 'desktop/supervisor.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ProcessSupervisor = module.ProcessSupervisor


class SupervisorTests(unittest.TestCase):
    def test_recovers_after_fork_exhaustion_without_busy_retrying(self):
        child = Mock(pid=123)
        child.poll.return_value = None
        with patch.object(module.time, 'monotonic', return_value=100) as clock, patch.object(module.subprocess, 'Popen', side_effect=[BlockingIOError(errno.EAGAIN, 'thread limit'), child]) as spawn:
            supervisor = ProcessSupervisor(['sidecar'])
            supervisor.tick()
            self.assertIsNone(supervisor.process)
            supervisor.tick()
            self.assertEqual(spawn.call_count, 1)
            clock.return_value = 115
            supervisor.tick()
            self.assertIs(supervisor.process, child)
            supervisor.tick()
            self.assertEqual(spawn.call_count, 2)

    def test_cleans_up_session_descendants_before_restart(self):
        child = Mock(pid=123)
        child.poll.return_value = 1
        with patch.object(module.time, 'monotonic', return_value=100) as clock, patch.object(module.os, 'killpg') as kill, patch.object(module.subprocess, 'Popen') as spawn:
            supervisor = ProcessSupervisor(['sidecar'], cleanup_group=True)
            supervisor.process = child
            supervisor.tick()
            kill.assert_called_once_with(123, module.signal.SIGKILL)
            spawn.assert_not_called()
            clock.return_value = 115
            supervisor.tick()
            spawn.assert_called_once()

    def test_restarts_and_reaps_a_real_failed_child(self):
        supervisor = ProcessSupervisor([sys.executable, '-c', 'raise SystemExit(7)'], retry_seconds=0)
        supervisor.tick()
        first = supervisor.process
        first.wait(timeout=5)
        supervisor.tick()
        second = supervisor.process
        self.assertNotEqual(first.pid, second.pid)
        self.assertEqual(first.returncode, 7)
        second.wait(timeout=5)

    def test_stop_kills_and_reaps_the_sidecar(self):
        supervisor = ProcessSupervisor([sys.executable, '-c', 'import time; time.sleep(60)'])
        supervisor.tick()
        child = supervisor.process
        supervisor.stop()
        self.assertIsNone(supervisor.process)
        self.assertIsNotNone(child.returncode)


if __name__ == '__main__':
    unittest.main()
