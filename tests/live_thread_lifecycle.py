"""Verify official Hindsight thread replacement without calling a model."""
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile

from hindsightkit.mail_source import source_key, source_version
from hindsightkit.mail_sync import MailSync

from hindsightkit.connection import sdk, server_load


async def direct_lifecycle():
    client = sdk(server_load(), timeout=60)
    bank = 'hindsightkit-thread-test-' + uuid.uuid4().hex[:12]
    document = 'one-thread'
    result = {'bank': bank}
    try:
        await client.acreate_bank(bank_id=bank, retain_extraction_mode='chunks',
                                 retain_chunk_size=8000, enable_observations=False)
        await client.aupdate_bank_config(bank_id=bank, enable_auto_consolidation=False,
                                        enable_graph_retrieval=False, enable_temporal_retrieval=False)
        async def publish(text, operation=None):
            operation = operation or str(uuid.uuid4())
            await client.aretain(bank_id=bank, document_id=document, content=text,
                                update_mode='replace', retain_async=True, operation_id=operation)
            for _ in range(120):
                status = await client.operations.get_operation_status(bank_id=bank, operation_id=operation)
                if status.status == 'completed':
                    break
                if status.status in {'failed','cancelled'}:
                    raise AssertionError(status.status)
                await asyncio.sleep(.25)
            else:
                raise TimeoutError('Official operation did not finish.')
            actual = await client.documents.get_document(bank_id=bank, document_id=document)
            assert actual.original_text == text and actual.memory_unit_count == 1
            facts = await client.alist_memories(bank_id=bank,limit=100)
            assert facts.total == 1 and facts.items[0].text == text
            return operation
        old = '# Queue outcome\nProblem: requests fail.\nConclusion: initial routing hypothesis.\nStatus: unresolved.'
        new = '# Queue outcome\nProblem: requests fail.\nConclusion: queue waiting threshold caused the failure; routing hypothesis rejected.\nFix: owner validated a queue capacity increase.\nStatus: resolved.'
        await publish(old)
        operation = await publish(new)
        await publish(new, operation)
        result['replace_and_duplicate_retry_single_record'] = True
        recall = await client.arecall(bank_id=bank,query='queue failure routing',types=['world'],budget='low')
        assert all(item.text != old for item in recall.results)
        result['obsolete_recall_absent'] = True
        try:
            await client.aretain(bank_id=bank,document_id=document,content='invalid replacement',update_mode='invalid')
            raise AssertionError('Invalid replacement was accepted.')
        except ValueError:
            pass
        assert (await client.documents.get_document(bank_id=bank,document_id=document)).original_text == new
        result['rejected_update_preserves_accepted'] = True
        await client.documents.delete_document(bank_id=bank,document_id=document)
        assert (await client.alist_memories(bank_id=bank,limit=100)).total == 0
        assert not (await client.arecall(bank_id=bank,query='queue failure',types=['world'])).results
        result['withdrawal_removes_recall'] = True
    finally:
        await client.adelete_bank(bank_id=bank)
        result['test_bank_deleted'] = not (await client.banks.list_banks(q=bank,limit=100)).banks
        await client.aclose()
    return result


class SyntheticThreadSource:
    """Mailbox-shaped fixture; no WorkIQ process or email access."""
    def __init__(self):
        self.account = {'id': 'synthetic-lifecycle-account', 'mail': 'fixture@example.invalid'}
        self.messages_by_id = []
        self.thread_reads = 0
        self.base_time = datetime.now(timezone.utc) - timedelta(hours=1)
        self.add('report', 'The service failed during the initial routing investigation.')

    def add(self, identity, content):
        sent = (self.base_time + timedelta(minutes=len(self.messages_by_id))).isoformat()
        self.messages_by_id.append({'id': identity, 'internetMessageId': f'<{identity}@example.invalid>',
            'conversationId': 'one-current-thread', 'parentFolderId': 'inbox', 'subject': 'Synthetic service investigation',
            'receivedDateTime': sent, 'sentDateTime': sent, 'lastModifiedDateTime': sent, 'isDraft': False,
            'content': content})

    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def discover(self):
        return {'account': self.account, 'folders': [{'id': 'inbox', 'name': 'Inbox', 'path': 'Inbox',
                'parent_id': None, 'recommended': True}], 'unresolved': []}

    async def page(self, folder, start, end, next_link=None):
        assert folder == 'inbox'
        # One source per page exercises complete-window coalescing.
        index = int(next_link or 0)
        values = [{k: v for k, v in item.items() if k != 'content'} for item in self.messages_by_id[index:index + 1]]
        return {'messages': values, 'next_link': str(index + 1) if index + 1 < len(self.messages_by_id) else None}

    async def thread(self, conversation_id, folder_ids, before_iso):
        assert conversation_id == 'one-current-thread' and folder_ids == ['inbox']
        self.thread_reads += 1
        return [{'source_key': source_key(item, self.account['id']), 'source_version': source_version(item),
                 'content': item['content'], 'skip_reason': None, 'metadata': {'thread_id': item['conversationId'],
                     'folder_id': item['parentFolderId'], 'subject': item['subject'], 'sender': 'owner@example.invalid',
                     'sent_at': item['sentDateTime'], 'received_at': item['receivedDateTime'],
                     'source_url': 'https://outlook.office.com/mail/' + item['id']}} for item in self.messages_by_id]


