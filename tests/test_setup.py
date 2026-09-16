import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from provenloop import cli
from provenloop.command import prepend_path
from provenloop.memory import scope_for, SHARED_BANK


class SetupTests(unittest.TestCase):
    def test_command_path_registration_is_idempotent_and_preserves_others(self):
        directory = Path(tempfile.gettempdir()) / 'ProvenLoop command'
        original = os.pathsep.join(['first', str(directory), 'last'])
        updated = prepend_path(original, directory)
        self.assertEqual(updated, os.pathsep.join([str(directory), 'first', 'last']))
        self.assertEqual(updated, prepend_path(updated, directory))

    def test_new_profile_uses_requested_reasoning_defaults(self):
        from hindsight_embed.profile_manager import ProfileManager
        args = argparse.Namespace(port=0, model=None, model_dir=None, reasoning_effort=None)
        with patch.object(ProfileManager, 'load_profile_config', return_value={}), \
             patch.object(ProfileManager, 'create_profile') as create, \
             patch('provenloop.cli.socket.socket'):
            cli.configure_profile(args)
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
            cli.run(['git', 'init', main], capture=True)
            cli.run(['git', '-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], capture=True)
            cli.run(['git', '-C', main, 'worktree', 'add', '-b', 'fixture', worktree], capture=True)
            self.assertEqual(scope_for(main), scope_for(worktree))
            self.assertEqual(scope_for(sibling).bank, SHARED_BANK)

    def test_existing_port_is_idempotent(self):
        from hindsight_embed.profile_manager import ProfileManager
        args = argparse.Namespace(port=9077, model=None)
        with patch.object(ProfileManager, 'load_profile_config', return_value={'HINDSIGHT_API_PORT': '9077'}), \
             patch.object(ProfileManager, 'resolve_profile_paths', return_value=argparse.Namespace(port=9077)), \
             patch.object(ProfileManager, 'create_profile') as create:
            cli.configure_profile(args)
            create.assert_not_called()

    def test_jsonc_preserves_other_servers_and_comments(self):
        runtime = cli.runtime()
        if not (runtime / 'node_modules/jsonc-parser').is_dir():
            self.skipTest('Install runtime dependencies before integration tests.')
        with tempfile.TemporaryDirectory() as temp:
            mcp = Path(temp) / 'mcp.json'
            original = '{\n  // user comment\n  "servers": {"other": {"command": "other"},},\n}\n'
            mcp.write_text(original)
            cli.integrate('vscode', mcp, 'python.exe')
            self.assertIn('// user comment', mcp.read_text())
            self.assertIn('"other"', mcp.read_text())
            first = mcp.read_bytes()
            cli.integrate('vscode', mcp, 'python.exe')
            self.assertEqual(first, mcp.read_bytes())
            self.assertEqual(original, Path(str(mcp) + '.provenloop-backup').read_text())

    def test_conflicting_endpoint_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            mcp = base / 'mcp.json'
            mcp.write_text(json.dumps({'servers': {'hindsight': {'type': 'http', 'url': 'https://example.invalid/mcp/old/'}}}))
            original = mcp.read_bytes()
            with self.assertRaises(subprocess.CalledProcessError):
                cli.integrate('preflight', mcp, base / 'cli.json', base / 'config.json', 'http://127.0.0.1:9077')
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
                    cli.integrate('preflight', base / 'vs.json', base / 'cli.json', config, 'http://127.0.0.1:9077')
                self.assertEqual(content, config.read_text())

    def test_official_installer_merges_and_uses_stable_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            mcp = base / '.copilot/mcp-config.json'
            mcp.parent.mkdir()
            mcp.write_text('{ // keep\n "mcpServers": {"other": {"command": "other"},},\n}\n')
            config = base / '.hindsight/coding-agent.json'
            cli.integrate('config', config, 'http://127.0.0.1:9077')
            hook_path = base / '.copilot/hooks/hindsight-coding-agents.json'
            hook_path.parent.mkdir()
            hook_path.write_text(json.dumps({'version': 1, 'hooks': {'sessionStart': [{'command': 'echo user-hook', 'timeout': 1}]}}))
            for _ in range(2):
                cli.integrate('install-cli', base, config, 'http://127.0.0.1:9077', cli.node(), __import__('sys').executable)
            self.assertIn('// keep', mcp.read_text())
            self.assertIn('"other"', mcp.read_text())
            hooks = json.loads((base / '.copilot/hooks/hindsight-coding-agents.json').read_text())
            self.assertEqual(hooks['hooks']['sessionStart'][0]['command'], 'echo user-hook')
            for entries in hooks['hooks'].values():
                for hook in entries:
                    if hook.get('command') == 'echo user-hook':
                        continue
                    self.assertTrue(Path(hook['exec']).is_absolute())
                    self.assertEqual(hook['args'][:3], ['-m', 'provenloop.cli', 'hook'])
            self.assertEqual(json.loads(config.read_text())['optInOnly'], False)


if __name__ == '__main__':
    unittest.main()
