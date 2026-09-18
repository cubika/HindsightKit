import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch

from hindsightkit import cli, connection, services
from hindsightkit.platform import lifecycle
from hindsightkit.sharing import remote
from hindsightkit.setup import startup
from hindsightkit.platform import runtime as runtime_env


class StartupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='hk startup ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = self.root / 'client.json'
        self.output = io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(runtime_env, 'home', return_value=self.root))
        self.stack.enter_context(patch.object(connection, 'config_path', return_value=self.config))
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.start_local = self.stack.enter_context(patch.object(services, 'start_local'))
        self.stop_local = self.stack.enter_context(patch.object(services, 'stop_profile_services'))
        self.resume = self.stack.enter_context(patch.object(remote, 'resume'))
        self.resume_host = self.stack.enter_context(patch.object(remote, 'resume_host'))
        self.prepare_client = self.stack.enter_context(patch.object(remote, 'prepare_client'))
        # A missing registration mock must never create a real login task.
        self.task = self.stack.enter_context(patch.object(startup, '_task',
            side_effect=AssertionError('Unexpected Windows task registration')))
        self.private = self.stack.enter_context(patch('hindsightkit.platform.files.private_directory',
            side_effect=lambda path: path.mkdir(parents=True, exist_ok=True)))

    def record(self, mode='full', **changes):
        value = {'schema': 1, 'mode': mode, **changes}
        (self.root / 'installation.json').write_text(json.dumps(value), encoding='utf-8')

    def preference(self, enabled):
        (self.root / 'startup.json').write_text(
            json.dumps({'schema': 1, 'enabled': enabled}), encoding='utf-8')

    def launcher(self):
        result = self.root / 'bin/hindsightkit.exe'
        result.parent.mkdir(exist_ok=True)
        result.write_bytes(b'disposable launcher fixture')
        return result

    def task_state(self, *, enabled=True, exists=True):
        return {'enabled': enabled, 'exists': exists, 'name': 'fixture task', 'lastResult': 0}

    def test_explicit_stop_skips_all_services_and_preserves_state_bytes(self):
        self.record()
        lifecycle.stop()
        before = lifecycle.path().read_bytes()
        startup.run()
        self.start_local.assert_not_called()
        self.resume.assert_not_called()
        self.prepare_client.assert_not_called()
        self.assertEqual(lifecycle.path().read_bytes(), before)
        self.assertIn('remains stopped', self.output.getvalue())

    def test_disabled_startup_skips_all_services(self):
        self.preference(False)
        self.record()
        startup.run()
        self.start_local.assert_not_called()
        self.resume.assert_not_called()
        self.prepare_client.assert_not_called()
        self.assertFalse(lifecycle.path().exists())

    def test_server_roles_resume_without_changing_memory_epochs(self):
        lifecycle.connected()
        before = lifecycle.path().read_bytes()
        for mode in ('full', 'server-only'):
            with self.subTest(mode=mode):
                self.record(mode)
                self.start_local.reset_mock()
                self.resume.reset_mock()
                startup.run()
                self.start_local.assert_called_once_with()
                self.resume.assert_called_once_with()
                self.prepare_client.assert_not_called()
                self.assertEqual(lifecycle.path().read_bytes(), before)

    def test_stop_during_local_start_stops_services_without_resuming(self):
        self.record()
        self.start_local.side_effect = lifecycle.stop
        startup.run()
        self.stop_local.assert_called_once_with(database=True)
        self.resume.assert_not_called()
        self.assertTrue(lifecycle.state()['stopped'])

    def test_local_start_failure_propagates_and_preserves_lifecycle(self):
        self.record()
        lifecycle.connected()
        before = lifecycle.path().read_bytes()
        self.start_local.side_effect = RuntimeError('database unavailable')
        with self.assertRaisesRegex(RuntimeError, 'database unavailable'):
            startup.run()
        self.resume.assert_not_called()
        self.assertEqual(lifecycle.path().read_bytes(), before)

    def test_stop_during_failed_local_start_cleans_up_services(self):
        self.record()

        def failing_start():
            lifecycle.stop()
            raise RuntimeError('dashboard unavailable')

        self.start_local.side_effect = failing_start
        with self.assertRaisesRegex(RuntimeError, 'dashboard unavailable'):
            startup.run()
        self.stop_local.assert_called_once_with(database=True)
        self.resume.assert_not_called()
        self.assertTrue(lifecycle.state()['stopped'])

    def test_client_only_resumes_client_even_if_a_local_server_profile_exists(self):
        self.record('client-only')
        config = {'apiUrl': 'http://127.0.0.1:43123', 'apiToken': 'fixture',
                  'hindsightkit': {'transport': {'mode': 'connect', 'local_port': 43123}}}
        self.config.write_text(json.dumps(config), encoding='utf-8')
        lifecycle.connected()
        before = lifecycle.path().read_bytes()
        with patch.object(connection, 'has_server', return_value=True):
            startup.run()
        self.prepare_client.assert_called_once_with(config)
        self.start_local.assert_not_called()
        self.resume.assert_not_called()
        self.resume_host.assert_not_called()
        self.assertEqual(lifecycle.path().read_bytes(), before)

    def test_unconnected_or_disconnected_client_does_not_resume(self):
        self.record('client-only')
        for disconnected in (False, True):
            with self.subTest(disconnected=disconnected):
                if disconnected:
                    self.config.write_text('{}', encoding='utf-8')
                    lifecycle.disconnect()
                startup.run()
                self.prepare_client.assert_not_called()
                self.start_local.assert_not_called()
                self.resume.assert_not_called()
                self.resume_host.assert_not_called()

    def test_missing_or_invalid_installation_record_never_starts_services(self):
        record = self.root / 'installation.json'
        for value in (None, {'schema': 1, 'mode': 'unknown'}, {'schema': 9, 'mode': 'full'},
                      {'schema': 1}, [], 'full'):
            with self.subTest(value=value):
                if value is None:
                    record.unlink(missing_ok=True)
                else:
                    record.write_text(json.dumps(value), encoding='utf-8')
                with self.assertRaises((RuntimeError, ValueError)):
                    startup.run()
                self.start_local.assert_not_called()
                self.resume.assert_not_called()

    def test_saved_opt_out_survives_upgrade_without_requiring_a_launcher(self):
        self.preference(False)
        self.task.side_effect = None
        self.task.return_value = self.task_state(enabled=False, exists=False)
        startup.install(self.root / 'absent.exe')
        self.task.assert_called_once_with('remove')
        self.private.assert_not_called()
        self.assertFalse(json.loads((self.root / 'startup.json').read_text())['enabled'])
        self.assertFalse((self.root / 'bin/login-startup.ps1').exists())

    def test_invalid_preference_never_starts_or_registers(self):
        launcher = self.launcher()
        self.record()
        for value in ({'schema': 9, 'enabled': True}, {'schema': 1, 'enabled': 'false'},
                      {'schema': 1}, [], None):
            with self.subTest(value=value):
                (self.root / 'startup.json').write_text(json.dumps(value), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'Invalid login startup settings'):
                    startup.run()
                with self.assertRaisesRegex(RuntimeError, 'Invalid login startup settings'):
                    startup.install(launcher)
                self.task.assert_not_called()
                self.start_local.assert_not_called()
                self.prepare_client.assert_not_called()

    def test_registration_refresh_keeps_same_script_and_saved_state(self):
        launcher = self.launcher()
        self.task.side_effect = None
        self.task.return_value = self.task_state()
        startup.install(launcher)
        script = self.root / 'bin/login-startup.ps1'
        original = script.read_bytes()
        startup.install(launcher)
        self.assertEqual(script.read_bytes(), original)
        self.assertEqual(json.loads((self.root / 'startup.json').read_text()),
                         {'schema': 1, 'enabled': True})
        self.assertEqual(self.task.call_args_list,
                         [call('status'), call('install', enable=False)] * 2)
        self.assertFalse(script.with_suffix('.tmp').exists())

    def test_disabled_native_task_remains_disabled_during_upgrade(self):
        launcher = self.launcher()
        self.task.side_effect = None
        self.task.return_value = self.task_state(enabled=False)
        startup.install(launcher)
        self.assertFalse(json.loads((self.root / 'startup.json').read_text())['enabled'])
        self.task.assert_called_with('install', enable=False)

    def test_registration_failure_restores_previous_script_and_preference(self):
        launcher = self.launcher()
        self.preference(True)
        settings = (self.root / 'startup.json').read_bytes()
        script = self.root / 'bin/login-startup.ps1'
        for previous in (None, startup._runner(launcher).encode('utf-8-sig')):
            with self.subTest(previous=previous is not None):
                if previous is None:
                    script.unlink(missing_ok=True)
                else:
                    script.write_bytes(previous)
                self.task.side_effect = [self.task_state(), RuntimeError('scheduler unavailable')]
                with self.assertRaisesRegex(RuntimeError, 'scheduler unavailable'):
                    startup.install(launcher)
                self.assertEqual(script.read_bytes() if script.exists() else None, previous)
                self.assertEqual((self.root / 'startup.json').read_bytes(), settings)
                self.assertFalse(script.with_suffix('.tmp').exists())

    def test_foreign_task_preflight_preserves_existing_script(self):
        launcher = self.launcher()
        script = self.root / 'bin/login-startup.ps1'
        script.write_bytes(b'unrelated script')
        self.task.side_effect = RuntimeError('not owned by this installation')
        with self.assertRaisesRegex(RuntimeError, 'not owned'):
            startup.install(launcher)
        self.assertEqual(script.read_bytes(), b'unrelated script')
        self.private.assert_not_called()
        self.task.assert_called_once_with('status')
        self.assertFalse((self.root / 'startup.json').exists())

    def test_unowned_script_is_preserved_when_task_is_absent(self):
        launcher = self.launcher()
        script = self.root / 'bin/login-startup.ps1'
        script.write_bytes(b'unrelated script')
        self.task.side_effect = None
        self.task.return_value = self.task_state(enabled=False, exists=False)
        with self.assertRaisesRegex(RuntimeError, 'not managed by HindsightKit'):
            startup.install(launcher)
        self.assertEqual(script.read_bytes(), b'unrelated script')
        self.task.assert_called_once_with('status')
        self.assertFalse((self.root / 'startup.json').exists())

    def test_registration_rejects_any_other_launcher(self):
        launcher = self.root / 'other.exe'
        launcher.write_bytes(b'other application')
        with self.assertRaisesRegex(RuntimeError, 'installed HindsightKit command'):
            startup.install(launcher)
        self.task.assert_not_called()

    def test_enable_overrides_opt_out_without_resuming_explicit_stop(self):
        self.launcher()
        self.preference(False)
        lifecycle.stop()
        before = lifecycle.path().read_bytes()
        self.task.side_effect = None
        self.task.return_value = self.task_state()
        startup.command('on')
        self.task.assert_called_with('install', enable=True)
        self.assertTrue(json.loads((self.root / 'startup.json').read_text())['enabled'])
        self.assertEqual(lifecycle.path().read_bytes(), before)
        self.start_local.assert_not_called()
        self.assertIn('remains stopped', self.output.getvalue())

    def test_disable_removes_task_before_saving_opt_out(self):
        self.preference(True)
        original = (self.root / 'startup.json').read_bytes()
        self.task.side_effect = RuntimeError('foreign task')
        with self.assertRaisesRegex(RuntimeError, 'foreign task'):
            startup.command('off')
        self.assertEqual((self.root / 'startup.json').read_bytes(), original)
        self.task.side_effect = None
        self.task.return_value = self.task_state(enabled=False, exists=False)
        startup.command('off')
        self.task.assert_called_with('remove')
        self.assertFalse(json.loads((self.root / 'startup.json').read_text())['enabled'])
        self.stop_local.assert_not_called()

    def test_status_reports_task_result_and_log_location(self):
        self.task.side_effect = None
        self.task.return_value = {**self.task_state(), 'lastResult': 19}
        startup.command('status')
        self.task.assert_called_once_with('status')
        text = self.output.getvalue()
        self.assertIn('enabled', text)
        self.assertIn('Last task result: 19', text)
        self.assertIn(str(self.root / 'startup-error.log'), text)
        self.assertFalse((self.root / 'startup.json').exists())

    def test_cli_dispatches_public_controls_and_private_runner(self):
        with patch.object(runtime_env, 'prepare_env'), patch.object(startup, 'command') as command, \
             patch.object(startup, 'run') as run:
            for action in ('on', 'off', 'status'):
                with self.subTest(action=action):
                    self.assertEqual(cli.main(['startup', action]), 0)
                    command.assert_called_with(action)
            self.assertEqual(cli.main(['startup-run']), 0)
            run.assert_called_once_with()

    def test_private_runner_is_hidden_from_help_and_reports_failures(self):
        with self.assertRaises(SystemExit):
            cli.main(['--help'])
        self.assertIn('startup', self.output.getvalue())
        self.assertNotIn('startup-run', self.output.getvalue())
        with patch.object(runtime_env, 'prepare_env'), \
             patch.object(startup, 'run', side_effect=RuntimeError('database unavailable')), \
             contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(cli.main(['startup-run']), 1)
        self.assertIn('database unavailable', error.getvalue())


