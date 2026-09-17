"""Publish one replaceable thread outcome through the official Hindsight SDK."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from pathlib import Path
import sqlite3
import time
import uuid

from filelock import FileLock

MAIL_BANK = 'hindsightkit-mail'
PAGE_SIZE = 25
MAX_OUTCOME = 6000
MAX_METADATA = 16000
MAX_PREPARED = 16
MAX_SOURCES = 100000
MAX_THREADS = 10000
OVERLAP = timedelta(hours=6)
IMPORT_DEFAULTS = dict(model='', reasoning_effort='', parallel_threads=4)


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    return value.isoformat().replace('+00:00', 'Z')


def _date(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _dict(value):
    return value if isinstance(value, dict) else value.model_dump(mode='json')


class IdentityChanged(RuntimeError):
    pass


class MailSync:
    def __init__(self, data_dir: Path, api_url: str, bank: str = MAIL_BANK, *, source=None, client=None, builder=None):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._writer = FileLock(self.data_dir / 'writer.lock', timeout=0)
        self._writer.acquire()
        self.db = sqlite3.connect(self.data_dir / 'sync.sqlite3')
        self.db.row_factory = sqlite3.Row
        tables = {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in ('messages', 'jobs', 'evidence', 'receipts'):
            if table in tables and self.db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]:
                self.db.close()
                self._writer.release()
                raise ValueError('This ledger contains legacy message imports. Use an empty thread-outcome ledger.')
        for table in ('messages', 'jobs', 'evidence', 'receipts'):
            if table in tables:
                self.db.execute('DROP TABLE ' + table)
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY, version TEXT NOT NULL, thread TEXT NOT NULL,
                folder TEXT NOT NULL, metadata TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, subject TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0, applied_revision INTEGER NOT NULL DEFAULT 0,
                input_hash TEXT, outcome_hash TEXT, has_outcome INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'dirty', target_revision INTEGER,
                operation_id TEXT, payload TEXT, error TEXT);
            CREATE TABLE IF NOT EXISTS discovery_errors (id TEXT PRIMARY KEY, folder TEXT, error TEXT, thread TEXT);
        ''')
        if 'thread' not in {row['name'] for row in self.db.execute('PRAGMA table_info(discovery_errors)')}:
            self.db.execute('ALTER TABLE discovery_errors ADD COLUMN thread TEXT')
        self.api_url, self.bank = api_url, bank
        self.source, self.client, self.builder = source, client, builder
        self._source_open = self._bank_ready = self._closed = False
        self._source_lock = asyncio.Lock()
        self._task = self._scheduler = None
        self._wake = asyncio.Event()
        self._active_threads = 0
        self._metrics = {}
        self._model_metrics_baseline = {}
        self._run_started = None
        self.poll_seconds, self.operation_timeout = 2, 1800
        if self._get('config') is None:
            self._put('config', dict(folder_ids=[], lookback_days=30, interval_minutes=30, enabled=False))
        self._put('config', {**IMPORT_DEFAULTS, **self._get('config')})
        run = {**self._new_run(), **self._get('run', {})}
        if run['state'] in {'running', 'queued'}:
            run['state'] = 'paused'
        self._put('run', run)

    @staticmethod
    def _new_run():
        return dict(state='idle', scanned=0, imported=0, updated=0, withdrawn=0, outcomes=0,
                    skipped=0, failed=0, pending=0, last_success=None, next_run=None,
                    error=None, consolidation='disabled for thread outcomes')

    def _get(self, key, default=None):
        row = self.db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def _save(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', (key, _json(value)))

    def _put(self, key, value):
        with self.db:
            self._save(key, value)

    def _run_update(self, **values):
        self._put('run', {**self._get('run'), **values})

    def _count(self, **values):
        run = self._get('run')
        for key, value in values.items():
            run[key] += value
        self._put('run', run)

    def status(self):
        run = self._get('run')
        run['outcomes'] = self.db.execute('SELECT COUNT(*) FROM threads WHERE has_outcome=1').fetchone()[0]
        run['pending'] = self.db.execute("SELECT COUNT(*) FROM threads WHERE state!='idle'").fetchone()[0]
        run['active_threads'] = self._active_threads
        timing = dict(self._metrics)
        timing.update({key: round(value - self._model_metrics_baseline.get(key, 0), 3)
                       for key, value in getattr(self.builder, 'metrics', {}).items()})
        if self._run_started is not None:
            timing['elapsed_seconds'] = round(time.monotonic() - self._run_started, 3)
        run['timing'] = timing
        selected = set(self._get('config')['folder_ids'])
        selected_threads = self._selected_threads()
        failures_by_thread = {row['id'] for row in self.db.execute("SELECT id FROM threads WHERE error IS NOT NULL")
                              if row['id'] in selected_threads}
        unidentified = 0
        for row in self.db.execute('SELECT folder,thread FROM discovery_errors'):
            if row['folder'] in selected:
                if row['thread']:
                    failures_by_thread.add(row['thread'])
                else:
                    unidentified += 1
        run['failed'] = len(failures_by_thread) + unidentified
        failures = [dict(subject=row['subject'], reason=row['error']) for row in self.db.execute(
            'SELECT subject,error FROM threads WHERE error IS NOT NULL LIMIT 10')]
        failures.extend(dict(subject='Unidentified thread', reason=row['error']) for row in self.db.execute('SELECT error FROM discovery_errors LIMIT 10'))
        return dict(config=self._get('config'), account=self._get('account'), failures=failures[:10],
                    folders=self._get('folders', []), warnings=self._get('warnings', []), run=run)

    async def _open_source(self):
        if not self._source_open:
            if self.source is None:
                from .mail_source import WorkIQMailSource
                self.source = WorkIQMailSource(page_size=PAGE_SIZE, concurrency=3)
            await self.source.__aenter__()
            self._source_open = True

    def _require_source(self):
        if self.source is None:
            from .mail_source import find_workiq
            find_workiq()

    def _bind(self, account):
        address = account.get("mail") or account.get("userPrincipalName") or account.get("address")
        identity = str(account.get("id") or address or "").casefold()
        if not identity or not address:
            raise ValueError("WorkIQ did not provide a verified account.")
        old = self._get("identity")
        if old and old != identity:
            config = self._get("config")
            config["enabled"] = False
            self._put("config", config)
            self._run_update(state="paused", error="WorkIQ account changed. Restore the connected account before continuing.", next_run=None)
            raise IdentityChanged("WorkIQ account changed.")
        self._put("identity", identity)
        self._put("account", {"address": address, "name": account.get("displayName") or account.get("name") or address})

    async def discover(self):
        async with self._source_lock:
            await self._open_source()
            try:
                result = await self.source.discover()
            except Exception as exc:
                if getattr(exc, "code", None) != "workiq_account_changed":
                    raise
                config = self._get("config")
                config["enabled"] = False
                self._put("config", config)
                self._run_update(state="paused", error="WorkIQ account changed. Restore the connected account before continuing.", next_run=None)
                raise IdentityChanged() from None
            self._bind(result["account"])
        folders = [{**item, "recommended": item.get("recommended", item.get("selected", False))}
                   for item in result["folders"]]
        self._put("folders", folders)
        self._put("warnings", result.get("unresolved", []))
        if not self._get("configured", False):
            config = self._get("config")
            config["folder_ids"] = [f["id"] for f in folders if f["recommended"] and not f.get("excluded")]
            self._put("config", config)
        return self.status()

    async def configure(self, data):
        if not self._get("folders"):
            await self.discover()
        config = self._get("config")
        updated = {**config, **{k: v for k, v in data.items() if k in config}}
        folders = {f["id"]: f for f in self._get("folders", [])}
        ids = updated["folder_ids"]
        if not isinstance(ids, list) or any(not isinstance(i, str) or i not in folders or folders[i].get("excluded") for i in ids):
            raise ValueError("Select available folders outside the excluded subtrees.")
        for key, minimum, maximum in [("lookback_days", 1, 3650), ("interval_minutes", 0, 10080)]:
            if type(updated[key]) is not int or not minimum <= updated[key] <= maximum:
                raise ValueError(f"{key} must be between {minimum} and {maximum}.")
        if type(updated["enabled"]) is not bool:
            raise ValueError("enabled must be a boolean.")
        if not isinstance(updated['model'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|', updated['model']):
            raise ValueError('Provide a model ID or leave it blank to use the server model.')
        if not isinstance(updated['reasoning_effort'], str) or updated['reasoning_effort'] not in {'', 'none', 'low', 'medium', 'high', 'xhigh', 'max'}:
            raise ValueError('Choose a supported reasoning effort.')
        if type(updated['parallel_threads']) is not int or not 1 <= updated['parallel_threads'] <= 4:
            raise ValueError('parallel_threads must be between 1 and 4.')
        updated["folder_ids"] = list(dict.fromkeys(ids))
        if updated == config:
            return self.status()
        if self._task and not self._task.done():
            await self.pause()
        if any(updated[key] != config[key] for key in ('model', 'reasoning_effort')) and self.builder is not None:
            await self.builder.close()
            self.builder = None
        if updated["folder_ids"] != config["folder_ids"]:
            self._put("window", None)
        if updated["lookback_days"] > config["lookback_days"] and self._get("history_start"):
            earlier = _iso(_now() - timedelta(days=updated["lookback_days"]))
            self._put("history_start", min(self._get("history_start"), earlier))
            self._put("watermarks", {})
            self._put("window", None)
        elif updated['lookback_days'] < config['lookback_days'] and self._get('history_start'):
            self._put('history_start', _iso(_now() - timedelta(days=updated['lookback_days'])))
            self._put('window', None)
        self._put("config", updated)
        self._put("configured", True)
        self._run_update(next_run=_iso(_now()) if updated["enabled"] and updated["interval_minutes"] else None)
        self._wake.set()
        return self.status()

    async def preview(self, limit=5):
        await self.discover()
        self._validate_scope()
        config = self._get("config")
        end = _now()
        start = end - timedelta(days=config["lookback_days"])
        items = []
        async with self._source_lock:
            for folder in config["folder_ids"]:
                page = await self.source.page(folder, _iso(start), _iso(end))
                messages = await self.source.messages(page["messages"][:max(0, limit - len(items))])
                for message in messages:
                    items.append({"subject": message.get("metadata", {}).get("subject", ""),
                                  "source": message.get("source_text", ""),
                                  "cleaned": message.get("content", ""), "reason": message.get("skip_reason") or "Candidate for Hindsight extraction"})
                if len(items) >= limit:
                    break
        return {**self.status(), "items": items}

    async def boot(self):
        if self._get('config')['enabled']:
            self._require_source()
        if self._scheduler is None:
            self._scheduler = asyncio.create_task(self._schedule())
        if self._get("config")["enabled"]:
            self._launch()
        return self.status()

    def _launch(self):
        if self._task is None or self._task.done():
            self._run_update(state="queued", error=None, next_run=None)
            self._task = asyncio.create_task(self._run())

    async def start(self):
        self._require_source()
        config = self._get("config")
        if not config["folder_ids"]:
            raise ValueError("Select at least one folder before starting.")
        config["enabled"] = True
        self._put("config", config)
        self._put("configured", True)
        await self.boot()
        self._launch()
        return self.status()

    async def sync(self):
        self._require_source()
        if not self._get("config")["folder_ids"]:
            raise ValueError("Select at least one folder before synchronizing.")
        self._launch()
        return self.status()

    async def pause(self):
        config = self._get("config")
        config["enabled"] = False
        self._put("config", config)
        self._run_update(state="stopping", next_run=None)
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        self._run_update(state="paused", next_run=None)
        self._wake.set()
        return self.status()

    async def _schedule(self):
        while not self._closed:
            self._wake.clear()
            config, run = self._get("config"), self._get("run")
            if config["enabled"] and config["interval_minutes"] and run["next_run"] and _date(run["next_run"]) <= _now():
                self._launch()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=15)
            except TimeoutError:
                pass

    def _validate_scope(self):
        folders = {f['id']: f for f in self._get('folders', [])}
        if any(i not in folders or folders[i].get('excluded') for i in self._get('config')['folder_ids']):
            self._put('config', {**self._get('config'), 'enabled': False})
            self._run_update(state='paused', next_run=None, error='A selected folder is missing or excluded. Check the folder selection.')
            raise IdentityChanged()

    async def _ensure_bank(self):
        if self.client is None:
            from hindsight_client import Hindsight
            self.client = Hindsight(base_url=self.api_url, timeout=120)
        if not self._bank_ready:
            await self.client.acreate_bank(bank_id=self.bank)
            if not self._get('thread_bank_initialized', False):
                listing = _dict(await self.client.documents.list_documents(bank_id=self.bank, limit=1))
                if listing.get('items'):
                    raise ValueError('The mail bank is not empty. Use an empty bank for thread outcomes.')
                self._put('thread_bank_initialized', True)
            await self.client.aupdate_bank_config(bank_id=self.bank, retain_extraction_mode='chunks',
                retain_chunk_size=8000, retain_structured_chunk_size=8000, enable_observations=False,
                enable_auto_consolidation=False, enable_graph_retrieval=False, enable_temporal_retrieval=False)
            self._bank_ready = True

    def _thread(self, conversation):
        if not isinstance(conversation, str) or not conversation.strip() or len(conversation) > 4096:
            raise ValueError('A verified conversation ID is required.')
        return 'workiq-thread-' + _hash([self._get('identity'), conversation])

    def _record_sources(self, metadata):
        from .mail_source import WorkIQError, source_key, source_version
        for item in metadata:
            # A Graph locator identifies a retry record, never an imported source.
            locator = 'workiq-discovery-' + _hash([self._get('identity'), item['id']])
            if item.get('isDraft'):
                self.db.execute('DELETE FROM discovery_errors WHERE id=?', (locator,))
                continue
            if len(_json(item)) > 16000:
                raise ValueError('Source metadata exceeds the ledger bound.')
            try:
                thread = self._thread(item.get('conversationId'))
            except ValueError:
                thread = None
            if thread:
                if not self.db.execute('SELECT 1 FROM threads WHERE id=?', (thread,)).fetchone() and self.db.execute('SELECT COUNT(*) FROM threads').fetchone()[0] >= MAX_THREADS:
                    raise ValueError('Thread ledger capacity reached; narrow the scan scope.')
                self.db.execute('INSERT OR IGNORE INTO threads(id,conversation,subject) VALUES (?,?,?)',
                                (thread, item['conversationId'], item.get('subject', '')))
            try:
                key = source_key(item, self._get('identity'))
            except WorkIQError as exc:
                if exc.code != 'workiq_message_identity_missing':
                    raise
                key = None
            if key:
                self.db.execute('DELETE FROM discovery_errors WHERE id=?', (key,))
            if key is None or thread is None:
                error = 'workiq_message_identity_missing' if key is None else 'Missing conversation ID'
                old_error = self.db.execute('SELECT error,thread FROM discovery_errors WHERE id=?', (locator,)).fetchone()
                if thread and (not old_error or old_error['error'] != error or old_error['thread'] != thread):
                    self.db.execute("UPDATE threads SET revision=revision+1,state=CASE WHEN payload IS NULL THEN 'dirty' ELSE state END WHERE id=?", (thread,))
                self.db.execute('INSERT OR REPLACE INTO discovery_errors(id,folder,error,thread) VALUES (?,?,?,?)',
                                (locator, item['parentFolderId'], error, thread))
                continue
            self.db.execute('DELETE FROM discovery_errors WHERE id=?', (locator,))
            version = source_version(item)
            old = self.db.execute('SELECT version,thread FROM sources WHERE id=?', (key,)).fetchone()
            if not old and self.db.execute('SELECT COUNT(*) FROM sources').fetchone()[0] >= MAX_SOURCES:
                raise ValueError('Source ledger capacity reached; narrow the scan scope.')
            if not old or old['version'] != version or old['thread'] != thread:
                self.db.execute("UPDATE threads SET revision=revision+1,state=CASE WHEN payload IS NULL THEN 'dirty' ELSE state END WHERE id=?", (thread,))
            safe = {k: item[k] for k in ('id', 'internetMessageId', 'conversationId', 'parentFolderId', 'lastModifiedDateTime', 'receivedDateTime', 'sentDateTime', 'subject', 'isDraft') if k in item}
            self.db.execute('INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?)',
                            (key, version, thread, item['parentFolderId'], _json(safe)))

    def _selected_threads(self):
        selected = set(self._get('config')['folder_ids'])
        return {row['thread'] for row in self.db.execute('SELECT thread,folder FROM sources UNION SELECT thread,folder FROM discovery_errors')
                if row['thread'] and row['folder'] in selected}

    def _require_complete_discovery(self, identity):
        selected = set(self._get('config')['folder_ids'])
        if any(row['folder'] in selected for row in self.db.execute('SELECT folder FROM discovery_errors WHERE thread=?', (identity,))):
            from .mail_source import WorkIQError
            raise WorkIQError('workiq_thread_identity_incomplete')

    async def _scan(self):
        config = self._get('config')
        if not self._get('history_start'):
            self._put('history_start', _iso(_now() - timedelta(days=config['lookback_days'])))
        window = self._get('window')
        if not window or window['index'] >= len(window['folders']):
            watermarks = self._get('watermarks', {})
            for row in self.db.execute('SELECT DISTINCT folder FROM discovery_errors'):
                if row['folder'] in config['folder_ids']:
                    watermarks.pop(row['folder'], None)
            self._put('watermarks', watermarks)
            window = dict(end=_iso(_now()), folders=config['folder_ids'], index=0, next=None)
            self._put('window', window)
        while window['index'] < len(window['folders']):
            folder = window['folders'][window['index']]
            watermarks = self._get('watermarks', {})
            start = _date(self._get('history_start'))
            if folder in watermarks:
                start = max(start, _date(watermarks[folder]) - OVERLAP)
            async with self._source_lock:
                page = await self.source.page(folder, _iso(start), window['end'], window['next'])
            if len(page['messages']) > 100 or (page.get('next_link') and page['next_link'] == window['next']):
                raise ValueError('Invalid or repeated mail page.')
            with self.db:
                self._record_sources(page['messages'])
                window['next'] = page.get('next_link')
                if not window['next']:
                    watermarks[folder] = window['end']
                    window['index'] += 1
                self._save('watermarks', watermarks)
                self._save('window', window)
                run = self._get('run')
                run['scanned'] += len(page['messages'])
                self._save('run', run)
        return window['end']

    @staticmethod
    def _systemic_error(exc):
        from .mail_source import WorkIQError
        return getattr(exc, 'status', None) in {401, 403} or (isinstance(exc, WorkIQError) and exc.code in {
            'workiq_eula_required', 'workiq_tool_failed', 'workiq_transport_failed', 'workiq_not_connected'})

    @staticmethod
    def _error(exc):
        status = getattr(exc, 'status', None)
        safe = type(exc).__name__ == 'OutcomeError' and str(exc).startswith('outcome_') or type(exc).__name__ == 'WorkIQError' and str(exc).startswith('workiq_')
        detail = str(exc) if safe else type(exc).__name__
        detail += f' (HTTP {status})' if status else ''
        if getattr(exc, 'code', None) == 'workiq_eula_required':
            return detail + '. WorkIQ requires license acceptance before mail access. Review the WorkIQ terms before resuming.'
        if MailSync._systemic_error(exc):
            return detail + '. Import paused. Restore the source or connection before resuming.'
        return detail + '. Retry to resume this thread.'

    async def _run(self):
        phase = 'account verification'
        failed = set()
        self._metrics = {}
        self._model_metrics_baseline = dict(getattr(self.builder, 'metrics', {}))
        self._run_started = time.monotonic()
        try:
            if not self._get('window'):
                self._put('run', {**self._new_run(), 'last_success': self._get('run')['last_success']})
            self._run_update(state='running', error=None)
            await self.discover()
            self._validate_scope()
            phase = 'Hindsight configuration'
            await self._ensure_bank()
            phase = 'mail discovery'
            before = await self._measure('discovery', self._scan())
            for row in self.db.execute('SELECT id FROM threads WHERE payload IS NOT NULL').fetchall():
                try:
                    await self._deliver(row['id'])
                except Exception as exc:
                    if self._systemic_error(exc):
                        raise
                    failed.add(row['id'])
                    self._thread_error(row['id'], exc)
            selected = self._selected_threads()
            identities = [row['id'] for row in self.db.execute("SELECT id FROM threads WHERE state!='idle' ORDER BY CASE WHEN state='error' THEN 1 ELSE 0 END, rowid").fetchall()
                          if row['id'] in selected and row['id'] not in failed]
            phase = 'thread processing'
            await self._process_threads(identities, before, failed)
            discovery_failures = 0
            for row in self.db.execute('SELECT folder,thread FROM discovery_errors'):
                if row['folder'] in self._get('config')['folder_ids']:
                    if row['thread']:
                        failed.add(row['thread'])
                    else:
                        discovery_failures += 1
            self._put('window', None)
            self._run_update(state='error' if failed or discovery_failures else 'idle', failed=len(failed) + discovery_failures,
                error=f'{len(failed) + discovery_failures} thread updates need attention.' if failed or discovery_failures else None,
                last_success=self._get('run')['last_success'] if failed or discovery_failures else _iso(_now()))
        except asyncio.CancelledError:
            self._run_update(state='paused')
            raise
        except IdentityChanged:
            pass
        except Exception as exc:
            self._run_update(state='error', error=f'{phase} failed: {self._error(exc)}')
            if self._systemic_error(exc):
                self._put('config', {**self._get('config'), 'enabled': False})
        finally:
            config = self._get('config')
            if self._run_started is not None:
                self._metrics['elapsed_seconds'] = round(time.monotonic() - self._run_started, 3)
                self._run_started = None
            self._run_update(next_run=_iso(_now() + timedelta(minutes=config['interval_minutes'])) if config['enabled'] and config['interval_minutes'] else None)
            self._wake.set()

    async def _process_threads(self, identities, before, failed):
        remaining = iter(identities)

        async def worker():
            for identity in remaining:
                if asyncio.current_task().cancelling():
                    raise asyncio.CancelledError
                self._active_threads += 1
                attempted = False
                try:
                    await self._prepare(identity, before)
                    attempted = True
                except Exception as exc:
                    if self._systemic_error(exc):
                        raise
                    failed.add(identity)
                    self._thread_error(identity, exc)
                    attempted = True
                finally:
                    if attempted:
                        self._metrics['attempted_threads'] = self._metrics.get('attempted_threads', 0) + 1
                    self._active_threads -= 1

        tasks = [asyncio.create_task(worker()) for _ in range(min(len(identities), self._get('config')['parallel_threads']))]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done() and not task.cancelling():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _measure(self, phase, operation):
        started = time.monotonic()
        try:
            return await operation
        finally:
            key = phase + '_seconds'
            self._metrics[key] = round(self._metrics.get(key, 0) + time.monotonic() - started, 3)
            key = phase + '_calls'
            self._metrics[key] = self._metrics.get(key, 0) + 1

    def _thread_error(self, identity, exc):
        with self.db:
            self.db.execute("UPDATE threads SET state='error',error=? WHERE id=?", (self._error(exc), identity))

    async def _document(self, identity):
        try:
            return _dict(await self.client.documents.get_document(bank_id=self.bank, document_id=identity))
        except Exception as exc:
            if getattr(exc, 'status', None) == 404:
                return None
            raise

    async def _prepare(self, identity, before):
        self._require_complete_discovery(identity)
        row = self.db.execute('SELECT * FROM threads WHERE id=?', (identity,)).fetchone()
        if row['payload']:
            await self._deliver(identity)
            return
        if self.db.execute('SELECT COUNT(*) FROM threads WHERE payload IS NOT NULL').fetchone()[0] >= MAX_PREPARED:
            raise ValueError('Pending outcome queue is full; finish existing deliveries before preparing more.')
        async with self._source_lock:
            messages = await self._measure('source', self.source.thread(row['conversation'], self._get('config')['folder_ids'], before))
        if not messages or len(messages) > 100 or any(m.get('error') for m in messages):
            raise ValueError('Complete thread evidence is unavailable.')
        if sum(len(m.get('content', '')) for m in messages) > 100000:
            raise ValueError('Thread evidence exceeds the processing bound.')
        if any(m.get('metadata', {}).get('thread_id') != row['conversation'] for m in messages):
            raise ValueError('Thread evidence identity changed.')
        messages = sorted(messages, key=lambda m: (_date(m['metadata'].get('sent_at') or m['metadata']['received_at']), m['source_key']))
        semantic = [{k: v for k, v in m.get('metadata', {}).items() if k not in {'folder_id', 'source_url'}} for m in messages]
        input_hash = _hash([(m['source_key'], m.get('content', ''), m.get('skip_reason'), meta) for m, meta in zip(messages, semantic)])
        if input_hash == row['input_hash']:
            self._finish(identity, dict(action='unchanged', input_hash=input_hash), row['revision'])
            return
        previous = await self._document(identity)
        selected = set(self._get('config')['folder_ids'])
        expected = {r['id'] for r in self.db.execute('SELECT id,folder FROM sources WHERE thread=?', (identity,)) if r['folder'] in selected}
        actual = {m['source_key'] for m in messages}
        if not expected.issubset(actual):
            raise ValueError('Thread evidence omits a previously discovered source.')
        if self.builder is None:
            from .mail_outcome import OutcomeBuilder
            config = self._get('config')
            self.builder = OutcomeBuilder(model=config['model'] or None, reasoning_effort=config['reasoning_effort'] or None)
        decision = await self._measure('composition', self.builder.build(messages, previous=previous))
        self._validate_decision(decision)
        outcome_hash = _hash([decision['content'], decision['metadata']])
        if decision['action'] == 'publish' and previous and previous.get('original_text') == decision['content'] and row['outcome_hash'] == outcome_hash:
            decision = {**decision, 'action': 'unchanged'}
        target = {**decision, 'input_hash': input_hash, 'outcome_hash': outcome_hash, 'had_outcome': previous is not None}
        current = self.db.execute('SELECT revision FROM threads WHERE id=?', (identity,)).fetchone()[0]
        if current != row['revision']:
            raise ValueError('Thread evidence changed while preparing its outcome.')
        if decision['action'] == 'unchanged' or (decision['action'] == 'withdraw' and previous is None):
            self._finish(identity, target, row['revision'])
            return
        # Only the prepared outcome is durable, never the source correspondence.
        with self.db:
            if self.db.execute('SELECT COUNT(*) FROM threads WHERE payload IS NOT NULL').fetchone()[0] >= MAX_PREPARED:
                raise ValueError('Pending outcome queue is full; finish existing deliveries before preparing more.')
            self.db.execute("UPDATE threads SET target_revision=?,operation_id=?,payload=?,state='prepared',error=NULL WHERE id=? AND revision=?",
                (row['revision'], str(uuid.uuid4()), _json(target), identity, row['revision']))
        await self._measure('publication', self._deliver(identity))

    @staticmethod
    def _validate_decision(decision):
        if not isinstance(decision, dict) or set(decision) != {'action', 'content', 'metadata', 'reason'}:
            raise ValueError('Invalid thread outcome schema.')
        if decision['action'] not in {'publish', 'unchanged', 'withdraw'} or not isinstance(decision['reason'], str) or len(decision['reason']) > 1000:
            raise ValueError('Invalid thread outcome action.')
        if not isinstance(decision['content'], str) or len(decision['content']) > MAX_OUTCOME:
            raise ValueError('Thread outcome exceeds the content bound.')
        if decision['action'] == 'publish' and not decision['content'].strip():
            raise ValueError('A published outcome cannot be empty.')
        if not isinstance(decision['metadata'], dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in decision['metadata'].items()) or len(_json(decision['metadata'])) > MAX_METADATA:
            raise ValueError('Invalid outcome metadata.')

    async def _operation(self, operation):
        try:
            return _dict(await self.client.operations.get_operation_status(bank_id=self.bank, operation_id=operation))
        except Exception as exc:
            if getattr(exc, 'status', None) == 404:
                return {'status': 'not_found'}
            raise

    async def _deliver(self, identity):
        self._require_complete_discovery(identity)
        row = self.db.execute('SELECT * FROM threads WHERE id=?', (identity,)).fetchone()
        if not row['payload']:
            return
        target = json.loads(row['payload'])
        if row['target_revision'] < row['applied_revision']:
            raise ValueError('A stale thread revision cannot replace the accepted outcome.')
        if target['action'] == 'withdraw':
            try:
                await self.client.documents.delete_document(bank_id=self.bank, document_id=identity)
            except Exception as exc:
                if getattr(exc, 'status', None) != 404:
                    raise
            if await self._document(identity) is not None:
                raise RuntimeError('Withdrawn thread document is still present.')
            self._finish(identity, target, row['target_revision'])
            return
        operation = row['operation_id']
        result = await self._operation(operation)
        current = await self._document(identity)
        if current and result['status'] != 'completed':
            managed = set(json.loads((current.get('document_metadata') or {}).get('managed_tags', '[]')))
            target['user_tags'] = sorted(set(current.get('tags') or []) - managed)
            with self.db:
                self.db.execute('UPDATE threads SET payload=? WHERE id=?', (_json(target), identity))
        if result['status'] == 'cancelled':
            operation = str(uuid.uuid4())
            with self.db:
                self.db.execute("UPDATE threads SET operation_id=?,state='prepared' WHERE id=?", (operation, identity))
            result = {'status': 'not_found'}
        if result['status'] == 'not_found':
            from .mail_metadata import tags_for
            meta = {**target['metadata'], 'source': 'workiq-thread', 'thread_id': row['conversation'], 'revision': str(row['target_revision'])}
            if 'tags' not in target:
                previous = await self._document(identity) or {}
                target['tags'], managed = tags_for(meta, previous.get('tags') or [], previous.get('document_metadata') or {})
                target['metadata']['managed_tags'] = _json(managed)
                with self.db:
                    self.db.execute('UPDATE threads SET payload=? WHERE id=?', (_json(target), identity))
            meta['managed_tags'] = target['metadata']['managed_tags']
            await self.client.aretain(bank_id=self.bank, content=target['content'], metadata=meta, timestamp='unset',
                document_id=identity, tags=target['tags'], update_mode='replace', retain_async=True, operation_id=operation)
            with self.db:
                self.db.execute("UPDATE threads SET state='submitted' WHERE id=?", (identity,))
        elif result['status'] == 'failed':
            await self.client.operations.retry_operation(bank_id=self.bank, operation_id=operation)
        deadline = asyncio.get_running_loop().time() + self.operation_timeout
        while True:
            result = await self._operation(operation)
            if result['status'] == 'completed' and not int((result.get('result_metadata') or {}).get('extraction_errors_count') or 0):
                break
            if result['status'] in {'failed', 'cancelled', 'completed'}:
                raise RuntimeError('Thread publication did not complete cleanly.')
            if asyncio.get_running_loop().time() >= deadline:
                raise TimeoutError('Thread publication is still pending.')
            await asyncio.sleep(self.poll_seconds)
        document = await self._document(identity)
        if not document or document.get('memory_unit_count') != 1 or document.get('original_text') != target['content']:
            raise RuntimeError('Published thread outcome failed verification.')
        if 'user_tags' in target:
            from hindsight_client_api.models import UpdateDocumentRequest
            managed = set(json.loads(target['metadata']['managed_tags']))
            additions = set(document.get('tags') or []) - set(target['tags'])
            reconciled = sorted(managed | set(target['user_tags']) | additions)
            if set(document.get('tags') or []) != set(reconciled):
                await self.client.documents.update_document(bank_id=self.bank, document_id=identity,
                    update_document_request=UpdateDocumentRequest(tags=reconciled))
        self._finish(identity, target, row['target_revision'])

    def _finish(self, identity, target, revision):
        row = self.db.execute('SELECT has_outcome,revision,applied_revision FROM threads WHERE id=?', (identity,)).fetchone()
        if revision < row['applied_revision']:
            raise ValueError('A stale outcome cannot overwrite a newer accepted revision.')
        action = target['action']
        count = 'updated' if action == 'publish' and row['has_outcome'] else 'imported' if action == 'publish' else 'withdrawn' if action == 'withdraw' and row['has_outcome'] else 'skipped'
        has_outcome = 1 if action == 'publish' else 0 if action == 'withdraw' else row['has_outcome']
        with self.db:
            self.db.execute('''UPDATE threads SET applied_revision=?,input_hash=?,outcome_hash=COALESCE(?,outcome_hash),
                has_outcome=?,state=?,payload=NULL,operation_id=NULL,target_revision=NULL,error=NULL WHERE id=?''',
                (revision, target['input_hash'], target.get('outcome_hash') if action == 'publish' else None,
                 has_outcome, 'dirty' if row['revision'] > revision else 'idle', identity))
            run = self._get('run')
            run[count] += 1
            self._save('run', run)
        self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')

    async def close(self):
        self._closed = True
        for task in (self._task, self._scheduler):
            if task and not task.done():
                task.cancel()
        await asyncio.gather(*(t for t in (self._task, self._scheduler) if t), return_exceptions=True)
        cleanup = []
        if self._source_open:
            cleanup.append(self.source.__aexit__(None, None, None))
        if self.builder is not None:
            cleanup.append(self.builder.close())
        if self.client is not None:
            cleanup.append(self.client.aclose())
        results = await asyncio.gather(*cleanup, return_exceptions=True)
        try:
            self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        finally:
            self.db.close()
            self._writer.release()
        if any(isinstance(result, BaseException) for result in results):
            raise RuntimeError('A thread sync resource did not close cleanly.')
