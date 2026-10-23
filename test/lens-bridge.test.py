import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('lens_bridge', Path(__file__).resolve().parents[1] / 'desktop/lens-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


@unittest.skipUnless(hasattr(os, 'O_NOFOLLOW'), 'Linux descriptor-relative filesystem checks')
class LensBridgeTests(unittest.TestCase):
    def test_only_checks_desktop_and_never_uses_agy_service(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, 'ROOT', directory), \
                patch.object(bridge.subprocess, 'run') as run, patch.object(bridge.os, 'fchown', create=True):
            run.return_value.returncode = 0
            request = {'op': 'stage', 'job': 'aabbccddee', 'files': [{'name': 'image-1-0123456789ab.png', 'data': base64.b64encode(b'png-fixture').decode()}]}
            self.assertEqual(bridge.main(request), {'ok': True})
            self.assertEqual(run.call_args.args[0], ['systemctl', 'is-active', '--quiet', 'llm-desktop.service'])
            run.assert_called_once()
            self.assertEqual((Path(directory) / 'work/attachments/aabbccddee/image-1-0123456789ab.png').read_bytes(), b'png-fixture')

    def test_rejects_arbitrary_operations_and_attachment_paths(self):
        for operation in ('exec', 'image', 'shell'):
            with self.assertRaises(ValueError):
                bridge.main({'op': operation, 'job': 'aabbccddee'})
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge, 'ROOT', directory), \
                patch.object(bridge.subprocess, 'run') as run, patch.object(bridge.os, 'fchown', create=True):
            run.return_value.returncode = 0
            with self.assertRaises(ValueError):
                bridge.main({'op': 'stage', 'job': 'aabbccddee', 'files': [{'name': '../outside.png', 'data': 'aA=='}]})


if __name__ == '__main__':
    unittest.main()
