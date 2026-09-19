import contextlib
import io
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from hindsightkit import services
from hindsightkit.platform import startup


class ServiceStartupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='startup fixture ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = SimpleNamespace(log=self.root / 'api.log', ui_log=self.root / 'ui.log',
                                     port=9077, ui_port=19077)

    def launch(self, source, **options):
        script = self.root / 'launcher.py'
        script.write_text('import sys, time\nfrom pathlib import Path\n' + source, encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            startup.start_api(self.paths, {'HINDSIGHT_API_TENANT_API_KEY': 'fixture-secret'},
                command=[sys.executable, str(script), str(self.paths.log)], **options)
        return output.getvalue()

    def test_silent_command_reports_progress_before_exit_and_preserves_old_log(self):
        self.paths.log.write_text('PermissionError: old failure\n')
        output = self.launch('time.sleep(0.5)\n', timeout=5, interval=0.1)
        self.assertIn('Starting Hindsight API...', output)
        self.assertIn('elapsed', output)
        self.assertIn(str(self.paths.log), output)
        self.assertIn('ready', output)
        self.assertNotIn('old failure', output)

    def test_uncaught_daemon_failure_is_reported_without_waiting_for_launcher(self):
        traceback = ('Traceback (most recent call last):\n'
                     '  File "<frozen runpy>", line 198, in _run_module_as_main\n'
                     'PermissionError: denied fixture-secret\n')
        before = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'PermissionError') as caught:
            self.launch(f'Path(sys.argv[1]).write_text({traceback!r})\ntime.sleep(30)\n', timeout=8)
        self.assertLess(time.monotonic() - before, 6)
        self.assertIn('[REDACTED]', str(caught.exception))
        self.assertNotIn('fixture-secret', str(caught.exception))

    def test_logged_retry_exception_does_not_abort_start(self):
        traceback = ('Traceback (most recent call last):\n'
                     '  File "worker.py", line 1, in retry\nConnectionError: retrying\n')
        source = f'Path(sys.argv[1]).write_text({traceback!r})\ntime.sleep(0.3)\n'
        self.assertIn('ready', self.launch(source, timeout=5))

    def test_timeout_ends_only_spawned_launcher_and_reports_log(self):
        with self.assertRaisesRegex(RuntimeError, 'timed out after') as caught:
            self.launch('time.sleep(30)\n', timeout=0.4)
        self.assertIn(str(self.paths.log), str(caught.exception))

    def test_launcher_error_output_is_available_and_redacted(self):
        with self.assertRaisesRegex(RuntimeError, 'code 7') as caught:
            self.launch("print('api_key=fixture-secret', flush=True)\nsys.exit(7)\n", timeout=5)
        self.assertIn('[REDACTED]', str(caught.exception))
        self.assertNotIn('fixture-secret', str(caught.exception))

    def test_environment_override_secrets_are_redacted_from_daemon_log(self):
        traceback = ('Traceback (most recent call last):\n'
                     '  File "<frozen runpy>", line 198, in _run_module_as_main\n'
                     'RuntimeError: inherited-secret postgresql://user:password@host/db\n')
        with patch.dict(os.environ, {'HINDSIGHT_API_TENANT_API_KEY': 'inherited-secret',
                                    'HINDSIGHT_API_DATABASE_URL': 'postgresql://user:password@host/db'}):
            with self.assertRaises(RuntimeError) as caught:
                self.launch(f'Path(sys.argv[1]).write_text({traceback!r})\ntime.sleep(30)\n', timeout=8)
        self.assertNotIn('inherited-secret', str(caught.exception))
        self.assertNotIn('user:password', str(caught.exception))

    def test_rotation_and_partial_lines_do_not_replay_historical_failures(self):
        self.paths.log.write_text('old failure\n')
        tail = startup.LogTail(self.paths.log)
        self.paths.log.rename(self.root / 'api.log.1')
        self.paths.log.write_text('new startup\npart')
        self.assertEqual(tail.read(), ['new startup'])
        with self.paths.log.open('a') as stream:
            stream.write('ial\n')
        self.assertEqual(tail.read(), ['partial'])
        self.assertEqual(tail.read(), [])

    def test_concurrent_start_ignores_failure_written_while_waiting_for_lock(self):
        from filelock import FileLock
        lock = FileLock(str(self.paths.log) + '.hk-start.lock', thread_local=False)
        lock.acquire()
        def finish_other_start():
            time.sleep(0.2)
            self.paths.log.write_text('Traceback (most recent call last):\n'
                '  File "<frozen runpy>", line 198, in _run_module_as_main\n'
                'PermissionError: another attempt failed\n')
            lock.release()
        worker = threading.Thread(target=finish_other_start)
        worker.start()
        try:
            output = self.launch('time.sleep(0.2)\n', timeout=5)
            self.assertIn('ready', output)
            self.assertNotIn('another attempt failed', output)
        finally:
            worker.join()
            lock.release()

    def test_waiting_for_another_start_has_bounded_deadline(self):
        from filelock import FileLock
        with FileLock(str(self.paths.log) + '.hk-start.lock'), patch.object(startup.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'Another hk start'):
                self.launch('pass\n', timeout=0.1)
            spawn.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows process cleanup')
    def test_taskkill_timeout_still_kills_owned_launcher(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        with patch.object(startup.subprocess, 'run', side_effect=subprocess.TimeoutExpired('taskkill', 10)):
            startup.stop_launcher(process)
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)

    def test_invalid_budget_fails_before_spawning(self):
        with patch.object(startup.subprocess, 'Popen') as spawn:
            for value in ('bad', '0', '-1', 'nan'):
                with self.subTest(value=value), patch.dict(os.environ, {'HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT': value}):
                    with self.assertRaises(RuntimeError):
                        startup.start_api(self.paths, {})
            spawn.assert_not_called()

    def test_keyboard_interrupt_terminates_launcher(self):
        process = Mock()
        process.poll.return_value = None
        with patch.object(startup.subprocess, 'Popen', return_value=process), \
             patch.object(startup.time, 'sleep', side_effect=KeyboardInterrupt), \
             patch.object(startup, 'stop_launcher') as stop, \
             contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                startup.start_api(self.paths, {}, timeout=5)
        stop.assert_called_once_with(process)

    def test_local_start_shows_stages_and_urls_only_after_checks_pass(self):
        events = []
        with patch.object(services, 'require_local'), \
             patch.object(services.profile_env, 'profile_config', return_value=({}, self.paths)), \
             patch('hindsightkit.setup.postgres.require_postgresql', return_value='postgresql://fixture'), \
             patch('hindsightkit.setup.postgres.Postgres') as database, \
             patch('hindsightkit.setup.postgres.check_external', new_callable=AsyncMock,
                   side_effect=lambda _: events.append('database')), \
             patch('hindsightkit.platform.copilot.prepare', side_effect=lambda _: events.append('copilot')), \
             patch.object(services, 'start_api', side_effect=lambda *a: events.append('api')), \
             patch.object(services, 'start_ui', side_effect=lambda _: events.append('ui') or 'http://localhost:19077'), \
             patch('hindsightkit.connectors.registry.enabled_connectors', return_value=[]), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            database.return_value.state_path.is_file.return_value = False
            self.assertEqual(services.start_local(), ('http://127.0.0.1:9077', 'http://localhost:19077'))
        self.assertEqual(events, ['database', 'copilot', 'api', 'ui'])
        for value in ('Checking PostgreSQL', 'Checking inference runtime', 'Starting dashboard',
                      'API: http://127.0.0.1:9077', 'Dashboard: http://localhost:19077'):
            self.assertIn(value, output.getvalue())


if __name__ == '__main__':
    unittest.main()
