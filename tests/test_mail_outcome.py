import asyncio
import copy
import json
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from hindsightkit.mail_outcome import OutcomeBuilder, OutcomeError, prepare_messages, _validate


def message(text='Runtime check is blocked until the owner verifies the deployment.', key='mail-one', **metadata):
    return {'source_key': key, 'content': text, 'metadata': {'subject': 'Runtime incident',
        'thread_id': 'conversation', 'sender_name': 'Owner', 'sent_at': '2026-09-15T12:00:00Z',
        'received_at': '2026-09-15T12:00:02Z', 'source_url': 'https://outlook.office.com/mail/one', **metadata}}


def answer(**changes):
    quote = 'Runtime check is blocked until the owner verifies the deployment.'
    evidence = [{'source_id': 'mail-one', 'quote': quote}]
    result = {'action': 'publish', 'category': 'work', 'status': 'unresolved', 'title': 'Runtime deployment verification',
        'problem': {'text': 'The runtime check is blocked.', 'evidence': evidence},
        'conclusion': {'text': 'The owner must verify the deployment before the runtime check can proceed.', 'evidence': evidence},
        'reason': 'The thread records an unresolved verification requirement.'}
    result.update(changes)
    return result


class ValidationTests(unittest.TestCase):
    def test_publish_generates_provenance_and_preserves_conditions(self):
        _, index = prepare_messages([message()])
        result = _validate(answer(), index, None)
        self.assertEqual(result['action'], 'publish')
        self.assertIn('before the runtime check can proceed', result['content'])
        self.assertEqual(result['metadata']['last_supported_utc'], '2026-09-15T12:00:00Z')
        self.assertEqual(json.loads(result['metadata']['source_ids']), ['mail-one'])
        self.assertTrue(all(isinstance(value, str) for value in result['metadata'].values()))

    def test_content_labels_are_carried_only_when_present_in_outcome(self):
        _, index = prepare_messages([message()])
        result = _validate(answer(content_tags=['Runtime']), index, None)
        self.assertEqual(json.loads(result['metadata']['content_tags']), ['Runtime'])
        self.assertEqual(result['metadata']['subject'], 'Runtime incident')
        self.assertEqual(json.loads(result['metadata']['source_authors']), ['Owner'])
        with self.assertRaisesRegex(OutcomeError, 'content_label_invalid'):
            _validate(answer(content_tags=['InventedService']), index, None)

    def test_unknown_quote_author_time_not_inherited(self):
        rows, index = prepare_messages([message('[Earlier quoted message; author and date not verified]\nRuntime check is blocked until the owner verifies the deployment.')])
        self.assertIsNone(rows[0]['author'])
        self.assertIsNone(rows[0]['reported_at'])
        result = answer()
        for key in ('problem', 'conclusion'):
            result[key]['evidence'][0]['source_id'] = 'mail-one#quote-1'
        output = _validate(result, index, None)
        self.assertNotIn('last_supported_utc', output['metadata'])

    def test_evidence_ids_and_exact_text_checked(self):
        _, index = prepare_messages([message()])
        for alteration in ({'source_id': 'not-a-message', 'quote': 'Runtime check'}, {'source_id': 'mail-one', 'quote': 'Deployment verified.'}):
            result = answer()
            result['problem']['evidence'] = [alteration]
            with self.assertRaisesRegex(OutcomeError, 'evidence_invalid'):
                _validate(result, index, None)

    def test_resolved_needs_explicit_solution_and_verification(self):
        _, index = prepare_messages([message()])
        for result in (answer(status='resolved'), answer(status='resolved', solution=answer()['conclusion'], verification=[{'source_id':'mail-one','quote':message()['content']}])):
            with self.assertRaisesRegex(OutcomeError, 'resolution_unproven'):
                _validate(result, index, None)
        msg = message('The fix was deployed and verified. The runtime check passed.')
        _, index = prepare_messages([msg])
        claim = {'text': 'The deployed fix restored the runtime check.', 'evidence':[{'source_id':'mail-one','quote':msg['content']}]}
        result = _validate(answer(status='resolved', problem=claim, conclusion=claim, solution=claim, verification=claim['evidence']), index, None)
        self.assertEqual(result['metadata']['status'], 'resolved')

    def test_insufficient_context_and_unproven_withdraw_preserve_previous(self):
        _, index = prepare_messages([message()])
        prior = {'original_text':'The runtime check is blocked.'}
        for result in (answer(action='withdraw'), answer(action='unchanged', category='insufficient_context')):
            with self.assertRaises(OutcomeError):
                _validate(result, index, prior)
        output = _validate(answer(action='unchanged'), index, prior)
        self.assertEqual(output['content'], prior['original_text'])

    def test_withdraw_needs_newer_direct_correction(self):
        msg = message('The prior result is incorrect and no longer applies.')
        _, index = prepare_messages([msg])
        result = answer(action='withdraw', problem=None, conclusion=None,
                        withdrawal=[{'source_id':'mail-one','quote':msg['content']}])
        prior = {'original_text':'Old result', 'document_metadata':{'last_supported_utc':'2026-09-16T00:00:00Z'}}
        with self.assertRaisesRegex(OutcomeError,'not_newer'):
            _validate(result,index,prior)
        prior['document_metadata']['last_supported_utc']='2026-09-14T00:00:00Z'
        self.assertEqual(_validate(result,index,prior)['action'],'withdraw')

    def test_identical_outcome_noop(self):
        _, index = prepare_messages([message()])
        first = _validate(answer(), index, None)
        prior = {'original_text':first['content'], 'document_metadata':first['metadata']}
        self.assertEqual(_validate(answer(), index, prior)['action'],'unchanged')

    def test_incomplete_mixed_or_large_threads_rejected(self):
        for rows in ([], [message(), message(key='mail-two',thread_id='other')], [message('x' * 100001)], [{**message(),'error':'missing'}]):
            with self.assertRaises(OutcomeError):
                prepare_messages(rows)


