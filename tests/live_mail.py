"""Evaluate current thread outcomes with real sources and an official temporary bank.

Pass a JSON list of complete normalized threads from WorkIQMailSource.thread.
Use --keep-bank only when the user requests retained demonstration data.
"""
import argparse
import asyncio
import json
from pathlib import Path
import time
import uuid

from hindsightkit.connection import server_load, sdk
from hindsightkit.connectors.workiq.outcome import OutcomeBuilder


async def main(args):
    threads = json.loads(Path(args.samples).read_text(encoding='utf-8'))
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    bank = args.keep_bank or 'hindsightkit-thread-test-' + uuid.uuid4().hex[:12]
    client = sdk(server_load(), timeout=90)
    builder = OutcomeBuilder()
    report = {'bank': bank, 'threads': [], 'deleted': False}
    def save():
        (root / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    async def publish(document, result):
        operation = str(uuid.uuid4())
        await client.aretain(bank_id=bank, document_id=document, content=result['content'],
            metadata=result['metadata'], update_mode='replace', retain_async=True, operation_id=operation)
        for _ in range(240):
            state = await client.operations.get_operation_status(bank_id=bank, operation_id=operation)
            if state.status == 'completed': break
            if state.status in {'failed','cancelled'}: raise RuntimeError('Publication failed.')
            await asyncio.sleep(.25)
        else: raise TimeoutError('Publication did not complete.')
        doc = await client.documents.get_document(bank_id=bank, document_id=document)
        assert doc.memory_unit_count == 1 and doc.original_text == result['content']
    try:
        await client.acreate_bank(bank_id=bank, retain_extraction_mode='chunks', retain_chunk_size=8000, enable_observations=False)
        await client.aupdate_bank_config(bank_id=bank, enable_auto_consolidation=False,
                                        enable_graph_retrieval=False, enable_temporal_retrieval=False)
        for index, messages in enumerate(threads):
            begin = time.monotonic()
            result = await builder.build(messages)
            document = 'thread-' + str(index)
            record = {'index': index, 'source_count': len(messages), 'result': result, 'seconds': round(time.monotonic()-begin,1)}
            report['threads'].append(record)
            if result['action'] == 'publish':
                await publish(document, result)
                previous = (await client.documents.get_document(bank_id=bank,document_id=document)).model_dump(mode='json')
                repeat = await builder.build(messages, previous)
                record['repeat_action'] = repeat['action']
                assert repeat['action'] == 'unchanged'
            save()
            print(json.dumps({'thread':index,'action':result['action'],'seconds':record['seconds']}),flush=True)
        report['documents'] = (await client.documents.list_documents(bank_id=bank,limit=100)).model_dump(mode='json')
        report['memories'] = (await client.alist_memories(bank_id=bank,limit=100)).model_dump(mode='json')
        save()
    finally:
        await builder.close()
        if not args.keep_bank:
            operations = await client.operations.list_operations(bank_id=bank,limit=100)
            for operation in operations.operations:
                if operation.status in {'pending','processing'}:
                    await client.operations.cancel_operation(bank_id=bank,operation_id=operation.id)
            await client.adelete_bank(bank_id=bank)
            report['deleted'] = not (await client.banks.list_banks(q=bank,limit=100)).banks
        save()
        await client.aclose()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--keep-bank')
    asyncio.run(main(parser.parse_args()))