@unittest.skipUnless(os.name == 'nt', 'Windows hidden startup launcher')
class NativeStartupRunnerTests(unittest.TestCase):
    def test_generated_runner_quotes_paths_and_propagates_native_exit_code(self):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        self.assertTrue(compiler.is_file(), 'The Windows fixture compiler must be available.')
        with tempfile.TemporaryDirectory(prefix='hk login runner ') as temporary:
            root = Path(temporary) / "登录 user's space $(throw) & literal"
            root.mkdir()
            binary = root / 'hindsightkit.exe'
            config = root / "设置 user's connection.json"
            source = root / 'fixture.cs'
            source.write_text('''using System;
using System.IO;
using System.Text;
class Fixture {
    static int Main(string[] args) {
        string root = Environment.GetEnvironmentVariable("HINDSIGHTKIT_HOME");
        File.WriteAllLines(Path.Combine(root, "received.txt"), new[] {
            String.Join("|", args), root,
            Environment.GetEnvironmentVariable("HINDSIGHT_CONFIG"),
            Environment.CurrentDirectory,
            Environment.GetEnvironmentVariable("PYTHONUTF8"),
            Environment.GetEnvironmentVariable("PYTHONIOENCODING"),
            Environment.GetEnvironmentVariable("PYTHONUNBUFFERED")
        }, new UTF8Encoding(false));
        Console.WriteLine("fixture started");
        Console.Error.WriteLine("fixture diagnostic");
        return Int32.Parse(Environment.GetEnvironmentVariable("HK_FIXTURE_EXIT"));
    }
}
''', encoding='utf-8')
            compiled = subprocess.run([str(compiler), '/nologo', '/out:' + str(binary), str(source)],
                capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            script = root / 'login-startup.ps1'
            with patch.object(runtime_env, 'home', return_value=root), \
                 patch.object(connection, 'config_path', return_value=config):
                script.write_text(startup._runner(binary), encoding='utf-8-sig')
            shells = list(dict.fromkeys(filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')])))
            self.assertTrue(shells)
            for shell in shells:
                for expected in (0, 19):
                    with self.subTest(shell=Path(shell).name, exit=expected):
                        result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy',
                            'Bypass', '-File', str(script)], capture_output=True, text=True, timeout=30,
                            env={**os.environ, 'HK_FIXTURE_EXIT': str(expected)},
                            creationflags=subprocess.CREATE_NO_WINDOW)
                        error = root / 'startup-error.log'
                        detail = error.read_text(encoding='utf-8-sig') if error.exists() else ''
                        self.assertEqual(result.returncode, expected, result.stdout + result.stderr + detail)
                        self.assertEqual((root / 'received.txt').read_text(encoding='utf-8').splitlines(),
                            ['startup-run', str(root), str(config), str(root), '1', 'utf-8', '1'])
                        self.assertIn('fixture started', (root / 'startup.log').read_text(encoding='utf-8-sig'))
                        self.assertIn('fixture diagnostic', detail)


if __name__ == '__main__':
    unittest.main()
