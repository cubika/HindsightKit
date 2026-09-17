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
        self.assertTrue(client.stopped and client.aborted and client.disconnected)
        self.assertFalse(hasattr(client,'deleted'))
        self.assertEqual(client.cleanup,['abort','disconnect','stop'])
        self.assertFalse(Path(client.config['base_directory']).exists())

    async def test_one_format_repair_same_session(self):
        clients=[]
        def factory(**kwargs):
            client=FakeClient([{'invalid':True},answer()],**kwargs);clients.append(client);return client
        with patch('hindsightkit.mail_outcome.shutil.copyfile'):
            result=await OutcomeBuilder(self.profile,client_factory=factory).build([message()])
        self.assertEqual(result['action'],'publish')
        self.assertEqual(len(clients),1)
        self.assertEqual(len(clients[0].prompts),2)

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
        self.assertTrue(clients[0].stopped and clients[0].aborted)

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
