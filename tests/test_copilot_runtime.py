import asyncio
import contextlib
import io
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit.platform import copilot, runtime
from hindsightkit.setup import installer


class CopilotRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='hk-copilot-')))
        self.stack.enter_context(patch.object(runtime, 'home', return_value=self.root))
        self.stack.enter_context(patch.dict(os.environ, {
            'COPILOT_CLI_PATH': '', 'COPILOT_SDK_DEFAULT_CONNECTION': 'stdio',
            'HINDSIGHTKIT_INSTALL_LOG': '',
        }))
        os.environ.pop('HINDSIGHT_API_LLM_PROVIDER', None)
        os.environ.pop('HINDSIGHT_API_LLM_BASE_URL', None)
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.config = {'HINDSIGHT_API_LLM_PROVIDER': 'github-copilot'}

    def entry(self, name='copilot.exe'):
        binary = self.root / name
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_bytes(b'fixture')
        return binary

    def test_selected_installed_cli_bypasses_sdk_cache_resolution(self):
        from copilot import CopilotClient
        binary = self.entry()
        with patch.object(installer, 'find_copilot', return_value=([str(binary)], 'GitHub Copilot CLI 1.0.85')), \
             patch('copilot._cli_download.ensure_runtime_wrapper', side_effect=AssertionError('cache must not be used')) as download:
            self.assertEqual(copilot.prepare(self.config), str(binary))
            client = CopilotClient(mode='copilot-cli')
            self.assertEqual(client._connection.path, str(binary))
            self.assertEqual(client._cli_path_source, 'environment')
        download.assert_not_called()
        self.assertEqual((self.root / 'copilot-path.txt').read_text().strip(), str(binary))
        self.assertIn('Copilot SDK: using', self.output.getvalue())

    def test_official_javascript_entrypoint_is_saved_without_node_arguments(self):
        loader = self.entry('npm/node_modules/@github/copilot/npm-loader.js')
        self.assertEqual(copilot.select(['node', str(loader)]), str(loader))
        self.assertEqual(os.environ['COPILOT_CLI_PATH'], str(loader))

    def test_saved_cli_is_restored_silently_without_discovery(self):
        binary = self.entry('saved/copilot.exe')
        (self.root / 'copilot-path.txt').write_text(str(binary) + '\n', encoding='utf-8')
        with patch.object(installer, 'find_copilot') as find:
            self.assertEqual(copilot.restore(), str(binary))
            self.assertEqual(self.output.getvalue(), '')
            self.assertEqual(copilot.prepare(self.config), str(binary))
        find.assert_not_called()

    def test_missing_saved_cli_is_rediscovered(self):
        (self.root / 'copilot-path.txt').write_text(str(self.root / 'removed.exe'), encoding='utf-8')
        binary = self.entry('replacement.exe')
        with patch.object(installer, 'find_copilot', return_value=([str(binary)], 'GitHub Copilot CLI 1.0.85')) as find:
            self.assertEqual(copilot.restore(), None)
            self.assertEqual(copilot.prepare(self.config), str(binary))
        find.assert_called_once_with()
        self.assertEqual((self.root / 'copilot-path.txt').read_text().strip(), str(binary))

    def test_explicit_override_is_preserved_even_when_missing(self):
        explicit = str(self.root / 'user-selected.exe')
        os.environ['COPILOT_CLI_PATH'] = explicit
        with patch.object(installer, 'find_copilot') as find:
            self.assertEqual(copilot.prepare(self.config), explicit)
            self.assertEqual(copilot.select([str(self.entry())]), explicit)
        find.assert_not_called()
        self.assertFalse((self.root / 'copilot-path.txt').exists())

    def test_external_runtime_and_other_provider_skip_local_cli(self):
        for config in ({'HINDSIGHT_API_LLM_PROVIDER': 'openai'},
                       dict(self.config, HINDSIGHT_API_LLM_BASE_URL='http://127.0.0.1:1234')):
            with self.subTest(config=config), patch.object(installer, 'find_copilot') as find:
                self.assertIsNone(copilot.prepare(config))
                find.assert_not_called()
        self.assertEqual(self.output.getvalue(), '')
        self.assertEqual(os.environ['COPILOT_CLI_PATH'], '')

    def test_inherited_provider_and_empty_runtime_override_profile(self):
        binary = self.entry()
        with patch.dict(os.environ, {'HINDSIGHT_API_LLM_PROVIDER': 'github-copilot',
                                     'HINDSIGHT_API_LLM_BASE_URL': ''}), \
             patch.object(installer, 'find_copilot', return_value=([str(binary)], 'GitHub Copilot CLI 1.0.85')):
            self.assertEqual(copilot.prepare({'HINDSIGHT_API_LLM_PROVIDER': 'openai',
                'HINDSIGHT_API_LLM_BASE_URL': 'http://127.0.0.1:1234'}), str(binary))

    def test_inherited_provider_or_external_runtime_can_disable_local_selection(self):
        for environment in ({'HINDSIGHT_API_LLM_PROVIDER': 'openai'},
                            {'HINDSIGHT_API_LLM_BASE_URL': 'http://127.0.0.1:1234'},
                            {'HINDSIGHT_API_LLM_PROVIDER': ''}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment), \
                 patch.object(installer, 'find_copilot') as find:
                self.assertIsNone(copilot.prepare(self.config))
                find.assert_not_called()

    def test_missing_installation_does_not_fall_back_to_sdk_download(self):
        with patch.object(installer, 'find_copilot', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Rerun the release installer'):
                copilot.prepare(self.config)
        self.assertEqual(os.environ['COPILOT_CLI_PATH'], '')

    def test_invalid_saved_path_is_ignored(self):
        for saved in ('relative/copilot.exe', str(self.root / 'broken\npath.exe'),
                      str(self.entry('copilot.cmd'))):
            with self.subTest(saved=saved):
                (self.root / 'copilot-path.txt').write_text(saved, encoding='utf-8')
                self.assertIsNone(copilot.restore())
                self.assertEqual(os.environ['COPILOT_CLI_PATH'], '')

    def test_old_openai_template_url_still_selects_local_copilot(self):
        binary = self.entry()
        with patch.object(installer, 'find_copilot', return_value=([str(binary)], 'GitHub Copilot CLI 1.0.85')):
            self.assertEqual(copilot.prepare(dict(self.config,
                HINDSIGHT_API_LLM_BASE_URL='https://api.openai.com/v1/')), str(binary))

    def test_failed_atomic_replace_preserves_previous_selection(self):
        saved = self.root / 'copilot-path.txt'
        saved.write_text('previous', encoding='utf-8')
        with patch.object(os, 'replace', side_effect=PermissionError('fixture')):
            with self.assertRaises(PermissionError):
                copilot.select([str(self.entry())])
        self.assertEqual(saved.read_text(), 'previous')
        self.assertEqual(os.environ['COPILOT_CLI_PATH'], '')
        self.assertEqual(list(self.root.glob('copilot-path-*.tmp')), [])

    def test_shell_launcher_cannot_be_saved_as_sdk_executable(self):
        with self.assertRaisesRegex(RuntimeError, 'native executable'):
            copilot.select([str(self.entry('copilot.cmd'))])
        self.assertFalse((self.root / 'copilot-path.txt').exists())

    def test_installer_selects_cli_before_checking_sdk_authentication(self):
        binary = self.entry()
        async def authenticated():
            self.assertEqual(os.environ['COPILOT_CLI_PATH'], str(binary))
            return True
        with patch.object(installer, 'find_copilot', return_value=([str(binary)], 'GitHub Copilot CLI 1.0.85')), \
             patch.object(installer, 'copilot_authenticated', side_effect=authenticated), \
             patch('hindsightkit.setup.progress.run_install') as install:
            installer.ensure_copilot()
        install.assert_not_called()

    def test_installer_auth_uses_same_mode_as_hindsight(self):
        with patch('copilot.CopilotClient') as create, patch.object(Path, 'home', return_value=self.root):
            client = create.return_value
            client.start = AsyncMock()
            client.stop = AsyncMock()
            client.get_auth_status = AsyncMock()
            client.get_auth_status.return_value.isAuthenticated = True
            self.assertTrue(asyncio.run(installer.copilot_authenticated()))
            self.assertEqual(create.call_args.kwargs['mode'], 'copilot-cli')
            client.stop.assert_awaited_once()

    def test_installer_uses_explicit_cli_for_validation_and_login(self):
        binary = self.entry('user/copilot.exe')
        os.environ['COPILOT_CLI_PATH'] = str(binary)
        with patch.object(installer, 'copilot_candidates') as candidates, \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess(
                 [], 0, 'GitHub Copilot CLI 1.0.85\n', '')) as version, \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock, side_effect=[False, True]), \
             patch.object(runtime, 'run') as login:
            installer.ensure_copilot()
        candidates.assert_not_called()
        self.assertEqual(version.call_args.args[0], [str(binary), '--version'])
        login.assert_called_once_with([str(binary), 'login'])
        self.assertEqual(os.environ['COPILOT_CLI_PATH'], str(binary))
        self.assertFalse((self.root / 'copilot-path.txt').exists())

    def test_unusable_explicit_cli_does_not_install_or_select_another(self):
        os.environ['COPILOT_CLI_PATH'] = str(self.root / 'absent.exe')
        with patch.object(installer, 'copilot_candidates') as candidates, \
             patch.object(subprocess, 'run', side_effect=FileNotFoundError('fixture')), \
             patch('hindsightkit.setup.progress.run_install') as install, \
             patch.object(installer, 'copilot_authenticated') as authenticate:
            with self.assertRaisesRegex(RuntimeError, 'No usable GitHub Copilot CLI'):
                installer.ensure_copilot()
        candidates.assert_not_called()
        install.assert_not_called()
        authenticate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
