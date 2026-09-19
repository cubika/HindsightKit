import asyncio
import contextlib
import io
import json
import inspect
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from hindsight_client import Hindsight

from hindsightkit.platform import runtime as runtime_env
from hindsightkit import hooks
from hindsightkit.hooks import session_config
from hindsightkit.memory.api import Memory, ReadSource, Scope, SHARED_BANK, scope_for
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
        with patch('hindsightkit.memory.api.subprocess.run', return_value=SimpleNamespace(returncode=128, stdout='', stderr='fatal: dubious ownership')):
            with self.assertRaisesRegex(RuntimeError, 'Cannot determine'):
                scope_for(Path.cwd())


class UnifiedReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_hook_and_explicit_read_use_same_sources(self):
        client = SimpleNamespace(arecall=AsyncMock(return_value=Result('finding')), aclose=AsyncMock())
        config = {'bankId': 'repo-a', '_repository': '/a', 'hindsightkit': {'mode': 'client'}}
        with patch('hindsightkit.connection.sdk', return_value=client), \
             patch('hindsightkit.connection.report', new_callable=AsyncMock), \
             patch('hindsightkit.connection.discover', new_callable=AsyncMock, return_value={'connectors': ['workiq']}):
            result = await hooks.prompt_memory(config, {'prompt': 'What constraints apply?'})
        self.assertEqual({item['bank'] for item in result['memories']}, {'repo-a', SHARED_BANK, 'hindsightkit-mail'})
        self.assertEqual(sum(call.kwargs['max_tokens'] for call in client.arecall.await_args_list), 2048)
        client.aclose.assert_awaited_once()

    async def test_recall_and_reflect_share_sources_and_use_valid_sdk_parameters(self):
        client = FakeClient()
        sources = (ReadSource('workiq', 'mail', ('world',), 'mid'),)
        for operation in ('recall', 'reflect'):
            with self.subTest(operation=operation), \
                 patch('hindsightkit.connectors.registry.readable_sources', new_callable=AsyncMock, return_value=sources):
                client.calls.clear()
                memory = Memory(client, Scope('repo-a', '/a'), config={})
                result = await memory.read(operation, 'What constraints apply?', 1025)
                self.assertTrue(result['complete'])
                self.assertEqual({item['bank'] for item in result['memories']}, {'repo-a', SHARED_BANK, 'mail'})
                self.assertEqual(sum(args['max_tokens'] for _, args in client.calls), 1025)
                for _, args in client.calls:
                    inspect.signature(getattr(Hindsight, 'a' + operation)).bind(None, **args)
                    self.assertEqual(args['query'], 'What constraints apply?')
                args = next(args for _, args in client.calls if args['bank_id'] == 'mail')
                self.assertEqual(args['types' if operation == 'recall' else 'fact_types'], ['world'])
                if operation == 'reflect':
                    self.assertTrue(args['include_facts'])
                await memory.retain('Repository finding')
                self.assertEqual(client.calls[-1][1]['bank_id'], 'repo-a')

    async def test_failed_source_preserves_success_and_missing_bank_is_empty(self):
        class Failed(Exception):
            def __init__(self, status):
                self.status = status
                super().__init__('private-url secret-token')
        async def recall(**args):
            if args['bank_id'] == SHARED_BANK:
                raise Failed(404)
            if args['bank_id'] == 'mail':
                raise Failed(503)
            return Result('useful finding')
        client = SimpleNamespace(arecall=recall)
        with patch('hindsightkit.connectors.registry.readable_sources', new_callable=AsyncMock,
                   return_value=(ReadSource('workiq', 'mail'),)):
            result = await Memory(client, Scope('repo-a', '/a'), config={}).read('recall', 'question')
        self.assertFalse(result['complete'])
        self.assertEqual([item['status'] for item in result['memories']], ['ok', 'empty', 'error'])
        self.assertEqual(result['memories'][0]['result']['results'][0]['text'], 'useful finding')
        self.assertNotIn('secret-token', json.dumps(result))

    async def test_discovery_failure_is_reported_without_losing_core_results(self):
        with patch('hindsightkit.connectors.registry.readable_sources', new_callable=AsyncMock,
                   side_effect=RuntimeError('private-url secret-token')):
            result = await Memory(FakeClient(), Scope(SHARED_BANK), config={}).read('recall', 'question')
        self.assertFalse(result['complete'])
        self.assertEqual(result['errors'][0]['source'], 'connectors')
        self.assertEqual(result['memories'][0]['status'], 'ok')
        self.assertNotIn('secret-token', json.dumps(result))

    async def test_deadline_preserves_fast_results_and_cancels_slow_source(self):
        canceled = asyncio.Event()
        async def recall(**args):
            if args['bank_id'] == 'mail':
                try:
                    await asyncio.Event().wait()
                finally:
                    canceled.set()
            return Result('fast finding')
        with patch('hindsightkit.connectors.registry.readable_sources', new_callable=AsyncMock,
                   return_value=(ReadSource('workiq', 'mail'),)):
            result = await Memory(SimpleNamespace(arecall=recall), Scope(SHARED_BANK), config={}).read(
                'recall', 'question', timeout=0.1)
        self.assertTrue(canceled.is_set())
        self.assertFalse(result['complete'])
        self.assertEqual([item['status'] for item in result['memories']], ['ok', 'error'])

    async def test_duplicate_banks_preserve_core_types_without_spending_budget_twice(self):
        client = FakeClient()
        with patch('hindsightkit.connectors.registry.readable_sources', new_callable=AsyncMock,
                   return_value=(ReadSource('workiq', SHARED_BANK, ('world',), 'mid'),) * 2):
            result = await Memory(client, Scope(SHARED_BANK), config={}).read('recall', 'question', 256)
        self.assertEqual(len(result['memories']), 1)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0][1]['max_tokens'], 256)
        self.assertNotIn('types', client.calls[0][1])
        self.assertEqual(result['memories'][0]['source'], 'shared')


