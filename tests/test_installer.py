import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from hindsightkit import cli
from hindsightkit.setup import installer
from hindsightkit.platform import runtime as runtime_env


ROOT = Path(__file__).resolve().parents[1]


class InstallerTests(unittest.TestCase):
    def test_success_commits_selected_role_after_installed_command_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / 'installation.json'
            with patch.object(runtime_env, 'home', return_value=root), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(installer, 'validate_setup_options'), patch.object(installer, 'require_client_prerequisites'), \
                 patch('hindsightkit.setup.node_bundle.release_bundle', return_value=None), \
                 patch.object(installer, 'setup_client_only'), patch.object(installer, 'setup_client'), \
                 patch.object(installer, 'setup_server', return_value={'apiUrl': 'http://localhost:9077'}), \
                 patch.object(installer, 'can_connect_local_client', return_value=True), \
                 patch('hindsightkit.setup.command.install', return_value=root / 'bin/hk.cmd') as command, \
                 patch.object(runtime_env, 'run') as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                for arguments, mode in [(['--client-only'], 'client-only'),
                                        (['--server', 'https://example.invalid'], 'client-only'),
                                        (['--server-only'], 'server-only'), ([], 'full')]:
                    with self.subTest(mode=mode, arguments=arguments):
                        record.write_text('{"schema": 1, "mode": "old"}\n')
                        original = record.read_bytes()

                        def install_command(_):
                            self.assertEqual(record.read_bytes(), original)
                            return root / 'bin/hk.cmd'

                        command.side_effect = install_command

                        def verify_command(arguments, *, capture):
                            self.assertEqual(arguments, [root / 'bin/hk.cmd', '--help'])
                            self.assertTrue(capture)
                            self.assertEqual(record.read_bytes(), original)

                        run.side_effect = verify_command
                        self.assertEqual(installer.main(arguments), 0)
                        self.assertEqual(json.loads(record.read_text()), {'schema': 1, 'mode': mode})
                        self.assertEqual(list(root.glob('.installation-*')), [])

    def test_failed_setup_preserves_the_last_successful_role(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / 'installation.json'
            original = b'{"schema": 1, "mode": "client-only"}\n'
            with patch.object(runtime_env, 'home', return_value=root), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(installer, 'validate_setup_options'), patch.object(installer, 'require_client_prerequisites'), \
                 patch('hindsightkit.setup.node_bundle.release_bundle', return_value=None), \
                 patch.object(installer, 'setup_client_only'), \
                 patch('hindsightkit.setup.command.install', side_effect=RuntimeError('fixture launcher failure')), \
                 contextlib.redirect_stderr(io.StringIO()):
                for existing in [False, True]:
                    with self.subTest(existing=existing):
                        if existing:
                            record.write_bytes(original)
                        self.assertEqual(installer.main(['--client-only']), 1)
                        self.assertEqual(record.read_bytes() if existing else record.exists(), original if existing else False)

    def test_failed_launcher_verification_preserves_the_last_successful_role(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / 'installation.json'
            original = b'{"schema": 1, "mode": "client-only"}\n'
            record.write_bytes(original)
            with patch.object(runtime_env, 'home', return_value=root), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(installer, 'setup', return_value=root / 'bin/hindsightkit.exe'), \
                 patch.object(runtime_env, 'run', side_effect=subprocess.CalledProcessError(1, 'launcher --help')), \
                 contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.main(['--server-only']), 1)
            self.assertEqual(record.read_bytes(), original)

    @unittest.skipUnless(os.name == 'nt', 'Windows installation role resolution')
    def test_source_and_published_mode_resolution_match(self):
        shells = list(dict.fromkeys(filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')])))
        with tempfile.TemporaryDirectory(prefix='installer modes ') as directory:
            root = Path(directory)
            cases = []

            def case(name, expected, *, mode=None, server=False, stamp=False, config=False,
                     default_config=False, options=None, inherited='', invalid=False):
                path = root / name
                state = path / 'state'
                state.mkdir(parents=True)
                profile = path / 'profile'
                config_path = profile / '.hindsight/coding-agent.json' if default_config else path / 'custom-config.json'
                if mode is not None or invalid:
                    (state / 'installation.json').write_text('broken json' if invalid else json.dumps({'schema': 1, 'mode': mode}))
                if stamp:
                    target = state / 'client-runtime/.installed-lock'
                    target.parent.mkdir()
                    target.write_text('verified client packages')
                if server:
                    target = profile / '.hindsight/profiles/hindsightkit.env'
                    target.parent.mkdir(parents=True)
                    target.write_text('existing local server')
                if config:
                    config_path.parent.mkdir(parents=True, exist_ok=True)
                    config_path.write_text('{}')
                cases.append({'name': name, 'expected': expected, 'state': str(state), 'profile': str(profile),
                              'config': '' if default_config else str(config_path), 'options': options or {},
                              'inherited': inherited})

            case('fresh', 'full')
            case('legacy-unconnected', 'client-only', stamp=True)
            case('legacy-connected', 'client-only', config=True)
            case('legacy-default-config', 'client-only', config=True, default_config=True)
            case('legacy-full', 'full', server=True, stamp=True, config=True)
            case('saved-client-with-server', 'client-only', mode='client-only', server=True)
            case('saved-server', 'server-only', mode='server-only')
            case('saved-full', 'full', mode='full', stamp=True)
            case('explicit-full', 'full', mode='client-only', options={'ClientOnly': False})
            case('explicit-server', 'server-only', mode='client-only', options={'ServerOnly': True})
            case('explicit-client', 'client-only', mode='full', options={'ClientOnly': True})
            case('explicit-connection', 'client-only', mode='full', options={'Server': 'https://example.invalid'})
            case('bootstrap-full', 'full', mode='client-only', inherited='full')
            case('invalid-record', 'error', invalid=True)
            case('repair-role', 'client-only', invalid=True, options={'ClientOnly': True})
            case('conflicting-roles', 'error', options={'ClientOnly': True, 'ServerOnly': True})
            case('conflicting-server', 'error', options={'Server': 'https://example.invalid', 'ServerOnly': True})
            case('client-port', 'error', mode='client-only', options={'Port': 9077})
            case('client-model', 'error', mode='client-only', options={'Model': 'model'})
            case('unconnected-key', 'error', mode='client-only', options={'ApiKeyEnv': 'TEST_KEY'})
            case('invalid-effort', 'error', options={'ReasoningEffort': 'invalid'})
            for port in (0, 1024, 55534):
                case(f'valid-port-{port}', 'full', options={'Port': port})
            for port in (-1, 1, 1023, 55535, 65535):
                case(f'invalid-port-{port}', 'error', options={'Port': port})
            for server in ('ftp://example.invalid', 'https://example.invalid/path',
                           'https://user@example.invalid', 'https://example.invalid?key=secret'):
                case(f'invalid-server-{len(cases)}', 'error', options={'Server': server})
            case_file = root / 'cases.json'
            case_file.write_text(json.dumps(cases))
            published = root / 'install.ps1'
            shared_options = ROOT / 'src/hindsightkit/scripts/install_options.ps1'
            published.write_text((ROOT / 'distribution/install.ps1').read_text(encoding='utf-8')
                .replace('@@INSTALL_OPTIONS@@', shared_options.read_text(encoding='utf-8'))
                .replace('@@REQUIRES_AUTH@@', '$false'), encoding='utf-8')
            harness = root / 'resolve.ps1'
            harness.write_text('''$ErrorActionPreference = 'Stop'
$cases = Get-Content -LiteralPath $env:TEST_CASES -Raw | ConvertFrom-Json
$results = @()
foreach ($source in @($env:TEST_SOURCE_OPTIONS, $env:TEST_PUBLISHED_SETUP)) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
    if ($errors) { throw $errors[0] }
    $functions = $ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -in @('Resolve-InstallMode', 'Assert-InstallOptions')
    }, $true)
    foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
    foreach ($case in $cases) {
        $env:HINDSIGHTKIT_HOME = $case.state
        $env:USERPROFILE = $case.profile
        $env:HINDSIGHT_CONFIG = $case.config
        $env:HINDSIGHTKIT_INSTALL_MODE = $case.inherited
        $options = @{}
        foreach ($property in $case.options.PSObject.Properties) { $options[$property.Name] = $property.Value }
        try {
            $mode = Resolve-InstallMode $options
            Assert-InstallOptions $options $mode
        } catch { $mode = 'error' }
        $results += @{source=$source; name=$case.name; mode=$mode; expected=$case.expected}
    }
}
ConvertTo-Json -InputObject $results -Compress
''', encoding='utf-8')
            for shell in shells:
                with self.subTest(shell=shell):
                    environment = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
                    environment.update(TEST_CASES=str(case_file), TEST_SOURCE_OPTIONS=str(shared_options),
                                       TEST_PUBLISHED_SETUP=str(published))
                    result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(harness)],
                                            env=environment, text=True, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    rows = json.loads(result.stdout)
                    self.assertEqual(len(rows), len(cases) * 2)
                    for row in rows:
                        self.assertEqual(row['mode'], row['expected'], row)

    @unittest.skipUnless(os.name == 'nt', 'Windows setup dependency selection')
    def test_setup_applies_saved_role_to_source_and_release_dependencies(self):
        shell = shutil.which('powershell.exe')
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        with tempfile.TemporaryDirectory(prefix='setup roles ') as directory:
            root = Path(directory)
            source = root / 'fixture.cs'
            source.write_text('''using System;
using System.IO;
class Fixture { static void Main(string[] args) {
  string name = Path.GetFileName(Environment.GetCommandLineArgs()[0]);
  if (name == "node.exe") { Console.WriteLine(args[0] == "-p" ? "x64" : "v22.23.2"); }
  else if (args[0] == "--version") { Console.WriteLine("Python 3.12.11"); }
  else { File.WriteAllLines(Environment.GetEnvironmentVariable("TEST_PYTHON_ARGS"), args); }
} }
''', encoding='utf-8')
            native = root / 'fixture.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(native), str(source)],
                           check=True, capture_output=True, timeout=30)
            for release in [False, True]:
                for name, arguments, server, role in [
                        ('legacy-client', '', False, 'client-only'),
                        ('saved-client-with-server', '', True, 'client-only'),
                        ('explicit-full', '-ClientOnly:$false', False, 'full'),
                        ('explicit-server', '-ServerOnly', False, 'server-only')]:
                    with self.subTest(release=release, case=name):
                        case = root / (('release-' if release else 'source-') + name)
                        app, state, binary = case / 'app', case / 'state', case / 'bin'
                        for path in [app, state, binary]:
                            path.mkdir(parents=True)
                        shutil.copyfile(ROOT / 'setup.ps1', app / 'setup.ps1')
                        (app / 'src/hindsightkit/scripts').mkdir(parents=True)
                        shutil.copyfile(ROOT / 'src/hindsightkit/scripts/install_options.ps1',
                                        app / 'src/hindsightkit/scripts/install_options.ps1')
                        if name == 'legacy-client':
                            stamp = state / 'client-runtime/.installed-lock'
                            stamp.parent.mkdir()
                            stamp.write_text('verified client packages')
                        else:
                            (state / 'installation.json').write_text(json.dumps({'schema': 1, 'mode': 'client-only'}))
                        if server:
                            profile = case / '.hindsight/profiles/hindsightkit.env'
                            profile.parent.mkdir(parents=True)
                            profile.write_text('existing server')
                        python = app / '.venv/Scripts/python.exe'
                        python.parent.mkdir(parents=True)
                        shutil.copyfile(native, python)
                        shutil.copyfile(native, binary / 'node.exe')
                        npm = binary / 'node_modules/npm/bin/npm-cli.js'
                        npm.parent.mkdir(parents=True)
                        npm.write_text('// fixture')
                        if release:
                            (app / 'python/wheels').mkdir(parents=True)
                            (app / 'python/wheels/fixture.whl').write_bytes(b'fixture')
                            for filename in ['requirements-client.txt', 'requirements-server.txt']:
                                (app / 'python' / filename).write_text('fixture')
                        (binary / 'uv.ps1').write_text('''if ($args[0] -eq '--version') {
    Write-Output 'uv 0.12.15'
} else { ConvertTo-Json -InputObject @($args) | Set-Content -LiteralPath $env:TEST_UV_ARGS }
$global:LASTEXITCODE = 0
''', encoding='utf-8')
                        (binary / 'hindsightkit.ps1').write_text('$global:LASTEXITCODE = 0\n')
                        wrapper = case / 'invoke.ps1'
                        wrapper.write_text('function Invoke-WebRequest { throw "Unexpected installation download" }\n'
                                           '& $env:TEST_SETUP ' + arguments + '\nexit $LASTEXITCODE\n')
                        environment = {key: value for key, value in os.environ.items()
                                       if key.lower() != 'psmodulepath' and not key.upper().startswith('HINDSIGHTKIT_')}
                        environment.update(USERPROFILE=str(case), HINDSIGHTKIT_HOME=str(state), COPILOT_HOME='',
                            HINDSIGHT_CONFIG=str(case / 'coding-agent.json'),
                            HINDSIGHTKIT_RELEASE_MANIFEST=str(app / 'release.json') if release else '',
                            TEST_SETUP=str(app / 'setup.ps1'), TEST_PYTHON_ARGS=str(case / 'python-args.txt'),
                            TEST_UV_ARGS=str(case / 'uv-args.json'), PATH=str(binary) + os.pathsep + os.environ['PATH'])
                        result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper)],
                                                env=environment, capture_output=True, text=True, timeout=30)
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        python_args = (case / 'python-args.txt').read_text().splitlines()
                        self.assertEqual(python_args[:2], ['-m', 'hindsightkit.setup.installer'])
                        self.assertEqual('--client-only' in python_args, role == 'client-only')
                        self.assertEqual('--server-only' in python_args, role == 'server-only')
                        uv_args = json.loads((case / 'uv-args.json').read_text(encoding='utf-8-sig'))
                        needs_server = role != 'client-only' or server
                        if release:
                            self.assertEqual(Path(uv_args[-1]).name,
                                'requirements-server.txt' if needs_server else 'requirements-client.txt')
                        else:
                            self.assertEqual('--extra' in uv_args, needs_server)


if __name__ == '__main__':
    unittest.main()