class SyntheticOutcomeBuilder:
    """Deterministic composer; all publication uses the real runner and SDK."""
    old = 'Synthetic service outcome. The initial routing hypothesis is unresolved.'
    new = 'Synthetic service outcome. Queue capacity caused the failure. The owner verified the capacity fix; the routing hypothesis was rejected.'

    def __init__(self):
        self.calls = 0

    async def build(self, messages, previous=None):
        self.calls += 1
        latest = messages[-1]
        if latest['content'] == 'The entire outcome was refuted and withdrawn.':
            return {'action': 'withdraw', 'content': '', 'metadata': {}, 'reason': 'Explicit synthetic refutation.'}
        content = self.new if len(messages) > 1 else self.old
        if previous and previous['original_text'] == content:
            return {'action': 'unchanged', 'content': content, 'metadata': previous.get('document_metadata') or {},
                    'reason': 'Synthetic outcome unchanged.'}
        return {'action': 'publish', 'content': content, 'metadata': {'kind': 'thread-outcome',
                'status': 'resolved' if len(messages) > 1 else 'unresolved', 'source_ids': json.dumps([latest['source_key']]),
                'source_url': latest['metadata']['source_url'], 'last_supported_utc': latest['metadata']['sent_at']},
                'reason': 'Synthetic evidence is sufficient.'}

    async def close(self): pass


async def runner_lifecycle():
    config = server_load()
    client = sdk(config, timeout=60)
    bank = 'hindsightkit-runner-test-' + uuid.uuid4().hex[:12]
    source, builder = SyntheticThreadSource(), SyntheticOutcomeBuilder()
    result = {'bank': bank}
    runner = None
    try:
        with tempfile.TemporaryDirectory(prefix='hindsightkit-thread-ledger-') as directory:
            runner = MailSync(Path(directory), config['apiUrl'], bank=bank, source=source, client=client, builder=builder)
            runner.poll_seconds = .25
            await runner.discover()
            await runner.configure({'interval_minutes': 0, 'prefilter_enabled': False})

            async def run():
                await runner.sync()
                await asyncio.wait_for(runner._task, 120)
                status = runner.status()
                assert status['run']['state'] == 'idle', status['run']['error']
                assert status['run']['pending'] == 0
                return status['run']

            first = await run()
            documents = await client.documents.list_documents(bank_id=bank, limit=100)
            assert len(documents.items) == 1 and first['outcomes'] == first['imported'] == 1
            document = documents.items[0].id
            assert document.startswith('workiq-thread-')
            assert (await client.documents.get_document(bank_id=bank, document_id=document)).original_text == builder.old
            result['runner_initial_single_outcome'] = True

            source.add('diagnosis', 'Queue capacity caused the failure; routing was not the cause.')
            source.add('verification', 'The owner increased queue capacity and verified that the service recovered.')
            changed = await run()
            documents = await client.documents.list_documents(bank_id=bank, limit=100)
            assert [item.id for item in documents.items] == [document]
            actual = await client.documents.get_document(bank_id=bank, document_id=document)
            assert actual.original_text == builder.new and actual.memory_unit_count == 1
            assert changed['updated'] == changed['outcomes'] == 1 and changed['scanned'] == 3
            assert builder.calls == source.thread_reads == 2
            memories = await client.alist_memories(bank_id=bank, limit=100)
            assert memories.total == 1 and memories.items[0].text == builder.new
            recall = await client.arecall(bank_id=bank, query='synthetic service routing failure', types=['world'], budget='low')
            assert all(item.text != builder.old for item in recall.results)
            result['runner_cross_page_update_one_current_record'] = True
            result['runner_old_outcome_absent_from_recall'] = True

            builds, reads = builder.calls, source.thread_reads
            repeated = await run()
            assert builder.calls == builds and source.thread_reads == reads
            assert repeated['imported'] == repeated['updated'] == 0
            assert (await client.alist_memories(bank_id=bank, limit=100)).total == 1
            result['runner_unchanged_skips_source_and_composer'] = True

            source.add('withdrawal', 'The entire outcome was refuted and withdrawn.')
            withdrawn = await run()
            assert withdrawn['withdrawn'] == 1 and withdrawn['outcomes'] == 0
            assert not (await client.documents.list_documents(bank_id=bank, limit=100)).items
            assert (await client.alist_memories(bank_id=bank, limit=100)).total == 0
            assert not (await client.arecall(bank_id=bank, query='synthetic service queue routing', types=['world'], budget='low')).results
            result['runner_withdrawal_removes_document_and_recall'] = True
            assert not runner.db.execute('SELECT 1 FROM threads WHERE payload IS NOT NULL').fetchone()
            result['runner_pending_payloads_cleared'] = True
            await runner.close()
            runner = None
    finally:
        if runner is not None:
            await runner.close()
        cleanup = sdk(config, timeout=60)
        try:
            await cleanup.adelete_bank(bank_id=bank)
            result['test_bank_deleted'] = not (await cleanup.banks.list_banks(q=bank, limit=100)).banks
        finally:
            await cleanup.aclose()
    return result


async def main():
    result = {'direct_sdk': await direct_lifecycle(), 'runner': await runner_lifecycle()}
    print(json.dumps(result))


if __name__ == '__main__':
    asyncio.run(main())
