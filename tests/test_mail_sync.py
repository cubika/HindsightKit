import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from hindsightkit.mail_sync import MailSync
from hindsightkit.mail_source import WorkIQError, source_key, source_version


class Missing(Exception):
    status = 404


def mail(identity, thread='discussion', text='Initial finding', sent='2026-09-16T03:00:00Z', folder='inbox'):
    return dict(id=identity, internetMessageId=f'<{identity}@example.invalid>', conversationId=thread,
                parentFolderId=folder, lastModifiedDateTime=sent, receivedDateTime=sent,
                sentDateTime=sent, subject='Same subject', isDraft=False, text=text)


class Source:
    def __init__(self):
        self.identity = dict(id='account-a', mail='a@example.invalid')
        self.folders = [dict(id='inbox', name='Inbox', path='Inbox', recommended=True),
                        dict(id='other', name='Other', path='Other'),
                        dict(id='excluded', name='Sev3', path='DSAPISOT/Sev3', excluded=True)]
        self.items = [mail('one')]
        self.page_size = 2
        self.reads, self.thread_reads = [], []
        self.error_threads = set()
        self.fail_page = None
        self.closed = 0
        self.gate = None

    async def __aenter__(self): return self
    async def __aexit__(self, *args): self.closed += 1
    async def discover(self): return dict(account=self.identity, folders=self.folders, unresolved=[])

    async def page(self, folder, start, end, next_link=None):
        self.reads.append((folder, start, end, next_link))
        if next_link == self.fail_page and next_link is not None:
            raise ConnectionError('Private content must not be printed')
        items = [m for m in self.items if m['parentFolderId'] == folder]
        offset = int(next_link or 0)
        page = [{k: v for k, v in m.items() if k != 'text'} for m in items[offset:offset + self.page_size]]
        next_page = str(offset + self.page_size) if offset + self.page_size < len(items) else None
        return dict(messages=page, next_link=next_page)

    def normalize(self, value):
        meta = dict(thread_id=value['conversationId'], folder_id=value['parentFolderId'], subject=value['subject'],
                    sent_at=value['sentDateTime'], received_at=value['receivedDateTime'], sender='author@example.invalid',
                    source_url='https://outlook.office.com/mail/' + value['id'])
        return dict(source_key=source_key(value, self.identity['id']), source_version=source_version(value),
                    content=value['text'], metadata=meta, skip_reason=None, source_text=value['text'], raw=value)

    async def thread(self, conversation_id, folder_ids, before_iso):
        self.thread_reads.append((conversation_id, list(folder_ids), before_iso))
        if self.gate: await self.gate.wait()
        if conversation_id in self.error_threads: raise ValueError('Incomplete protected thread')
        return [self.normalize(m) for m in reversed(self.items) if m['conversationId'] == conversation_id and m['parentFolderId'] in folder_ids]

    async def messages(self, metadata):
        ids = {m['id'] for m in metadata}
        return [self.normalize(m) for m in self.items if m['id'] in ids]


class Builder:
    def __init__(self):
        self.calls = []
        self.closed = 0
        self.invalid = False
        self.fail = False

    async def build(self, messages, previous=None):
        self.calls.append((deepcopy(messages), deepcopy(previous)))
        if self.fail: raise RuntimeError('Model unavailable')
        if self.invalid: return dict(action='publish', content='x' * 6001, metadata={}, reason='Too long')
        substantive = [m for m in messages if m['content'] not in {'Thanks', 'PR-local'}]
        latest = substantive[-1] if substantive else None
        if latest is None or (previous and previous['original_text'] == latest['content']):
            return dict(action='unchanged', content='', metadata={}, reason='No new work outcome')
        if latest['content'] == 'Withdraw':
            return dict(action='withdraw', content='', metadata={}, reason='Explicit refutation')
        return dict(action='publish', content=latest['content'], reason='Supported service finding',
                    metadata=dict(status='resolved' if 'Verified' in latest['content'] else 'unresolved',
                                  source_ids=json.dumps([latest['source_key']]), last_supported_utc=latest['metadata']['sent_at']))

    async def close(self): self.closed += 1


