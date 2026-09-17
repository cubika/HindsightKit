import argparse
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile
from unittest.mock import AsyncMock, patch

from hindsightkit import cli, connection


def options(**values):
    return argparse.Namespace(**dict(dict(server=None, api_key_env=None, model=None,
        server_only=False, model_dir=None, port=None, reasoning_effort=None, no_open=True), **values))


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
            auth = stack.enter_context(patch.object(cli, 'ensure_copilot'))
            stack.enter_context(patch.object(cli.shutil, 'which', return_value='git'))
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
            async def response(config, method, endpoint, **kwargs):
                if endpoint == '/ext/hindsightkit/connection':
                    return request.return_value
                if endpoint == '/v1/default/banks/hindsightkit-shared/stats':
                    return {'bank_id': 'hindsightkit-shared', 'total_nodes': 0}
                raise RuntimeError('Unexpected endpoint: ' + endpoint)
            request.side_effect = response
            register = stack.enter_context(patch.object(connection, 'register', new_callable=AsyncMock))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield SimpleNamespace(path=path, profile_path=profile_path, packages=packages,
                configure=configure, profile=profile, start=start, integrate=integrate,
                request=request, register=register, auth=auth)

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
            stopped = stack.enter_context(patch.object(cli, 'stop_profile_services'))
            packages = stack.enter_context(patch.object(cli, 'install_node_packages'))
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
                hosts=hosts, cleanup=cleanup, git=git, prompt=prompt, stopped=stopped, packages=packages)

    def test_cli_exposes_server_address_and_removes_old_setup_flags(self):
        with patch.object(cli, 'prepare_env'), patch.object(cli, 'setup') as setup:
            self.assertEqual(cli.main(['setup']), 0)
            self.assertIsNone(setup.call_args.args[0].server)
            self.assertFalse(setup.call_args.args[0].server_only)
            self.assertEqual(cli.main(['setup', '--server-only']), 0)
            self.assertTrue(setup.call_args.args[0].server_only)
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
                 patch.object(cli, 'setup_server', return_value={'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'local-key'}) as server, \
                 patch.object(cli, 'setup_client') as client, patch.object(cli, 'require_client_prerequisites'), \
                 patch.object(cli, 'home', return_value=root), \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe'), \
                 contextlib.redirect_stdout(io.StringIO()):
                cli.setup(options())
                server.assert_called_once()
                client.assert_not_called()
                cli.setup(options(server='http://remote.invalid'))
                client.assert_called_once()

    def test_default_setup_connects_client_to_server_result_and_server_only_skips_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local = {'apiUrl': 'http://127.0.0.1:18077', 'apiToken': 'generated-key'}
            with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(root / 'client.json')}), \
                 patch.object(cli, 'setup_server', return_value=local) as server, \
                 patch.object(cli, 'setup_client') as client, patch.object(cli, 'require_client_prerequisites') as prereqs, \
                 patch.object(cli, 'home', return_value=root), \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe'), \
                 contextlib.redirect_stdout(io.StringIO()):
                args = options(port=18077, model='chosen-model')
                cli.setup(args)
                server.assert_called_once_with(args)
                client.assert_called_once_with(args, local_server=local)
                client.reset_mock()
                prereqs.reset_mock()
                cli.setup(options(server_only=True))
                client.assert_not_called()
                prereqs.assert_not_called()

    def test_invalid_options_and_missing_prerequisites_fail_before_server_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(cli, 'setup_server') as server, patch.object(cli, 'setup_client') as client, \
                 patch.object(cli.Path, 'home', return_value=root), \
                 patch.dict(os.environ, {'COPILOT_HOME': str(root / '.copilot')}):
                for args in [options(server='http://host', server_only=True), options(port=65536),
                             options(model_dir=str(root / 'missing')), options(server='ftp://host')]:
                    with self.subTest(args=args), self.assertRaises((ValueError, FileNotFoundError)):
                        cli.setup(args)
                with patch.object(cli.shutil, 'which', return_value=None), self.assertRaisesRegex(RuntimeError, 'Git'):
                    cli.setup(options())
                with patch.dict(os.environ, {'COPILOT_HOME': str(root / 'other')}), self.assertRaisesRegex(RuntimeError, 'COPILOT_HOME'):
                    cli.setup(options(server_only=True))
                server.assert_not_called()
                client.assert_not_called()

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
                              ['-Server', 'http://host', '-ServerOnly'], ['-Port', '65536'],
                              ['-ModelDir', str(root / 'missing')], ['-ApiKeyEnv', 'MISSING_HINDSIGHTKIT_TEST_KEY'],
                              ['-Bank', 'hidden'], ['-DeviceName', 'automatic'], ['-ApiUrl', 'http://host'],
                              ['-Share'], ['-Listen', '0.0.0.0'], ['-Local'], ['-ReplaceConnection']]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(command + arguments, capture_output=True, timeout=15)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / '.runtime').exists())

    def test_powershell_checks_git_and_copilot_home_before_downloads(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        if not shell:
            self.skipTest('PowerShell is not available.')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            script = root / 'setup.ps1'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
            for changes, message in [({'PATH': '', 'COPILOT_HOME': ''}, 'Git must be installed'),
                                     ({'COPILOT_HOME': str(root / 'custom-copilot')}, 'Unset COPILOT_HOME')]:
                with self.subTest(changes=changes):
                    result = subprocess.run([shell, '-NoProfile', '-File', str(script)],
                        env={**os.environ, **changes}, capture_output=True, text=True, encoding='utf-8', timeout=15)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse((root / '.runtime').exists())

    def test_client_release_upgrade_retains_installed_server_dependencies(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        if not shell:
            self.skipTest('PowerShell is not available.')
        for installed_server in [None, 'profile', 'runtime']:
            with self.subTest(installed_server=installed_server), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                release = root / 'new-release'
                release.mkdir()
                script = release / 'setup.ps1'
                shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
                if installed_server == 'profile':
                    profile = root / '.hindsight/profiles/hindsightkit.env'
                    profile.parent.mkdir(parents=True)
                    profile.write_text('HINDSIGHT_API_PORT=18077\n', encoding='utf-8')
                elif installed_server == 'runtime':
                    (release / '.venv/Lib/site-packages/hindsight_api').mkdir(parents=True)
                binary = root / 'bin'
                binary.mkdir()
                (binary / 'node.ps1').write_text("Write-Output 'v22.23.2'\n", encoding='utf-8')
                (binary / 'uv.ps1').write_text(
                    'ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath $env:TEST_SYNC_ARGS\n'
                    '$global:LASTEXITCODE = 71\n', encoding='utf-8')
                trace = root / 'sync-args.json'
                environment = {**os.environ, 'USERPROFILE': str(root), 'COPILOT_HOME': '',
                    'PATH': str(binary) + os.pathsep + os.environ['PATH'], 'TEST_SYNC_ARGS': str(trace)}
                result = subprocess.run([shell, '-NoProfile', '-File', str(script), '-Server', 'http://remote.invalid'],
                    env=environment, capture_output=True, text=True, encoding='utf-8', timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('exit 71', result.stderr)
                arguments = json.loads(trace.read_text(encoding='utf-8-sig'))
                self.assertEqual(arguments[:3], ['sync', '--project', str(release)])
                self.assertEqual('--extra' in arguments, installed_server is not None)
                if installed_server:
                    self.assertEqual(arguments[-2:], ['--extra', 'server'])
                if installed_server == 'profile':
                    self.assertFalse((release / '.venv').exists())
                    self.assertEqual(profile.read_text(encoding='utf-8'), 'HINDSIGHT_API_PORT=18077\n')

    @unittest.skipUnless(os.name == 'nt', 'Release installer runs on Windows.')
    def test_release_setup_uses_its_own_node_and_reuses_the_verified_version(self):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if not shell or not compiler.is_file():
            self.skipTest('PowerShell and the Windows .NET compiler are required.')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'node.cs'
            source.write_text('class Node { static void Main() { System.Console.WriteLine("v22.23.2"); } }', encoding='utf-8')
            fake_node = root / 'node.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(fake_node), str(source)], check=True, capture_output=True, timeout=30)
            source.write_text('class Node { static void Main() { System.Console.WriteLine("v22.18.0"); } }', encoding='utf-8')
            old_node = root / 'old-node.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(old_node), str(source)], check=True, capture_output=True, timeout=30)
            archive = root / 'fixture.zip'
            with zipfile.ZipFile(archive, 'w') as fixture:
                fixture.write(fake_node, 'node-v22.23.2-win-x64/node.exe')
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            for bundled in [None, 'matching', 'outdated']:
                with self.subTest(bundled=bundled):
                    case = root / str(bundled)
                    release = case / 'release'
                    release.mkdir(parents=True)
                    script = release / 'setup.ps1'
                    shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
                    selected_node = release / '.runtime/tools/node-v22.23.2-win-x64/node.exe'
                    if bundled:
                        selected_node.parent.mkdir(parents=True)
                        shutil.copyfile(fake_node if bundled == 'matching' else old_node, selected_node)
                    binary = case / 'old-checkout-bin'
                    binary.mkdir()
                    (binary / 'node.ps1').write_text('throw "Old checkout Node must not be selected."\n', encoding='utf-8')
                    (binary / 'uv.ps1').write_text('$global:LASTEXITCODE = 0\n', encoding='utf-8')
                    state = case / 'state'
                    state.mkdir()
                    saved_node = state / 'node-path.txt'
                    saved_node.write_text(str(binary / 'node.ps1'), encoding='utf-8')
                    requests = case / 'downloads.txt'
                    wrapper = case / 'test.ps1'
                    wrapper.write_text(
                        'function Invoke-WebRequest {\n'
                        '  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)\n'
                        '  if (-not $UseBasicParsing) { throw "Missing basic parsing." }\n'
                        '  Add-Content -LiteralPath $env:TEST_DOWNLOADS -Value $Uri\n'
                        '  if ($Uri.EndsWith("SHASUMS256.txt")) { return @{ Content = $env:TEST_CHECKSUM + "  node-v22.23.2-win-x64.zip" } }\n'
                        '  Copy-Item -LiteralPath $env:TEST_ARCHIVE -Destination $OutFile\n'
                        '}\n& $env:TEST_SETUP -Server http://remote.invalid\n', encoding='utf-8')
                    environment = {**os.environ, 'USERPROFILE': str(case), 'COPILOT_HOME': '',
                        'HINDSIGHTKIT_HOME': str(state), 'HINDSIGHTKIT_RELEASE_MANIFEST': str(release / 'release.json'),
                        'PATH': str(binary) + os.pathsep + os.environ['PATH'], 'TEST_ARCHIVE': str(archive),
                        'TEST_CHECKSUM': checksum, 'TEST_SETUP': str(script), 'TEST_DOWNLOADS': str(requests)}
                    result = subprocess.run([shell, '-NoProfile', '-File', str(wrapper)], env=environment,
                        capture_output=True, text=True, encoding='utf-8', timeout=30)
                    # Stop at the absent fake venv; dependency selection and saved runtime path have completed.
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('python.exe', result.stderr)
                    self.assertNotIn('Old checkout Node', result.stderr)
                    self.assertEqual(saved_node.read_text(encoding='utf-8'), str(selected_node))
                    self.assertEqual(requests.exists(), bundled != 'matching')
                    if bundled != 'matching':
                        self.assertEqual(len(requests.read_text(encoding='utf-8-sig').splitlines()), 2)

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
                fixture.stopped.assert_called_once()

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

    def test_local_client_uses_current_server_key_and_does_not_repeat_login(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.client_environment(Path(temp)) as fixture:
                fixture.path.write_text(json.dumps({'apiUrl': 'http://127.0.0.1:18077', 'apiToken': 'old-key',
                    'hindsightkit': {'mode': 'client'}}))
                local = {'apiUrl': 'http://127.0.0.1:18077', 'apiToken': 'current-key'}
                with patch.object(cli.getpass, 'getpass') as prompt:
                    cli.setup_client(options(model='server-model', port=18077), local_server=local)
                prompt.assert_not_called()
                fixture.auth.assert_not_called()
                config = fixture.register.call_args.args[0]
                self.assertEqual(config['apiUrl'], local['apiUrl'])
                self.assertEqual(config['apiToken'], 'current-key')
                self.assertEqual(json.loads(fixture.path.read_text())['apiToken'], 'current-key')

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
