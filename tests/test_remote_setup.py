import argparse
import asyncio
import contextlib
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from provenloop import cli, connection
from provenloop.hooks import session_config
from provenloop.memory import Memory, Scope


def options(**values):
    return argparse.Namespace(**dict(dict(api_url='http://127.0.0.1:19078', bank='team-memory',
        api_key_env='TEST_MEMORY_KEY', device_name='Test PC', local=False, share=False,
        listen=None, replace_connection=False, model=None, model_dir=None, port=None,
        reasoning_effort=None, no_open=True), **values))


class RemoteSetupTests(unittest.TestCase):
    def test_powershell_rejects_bad_client_setup_before_creating_runtime(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        if not shell:
            self.skipTest('PowerShell is not available.')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / 'setup.ps1'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
            config = root / 'config.json'
            env = {**os.environ, 'HINDSIGHT_CONFIG': str(config)}
            command = [shell, '-NoProfile', '-File', str(script), '-ApiUrl', 'http://127.0.0.1:1']
            result = subprocess.run(command, env=env, capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / '.runtime').exists())
            config.write_text(json.dumps({'apiUrl': 'http://127.0.0.1:9077',
                'provenloop': {'mode': 'local', 'bank': None}}))
            result = subprocess.run(command + ['-Bank', 'shared'], env=env, capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / '.runtime').exists())

    def test_client_setup_registers_without_installing_or_starting_server(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / 'coding-agent.json'
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(config), 'TEST_MEMORY_KEY': 'test-key'}), \
                 patch.object(cli.Path, 'home', return_value=root), \
                 patch.object(cli, 'home', return_value=root / 'runtime'), \
                 patch.object(cli, 'vscode_user_directories', return_value=[root / 'Code']), \
                 patch.object(cli, 'install_node_packages') as packages, \
                 patch.object(cli, 'ensure_copilot'), patch.object(cli, 'node', return_value='node'), \
                 patch.object(cli, 'configure_profile') as profile, patch.object(cli, 'start') as start, \
                 patch.object(cli, 'integrate') as integrate, \
                 patch.object(cli, 'remove_project_registration'), \
                 patch.object(connection, 'request', new_callable=AsyncMock) as request, \
                 patch.object(connection, 'register', new_callable=AsyncMock) as register, \
                 patch('provenloop.command.install', return_value='provenloop.exe'), \
                 contextlib.redirect_stdout(io.StringIO()):
                cli.setup(options())
            packages.assert_called_once_with(client=True)
            profile.assert_not_called()
            start.assert_not_called()
            self.assertEqual(request.await_count, 2)
            candidate = register.call_args.args[0]
            self.assertEqual(candidate['apiToken'], 'test-key')
            self.assertEqual(candidate['provenloop']['bank'], 'team-memory')
            self.assertEqual(candidate['provenloop']['mode'], 'client')
            self.assertFalse((root / '.hindsight/profiles').exists())
            for call in integrate.call_args_list:
                self.assertNotIn('test-key', str(call.args))

    def test_failed_connection_does_not_register_or_replace_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = root / 'config.json'
            config.write_text('{}')
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(config), 'TEST_MEMORY_KEY': 'test-key'}), \
                 patch.object(cli, 'home', return_value=root), \
                 patch.object(cli, 'vscode_user_directories', return_value=[]), \
                 patch.object(cli, 'install_node_packages'), patch.object(cli, 'integrate') as integrate, \
                 patch.object(connection, 'request', side_effect=RuntimeError('connection refused')), \
                 patch.object(connection, 'register', new_callable=AsyncMock) as register:
                with self.assertRaisesRegex(RuntimeError, 'connection refused'):
                    cli.setup(options())
            integrate.assert_not_called()
            register.assert_not_called()
            self.assertEqual(config.read_text(), '{}')

    def test_client_commands_do_not_start_or_stop_local_services(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            config.write_text(json.dumps({'apiUrl': 'http://127.0.0.1:19078',
                'provenloop': {'mode': 'client', 'bank': 'team-memory'}}))
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(config)}), \
                 patch.object(cli, 'prepare_env'), patch.object(cli, 'run') as run, \
                 patch.object(cli.webbrowser, 'open') as browser, \
                 contextlib.redirect_stderr(io.StringIO()):
                for command in ('start', 'stop', 'ui'):
                    self.assertEqual(cli.main([command]), 1)
            run.assert_not_called()
            browser.assert_not_called()

    def test_two_paths_use_fixed_bank_and_no_extra_shared_read(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            a, b = root / 'a', root / 'b'
            a.mkdir(); b.mkdir()
            config = {'apiUrl': 'http://127.0.0.1:1', 'apiToken': 'key',
                      'provenloop': {'bank': 'team-memory', 'mode': 'client'}}
            with patch('provenloop.hooks.home', return_value=root):
                first = session_config({'sessionId': 'a', 'cwd': str(a)}, config)[1]
                second = session_config({'sessionId': 'b', 'cwd': str(b)}, config)[1]
            self.assertEqual(first['bankId'], second['bankId'])
            self.assertEqual(first['bankId'], 'team-memory')
            self.assertEqual(first['apiToken'], 'key')
            self.assertEqual(Scope(first['bankId']).readable_banks, ('team-memory',))

    def test_bank_and_destination_change_require_explicit_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / 'config.json'
            config.write_text(json.dumps({'apiUrl': 'http://127.0.0.1:9', 'apiToken': 'key',
                'provenloop': {'mode': 'client', 'bank': 'old'}}))
            original = config.read_bytes()
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(config), 'TEST_MEMORY_KEY': 'test-key'}):
                with self.assertRaisesRegex(ValueError, 'replace-connection'):
                    cli.setup(options())
            self.assertEqual(original, config.read_bytes())

    def test_bare_client_setup_preserves_endpoint_bank_and_device(self):
        # Parse-time default command keeps a remote installation remote on rerun.
        with patch.object(cli, 'prepare_env'), patch.object(cli, 'setup') as setup:
            self.assertEqual(cli.main(['setup']), 0)
        args = setup.call_args.args[0]
        self.assertFalse(args.local)
        self.assertIsNone(args.api_url)


if __name__ == '__main__':
    unittest.main()
