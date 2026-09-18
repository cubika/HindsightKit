import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from hindsightkit import mail_ledger
from hindsightkit.mail_sync import MailSync


class LedgerTests(unittest.TestCase):
    def test_migration_preserves_errors_and_adds_indexes_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sync.sqlite3'
            db = sqlite3.connect(path)
            db.executescript('''
                CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE discovery_errors(id TEXT PRIMARY KEY, folder TEXT, error TEXT);
                INSERT INTO discovery_errors VALUES ('error', 'inbox', 'unavailable');
            ''')
            with db:
                db.execute('INSERT INTO settings VALUES (?,?)',
                           ('config', json.dumps({'folder_ids':['inbox']})))
            db.close()
            before = path.read_bytes()
            self.assertEqual(mail_ledger.saved_status(directory)['run']['failed'], 1)
            self.assertEqual(path.read_bytes(), before)
            db = sqlite3.connect(path)
            try:
                for _ in range(2):
                    mail_ledger.initialize(db)
                self.assertEqual(db.execute('SELECT * FROM discovery_errors').fetchall(),
                                 [('error', 'inbox', 'unavailable', None)])
                for query, parameters in [
                    ('SELECT id,folder FROM sources WHERE thread=?', ('thread',)),
                    ('SELECT folder FROM discovery_errors WHERE thread=?', ('thread',)),
                    ('SELECT thread FROM sources WHERE folder IN (?)', ('inbox',)),
                    ('SELECT thread FROM discovery_errors WHERE folder IN (?)', ('inbox',)),
                ]:
                    with self.subTest(query=query):
                        plan = ' '.join(row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + query, parameters))
                        self.assertIn('SEARCH', plan)
                        self.assertIn('INDEX', plan)
            finally:
                db.close()

    def test_folder_selection_deduplicates_and_keeps_discovery_only_threads(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        mail_ledger.initialize(db)
        with db:
            db.executemany('INSERT INTO sources VALUES (?,?,?,?,?)', [
                ('one', 'v', 'shared', 'inbox', '{}'), ('two', 'v', 'shared', 'sent', '{}'),
                ('three', 'v', 'excluded', 'archive', '{}'),
                ('four', 'v', 'quoted-folder', "folder') OR 1=1 --", '{}'),
            ])
            db.executemany('INSERT INTO discovery_errors VALUES (?,?,?,?)', [
                ('one', 'inbox', 'missing', 'shared'), ('two', 'sent', 'missing', 'discovery-only'),
                ('three', 'inbox', 'missing', None), ('four', 'archive', 'missing', 'excluded-error'),
            ])
        self.assertEqual(mail_ledger.selected_threads(db, []), set())
        self.assertEqual(mail_ledger.selected_threads(db, ['inbox', 'sent', 'inbox']), {'shared', 'discovery-only'})
        self.assertEqual(mail_ledger.selected_threads(db, ["folder') OR 1=1 --"]), {'quoted-folder'})

    def test_status_matches_while_running_and_closed_without_stale_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            sync = MailSync(Path(directory), 'unused')
            try:
                sync._put('config', {**mail_ledger.new_config(), 'folder_ids':['inbox']})
                sync._put('run', {'state':'paused', 'failed':999})
                with sync.db:
                    for i in range(12):
                        sync.db.execute('INSERT INTO threads(id,conversation,subject,error) VALUES (?,?,?,?)',
                                        (f't{i}', f'c{i}', f'Selected {i}', 'failed'))
                        sync.db.execute('INSERT INTO sources VALUES (?,?,?,?,?)', (f's{i}', 'v', f't{i}', 'inbox', '{}'))
                        sync.db.execute('INSERT INTO discovery_errors VALUES (?,?,?,?)', (f'e{i}', 'inbox', 'missing', f't{i}'))
                    sync.db.execute('INSERT INTO discovery_errors VALUES (?,?,?,?)', ('unknown', 'inbox', 'missing', None))
                    sync.db.execute('INSERT INTO discovery_errors VALUES (?,?,?,?)', ('only', 'inbox', 'missing', 'discovery-only'))
                    sync.db.execute('INSERT INTO threads(id,conversation,subject,error,has_outcome) VALUES (?,?,?,?,?)',
                                    ('excluded', 'excluded', 'Excluded failure', 'private excluded detail', 1))
                    sync.db.execute('INSERT INTO sources VALUES (?,?,?,?,?)', ('excluded', 'v', 'excluded', 'archive', '{}'))
                active = sync.status()
                saved = mail_ledger.saved_status(directory)
                active['run'].pop('active_threads')
                active['run'].pop('timing')
                self.assertEqual(saved, active)
                self.assertEqual(saved['run']['failed'], 14)
                self.assertEqual(saved['run']['pending'], 13)
                self.assertEqual(saved['run']['outcomes'], 1)
                self.assertEqual(len(saved['failures']), 10)
                self.assertNotIn('private excluded detail', json.dumps(saved))
            finally:
                asyncio.run(sync.close())
            before = (Path(directory) / 'sync.sqlite3').read_bytes()
            self.assertEqual(mail_ledger.saved_status(directory), saved)
            self.assertEqual((Path(directory) / 'sync.sqlite3').read_bytes(), before)

    def test_empty_snapshot_does_not_create_files_or_share_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / 'missing'
            first = mail_ledger.saved_status(missing)
            first['config']['folder_ids'].append('inbox')
            first['failures'].append({'reason':'changed'})
            self.assertEqual(mail_ledger.saved_status(missing), mail_ledger.new_status())
            self.assertFalse(missing.exists())
