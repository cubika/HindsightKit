import argparse
import contextlib
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit import cli, connection


def options(**values):
    return argparse.Namespace(**dict(dict(server=None, api_key_env=None, model=None,
        model_dir=None, port=None, reasoning_effort=None, no_open=True), **values))


class RemoteSetupTests(unittest.TestCase):
    @contextlib.contextmanager
    def client_environment(self, root):
        path = root / 'coding-agent.json'
        profile_path = root / 'server.env'
        profile_path.write_text('HINDSIGHT_API_TENANT_API_KEY=server-only-key\n', encoding='utf-8')
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(path),
                'TEST_MEMORY_KEY': 'client-key', 'COPILOT_HOME': str(root / '.copilot')}))
            stack.enter_context(patch.object(cli.Path, 'home', return_value=root))
            stack.enter_context(patch.object(cli, 'home', return_value=root / 'runtime'))
            stack.enter_context(patch.object(cli, 'vscode_user_directories', return_value=[root / 'Code']))
            packages = stack.enter_context(patch.object(cli, 'install_node_packages'))
            stack.enter_context(patch.object(cli, 'ensure_copilot'))
            stack.enter_context(patch.object(cli, 'node', return_value='node'))
            stack.enter_context(patch.object(cli.socket, 'gethostname', return_value='Automatic-Hostname'))
            configure = stack.enter_context(patch.object(cli, 'configure_profile'))
            profile = stack.enter_context(patch.object(cli, 'profile_config'))
            start = stack.enter_context(patch.object(cli, 'start'))
            stack.enter_context(patch.object(cli, 'remove_project_registration'))

            def integration(action, *args, **kwargs):
                if action == 'config':
                    previous = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
                    path.write_text(json.dumps({**previous, 'apiUrl': args[1], **kwargs['data']}), encoding='utf-8')

            integrate = stack.enter_context(patch.object(cli, 'integrate', side_effect=integration))
            request = stack.enter_context(patch.object(connection, 'request', new_callable=AsyncMock))
            request.return_value = {'protocol': 1, 'routing': 'repository', 'sharedBank': 'hindsightkit-shared'}
            register = stack.enter_context(patch.object(connection, 'register', new_callable=AsyncMock))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield SimpleNamespace(path=path, profile_path=profile_path, packages=packages,
                configure=configure, profile=profile, start=start, integrate=integrate,
                request=request, register=register)

    @contextlib.contextmanager
    def server_environment(self, root, profile):
        client_path = root / 'coding-agent.json'
        profile_path = root / 'server.env'
        profile_path.write_text('HINDSIGHT_API_LLM_MODEL=existing-model\n', encoding='utf-8')
        paths = SimpleNamespace(port=9077, ui_port=19077, config=profile_path)
        with contextlib.ExitStack() as stack:
            environment = {key: value for key, value in os.environ.items() if key not in {'APPDATA', 'COPILOT_HOME'}}
            environment['HINDSIGHT_CONFIG'] = str(client_path)
            stack.enter_context(patch.dict(os.environ, environment, clear=True))
            stack.enter_context(patch.object(cli.Path, 'home', return_value=root))
            stack.enter_context(patch.object(cli, 'home', return_value=root / 'runtime'))
            stack.enter_context(patch.object(cli, 'profile_config', return_value=(profile, paths)))
            configure = stack.enter_context(patch.object(cli, 'configure_profile'))
            sharing = stack.enter_context(patch.object(cli, 'configure_sharing'))
            stack.enter_context(patch.object(cli, 'install_node_packages'))
            stack.enter_context(patch.object(cli, 'ensure_copilot'))
            stack.enter_context(patch.object(cli, 'start', return_value=('http://127.0.0.1:9077', 'http://localhost:19077')))
            check = stack.enter_context(patch.object(cli, 'check_memory', new_callable=AsyncMock))
            stack.enter_context(patch.object(cli, 'ensure_bank', new_callable=AsyncMock))
            request = stack.enter_context(patch.object(connection, 'request', new_callable=AsyncMock))
            register = stack.enter_context(patch.object(connection, 'register', new_callable=AsyncMock))
            stack.enter_context(patch('hindsightkit.postgres.setup_database'))
            stack.enter_context(patch('hindsightkit.routing.seed_aliases'))
            stack.enter_context(patch('hindsightkit.postgres.private_directory', side_effect=lambda path: path.mkdir(parents=True, exist_ok=True)))
            stack.enter_context(patch('hindsightkit.postgres.restrict_access'))
            integrate = stack.enter_context(patch.object(cli, 'integrate'))
            hosts = stack.enter_context(patch.object(cli, 'vscode_user_directories'))
            cleanup = stack.enter_context(patch.object(cli, 'remove_project_registration'))
            git = stack.enter_context(patch.object(cli.shutil, 'which'))
            prompt = stack.enter_context(patch.object(cli.getpass, 'getpass'))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield SimpleNamespace(path=client_path, configure=configure, sharing=sharing,
                check=check, request=request, register=register, integrate=integrate,
                hosts=hosts, cleanup=cleanup, git=git, prompt=prompt)

    def test_cli_exposes_server_address_and_removes_old_setup_flags(self):
        with patch.object(cli, 'prepare_env'), patch.object(cli, 'setup') as setup:
            self.assertEqual(cli.main(['setup']), 0)
            self.assertIsNone(setup.call_args.args[0].server)
            self.assertEqual(cli.main(['setup', '--server', 'http://example.invalid:9077']), 0)
            self.assertEqual(setup.call_args.args[0].server, 'http://example.invalid:9077')
            for flag in ['--api-url', '--bank', '--device-name', '--share', '--listen', '--local', '--replace-connection']:
                with self.subTest(flag=flag), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    cli.main(['setup', flag])
            for name in ['api_url', 'bank', 'device_name', 'share', 'listen', 'local', 'replace_connection']:
                self.assertFalse(hasattr(setup.call_args.args[0], name))

    def test_default_setup_selects_server_even_with_a_saved_client(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'coding-agent.json'
            path.write_text(json.dumps({'apiUrl': 'https://remote.invalid', 'hindsightkit': {'mode': 'client'}}))
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(path)}), \
                 patch.object(cli, 'setup_server') as server, patch.object(cli, 'setup_client') as client, \
                 patch.object(cli, 'home', return_value=root), \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe'), \
                 contextlib.redirect_stdout(io.StringIO()):
                cli.setup(options())
                server.assert_called_once()
                client.assert_not_called()
                cli.setup(options(server='http://remote.invalid'))
                client.assert_called_once()

    def test_powershell_rejects_bad_server_options_before_runtime_changes(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        if not shell:
            self.skipTest('PowerShell is not available.')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / 'setup.ps1'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
            command = [shell, '-NoProfile', '-File', str(script)]
            for arguments in [['-Server', 'ftp://invalid.example'], ['-Server', 'http://host/path'],
                              ['-Server', 'http://host', '-Model', 'server-only'],
                              ['-Bank', 'hidden'], ['-DeviceName', 'automatic'], ['-ApiUrl', 'http://host'],
                              ['-Share'], ['-Listen', '0.0.0.0'], ['-Local'], ['-ReplaceConnection']]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(command + arguments, capture_output=True, timeout=15)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / '.runtime').exists())

    def test_server_setup_leaves_hosts_and_same_machine_client_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.server_environment(root, {'HINDSIGHT_API_TENANT_API_KEY': 'server-key'}) as fixture:
                fixture.path.write_text(json.dumps({'apiUrl': 'https://remote.invalid', 'apiToken': 'client-key',
                    'hindsightkit': {'mode': 'client'}}), encoding='utf-8')
                original = fixture.path.read_bytes()
                cli.setup_server(options())
                self.assertEqual(fixture.path.read_bytes(), original)
                fixture.configure.assert_called_once()
                self.assertEqual(fixture.sharing.call_args.args[0], 'server-key')
                fixture.check.assert_awaited_once_with('http://127.0.0.1:9077', 'server-key')
                fixture.integrate.assert_not_called()
                fixture.hosts.assert_not_called()
                fixture.cleanup.assert_not_called()
                fixture.git.assert_not_called()
                fixture.register.assert_not_awaited()
                fixture.prompt.assert_not_called()
                request_config = fixture.request.call_args.args[0]
                self.assertEqual(request_config['apiToken'], 'server-key')
                self.assertEqual(request_config['apiUrl'], 'http://127.0.0.1:9077')
                self.assertEqual((root / 'runtime/server/connection-key.txt').read_text(), 'server-key')

    def test_client_discovers_routing_and_hostname_without_changing_server(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.client_environment(Path(temp)) as fixture:
                before = fixture.profile_path.read_bytes()
                cli.setup_client(options(server='http://127.0.0.1:19078', api_key_env='TEST_MEMORY_KEY'))
                fixture.configure.assert_not_called()
                fixture.profile.assert_not_called()
                fixture.start.assert_not_called()
                fixture.packages.assert_called_once_with(client=True)
                self.assertEqual(fixture.profile_path.read_bytes(), before)
                paths = [item.args[2] for item in fixture.request.call_args_list]
                self.assertIn('/ext/hindsightkit/connection', paths)
                config = fixture.register.call_args.args[0]
                self.assertEqual(config['apiToken'], 'client-key')
                self.assertEqual(config['hindsightkit']['name'], 'Automatic-Hostname')
                self.assertNotIn('bank', config['hindsightkit'])
                self.assertEqual(config['hindsightkit']['mode'], 'client')
                self.assertTrue(config['hindsightkit']['deviceId'])
                for item in fixture.integrate.call_args_list:
                    self.assertNotIn('client-key', str(item.args))

    def test_client_rerun_preserves_device_id_and_refreshes_hostname(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.client_environment(Path(temp)) as fixture:
                fixture.path.write_text(json.dumps({'apiUrl': 'http://127.0.0.1:19078', 'apiToken': 'saved-key',
                    'logLevel': 'warn', 'hindsightkit': {'mode': 'client', 'bank': 'previous-bank',
                    'deviceId': '39c07d23-4f04-4e57-a4b3-e80f9f2229cc', 'name': 'Old hostname'}}))
                with patch.object(cli.getpass, 'getpass') as prompt:
                    cli.setup_client(options(server='http://127.0.0.1:19078'))
                prompt.assert_not_called()
                config = json.loads(fixture.path.read_text())
                self.assertEqual(config['apiToken'], 'saved-key')
                self.assertEqual(config['hindsightkit']['deviceId'], '39c07d23-4f04-4e57-a4b3-e80f9f2229cc')
                self.assertEqual(config['hindsightkit']['name'], 'Automatic-Hostname')
                self.assertNotIn('bank', config['hindsightkit'])
                self.assertEqual(config['logLevel'], 'warn')

    def test_new_destination_does_not_receive_old_saved_key(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.client_environment(Path(temp)) as fixture:
                fixture.path.write_text(json.dumps({'apiUrl': 'http://old.invalid', 'apiToken': 'old-server-key',
                    'hindsightkit': {'mode': 'client'}}))
                with patch.object(cli.getpass, 'getpass', return_value='new-server-key') as prompt:
                    cli.setup_client(options(server='http://new.invalid'))
                prompt.assert_called_once()
                self.assertTrue(all(item.args[0]['apiToken'] == 'new-server-key'
                                    for item in fixture.request.call_args_list))

    def test_failed_or_incompatible_discovery_preserves_client_settings(self):
        for discovery in [RuntimeError('connection refused'), {'protocol': 2, 'routing': 'repository'},
                          {'protocol': 1}, {'protocol': 1, 'routing': 'unknown'}]:
            with self.subTest(discovery=discovery), tempfile.TemporaryDirectory() as temp:
                with self.client_environment(Path(temp)) as fixture:
                    fixture.path.write_text(json.dumps({'old': 'preserve'}, indent=2))
                    before = fixture.path.read_bytes()
                    if isinstance(discovery, Exception):
                        fixture.request.side_effect = discovery
                    else:
                        fixture.request.return_value = discovery
                    with self.assertRaises((RuntimeError, ValueError)):
                        cli.setup_client(options(server='http://new.invalid', api_key_env='TEST_MEMORY_KEY'))
                    self.assertEqual(fixture.path.read_bytes(), before)
                    fixture.packages.assert_not_called()
                    fixture.integrate.assert_not_called()
                    fixture.register.assert_not_awaited()

    def test_local_management_does_not_follow_same_machine_remote_client(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'coding-agent.json'
            client = {'apiUrl': 'https://remote.invalid', 'apiToken': 'remote-key', 'hindsightkit': {'mode': 'client'}}
            path.write_text(json.dumps(client))
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(path)}), \
                 patch.object(cli, 'profile_config', return_value=({'HINDSIGHT_API_TENANT_API_KEY': 'server-key'},
                    SimpleNamespace(port=9077))), patch.object(connection, 'has_server', return_value=True):
                self.assertEqual(connection.load(), client)
                server = connection.server_load()
                self.assertEqual(server['apiUrl'], 'http://127.0.0.1:9077')
                self.assertEqual(server['apiToken'], 'server-key')
                self.assertEqual(connection.management(), server)
                with patch.object(connection, 'has_server', return_value=False):
                    self.assertEqual(connection.management(), client)


if __name__ == '__main__':
    unittest.main()
