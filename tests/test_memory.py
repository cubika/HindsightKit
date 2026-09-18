import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from hindsightkit import runtime as runtime_env
from hindsightkit.hooks import session_config
from hindsightkit.memory import Memory, Scope, SHARED_BANK, scope_for
from hindsightkit.mcp import scope_from_roots


class Result:
    def __init__(self, text): self.text = text
    def model_dump(self, **kwargs): return {'results': [{'text': self.text}]}


class FakeClient:
    def __init__(self): self.calls = []
    async def aretain(self, **kwargs):
        self.calls.append(('retain', kwargs))
        return Result('saved')
    async def arecall(self, **kwargs):
        self.calls.append(('recall', kwargs))
        await asyncio.sleep(0)
        return Result(kwargs['bank_id'])
    areflect = arecall


class MemoryTests(unittest.TestCase):
    def test_repo_reads_own_and_shared_but_only_writes_own(self):
        async def check():
            client = FakeClient()
            memory = Memory(client, Scope('repo-a', '/a'))
            await memory.retain('A fact')
            result = await memory.read('recall', 'question', 1024)
            self.assertEqual(client.calls[0][1]['bank_id'], 'repo-a')
            self.assertEqual({item['bank'] for item in result['memories']}, {'repo-a', SHARED_BANK})
            self.assertEqual(sum(call[1]['max_tokens'] for call in client.calls[1:]), 1024)
            self.assertNotIn('repo-b', json.dumps(result))
        asyncio.run(check())

    def test_nonrepo_reads_and_writes_shared_only(self):
        async def check():
            client = FakeClient()
            memory = Memory(client, Scope(SHARED_BANK))
            await memory.retain('shared fact')
            await memory.read('reflect', 'question')
            self.assertEqual([args['bank_id'] for _, args in client.calls], [SHARED_BANK, SHARED_BANK])
        asyncio.run(check())

    def test_same_named_repositories_differ_and_worktrees_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            a, b, worktree = root / 'a/repo', root / 'b/repo', root / 'wt'
            for path in [a, b]:
                path.mkdir(parents=True)
                runtime_env.run(['git', 'init', path], capture=True)
                runtime_env.run(['git', '-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                         'commit', '--allow-empty', '-m', 'fixture'], capture=True)
            runtime_env.run(['git', '-C', a, 'worktree', 'add', '-b', 'test', worktree], capture=True)
            self.assertNotEqual(scope_for(a), scope_for(b))
            self.assertEqual(scope_for(a), scope_for(worktree))
            (a / 'sub').mkdir()
            self.assertEqual(scope_for(a), scope_for(a / 'sub'))

    def test_session_stays_in_origin_after_cwd_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            a, b = root / 'a', root / 'b'
            a.mkdir(); b.mkdir()
            runtime_env.run(['git', 'init', a], capture=True)
            with patch('hindsightkit.hooks.home', return_value=root):
                first = session_config({'sessionId': 'session', 'cwd': str(a)}, {'apiUrl': 'local'})
                second = session_config({'sessionId': 'session', 'cwd': str(b)}, {'apiUrl': 'local'})
                self.assertEqual(first, second)
                self.assertEqual(first[1]['bankId'], scope_for(a).bank)
                self.assertEqual(session_config({'sessionId':'another', 'cwd':str(b)}, {})[1]['bankId'], SHARED_BANK)
                refreshed = session_config({'sessionId':'session', 'cwd':str(b)}, {'apiUrl':'new-local'})
                self.assertEqual(refreshed[1]['bankId'], first[1]['bankId'])
                self.assertEqual(refreshed[1]['apiUrl'], 'new-local')

    def test_workspace_roots_reject_ambiguous_repositories(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / 'a', Path(temp) / 'b'
            a.mkdir(); b.mkdir()
            for path in [a, b]: runtime_env.run(['git', 'init', path], capture=True)
            with self.assertRaisesRegex(ValueError, 'one repository'):
                scope_from_roots([SimpleNamespace(uri=a.as_uri()), SimpleNamespace(uri=b.as_uri())])
            self.assertEqual(scope_from_roots([]), Scope(SHARED_BANK))
            self.assertEqual(scope_from_roots([SimpleNamespace(uri=a.as_uri())]), scope_for(a))

    def test_git_failure_does_not_route_repo_memory_into_shared(self):
        with patch('hindsightkit.memory.subprocess.run', return_value=SimpleNamespace(returncode=128, stdout='', stderr='fatal: dubious ownership')):
            with self.assertRaisesRegex(RuntimeError, 'Cannot determine'):
                scope_for(Path.cwd())
