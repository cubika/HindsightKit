import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from hindsightkit.sharing import log as relay_log


class RelayLogTests(unittest.TestCase):
    def test_rotation_waits_for_another_writer_to_finish_inspecting_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inspecting, release, second_lock = threading.Event(), threading.Event(), threading.Event()
            native_lock, native_check = relay_log.FileLock, relay_log.reject_links
            failures = []

            def inspect(path):
                if path.name == 'supervisor.log' and threading.current_thread().name == 'first-writer':
                    inspecting.set()
                    if not release.wait(3):
                        failures.append('Inspection was never released.')
                native_check(path)

            @contextlib.contextmanager
            def lock(*args, **kwargs):
                if threading.current_thread().name == 'second-writer':
                    second_lock.set()
                with native_lock(*args, **kwargs):
                    yield

            def rotate(*args):
                # A Windows metadata handle can deny rename until inspection finishes.
                if inspecting.is_set() and not release.is_set():
                    raise PermissionError('Path inspection overlaps rotation.')
                return native_replace(*args)

            native_replace = relay_log.os.replace
            relay_log.path(root).write_text('old record\n')
            errors = io.StringIO()
            with patch.object(relay_log, 'MAX_BYTES', 1), patch.object(relay_log, 'FileLock', lock), \
                 patch.object(relay_log, 'reject_links', side_effect=inspect), \
                 patch.object(relay_log.os, 'replace', side_effect=rotate), contextlib.redirect_stderr(errors):
                first = threading.Thread(name='first-writer', target=relay_log.event, args=(root, 'first'))
                second = threading.Thread(name='second-writer', target=relay_log.event, args=(root, 'second'))
                first.start()
                try:
                    self.assertTrue(inspecting.wait(2))
                    second.start()
                    self.assertTrue(second_lock.wait(2))
                    second.join(0.1)
                    self.assertTrue(second.is_alive(), 'Rotation ran while another writer inspected the log.')
                finally:
                    release.set()
                    first.join(4)
                    if second.ident is not None:
                        second.join(4)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(failures, [])
            self.assertEqual(errors.getvalue(), '')
            self.assertEqual(json.loads(relay_log.path(root).read_text())['event'], 'second')
            self.assertEqual(json.loads((root / 'supervisor.log.1').read_text())['event'], 'first')

    def test_failed_operation_is_durable_and_does_not_expose_exception_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(TimeoutError):
                with relay_log.operation(root, 'server.discovery'):
                    self.assertEqual(relay_log.current_root(), root)
                    raise TimeoutError('Bearer synthetic-secret hk1.secret')
            self.assertIsNone(relay_log.current_root())
            text = relay_log.path(root).read_text()
            records = [json.loads(line) for line in text.splitlines()]
            self.assertEqual([item['event'] for item in records],
                             ['server.discovery.started', 'server.discovery.failed'])
            self.assertEqual(records[-1]['error'], 'TimeoutError')
            self.assertIn('elapsed_seconds', records[-1])
            self.assertNotIn('synthetic-secret', text)
            self.assertNotIn('hk1.secret', text)

    def test_processes_share_bounded_rotation_with_complete_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code = ('from hindsightkit.sharing import log as relay_log; import sys; '
                    'relay_log.MAX_BYTES = 2048; '
                    '[relay_log.event(sys.argv[1], "fixture.event", sequence=i) for i in range(60)]')
            processes = [subprocess.Popen([sys.executable, '-c', code, str(root)],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(3)]
            try:
                for process in processes:
                    output, errors = process.communicate(timeout=30)
                    self.assertEqual(process.returncode, 0, errors.decode())
                    self.assertEqual(errors, b'', errors.decode(errors='replace'))
                for name in ('supervisor.log', 'supervisor.log.1'):
                    log = root / name
                    self.assertLessEqual(log.stat().st_size, 2048)
                    records = [json.loads(line) for line in log.read_text().splitlines()]
                    self.assertTrue(records)
                    self.assertTrue(all(item['event'] == 'fixture.event' for item in records))
                self.assertFalse((root / 'supervisor.log.2').exists())
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=5)

    def test_log_failure_warns_and_preserves_the_original_exception(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(relay_log, 'reject_links', side_effect=PermissionError('private details')), \
             contextlib.redirect_stderr(io.StringIO()) as output:
            with self.assertRaisesRegex(ValueError, 'original failure'):
                with relay_log.operation(Path(directory), 'fixture'):
                    raise ValueError('original failure')
            self.assertEqual(output.getvalue().count('Cannot write relay log'), 1)
            self.assertNotIn('private details', output.getvalue())


if __name__ == '__main__':
    unittest.main()
