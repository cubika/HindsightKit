import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from hindsightkit import connection
from hindsightkit.setup import installer
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env
from hindsightkit.setup.command import prepend_path
from hindsightkit.memory.api import scope_for, SHARED_BANK


class SetupTests(unittest.TestCase):
    def setUp(self):
        if self._testMethodName not in {
            'test_jsonc_preserves_other_servers_and_comments',
            'test_conflicting_endpoint_is_not_overwritten',
            'test_disabled_learning_and_jsonc_runtime_config_are_rejected',
            'test_official_installer_merges_and_uses_stable_absolute_paths',
        }:
            return
        source = runtime_env.home() / 'client-runtime'
        if not (source / 'node_modules/jsonc-parser').is_dir():
            self.skipTest('Install client runtime dependencies before integration tests.')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        runtime = Path(temporary.name) / 'runtime'
        shutil.copytree(source, runtime)
        for fixture in (patch.object(runtime_env, 'runtime', return_value=runtime),
                        patch.object(runtime_env, 'node', return_value=shutil.which('node'))):
            fixture.start()
            self.addCleanup(fixture.stop)

    @unittest.skipUnless(os.name == 'nt', 'Windows setup output handling')
    def test_setup_private_native_output_is_displayed_but_not_logged(self):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'output.cs'
            source.write_text('''class Output { static void Main() {
System.Console.WriteLine("DEVICE-CODE-FIXTURE");
System.Console.Error.WriteLine("error: private login detail");
System.Environment.Exit(19);
} }
''', encoding='utf-8')
            executable = root / 'output.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(executable), str(source)],
                           check=True, capture_output=True, timeout=30)
            harness = root / 'invoke.ps1'
            harness.write_text('''param([string]$Setup, [string]$Native)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Setup, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Setup syntax error' }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
Write-InstallStatus 'Starting: private setup'
try { Invoke-Checked $Native @() -PrivateOutput }
catch { Write-InstallStatus $_.Exception.Message; exit 19 }
''', encoding='utf-8')
            for shell in filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')]):
                with self.subTest(shell=Path(shell).name):
                    log = root / (Path(shell).stem + '.log')
                    result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(harness),
                        '-Setup', str(Path(__file__).resolve().parents[1] / 'setup.ps1'), '-Native', str(executable)],
                        env={**os.environ, 'HINDSIGHTKIT_INSTALL_LOG': str(log)}, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 19, result.stdout + result.stderr)
                    self.assertIn('DEVICE-CODE-FIXTURE', result.stdout)
                    self.assertIn('private login detail', result.stdout + result.stderr)
                    recorded = log.read_text(encoding='utf-8')
                    self.assertIn('Starting: private setup', recorded)
                    self.assertIn('exit 19', recorded)
                    self.assertNotIn('DEVICE-CODE-FIXTURE', recorded)
                    self.assertNotIn('private login detail', recorded)

    def test_release_upgrade_stops_hindsightkit_api_without_using_its_health_gate(self):
        with patch('hindsight_embed.daemon_embed_manager.DaemonEmbedManager') as manager, \
             patch('hindsightkit.sharing.remote.stop'), \
             patch('hindsightkit.connectors.host.stop') as stop_connectors, \
             patch.object(runtime_env, 'run') as run, patch.object(runtime_env, 'executable', return_value='new-release/hindsight-embed'):
            manager.return_value.is_ui_running.return_value = True
            manager.return_value.is_running.side_effect = AssertionError('Stopping must not depend on API health')
            services.stop_profile_services()
            self.assertEqual([call.args[0] for call in run.call_args_list], [
                ['new-release/hindsight-embed', '--profile', 'hindsightkit', 'ui', 'stop'],
            ])
            manager.return_value.is_ui_running.assert_called_once_with('hindsightkit')
            manager.return_value.stop.assert_called_once_with('hindsightkit')
            stop_connectors.assert_called_once_with(runtime_env.home() / 'connectors')
            manager.return_value.is_ui_running.return_value = False
            run.reset_mock()
            services.stop_profile_services()
            run.assert_not_called()
            self.assertEqual(manager.return_value.stop.call_count, 2)
            manager.return_value.is_running.assert_not_called()

    def test_command_path_registration_is_idempotent_and_preserves_others(self):
        directory = Path(tempfile.gettempdir()) / 'HindsightKit command'
        original = os.pathsep.join(['first', str(directory), 'last'])
        updated = prepend_path(original, directory)
        self.assertEqual(updated, os.pathsep.join([str(directory), 'first', 'last']))
        self.assertEqual(updated, prepend_path(updated, directory))

    def test_new_profile_uses_requested_reasoning_defaults(self):
        from hindsight_embed.profile_manager import ProfileManager
        args = argparse.Namespace(port=0, model=None, model_dir=None, reasoning_effort=None)
        with patch.object(ProfileManager, 'load_profile_config', return_value={}), \
             patch.object(ProfileManager, 'create_profile') as create, \
             patch('hindsightkit.setup.installer.socket.socket'):
            installer.configure_profile(args)
            config = create.call_args.args[2]
            self.assertEqual(config['HINDSIGHT_API_LLM_MODEL'], 'gpt-6-astra')
            self.assertEqual(config['HINDSIGHT_API_LLM_REASONING_EFFORT'], 'xhigh')

    def test_worktree_and_main_share_bank_but_siblings_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            main = base / 'project with spaces'
            worktree = base / 'worktree'
            sibling = base / 'sibling'
            main.mkdir()
            sibling.mkdir()
            runtime_env.run(['git', 'init', main], capture=True)
            runtime_env.run(['git', '-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], capture=True)
            runtime_env.run(['git', '-C', main, 'worktree', 'add', '-b', 'fixture', worktree], capture=True)
            self.assertEqual(scope_for(main), scope_for(worktree))
            self.assertEqual(scope_for(sibling).bank, SHARED_BANK)

    def test_existing_port_is_idempotent(self):
        from hindsight_embed.profile_manager import ProfileManager
        args = argparse.Namespace(port=9077, model=None)
        with patch.object(ProfileManager, 'load_profile_config', return_value={'HINDSIGHT_API_PORT': '9077'}), \
             patch.object(ProfileManager, 'resolve_profile_paths', return_value=argparse.Namespace(port=9077)), \
             patch.object(ProfileManager, 'create_profile') as create:
            installer.configure_profile(args)
            create.assert_not_called()

    def test_jsonc_preserves_other_servers_and_comments(self):
        runtime = runtime_env.runtime()
        if not (runtime / 'node_modules/jsonc-parser').is_dir():
            self.skipTest('Install runtime dependencies before integration tests.')
        with tempfile.TemporaryDirectory() as temp:
            mcp = Path(temp) / 'mcp.json'
            original = '{\n  // user comment\n  "servers": {"other": {"command": "other"},},\n}\n'
            mcp.write_text(original)
            installer.integrate('vscode', mcp, 'python.exe')
            self.assertIn('// user comment', mcp.read_text())
            self.assertIn('"other"', mcp.read_text())
            first = mcp.read_bytes()
            installer.integrate('vscode', mcp, 'python.exe')
            self.assertEqual(first, mcp.read_bytes())
            self.assertEqual(original, Path(str(mcp) + '.hindsightkit-backup').read_text())

    def test_conflicting_endpoint_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            mcp = base / 'mcp.json'
            mcp.write_text(json.dumps({'servers': {'hindsight': {'type': 'http', 'url': 'https://example.invalid/mcp/old/'}}}))
            original = mcp.read_bytes()
            with self.assertRaises(subprocess.CalledProcessError):
                installer.integrate('preflight', mcp, base / 'cli.json', base / 'config.json', 'http://127.0.0.1:9077')
            self.assertEqual(original, mcp.read_bytes())

    def test_disabled_learning_and_jsonc_runtime_config_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = base / 'config.json'
            for content in [
                '{"disabled": true}',
                '{/* comment */ "apiUrl":"http://127.0.0.1:9077"}',
                '{"harnesses":{"copilot-cli":{"mapPathToBank":{"other":"another-bank"}}}}',
                '{"harnesses":{"copilot-cli":{"banks":{"bank":{"disabled":true}}}}}',
            ]:
                config.write_text(content)
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.integrate('preflight', base / 'vs.json', base / 'cli.json', config, 'http://127.0.0.1:9077')
                self.assertEqual(content, config.read_text())

    def test_official_installer_merges_and_uses_stable_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            mcp = base / '.copilot/mcp-config.json'
            mcp.parent.mkdir()
            mcp.write_text('{ // keep\n "mcpServers": {"other": {"command": "other"},},\n}\n')
            config = base / '.hindsight/coding-agent.json'
            installer.integrate('config', config, 'http://127.0.0.1:9077')
            hook_path = base / '.copilot/hooks/hindsight-coding-agents.json'
            hook_path.parent.mkdir()
            hook_path.write_text(json.dumps({'version': 1, 'hooks': {'sessionStart': [{'command': 'echo user-hook', 'timeout': 1}]}}))
            for _ in range(2):
                installer.integrate('install-cli', base, config, 'http://127.0.0.1:9077', runtime_env.node(), sys.executable)
            self.assertIn('// keep', mcp.read_text())
            self.assertIn('"other"', mcp.read_text())
            hooks = json.loads((base / '.copilot/hooks/hindsight-coding-agents.json').read_text())
            self.assertEqual(hooks['hooks']['sessionStart'][0]['command'], 'echo user-hook')
            for entries in hooks['hooks'].values():
                for hook in entries:
                    if hook.get('command') == 'echo user-hook':
                        continue
                    self.assertTrue(Path(hook['exec']).is_absolute())
                    self.assertEqual(hook['args'][:3], ['-m', 'hindsightkit.cli', 'hook'])
            self.assertEqual(json.loads(config.read_text())['optInOnly'], False)

    def test_client_upgrade_rewrites_real_editor_and_hook_paths_without_connection_changes(self):
        runtime = runtime_env.home() / 'client-runtime'
        if not (runtime / 'node_modules/@vectorize-io/hindsight-coding-agents/dist/installer.js').is_file():
            self.skipTest('Install client runtime dependencies before integration tests.')
        actual_integrate = installer.integrate
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            isolated_runtime = base / 'kit/client-runtime'
            shutil.copytree(runtime, isolated_runtime)
            config = base / '.hindsight/coding-agent.json'
            config.parent.mkdir()
            candidate = {'apiUrl': 'http://127.0.0.1:41234', 'apiToken': 'saved-test-key',
                'serverMode': 'self-hosted', 'optInOnly': False,
                'hindsightkit': {'mode': 'client', 'activity': True, 'deviceId': 'saved-test-device',
                    'transport': {'mode': 'connect', 'tunnel_id': 'test-private-relay',
                                  'local_port': 41234, 'remote_port': 9077}}}
            config.write_text(json.dumps(candidate, indent=4) + '\n', encoding='utf-8')
            original = config.read_bytes()
            old_python = str(base / 'old-release/python.exe')
            mcp = base / '.copilot/mcp-config.json'
            mcp.parent.mkdir()
            mcp.write_text(json.dumps({'mcpServers': {
                'hindsight': {'command': old_python, 'args': ['-m', 'hindsightkit.cli', 'mcp', '--context', 'cli']},
                'other': {'command': 'preserved-command'}}}))
            editor = base / 'Code/mcp.json'
            editor.parent.mkdir()
            editor.write_text(json.dumps({'servers': {
                'hindsight': {'command': old_python, 'args': ['-m', 'hindsightkit.cli', 'mcp', '--context', 'vscode']},
                'other': {'command': 'preserved-command'}}}))
            hook_path = base / '.copilot/hooks/hindsight-coding-agents.json'
            hook_path.parent.mkdir()
            hook_path.write_text(json.dumps({'version': 1, 'hooks': {'sessionStart': [
                {'type': 'command', 'exec': old_python, 'args': ['-m', 'hindsightkit.cli', 'hook', 'sessionStart']},
                {'command': 'echo retained-user-hook', 'timeout': 1}]}}))

            def integration(action, *args, **options):
                options['runtime_path'] = isolated_runtime
                return actual_integrate(action, *args, **options)

            with patch.object(Path, 'home', return_value=base), \
                 patch.object(runtime_env, 'home', return_value=base / 'kit'), \
                 patch.object(connection, 'config_path', return_value=config), \
                 patch.object(installer, 'vscode_user_directories', return_value=[editor.parent]), \
                 patch.object(installer, 'integrate', side_effect=integration), \
                 patch.object(connection, 'request', side_effect=AssertionError('No network during upgrade')), \
                 patch.object(connection, 'register', side_effect=AssertionError('No registration during upgrade')), \
                 patch.object(installer, 'ensure_copilot', side_effect=AssertionError('No login during upgrade')):
                for _ in range(2):
                    installer.install_client_integrations(candidate, candidate, write_config=False)
            self.assertEqual(config.read_bytes(), original)
            cli_config = json.loads(mcp.read_text())['mcpServers']
            vs_config = json.loads(editor.read_text())['servers']
            self.assertEqual(cli_config['hindsight']['command'], sys.executable)
            self.assertEqual(vs_config['hindsight']['command'], sys.executable)
            self.assertEqual(cli_config['other']['command'], 'preserved-command')
            self.assertEqual(vs_config['other']['command'], 'preserved-command')
            hooks = json.loads(hook_path.read_text())['hooks']
            self.assertEqual(hooks['sessionStart'][0]['command'], 'echo retained-user-hook')
            for entries in hooks.values():
                for hook in entries:
                    if hook.get('command') == 'echo retained-user-hook':
                        continue
                    self.assertEqual(hook['exec'], sys.executable)
                    self.assertEqual(hook['env']['HINDSIGHT_CONFIG'], str(config))


if __name__ == '__main__':
    unittest.main()
