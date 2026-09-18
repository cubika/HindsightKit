import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hindsightkit.mail_filter import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, MailPrefilter
from hindsightkit.mail_outcome import OutcomeBuilder, QUOTE_MARKER


def message(text='Your monthly receipt is available in the account portal.', key='private-mail-id', **metadata):
    return {'source_key': key, 'content': text, 'metadata': {'thread_id': 'private-thread-id',
        'subject': 'Account update', 'sender_name': 'Sender', 'sent_at': '2026-09-15T12:00:00Z',
        'received_at': '2026-09-15T12:00:02Z', **metadata}}


def answer(prompt, **changes):
    payload = json.loads(prompt)
    return {'thread_id': payload['thread_id'], 'source_ids': [source['source_id'] for source in payload['sources']],
            'all_sources_reviewed': True, 'decision': 'skip', **changes}


class FakeSession:
    def __init__(self, client):
        self.client = client

    async def send_and_wait(self, prompt, **kwargs):
        self.client.prompts.append(prompt)
        responses = self.client.response(prompt)
        if not isinstance(responses, list):
            responses = [responses]
        for response in responses:
            self.client.session_config['tools'][0].handler(SimpleNamespace(arguments=response))


class FakeClient:
    def __init__(self, response=answer, **kwargs):
        self.response, self.config = response, kwargs
        self.prompts, self.cleanup = [], []

    async def start(self):
        pass

    async def create_session(self, **kwargs):
        self.session_config = kwargs
        return FakeSession(self)

    async def stop(self):
        self.cleanup.append('stop')

    async def force_stop(self):
        self.cleanup.append('force_stop')


