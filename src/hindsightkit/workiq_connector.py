"""Optional WorkIQ adapter: prerequisites, settings and native mail recall."""
from copy import deepcopy
import asyncio
import json
from pathlib import Path
import sqlite3

DEFAULT = {'config': {'folder_ids': [], 'lookback_days': 30, 'interval_minutes': 30, 'enabled': False,
                       'model': '', 'reasoning_effort': '', 'parallel_threads': 4},
           'account': None, 'folders': [], 'warnings': [], 'failures': [],
           'run': {'state': 'idle', 'scanned': 0, 'imported': 0, 'skipped': 0, 'failed': 0,
                   'pending': 0, 'outcomes': 0, 'updated': 0, 'withdrawn': 0, 'last_success': None, 'next_run': None, 'error': None}}


def saved_status(directory):
    value = deepcopy(DEFAULT)
    path = Path(directory) / 'sync.sqlite3'
    if path.is_file():
        try:
            db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
            try:
                for key, data in db.execute('SELECT key,value FROM settings'):
                    if key in value:
                        value[key] = {**value[key], **json.loads(data)} if key == 'config' else json.loads(data)
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if 'threads' in tables:
                    value['run']['pending'] = db.execute("SELECT COUNT(*) FROM threads WHERE state!='idle'").fetchone()[0]
                    value['run']['outcomes'] = db.execute('SELECT COUNT(*) FROM threads WHERE has_outcome=1').fetchone()[0]
                    value['failures'] = [{'subject':row[0], 'reason':row[1]} for row in db.execute("SELECT subject,error FROM threads WHERE error IS NOT NULL LIMIT 10")]
                if 'discovery_errors' in tables:
                    value['failures'] += [{'subject': 'Unidentified thread', 'reason':row[1]}
                                         for row in db.execute('SELECT id,error FROM discovery_errors LIMIT 10')]
            finally:
                db.close()
        except (sqlite3.Error, KeyError, TypeError) as exc:
            raise ValueError('Unable to read email sync settings.') from exc
    return value


class Adapter:
    def __init__(self, directory, config):
        self.directory, self.config = Path(directory), config
        self.sync = None
        self.error = None
        self._check = None
        self._lock = asyncio.Lock()

    def availability(self, refresh=False):
        if self._check is None or refresh:
            from .mail_source import find_workiq, WorkIQError
            try:
                find_workiq()
                self._check = {'ready': True, 'message': 'WorkIQ is installed'}
            except (WorkIQError, OSError):
                self._check = {'ready': False, 'message': 'Install the supported WorkIQ 1.0.0 package, then refresh. HindsightKit does not install or launch it automatically.'}
        return self._check

    def status(self):
        value = self.sync.status() if self.sync else saved_status(self.directory)
        if self.error:
            value['run']['error'] = self.error
        return {**value, 'availability': self.availability(), 'bank': 'hindsightkit-mail'}

    async def _load(self):
        if self.sync is None:
            from . import connection
            from .mail_sync import MailSync
            self.sync = MailSync(self.directory, self.config['apiUrl'],
                                 client=connection.sdk(self.config, timeout=120))
        return self.sync

    async def action(self, action, data=None):
        async with self._lock:
            return await self._action(action, data)

    async def _action(self, action, data=None):
        if action not in {'discover', 'config', 'preview', 'start', 'pause', 'sync'}:
            raise ValueError('Unknown connector action.')
        if action == 'pause':
            if self.sync or (self.directory / 'sync.sqlite3').exists():
                await (await self._load()).pause()
                await self.close()
            self.error = None
            return self.status()
        if action == 'config':
            required = {'folder_ids', 'lookback_days', 'interval_minutes'}
            optional = {'model', 'reasoning_effort', 'parallel_threads'}
            if not isinstance(data, dict) or not required <= set(data) or set(data) - required - optional:
                raise ValueError('Choose folders, a lookback period, and a sync interval.')
        if not self.availability(refresh=True)['ready']:
            raise ValueError(self._check['message'])
        self.error = None
        sync = await self._load()
        if action == 'config':
            await sync.configure(data)
        else:
            result = await getattr(sync, action)()
            if action == 'preview':
                return result
        return self.status()

    async def boot(self):
        async with self._lock:
            if saved_status(self.directory)['config']['enabled']:
                if not self.availability(refresh=True)['ready']:
                    self.error = self._check['message']
                    return
                await (await self._load()).boot()

    async def close(self):
        if self.sync:
            try:
                await self.sync.close()
            finally:
                self.sync = None


def register_tools(server, config, directory):
    from . import connection
    advertised = 'workiq' in config.get('hindsightkit', {}).get('connectors', [])
    if connection.fixed_bank(config) or (not advertised and
            (connection.client_mode(config) or not (Path(directory) / 'sync.sqlite3').is_file())):
        return

    @server.tool
    async def recall_mail(query: str, max_tokens: int = 4096) -> dict:
        """Search current email thread outcomes with source links. Read only."""
        if not query.strip() or not 256 <= max_tokens <= 16384:
            raise ValueError('Provide a query and max_tokens between 256 and 16384.')
        client = connection.sdk(config, timeout=90)
        try:
            result = await client.arecall(bank_id='hindsightkit-mail', query=query, max_tokens=max_tokens,
                budget='mid', types=['world'],
                include_source_facts=False)
            return {'bank': 'hindsightkit-mail', 'result': result.model_dump(mode='json')}
        except Exception as exc:
            if getattr(exc, 'status', None) == 404:
                return {'bank': 'hindsightkit-mail', 'result': {}, 'message': 'No email has been imported.'}
            raise
        finally:
            await client.aclose()
