"""Evaluate authorized private samples in a disposable official Hindsight bank.

Usage: python tests/live_mail.py --samples .runtime/mail-samples.json --output .runtime/mail-eval/run
The input is produced by WorkIQMailSource.messages. No mailbox writes occur.
"""
import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import time
import uuid

from hindsight_client import Hindsight
from hindsightkit.cli import profile_config
from hindsightkit.mail_source import normalize_message
from hindsightkit.mail_sync import RETAIN_MISSION, RETAIN_INSTRUCTIONS, OBSERVATIONS_MISSION, MailSync


async def evaluate(args):
    samples = json.loads(Path(args.samples).read_text(encoding='utf-8'))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    _, paths = profile_config()
    client = Hindsight(base_url=f'http://127.0.0.1:{paths.port}', timeout=180)
    bank = 'hindsightkit-mail-test-' + uuid.uuid4().hex[:12]
    report = {'bank': bank, 'documents': [], 'queries': [], 'deleted': False}
    started = time.monotonic()

    def save():
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        await client.acreate_bank(bank_id=bank, retain_mission=RETAIN_MISSION,
            retain_extraction_mode='custom', retain_custom_instructions=RETAIN_INSTRUCTIONS,
            observations_mission=OBSERVATIONS_MISSION)
        if args.runner:
            await client.aupdate_bank_config(bank_id=bank, enable_auto_consolidation=False,
                retain_chunk_size=4000, retain_structured_chunk_size=4000)
        items = []
        for index, original in enumerate(samples):
            if original.get('error'):
                report['documents'].append({'index': index, 'error': original['error'], 'skip_reason': 'unavailable body'})
                continue
            sample = normalize_message(original['raw'], 'evaluation-mailbox')
            meta = {str(k): str(v) for k, v in sample['metadata'].items()}
            document = {'index': index, 'subject': meta['subject'], 'source': sample['source_text'],
                        'cleaned': sample['content'], 'skip_reason': sample['skip_reason']}
            report['documents'].append(document)
            if sample['skip_reason']:
                continue
            document_id = 'sample-' + str(index)
            document['document_id'] = document_id
            stamp = meta.get('sent_at') or meta['received_at']
            items.append({'content': sample['content'], 'document_id': document_id,
                'context': 'Work email. Quoted correspondence is historical evidence with unverified authorship and date.',
                'metadata': {**meta, 'source': 'workiq-mail'}, 'tags': ['source:workiq-mail'],
                'timestamp': datetime.fromisoformat(stamp.replace('Z', '+00:00'))})
        save()
        deadline = time.monotonic() + args.timeout
        if args.runner:
            runner = MailSync(output / 'ledger', f'http://127.0.0.1:{paths.port}', bank, client=client)
            runner._put('account', {'address': 'evaluation', 'name': 'Evaluation'})
            for item in items:
                payload = json.dumps({'content': item['content'], 'metadata': item['metadata']})
                runner.db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)',
                    (item['document_id'], 'evaluation', '', 'pending', item['document_id'], payload, None, None, None))
            runner.db.commit()
            try:
                print(json.dumps({'bank':bank,'stage':'runner_started','items':len(items)}),flush=True)
                await asyncio.wait_for(runner._drain(), timeout=args.timeout)
                report['runner_status'] = runner.status()
                report['runner_clean_payloads'] = not runner.db.execute('SELECT 1 FROM messages WHERE payload IS NOT NULL').fetchone()
            finally:
                runner.client = None
                await runner.close()
            operation = None
        else:
            operation = str(uuid.uuid4())
            result = await client.aretain_batch(bank_id=bank, items=items, retain_async=True, operation_id=operation)
            report['submission'] = result.model_dump(mode='json')
            save()
            print(json.dumps({'bank': bank, 'stage': 'submitted', 'items': len(items), 'skipped': len(samples)-len(items)}), flush=True)
        while operation and time.monotonic() < deadline:
            result = await client.operations.get_operation_status(bank_id=bank, operation_id=operation)
            report['operation'] = result.model_dump(mode='json')
            save()
            if result.status == 'completed':
                if (result.result_metadata or {}).get('extraction_errors_count'):
                    raise RuntimeError('Extraction completed with errors.')
                break
            if result.status in {'failed', 'cancelled'}:
                raise RuntimeError('Extraction failed; inspect the private report.')
            if result.status == 'not_found':
                raise RuntimeError('The evaluation operation was removed.')
            await asyncio.sleep(3)
        if operation and time.monotonic() >= deadline:
            raise TimeoutError('Mail extraction exceeded the evaluation budget.')
        report['retain_seconds'] = round(time.monotonic()-started, 1)
        print(json.dumps({'stage': 'retained', 'seconds': report['retain_seconds']}), flush=True)
        facts = (await client.alist_memories(bank_id=bank, limit=1000)).model_dump(mode='json')
        report['memories'] = facts
        for doc in report['documents']:
            if 'document_id' in doc:
                try:
                    detail = await client.documents.get_document(bank_id=bank, document_id=doc['document_id'])
                    doc['memory_count'] = detail.memory_unit_count
                except Exception as exc:
                    if not args.runner or getattr(exc,'status',None) != 404:
                        raise
                    doc['memory_count'] = 0
        save()
        if args.runner:
            await client.banks.trigger_consolidation(bank_id=bank)
        # Consolidation can lag retain; wait for a stable completed operation snapshot.
        stable = 0
        while time.monotonic() < deadline and stable < 3:
            operations = (await client.operations.list_operations(bank_id=bank, type='consolidation', limit=100)).model_dump(mode='json')
            report['consolidation'] = operations
            rows = operations.get('operations', [])
            active = [o for o in rows if o.get('status') in {'pending', 'processing'}]
            failed = [o for o in rows if o.get('status') in {'failed', 'cancelled'}]
            stable = stable + 1 if not active and not failed else 0
            save()
            await asyncio.sleep(5)
        report['consolidation_checked'] = stable >= 3
        if not report['consolidation_checked']:
            raise TimeoutError('Consolidation did not finish cleanly within the evaluation budget.')
        report['memories'] = (await client.alist_memories(bank_id=bank, limit=1000)).model_dump(mode='json')
        queries = [
            'What propagation time and consistency conditions apply to SPO proxy addresses, DSAPI and ADMIN API?',
            'Does Substrate Explorer support querying a consumer tenant? Is the FindByDirectoryKeys contract confirmed?',
            'What compatibility issue was found for multivalued properties sent through value rather than values?',
            'What evidence distinguishes backend routing failures from permission problems for GetOrganizationIBSettings?',
        ]
        for query in queries:
            begin = time.monotonic()
            recall = await client.arecall(bank_id=bank, query=query, budget='mid', max_tokens=4096)
            report['queries'].append({'query': query, 'seconds': round(time.monotonic()-begin,1), 'recall': recall.model_dump(mode='json')})
            save()
        # Compare native retrieval arms on identical data before choosing defaults.
        await client.aupdate_bank_config(bank_id=bank, enable_graph_retrieval=False, enable_temporal_retrieval=False)
        report['focused_queries'] = []
        for query in queries:
            recall = await client.arecall(bank_id=bank, query=query, budget='mid', max_tokens=4096)
            report['focused_queries'].append({'query': query, 'recall': recall.model_dump(mode='json')})
            save()
        if args.runner:
            report['mail_tool_queries'] = []
            for query in queries:
                recall = await client.arecall(bank_id=bank, query=query, budget='mid', max_tokens=4096,
                    types=['world','experience','observation'], prefer_observations=True,
                    include_source_facts=True, max_source_facts_tokens=2048)
                report['mail_tool_queries'].append({'query':query,'recall':recall.model_dump(mode='json')})
                save()
        report['total_seconds'] = round(time.monotonic()-started,1)
        print(json.dumps({'stage':'review_ready','seconds':report['total_seconds'],'counts':[d.get('memory_count',0) for d in report['documents']],'consolidation_checked':report['consolidation_checked']}),flush=True)
    finally:
        try:
            # Deleting a bank alone does not interrupt model calls already running.
            operations = await client.operations.list_operations(bank_id=bank, limit=100)
            for pending in operations.operations:
                if pending.status in {'pending', 'processing'}:
                    try:
                        await client.operations.cancel_operation(bank_id=bank, operation_id=pending.id)
                    except Exception as exc:
                        if getattr(exc, 'status', None) not in {404, 409}:
                            raise
            await client.adelete_bank(bank_id=bank)
            listing = await client.banks.list_banks(q=bank, limit=100)
            report['deleted'] = not listing.banks
            if not report['deleted']:
                raise RuntimeError('Test bank deletion was not verified.')
        finally:
            save()
            await client.aclose()
        print(json.dumps({'stage':'cleanup','bank':bank,'deleted':report['deleted']}),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--timeout',type=int,default=1200)
    parser.add_argument('--runner',action='store_true',help='Use the actual durable batching and quote context pipeline.')
    asyncio.run(evaluate(parser.parse_args()))
