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
        server_only=False, client_only=False, model_dir=None, port=None, reasoning_effort=None, no_open=True), **values))


def powershell_environment(root, **updates):
    environment = {key: value for key, value in os.environ.items()
                   if key.lower() != 'psmodulepath' and not key.upper().startswith('HINDSIGHTKIT_')}
    for name, relative in [('LOCALAPPDATA', 'AppData/Local'), ('APPDATA', 'AppData/Roaming')]:
        directory = root / relative
        directory.mkdir(parents=True, exist_ok=True)
        environment[name] = str(directory)
    environment.update(USERPROFILE=str(root), COPILOT_HOME='', HINDSIGHTKIT_HOME=str(root / 'state'))
    environment['PATH'] = os.pathsep.join(part for part in os.environ['PATH'].split(os.pathsep)
                                        if part and not (Path(part) / 'node.exe').is_file())
    return {**environment, **updates}


def offline_setup_command(shell, script, arguments=()):
    wrapper = script.with_name('invoke-test.ps1')
    quoted = [value if value.startswith('-') and value[1:].isalpha()
              else "'" + value.replace("'", "''") + "'" for value in arguments]
    wrapper.write_text("$ErrorActionPreference = 'Stop'\n"
                       'function Invoke-WebRequest { throw "Unexpected download in setup fixture." }\n'
                       "& (Join-Path $PSScriptRoot 'setup.ps1') " + ' '.join(quoted) +
                       '\nexit $LASTEXITCODE\n', encoding='utf-8')
    return [shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper)]


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
            self.assertFalse(setup.call_args.args[0].client_only)
            self.assertEqual(cli.main(['setup', '--client-only']), 0)
            self.assertTrue(setup.call_args.args[0].client_only)
            self.assertEqual(cli.main(['setup', '--server-only']), 0)
            self.assertTrue(setup.call_args.args[0].server_only)
            self.assertEqual(cli.main(['setup', '--server', 'http://example.invalid:9077']), 0)
            self.assertEqual(setup.call_args.args[0].server, 'http://example.invalid:9077')
            self.assertEqual(cli.main(['setup', '--client-only', '--server', 'http://example.invalid:9077']), 0)
            self.assertTrue(setup.call_args.args[0].client_only)
            for flag in ['--api-url', '--bank', '--device-name', '--share', '--listen', '--local', '--replace-connection']:
                with self.subTest(flag=flag), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    cli.main(['setup', flag])
            for name in ['api_url', 'bank', 'device_name', 'share', 'listen', 'local', 'replace_connection']:
                self.assertFalse(hasattr(setup.call_args.args[0], name))

    def test_client_only_install_does_not_select_or_contact_a_server(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.client_environment(root) as state, \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe') as launcher, \
                 patch.object(connection, 'has_server', return_value=False), \
                 patch.object(cli, 'setup_server') as server, patch.object(cli, 'stop_profile_services') as stop:
                cli.setup(options(client_only=True))
                state.packages.assert_called_once_with(client=True)
                state.auth.assert_called_once_with()
                launcher.assert_called_once_with(root / 'runtime/bin')
                state.integrate.assert_not_called()
                state.request.assert_not_awaited()
                state.register.assert_not_awaited()
                server.assert_not_called()
                stop.assert_not_called()
                self.assertFalse(state.path.exists())

    def test_client_only_upgrade_refreshes_integrations_offline_and_preserves_connection_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.client_environment(root) as state, \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe'), \
                 patch.object(connection, 'has_server', return_value=True), \
                 patch.object(cli, 'setup_server') as server, patch.object(cli, 'stop_profile_services') as stop:
                previous = {'apiUrl': 'http://127.0.0.1:41234', 'apiToken': 'saved-client-key',
                    'optInOnly': False, 'custom': 'preserved',
                    'hindsightkit': {'mode': 'client', 'activity': True, 'deviceId': 'saved-device',
                        'transport': {'mode': 'connect', 'tunnel_id': 'private-tunnel',
                                      'remote_port': 9077, 'local_port': 41234}}}
                state.path.write_text(json.dumps(previous, indent=4) + '\n', encoding='utf-8')
                original = state.path.read_bytes()
                state.request.side_effect = AssertionError('A disconnected server cannot block a client upgrade')
                for _ in range(2):
                    cli.setup(options(client_only=True))
                self.assertEqual(state.path.read_bytes(), original)
                self.assertEqual(state.profile_path.read_text(), 'HINDSIGHT_API_TENANT_API_KEY=server-only-key\n')
                self.assertEqual(state.packages.call_count, 2)
                state.auth.assert_not_called()
                state.request.assert_not_awaited()
                state.register.assert_not_awaited()
                server.assert_not_called()
                stop.assert_not_called()
                actions = [call.args[0] for call in state.integrate.call_args_list]
                self.assertEqual(actions, ['preflight', 'install-cli', 'vscode', 'check'] * 2)
                for call in state.integrate.call_args_list:
                    self.assertEqual(call.kwargs['runtime_path'], root / 'runtime/client-runtime')
                    if call.args[0] == 'install-cli':
                        self.assertEqual(call.args[-1], cli.sys.executable)
                    if call.args[0] == 'vscode':
                        self.assertEqual(call.args[2], cli.sys.executable)

    def test_client_only_upgrade_rejects_unmanaged_config_without_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.client_environment(root) as state:
                state.path.write_text('{"apiUrl": "https://existing.invalid"}\n')
                before = state.path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'not managed by HindsightKit'):
                    cli.setup(options(client_only=True))
                self.assertEqual(state.path.read_bytes(), before)
                state.packages.assert_not_called()
                state.integrate.assert_not_called()

    def test_client_only_with_server_connects_without_local_server_setup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.client_environment(root) as state, \
                 patch('hindsightkit.command.install', return_value='hindsightkit.exe'), \
                 patch.object(cli, 'setup_server') as server:
                cli.setup(options(client_only=True, server='https://memory.invalid', api_key_env='TEST_MEMORY_KEY'))
                server.assert_not_called()
                self.assertEqual(json.loads(state.path.read_text())['apiUrl'], 'https://memory.invalid')
                state.register.assert_awaited_once()

    def test_unconnected_client_status_and_commands_do_not_import_server_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / 'client-runtime'
            installed = directory / 'node_modules/@vectorize-io/hindsight-coding-agents/dist/installer.js'
            installed.parent.mkdir(parents=True)
            installed.write_text('// installed fixture')
            (directory / '.installed-lock').write_text('verified-lock')
            output = io.StringIO()
            with patch.object(cli, 'home', return_value=root), \
                 patch.object(connection, 'config_path', return_value=root / 'unconnected.json'), \
                 patch.object(connection, 'has_server', return_value=False), \
                 patch.object(connection, 'server_load', side_effect=AssertionError('No server dependencies')), \
                 patch.object(connection, 'request', new_callable=AsyncMock) as request, \
                 patch('hindsightkit.remote.status'), patch('hindsightkit.remote.resume') as resume, \
                 patch.object(cli, 'prepare_env'), contextlib.redirect_stdout(output), \
                 contextlib.redirect_stderr(output):
                self.assertTrue(cli.status())
                self.assertIn('installed; not connected', output.getvalue())
                self.assertEqual(cli.main(['start']), 1)
                self.assertEqual(cli.main(['check']), 1)
                self.assertIn('hindsightkit connect', output.getvalue())
                with self.assertRaisesRegex(RuntimeError, 'not connected'):
                    connection.load()
                request.assert_not_awaited()
                resume.assert_not_called()

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
                for args in [options(server='http://host', server_only=True),
                             options(client_only=True, server_only=True), options(client_only=True, model='server-model'),
                             options(client_only=True, api_key_env='NOT_USED'), options(port=65536),
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
            environment = powershell_environment(root)
            for arguments in [['-Server', 'ftp://invalid.example'], ['-Server', 'http://host/path'],
                              ['-Server', 'http://host', '-Model', 'server-only'],
                              ['-Server', 'http://host', '-ServerOnly'], ['-Port', '65536'],
                              ['-ModelDir', str(root / 'missing')], ['-ApiKeyEnv', 'MISSING_HINDSIGHTKIT_TEST_KEY'],
                              ['-Bank', 'hidden'], ['-DeviceName', 'automatic'], ['-ApiUrl', 'http://host'],
                              ['-Share'], ['-Listen', '0.0.0.0'], ['-Local'], ['-ReplaceConnection']]:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(offline_setup_command(shell, script, arguments),
                        env=environment, capture_output=True, timeout=15)
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
                    result = subprocess.run(offline_setup_command(shell, script),
                        env=powershell_environment(root, **changes), capture_output=True, text=True, encoding='utf-8', timeout=15)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse((root / '.runtime').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows setup dependency selection')
    def test_client_release_upgrade_retains_installed_server_dependencies(self):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        shells = list(dict.fromkeys(filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')])))
        if not shells or not compiler.is_file():
            self.skipTest('PowerShell and the Windows .NET compiler are required.')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'node.cs'
            source.write_text('class Node { static void Main(string[] args) { System.Console.WriteLine(args[0] == "-p" ? "x64" : "v22.23.2"); } }', encoding='utf-8')
            native = root / 'node.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(native), str(source)],
                           check=True, capture_output=True, timeout=30)
            for shell in shells:
                for installed_server in [None, 'profile', 'runtime']:
                    with self.subTest(shell=Path(shell).name, installed_server=installed_server):
                        case = root / Path(shell).stem / str(installed_server)
                        release = case / 'new-release'
                        release.mkdir(parents=True)
                        script = release / 'setup.ps1'
                        shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
                        if installed_server == 'profile':
                            profile = case / '.hindsight/profiles/hindsightkit.env'
                            profile.parent.mkdir(parents=True)
                            profile.write_text('HINDSIGHT_API_PORT=18077\n', encoding='utf-8')
                        elif installed_server == 'runtime':
                            (release / '.venv/Lib/site-packages/hindsight_api').mkdir(parents=True)
                        binary = case / 'bin'
                        binary.mkdir()
                        shutil.copyfile(native, binary / 'node.exe')
                        npm = binary / 'node_modules/npm/bin/npm-cli.js'
                        npm.parent.mkdir(parents=True)
                        npm.write_text('// fixture')
                        (binary / 'uv.ps1').write_text(
                            'if ($args[0] -eq "--version") { Write-Output "uv 0.12.15"; $global:LASTEXITCODE = 0; return }\n'
                            'ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath $env:TEST_SYNC_ARGS\n'
                            '$global:LASTEXITCODE = 71\n', encoding='utf-8')
                        trace = case / 'sync-args.json'
                        environment = powershell_environment(case, TEST_SYNC_ARGS=str(trace))
                        environment['PATH'] = str(binary) + os.pathsep + environment['PATH']
                        result = subprocess.run(offline_setup_command(shell, script, ['-Server', 'http://remote.invalid']),
                            env=environment, capture_output=True, text=True, encoding='utf-8', timeout=30)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('exit 71', result.stderr)
                        node_line = next(line for line in result.stdout.splitlines()
                                         if line.startswith('Reusing Node.js v22.23.2 at '))
                        self.assertTrue(Path(node_line.split(' at ', 1)[1]).samefile(binary / 'node.exe'))
                        arguments = json.loads(trace.read_text(encoding='utf-8-sig'))
                        self.assertEqual(arguments[:2], ['sync', '--project'])
                        self.assertTrue(Path(arguments[2]).samefile(release))
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
            source.write_text('class Node { static void Main(string[] args) { System.Console.WriteLine(args[0] == "-p" ? "x64" : "v22.23.2"); } }', encoding='utf-8')
            fake_node = root / 'node.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(fake_node), str(source)], check=True, capture_output=True, timeout=30)
            source.write_text('class Node { static void Main() { System.Console.WriteLine("v20.18.0"); } }', encoding='utf-8')
            old_node = root / 'old-node.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(old_node), str(source)], check=True, capture_output=True, timeout=30)
            archive = root / 'fixture.zip'
            with zipfile.ZipFile(archive, 'w') as fixture:
                fixture.write(fake_node, 'node-v22.23.2-win-x64/node.exe')
                fixture.writestr('node-v22.23.2-win-x64/node_modules/npm/bin/npm-cli.js', '// fixture')
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            for bundled in [None, 'matching', 'outdated']:
                with self.subTest(bundled=bundled):
                    case = root / str(bundled)
                    release = case / 'release'
                    release.mkdir(parents=True)
                    script = release / 'setup.ps1'
                    shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
                    (release / 'python/wheels').mkdir(parents=True)
                    (release / 'python/wheels/fixture.whl').write_bytes(b'fixture')
                    for name in ('requirements-client.txt', 'requirements-server.txt'):
                        (release / 'python' / name).write_text('fixture==1 --hash=sha256:' + '0' * 64)
                    selected_node = release / '.runtime/tools/node-v22.23.2-win-x64/node.exe'
                    if bundled:
                        selected_node.parent.mkdir(parents=True)
                        shutil.copyfile(fake_node if bundled == 'matching' else old_node, selected_node)
                        npm = selected_node.parent / 'node_modules/npm/bin/npm-cli.js'
                        npm.parent.mkdir(parents=True)
                        npm.write_text('// fixture')
                    binary = case / 'old-checkout-bin'
                    binary.mkdir()
                    (binary / 'node.ps1').write_text('throw "Old checkout Node must not be selected."\n', encoding='utf-8')
                    (binary / 'uv.ps1').write_text(
                        'if ($args[0] -eq "--version") { Write-Output "uv 0.12.15"; $global:LASTEXITCODE = 0; return }\n'
                        '$global:LASTEXITCODE = 71\n', encoding='utf-8')
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
                        '  if (-not $Uri.EndsWith("node-v22.23.2-win-x64.zip")) { throw "Unexpected download: $Uri" }\n'
                        '  Copy-Item -LiteralPath $env:TEST_ARCHIVE -Destination $OutFile\n'
                        '}\n& $env:TEST_SETUP -Server http://remote.invalid\nexit $LASTEXITCODE\n', encoding='utf-8')
                    environment = powershell_environment(case,
                        HINDSIGHTKIT_HOME=str(state), HINDSIGHTKIT_RELEASE_MANIFEST=str(release / 'release.json'),
                        TEST_ARCHIVE=str(archive), TEST_CHECKSUM=checksum, TEST_SETUP=str(script), TEST_DOWNLOADS=str(requests))
                    environment['PATH'] = str(binary) + os.pathsep + environment['PATH']
                    result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper)], env=environment,
                        capture_output=True, text=True, encoding='utf-8', timeout=30)
                    # Stop at fixture venv creation after Node selection, without installing dependencies.
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('exit 71', result.stderr)
                    self.assertNotIn('Old checkout Node', result.stderr)
                    self.assertTrue(selected_node.is_file())
                    self.assertEqual(saved_node.read_text(encoding='utf-8'), str(binary / 'node.ps1'))
                    self.assertIn('Reusing uv 0.12.15', result.stdout)
                    self.assertIn('Reusing Node.js v22.23.2' if bundled == 'matching' else 'Installed Node.js v22.23.2', result.stdout)
                    self.assertIn('Downloading Node.js 22.23.2', result.stdout) if bundled != 'matching' else self.assertNotIn('Downloading Node.js', result.stdout)
                    self.assertEqual(requests.exists(), bundled != 'matching')
                    if bundled != 'matching':
                        self.assertEqual(len(requests.read_text(encoding='utf-8-sig').splitlines()), 2)

    @unittest.skipUnless(os.name == 'nt', 'Windows release dependency installation')
    def test_release_bundle_is_required_before_any_download(self):
        shell = shutil.which('powershell.exe')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'setup.ps1'
            shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
            result = subprocess.run(offline_setup_command(shell, script, ['-ServerOnly']),
                env=powershell_environment(root, HINDSIGHTKIT_RELEASE_MANIFEST=str(root / 'release.json')),
                capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Python bundle is missing requirements-client.txt', result.stderr)
            self.assertIn('will not use PyPI', result.stderr)
            self.assertFalse((root / '.runtime').exists())
            self.assertNotIn('At line:', result.stderr)

    @unittest.skipUnless(os.name == 'nt', 'Windows release dependency installation')
    def test_release_offline_sync_roles_python_reuse_and_original_error_log(self):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        shells = list(dict.fromkeys(filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')])))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native_source = root / 'fixture.cs'
            native_source.write_text('''using System;
class Runtime { static void Main(string[] args) {
  string name = System.IO.Path.GetFileName(Environment.GetCommandLineArgs()[0]);
  if (name == "uv-error.exe") {
    Console.Error.WriteLine("error: synthetic dependency failed");
    Console.Error.WriteLine("Caused by: original TLS HandshakeFailure fixture");
    Environment.Exit(73);
  }
  Console.WriteLine(name == "node.exe" ? (args[0] == "-p" ? "x64" : "v22.23.2") : (Environment.GetEnvironmentVariable("TEST_PYTHON_VERSION") ?? "Python 3.12.11"));
} }
''', encoding='utf-8')
            native = root / 'runtime.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(native), str(native_source)],
                           check=True, capture_output=True, timeout=30)
            native_error = root / 'uv-error.exe'
            shutil.copyfile(native, native_error)
            cases = [('client', False), ('profile', False), ('runtime', True), ('server', False), ('wrong-python', True)]
            for shell in shells:
                for role, existing in cases:
                    with self.subTest(shell=Path(shell).name, role=role):
                        case = root / (Path(shell).stem + '-' + role)
                        app = case / 'app'
                        app.mkdir(parents=True)
                        shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', app / 'setup.ps1')
                        (app / 'python/wheels').mkdir(parents=True)
                        (app / 'python/wheels/fixture.whl').write_bytes(b'fixture')
                        for name in ('requirements-client.txt', 'requirements-server.txt'):
                            (app / 'python' / name).write_text('fixture==1 --hash=sha256:' + '0' * 64)
                        node = app / '.runtime/tools/node-v22.23.2-win-x64/node.exe'
                        node.parent.mkdir(parents=True)
                        shutil.copyfile(native, node)
                        npm = node.parent / 'node_modules/npm/bin/npm-cli.js'
                        npm.parent.mkdir(parents=True)
                        npm.write_text('// fixture')
                        python = app / '.venv/Scripts/python.exe'
                        if existing:
                            python.parent.mkdir(parents=True)
                            shutil.copyfile(native, python)
                        if role == 'runtime':
                            (app / '.venv/Lib/site-packages/hindsight_api').mkdir(parents=True)
                        if role == 'profile':
                            profile = case / '.hindsight/profiles/hindsightkit.env'
                            profile.parent.mkdir(parents=True)
                            profile.write_text('HINDSIGHT_API_PORT=19001')
                        binary = case / 'bin'
                        binary.mkdir()
                        trace, log = case / 'uv-calls.jsonl', case / 'install.log'
                        (binary / 'uv.ps1').write_text('''if ($args[0] -eq '--version') { Write-Output 'uv 0.12.15'; $global:LASTEXITCODE = 0; return }
ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:TEST_UV_CALLS
if ($args[0] -eq 'venv') {
    $target = Join-Path $args[1] 'Scripts/python.exe'
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $env:TEST_NATIVE -Destination $target
    $global:LASTEXITCODE = 0; return
}
& $env:TEST_UV_ERROR
$global:LASTEXITCODE = $LASTEXITCODE
''', encoding='utf-8')
                        environment = powershell_environment(case,
                            HINDSIGHTKIT_RELEASE_MANIFEST=str(app / 'release.json'), HINDSIGHTKIT_INSTALL_LOG=str(log),
                            TEST_UV_CALLS=str(trace), TEST_NATIVE=str(native), TEST_UV_ERROR=str(native_error),
                            TEST_PYTHON_VERSION='Python 3.11.8' if role == 'wrong-python' else 'Python 3.12.11')
                        environment['PATH'] = str(binary) + os.pathsep + environment['PATH']
                        arguments = [] if role == 'server' else ['-Server', 'http://remote.invalid']
                        result = subprocess.run(offline_setup_command(shell, app / 'setup.ps1', arguments),
                            env=environment, capture_output=True, text=True, encoding='utf-8', timeout=30)
                        self.assertNotEqual(result.returncode, 0)
                        calls = [json.loads(line) for line in trace.read_text(encoding='utf-8-sig').splitlines()] if trace.exists() else []
                        if role == 'wrong-python':
                            self.assertIn('requires Python 3.12', result.stderr)
                            self.assertEqual(calls, [])
                            continue
                        self.assertEqual(any(call[0] == 'venv' for call in calls), not existing)
                        sync = calls[-1]
                        self.assertEqual(sync[:2], ['pip', 'sync'])
                        self.assertEqual(sync[2], '--python')
                        self.assertTrue(Path(sync[3]).samefile(python))
                        self.assertEqual(sync[4:7], ['--offline', '--no-index', '--find-links'])
                        self.assertTrue(Path(sync[7]).samefile(app / 'python/wheels'))
                        self.assertEqual(sync[8:11], ['--require-hashes', '--only-binary', ':all:'])
                        expected = 'requirements-client.txt' if role == 'client' else 'requirements-server.txt'
                        self.assertEqual(Path(sync[11]).name, expected)
                        self.assertIn('Install bundled Python packages', result.stderr)
                        self.assertIn('exit 73', result.stderr)
                        recorded = log.read_text(encoding='utf-8')
                        self.assertIn('error: synthetic dependency failed', recorded)
                        self.assertIn('Caused by: original TLS HandshakeFailure fixture', recorded)
                        self.assertIn('Reusing Node.js v22.23.2', recorded)
                        self.assertNotIn('At line:', result.stderr)

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
