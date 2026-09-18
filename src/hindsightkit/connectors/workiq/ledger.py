"""Schema and status views for the existing mail synchronization ledger."""
import json
from pathlib import Path
import sqlite3


def new_config():
    return dict(folder_ids=[], lookback_days=30, interval_minutes=30, enabled=False,
                model='', reasoning_effort='', parallel_threads=8, prefilter_enabled=True,
                prefilter_model='gpt-5.6-terra', prefilter_reasoning_effort='low')


def new_run():
    return dict(state='idle', scanned=0, imported=0, updated=0, withdrawn=0, outcomes=0,
                skipped=0, prefiltered=0, prefilter_checked=0, prefilter_uncertain=0,
                failed=0, pending=0, last_success=None, next_run=None,
                error=None, consolidation='disabled for thread outcomes')


def new_status():
    return dict(config=new_config(), account=None, folders=[], warnings=[], failures=[], run=new_run())


def _tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _has_error_thread(db):
    return 'thread' in {row[1] for row in db.execute('PRAGMA table_info(discovery_errors)')}


def initialize(db):
    tables = _tables(db)
    legacy = ('messages', 'jobs', 'evidence', 'receipts')
    if any(table in tables and db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
           for table in legacy):
        raise ValueError('This ledger contains legacy message imports. Use an empty thread-outcome ledger.')
    for table in legacy:
        if table in tables:
            db.execute('DROP TABLE ' + table)
    db.executescript('''
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
    # Older ledgers must gain the column before its indexes are created.
    if not _has_error_thread(db):
        db.execute('ALTER TABLE discovery_errors ADD COLUMN thread TEXT')
    db.executescript('''
        CREATE INDEX IF NOT EXISTS sources_thread ON sources(thread);
        CREATE INDEX IF NOT EXISTS sources_folder_thread ON sources(folder, thread);
        CREATE INDEX IF NOT EXISTS discovery_errors_thread ON discovery_errors(thread);
        CREATE INDEX IF NOT EXISTS discovery_errors_folder_thread ON discovery_errors(folder, thread);
    ''')


def _selected_query(db, folders, tables):
    slots = ','.join('?' for _ in folders)
    queries, parameters = [], []
    for table in ('sources', 'discovery_errors'):
        if folders and table in tables and (table != 'discovery_errors' or _has_error_thread(db)):
            queries.append(f"SELECT thread FROM {table} WHERE folder IN ({slots}) AND thread IS NOT NULL AND thread!=''")
            parameters.extend(folders)
    return ' UNION '.join(queries) or 'SELECT NULL AS thread WHERE 0', parameters


def selected_threads(db, folders):
    query, parameters = _selected_query(db, folders, _tables(db))
    return {row[0] for row in db.execute(query, parameters)}


def status(db):
    value = new_status()
    for key, data in db.execute('SELECT key,value FROM settings'):
        if key in value:
            decoded = json.loads(data)
            value[key] = {**value[key], **decoded} if key in {'config', 'run'} else decoded
    tables = _tables(db)
    folders = value['config']['folder_ids']
    query, parameters = _selected_query(db, folders, tables)
    failures, failed_threads = [], set()
    if 'threads' in tables:
        value['run']['pending'], value['run']['outcomes'] = db.execute(
            "SELECT COUNT(CASE WHEN state!='idle' THEN 1 END), COUNT(CASE WHEN has_outcome=1 THEN 1 END) FROM threads"
        ).fetchone()
        for identity, subject, error in db.execute(
                f'SELECT id,subject,error FROM threads WHERE error IS NOT NULL AND id IN ({query}) ORDER BY rowid', parameters):
            failed_threads.add(identity)
            if len(failures) < 10:
                failures.append(dict(subject=subject, reason=error))
    unidentified = 0
    if folders and 'discovery_errors' in tables:
        thread = 'thread' if _has_error_thread(db) else 'NULL'
        slots = ','.join('?' for _ in folders)
        for identity, error in db.execute(
                f'SELECT {thread},error FROM discovery_errors WHERE folder IN ({slots}) ORDER BY id', folders):
            if identity and identity in failed_threads:
                continue
            if identity:
                failed_threads.add(identity)
            else:
                unidentified += 1
            if len(failures) < 10:
                failures.append(dict(subject='Unidentified thread', reason=error))
    value['run']['failed'] = len(failed_threads) + unidentified
    value['failures'] = failures
    return value


def saved_status(directory):
    path = Path(directory) / 'sync.sqlite3'
    if not path.is_file():
        return new_status()
    try:
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        try:
            return status(db)
        finally:
            db.close()
    except (sqlite3.Error, KeyError, TypeError) as exc:
        raise ValueError('Unable to read email sync settings.') from exc