class HookEvidenceTests(unittest.TestCase):
    def test_injected_context_keeps_provenance_and_reports_incomplete_reads(self):
        fact = {'id': 'fact-1', 'text': 'Compatibility decision', 'document_id': 'thread-1',
                'metadata': {'source_url': 'https://outlook.example.invalid/thread', 'last_supported_at': '2026-09-18'},
                'mentioned_at': '2026-09-18T12:00:00Z', 'tags': ['source:workiq-thread']}
        for facts in ([fact], []):
            with self.subTest(has_facts=bool(facts)), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = {'bankId': SHARED_BANK, '_repository': None, '_memory_repository': None}
                path = root / 'config.json'
                path.write_text(json.dumps(config))
                recalled = {'memories': [{'bank': 'mail', 'source': 'workiq', 'status': 'ok',
                                          'result': {'results': facts}}],
                            'complete': False, 'errors': [{'source': 'connectors', 'error': 'Discovery failed'}]}
                event = {'prompt': 'What constraints apply?', 'sessionId': 'fixture', 'cwd': temp}
                with patch.dict(os.environ, {'HINDSIGHT_CONFIG': str(path), 'HINDSIGHTKIT_HOME': temp,
                                             'HINDSIGHT_DISABLE_HOOKS': ''}), \
                     patch.object(hooks, 'session_config', return_value=(path, config)), \
                     patch.object(hooks, 'prompt_memory', new_callable=AsyncMock, return_value=recalled), \
                     patch('hindsightkit.sharing.remote.prepare_client'), \
                     patch('sys.stdin', io.StringIO(json.dumps(event))), contextlib.redirect_stdout(io.StringIO()) as output:
                    hooks.run('userPromptTransformed')
                prompt = json.loads(output.getvalue())['modifiedTransformedPrompt']
                block = json.loads(prompt.split('<hindsight_memory>\n')[1].split('\n</hindsight_memory>')[0])
                self.assertFalse(block['complete'])
                self.assertEqual(block['errors'], recalled['errors'])
                if facts:
                    self.assertEqual(block['memories'][0]['facts'], [fact])
                    self.assertEqual(block['memories'][0]['source'], 'workiq')