class Client:
    def __init__(self):
        self.documents = self.operations = self
        self.docs, self.jobs, self.targets = {}, {}, {}
        self.submissions, self.deleted, self.retries = [], [], []
        self.config = None
        self.mode = 'completed'
        self.response_loss = False
        self.delete_loss = False
        self.unit_count = 1
        self.closed = 0

    async def acreate_bank(self, **kwargs): pass
    async def list_documents(self, **kwargs): return {'items': list(self.docs.values())}
    async def aupdate_bank_config(self, **kwargs): self.config = kwargs
    async def aclose(self): self.closed += 1

    def complete(self, operation):
        request = self.targets[operation]
        self.jobs[operation]['status'] = 'completed'
        self.docs[request['document_id']] = dict(original_text=request['content'], document_metadata=request['metadata'], memory_unit_count=self.unit_count, tags=request.get('tags', []))

    async def aretain(self, **kwargs):
        self.submissions.append(deepcopy(kwargs))
        operation = kwargs['operation_id']
        self.targets[operation] = kwargs
        self.jobs[operation] = dict(status=self.mode, result_metadata=dict(extraction_errors_count=0))
        if self.mode == 'completed': self.complete(operation)
        if self.response_loss:
            self.response_loss = False
            raise ConnectionError('Lost accepted response')
        return dict(operation_id=operation)

    async def get_operation_status(self, bank_id, operation_id):
        if operation_id not in self.jobs: raise Missing()
        return self.jobs[operation_id]

    async def retry_operation(self, bank_id, operation_id):
        self.retries.append(operation_id)
        self.complete(operation_id)

    async def get_document(self, bank_id, document_id):
        if document_id not in self.docs: raise Missing()
        return deepcopy(self.docs[document_id])

    async def update_document(self, bank_id, document_id, update_document_request):
        self.docs[document_id]['tags'] = list(update_document_request.tags)

    async def delete_document(self, bank_id, document_id):
        self.deleted.append(document_id)
        if document_id not in self.docs: raise Missing()
        del self.docs[document_id]
        if self.delete_loss:
            self.delete_loss = False
            raise ConnectionError('Lost delete response')


class MailSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.source, self.client, self.builder = Source(), Client(), Builder()
        self.sync = self.runner()
        await self.sync.discover()
        await self.sync.configure({'interval_minutes': 0})

    def runner(self):
        runner = MailSync(Path(self.temp.name), 'http://127.0.0.1:9', source=self.source, client=self.client, builder=self.builder)
        runner.poll_seconds = .001
        return runner

    async def asyncTearDown(self):
        await self.sync.close()
        self.temp.cleanup()

    async def run_sync(self):
        await self.sync.sync()
        await asyncio.wait_for(self.sync._task, 4)
        return self.sync.status()

    async def restart(self):
        await self.sync.close()
        self.sync = self.runner()

    def append(self, name, content, thread='discussion', sent=None):
        value = mail(name, thread, content, sent or f'2026-09-16T{len(self.source.items) + 4:02}:00:00Z')
        self.source.items.append(value)

    async def test_full_scan_coalesces_cross_page_thread_into_one_outcome(self):
        self.append('two', 'Diagnosis')
        self.append('three', 'Verified fix')
        result = await self.run_sync()
        self.assertEqual(result['run']['scanned'], 3)
        self.assertEqual(result['run']['imported'], 1)
        self.assertEqual(result['run']['outcomes'], 1)
        self.assertEqual(len(self.source.reads), 2)
        self.assertEqual(len(self.source.thread_reads), 1)
        self.assertEqual(len(self.builder.calls), 1)
        self.assertEqual([m['content'] for m in self.builder.calls[0][0]], ['Initial finding', 'Diagnosis', 'Verified fix'])
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Verified fix')
        self.assertEqual(self.client.config['retain_extraction_mode'], 'chunks')
        self.assertFalse(self.client.config['enable_observations'])
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM threads WHERE payload IS NOT NULL').fetchone())
        self.assertNotIn('Verified fix', self.sync.db.execute('SELECT metadata FROM sources WHERE id=?', (source_key(self.source.items[-1], 'account-a'),)).fetchone()[0])

    async def test_corrections_and_fix_replace_same_document_without_growth(self):
        await self.run_sync()
        document = next(iter(self.client.docs))
        for name, content in [('two', 'Corrected diagnosis'), ('three', 'Verified fixed by owner')]:
            self.append(name, content)
            result = await self.run_sync()
            self.assertEqual(list(self.client.docs), [document])
            self.assertEqual(self.client.docs[document]['original_text'], content)
            self.assertEqual(result['run']['updated'], 1)
            self.assertEqual(result['run']['outcomes'], 1)
        self.assertEqual(self.builder.calls[-1][1]['original_text'], 'Corrected diagnosis')
        self.assertTrue(all(call['update_mode'] == 'replace' for call in self.client.submissions))

    async def test_unchanged_versions_skip_thread_read_and_model_and_courtesy_does_not_publish(self):
        await self.run_sync()
        await self.run_sync()
        self.assertEqual(len(self.builder.calls), 1)
        self.assertEqual(len(self.source.thread_reads), 1)
        self.append('courtesy', 'Thanks')
        result = await self.run_sync()
        self.assertEqual(len(self.client.submissions), 1)
        self.assertEqual(result['run']['skipped'], 1)
        self.assertEqual(result['run']['outcomes'], 1)

    async def test_changed_transport_version_with_identical_content_skips_model(self):
        await self.run_sync()
        self.source.items[0]['lastModifiedDateTime'] = '2026-09-17T03:00:00Z'
        await self.run_sync()
        self.assertEqual(len(self.builder.calls), 1)
        self.assertEqual(len(self.source.thread_reads), 2)
        self.assertEqual(len(self.client.submissions), 1)

    async def test_same_message_revision_replaces_current_outcome(self):
        await self.run_sync()
        self.source.items[0].update(text='Corrected source', lastModifiedDateTime='2026-09-17T03:00:00Z')
        result = await self.run_sync()
        self.assertEqual(result['run']['updated'], 1)
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Corrected source')

    async def test_out_of_order_older_evidence_cannot_revert_latest_fix(self):
        self.append('fix', 'Verified fix')
        await self.run_sync()
        self.append('late', 'Older guess', sent='2026-09-15T00:00:00Z')
        await self.run_sync()
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Verified fix')
        self.assertEqual(len(self.client.submissions), 1)

    async def test_withdraw_deletes_current_document_and_retries_lost_response(self):
        await self.run_sync()
        self.append('refute', 'Withdraw')
        self.client.delete_loss = True
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertFalse(self.client.docs)
        await self.restart()
        result = await self.run_sync()
        self.assertFalse(self.client.docs)
        self.assertEqual(result['run']['outcomes'], 0)
        self.assertEqual(result['run']['withdrawn'], 1)

    async def test_repository_only_thread_creates_no_memory(self):
        self.source.items[0]['text'] = 'PR-local'
        result = await self.run_sync()
        self.assertEqual(result['run']['skipped'], 1)
        self.assertFalse(self.client.docs)

    async def test_failed_update_preserves_accepted_result_and_other_threads_continue(self):
        await self.run_sync()
        self.append('new', 'New diagnosis')
        self.append('other', 'Independent result', thread='another')
        self.source.error_threads.add('discussion')
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(result['run']['imported'], 1)
        self.assertEqual(len(self.client.docs), 2)
        self.assertIn('Initial finding', [d['original_text'] for d in self.client.docs.values()])
        self.source.error_threads.clear()
        result = await self.run_sync()
        self.assertEqual(result['run']['updated'], 1)
        self.assertIn('New diagnosis', [d['original_text'] for d in self.client.docs.values()])

    async def test_failed_official_operation_preserves_old_and_reuses_prepared_result(self):
        await self.run_sync()
        self.append('new', 'Updated result')
        self.client.mode = 'failed'
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Initial finding')
        builds = len(self.builder.calls)
        await self.restart()
        self.client.mode = 'completed'
        result = await self.run_sync()
        self.assertEqual(result['run']['updated'], 1)
        self.assertEqual(len(self.builder.calls), builds)
        self.assertEqual(len(self.client.retries), 1)

    async def test_response_loss_after_publication_recovers_uuid_without_second_model(self):
        self.client.response_loss = True
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        operation = self.client.submissions[0]['operation_id']
        await self.restart()
        result = await self.run_sync()
        self.assertEqual(result['run']['outcomes'], 1)
        self.assertEqual(len(self.client.submissions), 1)
        self.assertEqual(len(self.builder.calls), 1)
        self.assertIn(operation, self.client.jobs)

    async def test_restart_checkpoint_does_not_compose_partial_scan(self):
        self.append('two', 'Diagnosis')
        self.append('three', 'Verified fix')
        self.source.fail_page = '2'
        result = await self.run_sync()
        self.assertEqual(result['run']['state'], 'error')
        self.assertFalse(self.builder.calls)
        self.assertNotIn('Private', result['run']['error'])
        last = self.source.reads[-1]
        self.source.fail_page = None
        await self.restart()
        await self.run_sync()
        self.assertEqual(self.source.reads[-1], last)
        self.assertEqual(len(self.builder.calls), 1)

    async def test_paused_pending_revision_finishes_before_newer_revision(self):
        self.client.mode = 'processing'
        await self.sync.start()
        for _ in range(100):
            if self.client.submissions: break
            await asyncio.sleep(.001)
        await self.sync.pause()
        self.assertEqual(self.sync.status()['run']['pending'], 1)
        old = self.client.submissions[0]['operation_id']
        self.append('new', 'Verified newer fix')
        self.client.complete(old)
        self.client.mode = 'completed'
        await self.restart()
        await self.run_sync()
        self.assertEqual(len(self.client.docs), 1)
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Verified newer fix')
        revisions = [int(call['metadata']['revision']) for call in self.client.submissions]
        self.assertEqual(revisions, sorted(revisions))

    async def test_invalid_composer_output_preserves_previous_result(self):
        await self.run_sync()
        self.append('new', 'Correction')
        self.builder.invalid = True
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(len(self.client.submissions), 1)
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Initial finding')

    async def test_missing_thread_id_does_not_group_by_subject(self):
        self.source.items[0]['conversationId'] = ''
        self.append('other', 'Actual thread', thread='another')
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(result['run']['outcomes'], 1)
        self.assertEqual(self.source.thread_reads[0][0], 'another')

    async def test_bad_identity_isolated_across_pages_and_retried_without_partial_outcome(self):
        self.source.items[0]['internetMessageId'] = '<truncated@example.invalid'
        self.append('other', 'Independent result', thread='another')
        self.append('related', 'Partial related result')
        self.append('only-bad', 'Unavailable isolated result', thread='isolated')
        self.source.items[-1]['internetMessageId'] = ''
        self.append('last', 'Last page result', thread='last')
        result = await self.run_sync()
        self.assertEqual(result['run']['scanned'], 5)
        self.assertEqual(result['run']['imported'], 2)
        self.assertEqual(result['run']['failed'], 2)
        self.assertEqual(result['run']['pending'], 2)
        self.assertEqual({row[0] for row in self.source.thread_reads}, {'another', 'last'})
        errors = self.sync.db.execute('SELECT * FROM discovery_errors').fetchall()
        self.assertEqual(len(errors), 2)
        self.assertTrue(all(row['id'].startswith('workiq-discovery-') and row['thread'] for row in errors))
        self.assertFalse(self.sync.db.execute("SELECT 1 FROM sources WHERE id LIKE 'workiq-discovery-%'").fetchone())
        self.assertTrue(all('workiq_thread_identity_incomplete' in failure['reason'] or 'workiq_message_identity_missing' in failure['reason'] for failure in result['failures']))
        self.source.reads.clear()
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 2)
        self.assertEqual(len(self.builder.calls), 2)
        self.assertEqual(self.source.reads[0][1], self.sync._get('history_start'))
        self.source.items[0]['internetMessageId'] = '<one@example.invalid>'
        self.source.items[3]['internetMessageId'] = '<only-bad@example.invalid>'
        self.source.reads.clear()
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 0)
        self.assertEqual(result['run']['pending'], 0)
        self.assertEqual(result['run']['outcomes'], 4)
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM discovery_errors').fetchone())
        self.assertEqual(self.source.reads[0][1], self.sync._get('history_start'))
        self.assertEqual(len(self.builder.calls), 4)

    async def test_bad_identity_preserves_accepted_result_and_counts_one_thread(self):
        await self.run_sync()
        accepted = deepcopy(self.client.docs)
        for identity in ('bad-one', 'bad-two'):
            self.append(identity, 'Unverified correction')
            self.source.items[-1]['internetMessageId'] = ''
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(result['run']['pending'], 1)
        self.assertEqual(self.client.docs, accepted)
        self.assertEqual(len(self.builder.calls), 1)
        self.assertEqual(self.sync.db.execute('SELECT COUNT(*) FROM discovery_errors').fetchone()[0], 2)

    async def test_discovery_holds_prepared_operation_until_identity_recovers(self):
        await self.run_sync()
        self.append('new', 'New accepted finding')
        self.client.response_loss = True
        await self.run_sync()
        held = self.sync.db.execute('SELECT operation_id,payload FROM threads').fetchone()
        self.assertIsNotNone(held['payload'])
        self.append('bad', 'Newest verified finding')
        self.source.items[-1]['internetMessageId'] = ''
        deliveries = []
        deliver = self.sync._deliver
        async def observe(identity):
            deliveries.append(bool(self.sync.db.execute('SELECT 1 FROM discovery_errors WHERE thread=?', (identity,)).fetchone()))
            await deliver(identity)
        self.sync._deliver = observe
        result = await self.run_sync()
        current = self.sync.db.execute('SELECT operation_id,payload FROM threads').fetchone()
        self.assertEqual(current['operation_id'], held['operation_id'])
        self.assertEqual(current['payload'], held['payload'])
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(deliveries, [True])
        self.assertEqual(len(self.client.submissions), 2)
        self.assertEqual(len(self.builder.calls), 2)
        self.source.items[-1]['internetMessageId'] = '<bad@example.invalid>'
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 0)
        self.assertEqual(result['run']['pending'], 0)
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM discovery_errors').fetchone())
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Newest verified finding')

    async def test_unidentified_discovery_error_recovers_without_duplicate_error(self):
        self.source.items[0].update(internetMessageId='', conversationId='')
        self.append('other', 'Independent result', thread='another')
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(result['run']['imported'], 1)
        self.source.items[0]['internetMessageId'] = '<one@example.invalid>'
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(self.sync.db.execute('SELECT COUNT(*) FROM discovery_errors').fetchone()[0], 1)
        self.source.items[0]['conversationId'] = 'recovered'
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 0)
        self.assertEqual(result['run']['outcomes'], 2)
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM discovery_errors').fetchone())

    async def test_existing_discovery_error_schema_migrates_and_clears_on_recovery(self):
        await self.sync.close()
        db = sqlite3.connect(Path(self.temp.name) / 'sync.sqlite3')
        try:
            with db:
                db.execute('DROP TABLE discovery_errors')
                db.execute('CREATE TABLE discovery_errors(id TEXT PRIMARY KEY,folder TEXT,error TEXT)')
                db.execute('INSERT INTO discovery_errors VALUES (?,?,?)',
                           (source_key(self.source.items[0], 'account-a'), 'inbox', 'Missing conversation ID'))
        finally:
            db.close()
        self.sync = self.runner()
        self.assertIn('thread', {row['name'] for row in self.sync.db.execute('PRAGMA table_info(discovery_errors)')})
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 0)
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM discovery_errors').fetchone())

    async def test_same_subject_different_conversation_ids_are_separate(self):
        self.append('other', 'Independent result', thread='another')
        result = await self.run_sync()
        self.assertEqual(result['run']['outcomes'], 2)

    async def test_preview_has_no_outcome_or_source_ledger_writes(self):
        result = await self.sync.preview()
        self.assertEqual(result['items'][0]['source'], 'Initial finding')
        self.assertFalse(self.builder.calls)
        self.assertFalse(self.client.submissions)
        self.assertEqual(self.sync.db.execute('SELECT COUNT(*) FROM sources').fetchone()[0], 0)

    async def test_account_change_pauses_without_read_or_submit(self):
        self.source.identity = dict(id='account-b', mail='b@example.invalid')
        await self.sync.start()
        await self.sync._task
        self.assertFalse(self.sync.status()['config']['enabled'])
        self.assertEqual(self.sync.status()['run']['state'], 'paused')
        self.assertFalse(self.source.reads)
        self.assertFalse(self.client.submissions)

    async def test_invalid_or_identical_configuration_does_not_cancel_run(self):
        self.source.gate = asyncio.Event()
        await self.sync.start()
        for _ in range(100):
            if self.source.thread_reads: break
            await asyncio.sleep(.001)
        task = self.sync._task
        await self.sync.configure(self.sync.status()['config'])
        with self.assertRaises(ValueError): await self.sync.configure({'lookback_days': -1})
        self.assertFalse(task.done())
        await self.sync.pause()

    async def test_disabled_scope_does_not_retry_unread_thread(self):
        self.source.error_threads.add('discussion')
        await self.run_sync()
        await self.sync.configure({'folder_ids': ['other']})
        self.source.thread_reads.clear()
        result = await self.run_sync()
        self.assertFalse(self.source.thread_reads)
        self.assertEqual(result['run']['failed'], 0)
        self.assertEqual(result['run']['state'], 'idle')

    async def test_single_record_check_rejects_multiple_engine_units(self):
        self.client.unit_count = 2
        result = await self.run_sync()
        self.assertEqual(result['run']['failed'], 1)
        self.assertEqual(result['run']['outcomes'], 0)
        self.assertEqual(result['run']['pending'], 1)

    async def test_enabled_boot_resumes_but_manual_mode_has_no_next_run(self):
        await self.sync.configure({'enabled': True})
        await self.restart()
        await self.sync.boot()
        await self.sync._task
        self.assertEqual(self.sync.status()['run']['outcomes'], 1)
        self.assertIsNone(self.sync.status()['run']['next_run'])

    async def test_single_writer_lock_prevents_duplicate_runner(self):
        from filelock import Timeout
        with self.assertRaises(Timeout):
            MailSync(Path(self.temp.name), 'unused')
        await self.restart()
        await self.run_sync()
        self.assertEqual(self.sync.status()['run']['outcomes'], 1)

    async def test_update_refreshes_managed_labels_and_preserves_user_tags(self):
        await self.run_sync()
        document=next(iter(self.client.docs))
        self.client.docs[document]['tags'].append('user:important')
        self.append('verified', 'Verified service fix')
        await self.run_sync()
        tags=self.client.docs[document]['tags']
        self.assertIn('status:resolved',tags)
        self.assertNotIn('status:unresolved',tags)
        self.assertIn('user:important',tags)
        self.assertEqual(len(self.client.docs),1)

    async def test_retry_preserves_tags_added_after_a_failed_update(self):
        await self.run_sync()
        document=next(iter(self.client.docs))
        self.append('verified','Verified fix')
        self.client.mode='failed'
        await self.run_sync()
        self.client.docs[document]['tags'].append('user:added-during-retry')
        self.client.mode='completed'
        await self.run_sync()
        self.assertIn('user:added-during-retry',self.client.docs[document]['tags'])
        self.assertEqual(len(self.client.docs),1)

    async def test_new_ledger_refuses_nonempty_bank_without_mutating_documents(self):
        self.client.docs['old-message'] = dict(original_text='Existing memory', memory_unit_count=1)
        result = await self.run_sync()
        self.assertEqual(result['run']['state'], 'error')
        self.assertFalse(self.source.reads)
        self.assertFalse(self.client.submissions)
        self.assertIn('old-message', self.client.docs)

    async def test_drafts_never_create_dirty_threads_or_model_calls(self):
        self.source.items[0]['isDraft'] = True
        self.source.items[0]['internetMessageId'] = None
        result = await self.run_sync()
        self.assertEqual(result['run']['scanned'], 1)
        self.assertEqual(result['run']['outcomes'], 0)
        self.assertFalse(self.builder.calls)
        self.assertFalse(self.source.thread_reads)
        self.assertFalse(self.sync.db.execute('SELECT 1 FROM discovery_errors').fetchone())

    async def test_auth_failure_disables_schedule_and_preserves_existing_outcome(self):
        await self.run_sync()
        self.append('new', 'Correction')
        class Unauthorized(Exception):
            status = 401
        async def denied(*args, **kwargs): raise Unauthorized()
        self.source.thread = denied
        await self.sync.start()
        await self.sync._task
        self.assertFalse(self.sync.status()['config']['enabled'])
        self.assertEqual(next(iter(self.client.docs.values()))['original_text'], 'Initial finding')

    async def test_source_capacity_failure_preserves_page_checkpoint(self):
        self.append('two', 'Other', thread='another')
        with patch('hindsightkit.mail_sync.MAX_SOURCES', 1):
            result = await self.run_sync()
        self.assertEqual(result['run']['state'], 'error')
        self.assertEqual(self.sync.db.execute('SELECT COUNT(*) FROM sources').fetchone()[0], 0)
        self.assertEqual(self.sync._get('window')['index'], 0)
        result = await self.run_sync()
        self.assertEqual(result['run']['outcomes'], 2)

    async def test_cancelled_official_operation_gets_new_uuid_same_document(self):
        self.client.mode = 'cancelled'
        await self.run_sync()
        first = self.client.submissions[0]
        self.client.mode = 'completed'
        result = await self.run_sync()
        second = self.client.submissions[1]
        self.assertNotEqual(first['operation_id'], second['operation_id'])
        self.assertEqual(first['document_id'], second['document_id'])
        self.assertEqual(result['run']['outcomes'], 1)
        self.assertEqual(len(self.builder.calls), 1)

    async def test_stale_accepted_revision_is_never_replaced(self):
        self.client.response_loss = True
        await self.run_sync()
        identity = self.sync.db.execute('SELECT id FROM threads').fetchone()[0]
        with self.sync.db:
            self.sync.db.execute('UPDATE threads SET applied_revision=999 WHERE id=?', (identity,))
        with self.assertRaisesRegex(ValueError, 'stale'):
            await self.sync._deliver(identity)
        self.assertEqual(len(self.client.submissions), 1)
    async def test_nonempty_legacy_ledger_is_refused_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'sync.sqlite3'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE messages(id TEXT)')
            db.execute("INSERT INTO messages VALUES ('existing')")
            db.commit(); db.close()
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'legacy'):
                MailSync(Path(temp), 'unused')
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