class PrefilterTests(unittest.IsolatedAsyncioTestCase):
    profile = {'HINDSIGHT_API_LLM_PROVIDER': 'github-copilot', 'HINDSIGHT_API_LLM_MODEL': 'gpt-6-astra',
               'HINDSIGHT_API_LLM_REASONING_EFFORT': 'xhigh'}

    def setUp(self):
        copier = patch('hindsightkit.mail_outcome.shutil.copyfile')
        copier.start()
        self.addCleanup(copier.stop)
        self.clients = []

    def factory(self, response=answer, client_type=FakeClient):
        def make(**kwargs):
            client = client_type(response=response, **kwargs)
            self.clients.append(client)
            return client
        return make

    def builder(self, response=answer, **kwargs):
        return MailPrefilter(copy.deepcopy(self.profile), client_factory=self.factory(response), **kwargs)

    async def test_default_fast_model_preserves_outcome_profile_and_isolated_sdk(self):
        profile = copy.deepcopy(self.profile)
        builder = MailPrefilter(profile, client_factory=self.factory())
        messages = [message()]
        before = copy.deepcopy(messages)
        result = await builder.classify(messages)
        self.assertEqual(result, {'decision': 'skip', 'reason': 'prefilter_routine_only',
                                 'model': DEFAULT_MODEL, 'reasoning_effort': DEFAULT_REASONING_EFFORT})
        self.assertEqual(profile, self.profile)
        self.assertEqual(messages, before)
        client = self.clients[0]
        self.assertEqual(client.config['mode'], 'empty')
        self.assertTrue(client.config['use_logged_in_user'])
        config = client.session_config
        self.assertEqual(config['model'], DEFAULT_MODEL)
        self.assertEqual(config['reasoning_effort'], DEFAULT_REASONING_EFFORT)
        self.assertEqual(config['available_tools'], ['record_classification'])
        self.assertTrue(config['tools'][0].is_terminal)
        self.assertTrue(config['tools'][0].skip_permission)
        for key in ('enable_config_discovery', 'enable_skills', 'enable_file_hooks', 'enable_session_store',
                    'enable_session_telemetry', 'enable_host_git_operations', 'enable_on_demand_instruction_discovery',
                    'enable_file_change_tracking', 'manage_schedule_enabled'):
            self.assertFalse(config[key])
        for key in ('skill_directories', 'plugin_directories', 'instruction_directories', 'custom_agents'):
            self.assertEqual(config[key], [])
        self.assertEqual(config['mcp_servers'], {})
        self.assertEqual(config['memory'], {'enabled': False})
        self.assertEqual(config['infinite_sessions'], {'enabled': False})
        self.assertEqual(client.cleanup, ['stop'])
        self.assertFalse(Path(client.config['base_directory']).exists())
        self.assertIs(MailPrefilter._stop_client, OutcomeBuilder._stop_client)
        self.assertIs(MailPrefilter.close, OutcomeBuilder.close)
        self.assertEqual(builder.metrics['decision_skip_count'], 1)
        self.assertEqual(builder.metrics['failure_count'], 0)

    async def test_model_and_reasoning_override_only_prefilter(self):
        builder = self.builder(model='another-model', reasoning_effort='medium')
        result = await builder.classify([message()])
        self.assertEqual(result['model'], 'another-model')
        self.assertEqual(result['reasoning_effort'], 'medium')
        self.assertEqual(self.clients[0].session_config['model'], 'another-model')
        self.assertEqual(builder.profile, self.profile)

    async def test_each_valid_decision_is_preserved(self):
        for decision in ('skip', 'keep', 'uncertain'):
            with self.subTest(decision=decision):
                builder = self.builder(lambda prompt: answer(prompt, decision=decision))
                result = await builder.classify([message()])
                self.assertEqual(result['decision'], decision)
                self.assertEqual(builder.metrics[f'decision_{decision}_count'], 1)
                self.assertEqual(builder.metrics['failure_count'], 0)

    async def test_entire_thread_quotes_and_original_text_reach_model_with_opaque_ids(self):
        earlier = 'The service needs a minimum lease of 45 seconds.'
        newest = 'Retrying with the documented minimum still returns an error.'
        item = message(newest + '\n' + QUOTE_MARKER + '\n' + earlier)
        item['source_text'] = newest + '\nEarlier message:\n' + earlier + '\nNote: the server overrides this setting.'
        messages = [item, message('A second reply confirms the same behavior.', key='another-private-id')]
        before = copy.deepcopy(messages)
        await self.builder(lambda prompt: answer(prompt, decision='keep')).classify(messages)
        payload = json.loads(self.clients[0].prompts[0])
        self.assertEqual(payload['thread_id'], 'thread')
        self.assertEqual({source['source_id'] for source in payload['sources']}, {'source-1', 'source-2', 'source-3', 'source-4'})
        texts = [source['text'] for source in payload['sources']]
        for expected in (newest, earlier, item['source_text'], messages[1]['content']):
            self.assertIn(expected, texts)
        quoted = next(source for source in payload['sources'] if source['text'] == earlier)
        self.assertIsNone(quoted['author'])
        self.assertIsNone(quoted['reported_at'])
        for identity in ('private-mail-id', 'private-thread-id', 'another-private-id'):
            self.assertNotIn(identity, self.clients[0].prompts[0])
        self.assertEqual(messages, before)

    async def test_topics_organizations_and_replies_always_use_semantic_model(self):
        for item in (message(subject='PIM: activation'), message(subject='Please accept your Stock Award'),
                     message('纯日程通知：请于周一参加例会。', subject='任意组织活动'),
                     message('Routine notice with an unresolved diagnostic observation.', subject='Re: Receipt')):
            result = await self.builder(lambda prompt: answer(prompt, decision='keep')).classify([item])
            self.assertEqual(result['decision'], 'keep')
        self.assertEqual(len(self.clients), 4)

    async def test_invalid_incomplete_or_mixed_inputs_fall_through_without_model(self):
        invalid = [None, [], {}, [None], [message(), {'error': 'missing'}],
                   [message(key='')], [message(thread_id='')], [message(subject=[])],
                   [message(), message(key='second', thread_id='different')], [message(), message()],
                   [{**message(), 'content': ''}], [{**message(), 'content': None}],
                   [{**message(), 'source_text': ''}], [{**message(), 'source_text': 12}],
                   [{**message(), 'error': 'private error text'}], [{**message(), 'skip_reason': 'draft'}],
                   [message(sent_at='not-a-date')], [message(sender_name=object())]]
        builder = self.builder()
        for messages in invalid:
            with self.subTest(messages=str(messages)[:80]):
                result = await builder.classify(messages)
                self.assertEqual(result['decision'], 'uncertain')
                self.assertEqual(result['reason'], 'prefilter_input_invalid')
        self.assertEqual(self.clients, [])
        self.assertEqual(builder.metrics['failure_count'], len(invalid))

    async def test_oversized_input_is_never_truncated_or_classified(self):
        for item in (message('x' * 100001), {**message(), 'source_text': 'x' * 100001},
                     message('x' * 99950)):
            result = await self.builder().classify([item])
            self.assertEqual(result['decision'], 'uncertain')
            self.assertEqual(result['reason'], 'prefilter_input_too_large')
        self.assertEqual(self.clients, [])

    async def test_strict_schema_ids_coverage_and_single_call_required(self):
        alterations = [lambda prompt: {}, lambda prompt: answer(prompt, thread_id='wrong-thread'),
            lambda prompt: answer(prompt, source_ids=['unknown-source']),
            lambda prompt: answer(prompt, source_ids=[]),
            lambda prompt: answer(prompt, source_ids=['source-1', 'source-1']),
            lambda prompt: answer(prompt, all_sources_reviewed=False),
            lambda prompt: answer(prompt, all_sources_reviewed='true'),
            lambda prompt: answer(prompt, all_sources_reviewed=1),
            lambda prompt: answer(prompt, decision='drop'),
            lambda prompt: answer(prompt, explanation='private content'),
            lambda prompt: [answer(prompt), answer(prompt)], lambda prompt: []]
        for response in alterations:
            builder = self.builder(response)
            result = await builder.classify([message()])
            self.assertEqual(result['decision'], 'uncertain')
            self.assertIn(result['reason'], {'prefilter_identity_invalid', 'prefilter_format_invalid'})
            self.assertEqual(builder.metrics['failure_count'], 1)
            self.assertEqual(len(self.clients[-1].prompts), 1)
            self.assertEqual(self.clients[-1].cleanup, ['stop'])
            self.assertNotIn('private content', json.dumps(result))

    async def test_missing_source_in_multi_message_response_is_uncertain(self):
        builder = self.builder(lambda prompt: answer(prompt, source_ids=['source-1']))
        result = await builder.classify([message(), message('A useful finding.', key='another-message')])
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'prefilter_identity_invalid')

    async def test_profile_and_sdk_failures_are_safe_uncertain_results(self):
        def broken(prompt):
            raise RuntimeError('Credential details and private email text')
        result = await self.builder(broken).classify([message()])
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'prefilter_model_failed')
        self.assertNotIn('Credential', json.dumps(result))
        self.assertEqual(self.clients[0].cleanup, ['stop'])
        builder = MailPrefilter({'HINDSIGHT_API_LLM_PROVIDER': 'other'}, client_factory=self.factory())
        result = await builder.classify([message()])
        self.assertEqual(result['reason'], 'prefilter_copilot_profile_required')
        self.assertEqual(len(self.clients), 1)

    async def test_timeout_fails_open_and_stops_runtime(self):
        class WaitingSession(FakeSession):
            async def send_and_wait(self, *args, **kwargs):
                await asyncio.Event().wait()
        class WaitingClient(FakeClient):
            async def create_session(self, **kwargs):
                self.session_config = kwargs
                return WaitingSession(self)
        builder = MailPrefilter(self.profile, timeout=0.02, client_factory=self.factory(client_type=WaitingClient))
        result = await builder.classify([message()])
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'prefilter_model_failed')
        self.assertEqual(self.clients[0].cleanup, ['stop'])
        self.assertFalse(Path(self.clients[0].config['base_directory']).exists())

    async def test_session_creation_timeout_falls_through_and_stops_runtime(self):
        class WaitingClient(FakeClient):
            async def create_session(self, **kwargs):
                await asyncio.Event().wait()
        builder = MailPrefilter(self.profile, timeout=0.02,
                                client_factory=self.factory(client_type=WaitingClient))
        result = await asyncio.wait_for(builder.classify([message()]), 2)
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'prefilter_model_failed')
        self.assertFalse(builder._clients)
        self.assertEqual(self.clients[0].cleanup, ['stop'])
        self.assertFalse(Path(self.clients[0].config['base_directory']).exists())
        self.assertEqual(builder.metrics['inference_count'], 0)

    async def test_cancellation_forces_cleanup_and_propagates(self):
        started = asyncio.Event()
        class WaitingSession(FakeSession):
            async def send_and_wait(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
        class WaitingClient(FakeClient):
            async def create_session(self, **kwargs):
                self.session_config = kwargs
                return WaitingSession(self)
        builder = MailPrefilter(self.profile, client_factory=self.factory(client_type=WaitingClient))
        task = asyncio.create_task(builder.classify([message()]))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.clients[0].cleanup, ['force_stop'])
        self.assertFalse(Path(self.clients[0].config['base_directory']).exists())
        self.assertEqual(builder.metrics['cancellation_count'], 1)
        self.assertEqual(builder.metrics['decision_skip_count'], 0)

    async def test_failed_cleanup_keeps_runtime_for_close_retry_and_never_skips(self):
        class BrokenClient(FakeClient):
            broken = True
            async def stop(self):
                if self.broken:
                    raise RuntimeError('stop failed')
                await super().stop()
            async def force_stop(self):
                if self.broken:
                    raise RuntimeError('private runtime details')
                await super().force_stop()
        builder = MailPrefilter(self.profile, client_factory=self.factory(client_type=BrokenClient))
        result = await builder.classify([message()])
        self.assertEqual(result['decision'], 'uncertain')
        self.assertEqual(result['reason'], 'prefilter_runtime_cleanup_failed')
        directory = Path(self.clients[0].config['base_directory'])
        self.assertTrue(directory.exists())
        self.assertTrue(builder._clients)
        self.clients[0].broken = False
        await builder.close()
        self.assertFalse(directory.exists())
        self.assertFalse(builder._clients)

    async def test_concurrent_classifications_have_independent_sessions_and_metrics(self):
        builder = self.builder()
        results = await asyncio.gather(*(builder.classify([message()]) for _ in range(8)))
        self.assertEqual([result['decision'] for result in results], ['skip'] * 8)
        self.assertEqual(len({client.config['base_directory'] for client in self.clients}), 8)
        self.assertTrue(all(len(client.prompts) == 1 for client in self.clients))
        self.assertTrue(all(client.cleanup == ['stop'] for client in self.clients))
        self.assertFalse(builder._clients)
        self.assertEqual(builder.metrics['decision_skip_count'], 8)
        for stage in ('runtime_start', 'inference', 'runtime_stop'):
            self.assertEqual(builder.metrics[stage + '_count'], 8)
            self.assertGreaterEqual(builder.metrics[stage + '_seconds'], 0)


if __name__ == '__main__':
    unittest.main()