class FakeSession:
    session_id = 'fake-session'
    def __init__(self, client):
        self.client = client
    async def send_and_wait(self,prompt,**kwargs):
        self.client.prompts.append(prompt)
        self.client.last_send_options = kwargs
        self.client.session_config['tools'][0].handler(SimpleNamespace(arguments=self.client.responses.pop(0)))
    async def abort(self):
        self.client.aborted = True
        self.client.cleanup.append("abort")
    async def disconnect(self):
        self.client.disconnected = True
        self.client.cleanup.append("disconnect")


class FakeClient:
    def __init__(self,responses,**kwargs):
        self.responses,self.config = responses,kwargs
        self.prompts=[]
        self.cleanup=[]
        self.stopped=self.aborted=self.disconnected=False
        self.forced=False
    async def start(self):
        pass
    async def create_session(self,**kwargs):
        self.session_config=kwargs
        return FakeSession(self)
    async def delete_session(self,session_id):
        self.deleted=session_id
        self.cleanup.append("delete")
    async def stop(self):
        self.stopped=True
        self.cleanup.append("stop")
    async def force_stop(self):
        self.forced=True
        self.cleanup.append("force_stop")


class BuilderTests(unittest.IsolatedAsyncioTestCase):
    profile={'HINDSIGHT_API_LLM_PROVIDER':'github-copilot','HINDSIGHT_API_LLM_MODEL':'configured-model','HINDSIGHT_API_LLM_REASONING_EFFORT':'xhigh'}
    async def test_sdk_isolated_terminal_tool_and_profile(self):
        clients=[]
        def factory(**kwargs):
            client=FakeClient([answer()],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            output=await OutcomeBuilder(self.profile,client_factory=factory).build([message()])
        self.assertEqual(output['action'],'publish')
        client=clients[0]
        self.assertEqual(client.config['mode'],'empty')
        self.assertTrue(client.config['use_logged_in_user'])
        config=client.session_config
        self.assertEqual(config['available_tools'],['record_outcome'])
        self.assertEqual(config['model'],'configured-model')
        self.assertEqual(config['reasoning_effort'],'xhigh')
        self.assertTrue(config['tools'][0].is_terminal)
        for key in ('enable_config_discovery','enable_skills','enable_file_hooks','enable_session_store','enable_host_git_operations','enable_session_telemetry'):
            self.assertFalse(config[key])
        self.assertEqual(config['mcp_servers'],{})
        self.assertEqual(config['memory'],{'enabled':False})
        self.assertTrue(client.stopped)
        self.assertFalse(hasattr(client,'deleted'))
        self.assertEqual(client.cleanup,['stop'])
        self.assertFalse(Path(client.config['base_directory']).exists())
        self.assertEqual(output['metadata']['analysis_model'], 'configured-model')
        self.assertEqual(output['metadata']['analysis_reasoning_effort'], 'xhigh')

    async def test_one_format_repair_same_session(self):
        clients=[]
        def factory(**kwargs):
            client=FakeClient([{'invalid':True},answer()],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            result=await OutcomeBuilder(self.profile,client_factory=factory).build([message()])
        self.assertEqual(result['action'],'publish')
        self.assertEqual(len(clients),1)
        self.assertEqual(len(clients[0].prompts),2)

    async def test_import_model_override_preserves_server_profile(self):
        clients=[]
        profile=dict(self.profile)
        def factory(**kwargs):
            client=FakeClient([answer()],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            result=await OutcomeBuilder(profile,client_factory=factory,model='gpt-5.6-luna',reasoning_effort='none').build([message()])
        self.assertEqual(result['action'],'publish')
        self.assertEqual(clients[0].session_config['model'],'gpt-5.6-luna')
        self.assertEqual(clients[0].session_config['reasoning_effort'],'none')
        self.assertEqual(result['metadata']['analysis_model'], 'gpt-5.6-luna')
        self.assertEqual(result['metadata']['analysis_reasoning_effort'], 'none')
        self.assertEqual(profile,self.profile)

    async def test_concurrent_builds_keep_separate_runtime_contexts_and_metrics(self):
        clients = []
        def factory(**kwargs):
            client = FakeClient([answer()], **kwargs)
            clients.append(client)
            return client
        builder = OutcomeBuilder(self.profile, client_factory=factory)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            await asyncio.gather(builder.build([message()]), builder.build([message()]))
        self.assertEqual(len(clients), 2)
        self.assertNotEqual(clients[0].config['base_directory'], clients[1].config['base_directory'])
        self.assertTrue(all(len(client.prompts) == 1 for client in clients))
        self.assertFalse(builder._clients)
        for stage in ('runtime_start', 'inference', 'runtime_stop'):
            self.assertEqual(builder.metrics[stage + '_count'], 2)
            self.assertGreaterEqual(builder.metrics[stage + '_seconds'], 0)

    async def test_cancel_during_inference_waits_for_force_stop_before_deleting_directory(self):
        started, forcing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class WaitingSession(FakeSession):
            async def send_and_wait(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
        class WaitingClient(FakeClient):
            async def create_session(self, **kwargs):
                return WaitingSession(self)
            async def force_stop(self):
                forcing.set()
                await release.wait()
                await super().force_stop()
        client = WaitingClient([])
        def factory(**kwargs):
            client.config = kwargs
            return client
        builder = OutcomeBuilder(self.profile, client_factory=factory)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            task = asyncio.create_task(builder.build([message()]))
            await asyncio.wait_for(started.wait(), 2)
            task.cancel()
            await asyncio.wait_for(forcing.wait(), 2)
            self.assertFalse(task.done())
            self.assertTrue(Path(client.config['base_directory']).exists())
            self.assertIn(client, builder._clients)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
        self.assertEqual(client.cleanup, ['force_stop'])
        self.assertFalse(builder._clients)
        self.assertFalse(Path(client.config['base_directory']).exists())
        self.assertEqual(builder.metrics['inference_count'], 1)
        self.assertEqual(builder.metrics['runtime_stop_count'], 1)

    async def test_cancel_during_graceful_stop_forces_owned_runtime_closed(self):
        stopping = asyncio.Event()
        class WaitingClient(FakeClient):
            async def stop(self):
                self.cleanup.append('stop')
                stopping.set()
                await asyncio.Event().wait()
        client = WaitingClient([answer()])
        builder = OutcomeBuilder(self.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            task = asyncio.create_task(builder.build([message()]))
            await asyncio.wait_for(stopping.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
        self.assertEqual(client.cleanup, ['stop', 'force_stop'])
        self.assertFalse(builder._clients)
        self.assertFalse(builder._directories)

    async def test_stop_timeout_uses_force_stop_and_keeps_completed_result(self):
        class WaitingClient(FakeClient):
            async def stop(self):
                self.cleanup.append('stop')
                await asyncio.Event().wait()
        client = WaitingClient([answer()])
        builder = OutcomeBuilder(self.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'), patch('hindsightkit.mail_outcome.RUNTIME_STOP_TIMEOUT', 0.01):
            result = await asyncio.wait_for(builder.build([message()]), 2)
        self.assertEqual(result['action'], 'publish')
        self.assertEqual(client.cleanup, ['stop', 'force_stop'])
        self.assertFalse(builder._clients)
        self.assertFalse(builder._directories)

    async def test_failed_force_stop_keeps_client_and_directory_for_close_retry(self):
        class BrokenClient(FakeClient):
            fail = True
            async def stop(self):
                raise TimeoutError()
            async def force_stop(self):
                if self.fail:
                    raise RuntimeError('fake shutdown failure')
                await super().force_stop()
        client = BrokenClient([answer()])
        builder = OutcomeBuilder(self.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            with self.assertRaisesRegex(OutcomeError, 'runtime_cleanup_failed'):
                await builder.build([message()])
        self.assertIn(client, builder._clients)
        directory = Path(builder._directories[client])
        self.assertTrue(directory.exists())
        client.fail = False
        await builder.close()
        self.assertTrue(client.forced)
        self.assertFalse(directory.exists())
        self.assertFalse(builder._clients)

    async def test_cancel_during_runtime_start_records_failure_and_forces_cleanup(self):
        starting = asyncio.Event()
        class WaitingClient(FakeClient):
            async def start(self):
                starting.set()
                await asyncio.Event().wait()
        client = WaitingClient([])
        builder = OutcomeBuilder(self.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            task = asyncio.create_task(builder.build([message()]))
            await asyncio.wait_for(starting.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
        self.assertEqual(client.cleanup, ['force_stop'])
        self.assertFalse(builder._clients)
        self.assertEqual(builder.metrics['runtime_start_count'], 1)
        self.assertEqual(builder.metrics['inference_count'], 0)
        self.assertEqual(builder.metrics['runtime_stop_count'], 1)

    async def test_two_invalid_results_raise(self):
        def factory(**kwargs):
            return FakeClient([{},{}],**kwargs)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'),self.assertRaisesRegex(OutcomeError,'format_invalid'):
            await OutcomeBuilder(self.profile,client_factory=factory).build([message()])

    async def test_repository_review_skips_without_model(self):
        def factory(**kwargs):
            self.fail('Review must not call the model')
        for subject in ('PR - Useful technical regression','Re: PR Review change','Pull request 123'):
            result=await OutcomeBuilder(self.profile,client_factory=factory).build([message(subject=subject)])
            self.assertEqual(result['action'],'unchanged')

    async def test_courtesy_never_erases_previous(self):
        result=await OutcomeBuilder(self.profile).build([message('')],{'original_text':'Preserved result'})
        self.assertEqual(result['action'],'unchanged')
        self.assertEqual(result['content'],'Preserved result')


if __name__ == '__main__':
    unittest.main()

class PackingTests(unittest.TestCase):
    def test_exact_quotes_reuse_actual_message_author(self):
        quote = '[Earlier quoted message; author and date not verified]'
        first = message('Keep v1 until the owner verifies v2.',key='mail-one')
        second = message('Verification is still pending.\n' + quote + '\nKeep v1 until the owner verifies v2.', key='mail-two', sent_at='2026-09-16T00:00:00Z')
        third = message('Acknowledged.\n' + quote + '\nUnique older evidence.\n' + quote + '\nUnique older evidence.',key='mail-three')
        sources,index = prepare_messages([first,second,third])
        self.assertEqual(sum(source['text']=='Keep v1 until the owner verifies v2.' for source in sources),1)
        self.assertEqual(sum(source['text']=='Unique older evidence.' for source in sources),1)
        self.assertEqual(index['mail-one'][0]['author'],'Owner')

    def test_unsupported_number_rejected(self):
        _,index = prepare_messages([message()])
        changed=answer()
        changed['conclusion']['text']='The deployment is blocked for 15 minutes.'
        with self.assertRaisesRegex(OutcomeError,'number_unsupported'):
            _validate(changed,index,None)


class PolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_prior_review_is_withdrawn_without_model(self):
        def fail(**kwargs):
            self.fail('No model needed for known repository-local review')
        output=await OutcomeBuilder(client_factory=fail).build([message(subject='PR - Useful review')],{'original_text':'Old code review memory'})
        self.assertEqual(output['action'],'withdraw')
        self.assertEqual(output['content'],'')

    async def test_model_timeout_closes_resources_and_preserves_old(self):
        class BrokenSession(FakeSession):
            async def send_and_wait(self,*args,**kwargs):
                raise TimeoutError()
        class BrokenClient(FakeClient):
            async def create_session(self,**kwargs):
                return BrokenSession(self)
        clients=[]
        def factory(**kwargs):
            client=BrokenClient([],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'),self.assertRaisesRegex(OutcomeError,'model_failed'):
            await OutcomeBuilder(BuilderTests.profile,client_factory=factory).build([message()],{'original_text':'Old result'})
        self.assertTrue(clients[0].stopped)

class GuardRegressionTests(unittest.TestCase):
    def test_negated_refutation_cannot_withdraw(self):
        for text,quote in [
            ('The previous diagnosis is not incorrect; it still applies.','The previous diagnosis is not incorrect; it still applies.'),
            ('The previous diagnosis is not incorrect; it still applies.','incorrect; it still applies'),
            ('We have not retracted the previous diagnosis.','retracted the previous diagnosis'),
        ]:
            _,index=prepare_messages([message(text)])
            result=answer(action='withdraw',problem=None,conclusion=None,withdrawal=[{'source_id':'mail-one','quote':quote}])
            with self.assertRaisesRegex(OutcomeError,'withdrawal_unproven'):
                _validate(result,index,{'original_text':'Previous result'})

    def test_truncated_verified_cannot_resolve(self):
        text='The fix has not been verified; the runtime check is still failing.'
        _,index=prepare_messages([message(text)])
        claim={'text':'The runtime check has recovered.','evidence':[{'source_id':'mail-one','quote':text}]}
        for quote in ('verified','been verified; the runtime check','The fix has not been verified; the runtime check is still failing.'):
            result=answer(status='resolved',problem=claim,conclusion=claim,solution=claim,verification=[{'source_id':'mail-one','quote':quote}])
            with self.assertRaisesRegex(OutcomeError,'resolution_unproven'):
                _validate(result,index,None)

    def test_numbers_and_units_are_exact(self):
        for evidence,claim_text,accepted in [
            ('The queue waited 150 milliseconds.','The queue waited 15 milliseconds.',False),
            ('The queue waited 15 seconds.','The queue waited 15 milliseconds.',False),
            ('The queue waited 789,615 ms.','The queue waited 789615 milliseconds.',True),
            ('The measured latency was 15.0 ms.','The measured latency was 15 milliseconds.',True),
        ]:
            _,index=prepare_messages([message(evidence)])
            claim={'text':claim_text,'evidence':[{'source_id':'mail-one','quote':evidence}]}
            result=answer(problem=claim,conclusion=claim)
            if accepted:
                self.assertEqual(_validate(result,index,None)['action'],'publish')
            else:
                with self.assertRaisesRegex(OutcomeError,'number_unsupported'):
                    _validate(result,index,None)

    def test_same_content_new_confirmation_updates_provenance(self):
        _,first_index=prepare_messages([message()])
        first=_validate(answer(),first_index,None)
        previous={'original_text':first['content'],'document_metadata':{**first['metadata'],'hosting_revision':'unchanged'}}
        self.assertEqual(_validate(answer(),first_index,previous)['action'],'unchanged')
        _,new_index=prepare_messages([message(key='mail-new',sent_at='2026-09-17T12:00:00Z',source_url='https://outlook.office.com/mail/new')])
        result=answer()
        for key in ('problem','conclusion'):
            result[key]['evidence'][0]['source_id']='mail-new'
        updated=_validate(result,new_index,previous)
        self.assertEqual(updated['action'],'publish')
        self.assertEqual(updated['content'],first['content'])
        self.assertEqual(updated['metadata']['last_supported_utc'],'2026-09-17T12:00:00Z')
        self.assertEqual(json.loads(updated['metadata']['source_ids']),['mail-new'])

    def test_unresolved_solution_is_labeled_proposed(self):
        _,index=prepare_messages([message()])
        result=_validate(answer(solution=answer()['conclusion']),index,None)
        self.assertIn('Proposed solution:',result['content'])


class DiagnosticUnitTests(unittest.TestCase):
    def test_explicit_ms_fields_support_only_milliseconds(self):
        text='QueueTimeExceeded(Job=ManagerChainL1,QueueTimeMs=789615,LimitMs=20000).'
        _,index=prepare_messages([message(text)])
        for claim_text,accepted in [('The queue age was 789615 ms against a 20000 ms limit.',True),
                                    ('The queue age was 789615 seconds against a 20000 ms limit.',False),
                                    ('The queue age was 78961 ms against a 20000 ms limit.',False)]:
            claim={'text':claim_text,'evidence':[{'source_id':'mail-one','quote':text}]}
            if accepted:
                self.assertEqual(_validate(answer(problem=claim,conclusion=claim),index,None)['action'],'publish')
            else:
                with self.assertRaisesRegex(OutcomeError,'number_unsupported'):
                    _validate(answer(problem=claim,conclusion=claim),index,None)
        _,index=prepare_messages([message('QueueTimeMs=150')])
        claim={'text':'The queue time was 15 ms.','evidence':[{'source_id':'mail-one','quote':'QueueTimeMs=150'}]}
        with self.assertRaisesRegex(OutcomeError,'number_unsupported'):
            _validate(answer(problem=claim,conclusion=claim),index,None)


class NumericRepairTests(unittest.IsolatedAsyncioTestCase):
    async def test_numeric_validation_gets_only_one_repair(self):
        invalid=answer()
        invalid['conclusion']['text']='The deployment is blocked for 15 minutes.'
        clients=[]
        def factory(**kwargs):
            client=FakeClient([invalid,answer()],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            result=await OutcomeBuilder(BuilderTests.profile,client_factory=factory).build([message()])
        self.assertEqual(result['action'],'publish')
        self.assertEqual(len(clients[0].prompts),2)
        self.assertIn('ending in Ms',clients[0].prompts[1])


def batch_answer(identity, **changes):
    result = copy.deepcopy(answer(**changes))
    for field in ('problem', 'conclusion', 'solution', 'owner'):
        if result.get(field):
            for evidence in result[field]['evidence']:
                evidence['source_id'] = identity + ':s1'
    return {'id': identity, 'outcome': result}


class BatchBuilderTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_timeout_scales_with_work_without_changing_model(self):
        requests = [{'id': str(i), 'messages': [message(key='mail-' + str(i), thread_id='thread-' + str(i))]} for i in range(4)]
        builder, clients = self.builder([[{'results': [batch_answer('t' + str(i + 1)) for i in range(4)]}]])
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            await builder.build_batch(requests)
        self.assertEqual(clients[0].last_send_options['timeout'], 480)
        self.assertEqual(clients[0].session_config['model'], BuilderTests.profile['HINDSIGHT_API_LLM_MODEL'])

    def requests(self):
        return [{'id': 'caller-thread-one', 'messages': [message(thread_id='first')], 'previous': None},
                {'id': 'caller-thread-two', 'messages': [message(thread_id='second')], 'previous': None}]

    def builder(self, responses):
        clients = []
        def factory(**kwargs):
            client = FakeClient(responses[len(clients)], **kwargs)
            clients.append(client)
            return client
        return OutcomeBuilder(BuilderTests.profile, client_factory=factory), clients

    async def test_multiple_threads_share_one_prompt_and_preserve_original_provenance(self):
        builder, clients = self.builder([[{'results': [batch_answer('t2'), batch_answer('t1')]}]])
        requests = self.requests()
        requests[0]['messages'].append(message('Verification is still pending.', key='mail-two', thread_id='first'))
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(requests)
        self.assertEqual(len(clients), 1)
        self.assertEqual(len(clients[0].prompts), 1)
        prompt = json.loads(clients[0].prompts[0])
        self.assertEqual([row['id'] for row in prompt['threads']], ['t1', 't2'])
        self.assertEqual(len(prompt['threads'][0]['messages']), 2)
        self.assertEqual(prompt['threads'][0]['messages'][0]['text'], requests[0]['messages'][0]['content'])
        self.assertNotIn('caller-thread-one', clients[0].prompts[0])
        config = clients[0].session_config
        self.assertEqual(config['available_tools'], ['record_outcomes'])
        self.assertTrue(config['tools'][0].is_terminal)
        self.assertEqual(config['model'], 'configured-model')
        self.assertEqual(config['reasoning_effort'], 'xhigh')
        self.assertEqual(config['tools'][0].parameters['$defs']['BatchItem']['properties']['id']['enum'], ['t1', 't2'])
        for request, thread_id in zip(requests, ('first', 'second')):
            result = results[request['id']]
            self.assertEqual(result['action'], 'publish')
            self.assertEqual(result['metadata']['thread_id'], thread_id)
            self.assertEqual(json.loads(result['metadata']['source_ids']), ['mail-one'])
            self.assertEqual(json.loads(result['metadata']['evidence'])[0]['source_id'], 'mail-one')
            self.assertEqual(result['metadata']['analysis_model'], 'configured-model')
            self.assertEqual(result['metadata']['analysis_reasoning_effort'], 'xhigh')
        self.assertEqual(builder.metrics['batch_calls'], 1)
        self.assertEqual(builder.metrics['batch_threads'], 2)
        self.assertEqual(builder.metrics['inference_count'], 1)
        self.assertEqual(clients[0].cleanup, ['stop'])
        self.assertFalse(builder._clients)

    async def test_each_unchanged_result_keeps_its_own_previous(self):
        builder, clients = self.builder([[{'results': [batch_answer('t2', action='unchanged'), batch_answer('t1', action='unchanged')]}]])
        requests = self.requests()
        for request in requests:
            request['previous'] = {'original_text': request['id'], 'document_metadata': {'marker': request['id']}}
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(requests)
        for request in requests:
            self.assertEqual(results[request['id']]['content'], request['id'])
            self.assertEqual(results[request['id']]['metadata'], {'marker': request['id']})
        self.assertEqual(len(clients), 1)

    async def test_cross_thread_evidence_is_retried_even_with_identical_original_source_ids(self):
        crossed = batch_answer('t1')
        crossed['outcome']['conclusion']['evidence'][0]['source_id'] = 't2:s1'
        builder, clients = self.builder([[{'results': [crossed, batch_answer('t2')]}], [answer()]])
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(self.requests())
        self.assertEqual(len(clients), 2)
        self.assertEqual(clients[1].session_config['available_tools'], ['record_outcome'])
        self.assertEqual(json.loads(clients[1].prompts[0])['messages'][0]['source_id'], 'mail-one')
        self.assertEqual(results['caller-thread-one']['metadata']['thread_id'], 'first')
        self.assertEqual(results['caller-thread-two']['metadata']['thread_id'], 'second')

    async def test_invalid_item_keeps_valid_peer_and_uses_original_individual_repair_limit(self):
        builder, clients = self.builder([[{'results': [{'id': 't1', 'outcome': {'invalid': True}}, batch_answer('t2')]}], [{}, answer()]])
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(self.requests())
        self.assertEqual([len(client.prompts) for client in clients], [1, 2])
        self.assertTrue(all(result['action'] == 'publish' for result in results.values()))
        self.assertTrue(all(client.session_config['reasoning_effort'] == 'xhigh' for client in clients))
        self.assertEqual(builder.metrics['batch_threads'], 2)
        self.assertEqual(builder.metrics['inference_count'], 3)

    async def test_duplicate_missing_and_malformed_identity_retry_only_the_affected_item(self):
        for rows in ([batch_answer('t1'), batch_answer('t1'), batch_answer('t2')],
                     [batch_answer('t2')],
                     [{**batch_answer('t1'), 'extra': True}, batch_answer('t2')],
                     [{'id': ['t1'], 'outcome': answer()}, batch_answer('t2')]):
            with self.subTest(rows=rows):
                builder, clients = self.builder([[{'results': rows}], [answer()]])
                with patch('hindsightkit.mail_outcome.shutil.copyfile'):
                    results = await builder.build_batch(self.requests())
                self.assertEqual(len(clients), 2)
                self.assertTrue(all(result['action'] == 'publish' for result in results.values()))
                self.assertEqual(results['caller-thread-two']['metadata']['thread_id'], 'second')

    async def test_unknown_identity_cannot_replace_a_valid_result(self):
        builder, clients = self.builder([[{'results': [batch_answer('t1'), batch_answer('unknown'), batch_answer('t2')]}]])
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(self.requests())
        self.assertEqual(set(results), {'caller-thread-one', 'caller-thread-two'})
        self.assertEqual(len(clients), 1)

    async def test_invalid_envelope_retries_each_thread_independently(self):
        for malformed in ({'results': [batch_answer('t1')], 'extra': True}, {'results': {}}, [batch_answer('t1')]):
            with self.subTest(malformed=malformed):
                builder, clients = self.builder([[malformed], [answer()], [answer()]])
                with patch('hindsightkit.mail_outcome.shutil.copyfile'):
                    results = await builder.build_batch(self.requests())
                self.assertEqual(len(clients), 3)
                self.assertTrue(all(result['action'] == 'publish' for result in results.values()))

    async def test_failed_retry_returns_per_item_error_without_losing_success(self):
        builder, clients = self.builder([[{'results': [batch_answer('t2')]}], [{}, {}]])
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(self.requests())
        self.assertIsInstance(results['caller-thread-one'], OutcomeError)
        self.assertEqual(str(results['caller-thread-one']), 'outcome_format_invalid')
        self.assertEqual(results['caller-thread-two']['action'], 'publish')
        self.assertEqual([len(client.prompts) for client in clients], [1, 2])

    async def test_preflight_excludes_review_empty_and_incomplete_threads_locally(self):
        builder, clients = self.builder([[{'results': [batch_answer('t4')]}]])
        requests = [
            {'id': 'review', 'messages': [message(subject='PR - Useful review')], 'previous': {'original_text': 'Old review'}},
            {'id': 'empty', 'messages': [message('')], 'previous': {'original_text': 'Keep me'}},
            {'id': 'incomplete', 'messages': [{**message(), 'error': 'missing'}]},
            {'id': 'work', 'messages': [message()]},
        ]
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(requests)
        self.assertEqual(results['review']['action'], 'withdraw')
        self.assertEqual(results['empty']['content'], 'Keep me')
        self.assertIsInstance(results['incomplete'], OutcomeError)
        self.assertEqual(results['work']['action'], 'publish')
        self.assertEqual(len(json.loads(clients[0].prompts[0])['threads']), 1)
        self.assertEqual(builder.metrics['batch_threads'], 1)

    async def test_no_work_does_not_start_runtime(self):
        builder, clients = self.builder([])
        self.assertEqual(await builder.build_batch([]), {})
        results = await builder.build_batch([{'id': 'empty', 'messages': [message('')]}])
        self.assertEqual(results['empty']['action'], 'unchanged')
        self.assertFalse(clients)
        self.assertEqual(builder.metrics['batch_calls'], 0)

    async def test_invalid_request_identity_or_count_is_rejected_before_runtime(self):
        builder, clients = self.builder([])
        for requests in (None, [{'id': '', 'messages': [message()]}],
                         [{'id': 'same', 'messages': [message()]}, {'id': 'same', 'messages': [message()]}],
                         [{'id': str(number), 'messages': [message()]} for number in range(9)]):
            with self.subTest(requests=requests), self.assertRaisesRegex(OutcomeError, 'batch_request_invalid'):
                await builder.build_batch(requests)
        self.assertFalse(clients)

    async def test_oversized_batch_splits_complete_threads_without_truncation(self):
        builder, clients = self.builder([[{'results': [batch_answer('t1', action='unchanged', problem=None, conclusion=None)]}],
                                        [{'results': [batch_answer('t1', action='unchanged', problem=None, conclusion=None)]}]])
        requests = self.requests()
        for request in requests:
            request['messages'][0]['content'] = 'x' * 50_001
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(requests)
        self.assertTrue(all(result['action'] == 'unchanged' for result in results.values()))
        self.assertEqual(len(clients), 2)
        self.assertEqual([len(json.loads(client.prompts[0])['threads']) for client in clients], [1, 1])
        self.assertEqual([len(json.loads(client.prompts[0])['threads'][0]['messages'][0]['text']) for client in clients], [50_001, 50_001])
        self.assertEqual(len(requests[0]['messages'][0]['content']), 50_001)
        self.assertEqual(builder.metrics['batch_calls'], 2)
        self.assertEqual(builder.metrics['batch_threads'], 2)

    async def test_batch_prompt_overhead_splits_valid_threads_and_preserves_preflight_results(self):
        builder, clients = self.builder([[{'results': [batch_answer('t1')]}], [{'results': [batch_answer('t1')]}]])
        requests = self.requests()
        for request in requests:
            thread_id = request['messages'][0]['metadata']['thread_id']
            request['messages'] = [message(key='mail-one' if number == 0 else f'mail-{number:03}',
                                           thread_id=thread_id, subject='x' * 800) for number in range(100)]
        requests.append({'id': 'empty', 'messages': [message('')], 'previous': {'original_text': 'Preserved'}})
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(requests)
        self.assertTrue(all(results[identity]['action'] == 'publish' for identity in ('caller-thread-one', 'caller-thread-two')))
        self.assertEqual(results['empty']['content'], 'Preserved')
        self.assertEqual(len(clients), 2)
        self.assertEqual(builder.metrics['batch_threads'], 2)
        for client in clients:
            thread = json.loads(client.prompts[0])['threads'][0]
            self.assertEqual(len(thread['messages']), 100)
            self.assertEqual(len(thread['messages'][0]['subject']), 800)

    async def test_oversized_single_item_returns_individual_bound_error_without_model_call(self):
        builder, clients = self.builder([])
        requests = self.requests()[:1]
        requests[0]['messages'][0]['metadata']['subject'] = 'x' * 160_000
        results = await builder.build_batch(requests)
        self.assertIsInstance(results['caller-thread-one'], OutcomeError)
        self.assertEqual(str(results['caller-thread-one']), 'outcome_thread_too_large')
        self.assertFalse(clients)
        self.assertEqual(builder.metrics['batch_calls'], 0)

    async def test_model_failure_does_not_restart_every_thread(self):
        class BrokenSession(FakeSession):
            async def send_and_wait(self, *args, **kwargs):
                raise TimeoutError()
        class BrokenClient(FakeClient):
            async def create_session(self, **kwargs):
                return BrokenSession(self)
        client = BrokenClient([])
        builder = OutcomeBuilder(BuilderTests.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            results = await builder.build_batch(self.requests())
        self.assertTrue(all(isinstance(result, OutcomeError) and str(result) == 'outcome_model_failed' for result in results.values()))
        self.assertEqual(builder.metrics['runtime_start_count'], 1)
        self.assertEqual(client.cleanup, ['stop'])

    async def test_batch_cancel_closes_runtime_without_starting_fallbacks(self):
        started = asyncio.Event()
        class WaitingSession(FakeSession):
            async def send_and_wait(self, *args, **kwargs):
                started.set()
                await asyncio.Event().wait()
        class WaitingClient(FakeClient):
            async def create_session(self, **kwargs):
                return WaitingSession(self)
        client = WaitingClient([])
        builder = OutcomeBuilder(BuilderTests.profile, client_factory=lambda **kwargs: client)
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            task = asyncio.create_task(builder.build_batch(self.requests()))
            await asyncio.wait_for(started.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
        self.assertEqual(builder.metrics['runtime_start_count'], 1)
        self.assertEqual(client.cleanup, ['force_stop'])
        self.assertFalse(builder._clients)
