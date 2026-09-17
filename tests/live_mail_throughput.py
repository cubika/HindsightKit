"""Compare import concurrency using complete frozen threads; consumes model allowance.

Input is the JSON list of normalized threads accepted by live_mail.py. Source reads
are excluded. Each round uses the original profile and a disposable official bank.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import time
import uuid

from hindsightkit.cli import profile_config
from hindsightkit.connection import server_load, sdk
from hindsightkit.mail_outcome import OutcomeBuilder, prepare_messages
from hindsightkit.mail_sync import MailSync
def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()
def error_code(error):
    detail = str(error) if type(error).__name__ == 'OutcomeError' else type(error).__name__
    return detail + (f' (HTTP {error.status})' if getattr(error, 'status', None) else '')


async def run_round(client, profile, frozen, parallelism, report, save):
    bank = 'hindsightkit-throughput-test-' + uuid.uuid4().hex
    run = dict(bank=bank, parallelism=parallelism, threads=[], deleted=False, error=None)
    report['rounds'].append(run)
    save()
    pending, tasks = set(), []
    gate = asyncio.Semaphore(parallelism)
    setup_started = time.monotonic()

    async def process(index, source):
        queued = time.monotonic()
        async with gate:
            started = time.monotonic()
            messages, builder = json.loads(source), OutcomeBuilder(profile=profile)
            record = dict(index=index, document_id='thread-' + digest(source),
                          source_count=len(messages), input_sha256=digest(source),
                          action=None, status=None, error=None, queue_seconds=started - queued)
            stage, stage_started = 'build', started
            metrics = {}
            try:
                result = await builder.build(messages)
                MailSync._validate_decision(result)
                metrics['build_seconds'] = time.monotonic() - stage_started
                record.update(result=result, action=result['action'], status=result['metadata'].get('status'))
                record['content_sha256'] = digest(result['content'])
                if encoded(messages) != source:
                    raise RuntimeError('Frozen input was modified.')
                if result['action'] == 'publish':
                    operation = str(uuid.uuid4())
                    pending.add(operation)
                    stage, stage_started = 'submit', time.monotonic()
                    await client.aretain(bank_id=bank, document_id=record['document_id'],
                        content=result['content'], metadata=result['metadata'], timestamp='unset',
                        update_mode='replace', retain_async=True, operation_id=operation)
                    metrics['submit_seconds'] = time.monotonic() - stage_started
                    stage, stage_started = 'publication_wait', time.monotonic()
                    while True:
                        state = await client.operations.get_operation_status(bank_id=bank, operation_id=operation)
                        if state.status in {'completed', 'failed', 'cancelled'}:
                            pending.discard(operation)
                            if state.status != 'completed' or int((state.result_metadata or {}).get('extraction_errors_count') or 0):
                                raise RuntimeError('Publication did not complete cleanly.')
                            break
                        if time.monotonic() - stage_started >= 1800:
                            raise TimeoutError('Publication is still pending.')
                        await asyncio.sleep(2)
                    metrics['publication_wait_seconds'] = time.monotonic() - stage_started
                    stage, stage_started = 'readback', time.monotonic()
                    document = await client.documents.get_document(bank_id=bank, document_id=record['document_id'])
                    if document.memory_unit_count != 1 or document.original_text != result['content']:
                        raise RuntimeError('Published outcome failed readback.')
                    record['verified'] = True
                    metrics['readback_seconds'] = time.monotonic() - stage_started
            except asyncio.CancelledError:
                record.update(error='cancelled', error_stage=stage)
                raise
            except Exception as error:
                record.update(error=error_code(error), error_stage=stage)
                metrics.setdefault(stage + '_seconds', time.monotonic() - stage_started)
            finally:
                try:
                    await builder.close()
                except Exception as error:
                    record['cleanup_error'] = error_code(error)
                record.update(seconds=time.monotonic() - started, metrics={**metrics, **builder.metrics})
                run['threads'].append(record)
                save()
                print(encoded({key: record[key] for key in ('index', 'action', 'seconds', 'error')}), flush=True)

    try:
        await client.acreate_bank(bank_id=bank, retain_extraction_mode='chunks',
                                  retain_chunk_size=8000, enable_observations=False)
        await client.aupdate_bank_config(bank_id=bank, retain_structured_chunk_size=8000,
            enable_auto_consolidation=False, enable_graph_retrieval=False, enable_temporal_retrieval=False)
        run['setup_seconds'] = time.monotonic() - setup_started
        started = time.monotonic()
        try:
            tasks = [asyncio.create_task(process(index, source)) for index, source in enumerate(frozen)]
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done() and not task.cancelling():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            run['wall_seconds'] = time.monotonic() - started
        good = sum(not row['error'] and not row.get('cleanup_error') for row in run['threads'])
        run.update(successful_threads=good, threads_per_minute=good * 60 / run['wall_seconds'])
        run['actions'] = {action: sum(row['action'] == action for row in run['threads'])
                          for action in ('publish', 'unchanged', 'withdraw')}
        run['stage_totals'] = {key: sum(row['metrics'].get(key, 0) for row in run['threads'])
                               for key in {key for row in run['threads'] for key in row['metrics']}}
    except Exception as error:
        run['error'] = error_code(error)
    finally:
        cleanup_started = time.monotonic()
        run['cleanup_errors'] = []
        for operation in pending:
            try:
                await client.operations.cancel_operation(bank_id=bank, operation_id=operation)
            except Exception as error:
                if getattr(error, 'status', None) != 404:
                    run['cleanup_errors'].append(error_code(error))
        try:
            await client.adelete_bank(bank_id=bank)
            run['deleted'] = not (await client.banks.list_banks(q=bank, limit=100)).banks
        except Exception as error:
            run['cleanup_errors'].append(error_code(error))
        run['cleanup_seconds'] = time.monotonic() - cleanup_started
        run['threads'].sort(key=lambda row: row['index'])
        save()


async def main(args):
    threads = json.loads(Path(args.samples).read_text(encoding='utf-8-sig'))
    if not isinstance(threads, list) or not threads or any(not isinstance(row, list) for row in threads):
        raise ValueError('Provide a nonempty JSON list of complete normalized threads.')
    for messages in threads:
        prepare_messages(messages)
    frozen = [encoded(messages) for messages in threads]
    if len(set(frozen)) != len(frozen):
        raise ValueError('Duplicate input threads would reuse a document in the same round.')
    profile, _ = profile_config()
    root = Path(args.output)
    root.mkdir(parents=True, exist_ok=True)
    report = dict(source_mode='frozen_complete_threads', input_sha256=digest(encoded(threads)),
        source_reads_included=False, thread_count=len(threads), rounds=[], differences=[],
        model=profile.get('HINDSIGHT_API_LLM_MODEL'), reasoning_effort=profile.get('HINDSIGHT_API_LLM_REASONING_EFFORT'),
        wall_scope='Build through verified publication; excludes bank setup, cleanup and source reads.',
        metrics_scope='Per-thread elapsed seconds; stage totals overlap during concurrent rounds.')
    def save():
        (root / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    client = sdk(server_load(), timeout=120)
    try:
        for parallelism in args.parallelism:
            await run_round(client, profile, frozen, parallelism, report, save)
            if not report['rounds'][-1]['deleted']:
                break
        baseline = {row['index']: row for row in report['rounds'][0]['threads']}
        for run in report['rounds'][1:]:
            for row in run['threads']:
                previous = baseline.get(row['index'], {})
                changed = {key: [previous.get(key), row.get(key)] for key in ('action', 'status', 'content_sha256', 'error')
                           if previous.get(key) != row.get(key)}
                if changed:
                    report['differences'].append(dict(index=row['index'], parallelism=run['parallelism'], changes=changed))
    finally:
        save()
        await client.aclose()
    return int(len(report['rounds']) != len(args.parallelism) or any(run['error'] or not run['deleted'] or
        run['cleanup_errors'] or any(row['error'] or row.get('cleanup_error') for row in run['threads']) for run in report['rounds']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--parallelism', default='1,4', type=lambda value: [int(part) for part in value.split(',')])
    args = parser.parse_args()
    if not args.parallelism or any(value not in range(1, 5) for value in args.parallelism):
        parser.error('--parallelism must contain comma-separated values from 1 to 4.')
    raise SystemExit(asyncio.run(main(args)))
