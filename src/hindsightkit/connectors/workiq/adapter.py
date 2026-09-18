"""Optional WorkIQ adapter: prerequisites, settings and native mail recall."""
import asyncio
import os
from pathlib import Path
import subprocess

from hindsightkit.connectors.workiq.ledger import saved_status

EULA_ERROR = ('workiq_eula_required. WorkIQ requires license acceptance before mail access. '
              'Review the WorkIQ terms before resuming.')


def _eula_required(error):
    return isinstance(error, str) and ('workiq_eula_required' in error or
        'WorkIQ requires license acceptance before mail access.' in error)


async def _accept_workiq_eula():
    from hindsightkit.connectors.workiq.source import find_workiq
    binary = find_workiq()
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        process = await asyncio.create_subprocess_exec(binary, 'accept-eula', '--log-level', 'None',
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **flags)
        try:
            code = await asyncio.wait_for(process.wait(), timeout=60)
        except BaseException:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                raise ValueError('WorkIQ did not stop after license acceptance was interrupted. Check WorkIQ before trying again.') from None
            raise
    except TimeoutError:
        raise ValueError('WorkIQ license acceptance timed out. Refresh folders before trying again.') from None
    except OSError:
        raise ValueError('WorkIQ could not accept the license. Check the WorkIQ installation and try again.') from None
    if code != 0:
        raise ValueError('WorkIQ could not accept the license. Try again or accept it in the terminal.')


class Adapter:
    def __init__(self, directory, config):
        self.directory, self.config = Path(directory), config
        self.sync = None
        self.error = None
        self._check = None
        self._lock = asyncio.Lock()

    def availability(self, refresh=False):
        if self._check is None or refresh:
            from hindsightkit.connectors.workiq.source import find_workiq, WorkIQError
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
        return {**value, 'availability': self.availability(), 'bank': 'hindsightkit-mail',
                'consent': {'required': _eula_required(value['run'].get('error'))}}

    async def _load(self):
        if self.sync is None:
            from hindsightkit import connection
            from hindsightkit.connectors.workiq.sync import MailSync
            self.sync = MailSync(self.directory, self.config['apiUrl'],
                                 client=connection.sdk(self.config, timeout=120))
        return self.sync

    async def action(self, action, data=None):
        from hindsightkit.connectors.workiq.source import WorkIQError
        async with self._lock:
            try:
                return await self._action(action, data)
            except WorkIQError as exc:
                if exc.code != 'workiq_eula_required':
                    raise
                self.error = EULA_ERROR
                if self.sync:
                    await self.sync.pause()
                    self.sync._run_update(error=EULA_ERROR)
                raise ValueError(EULA_ERROR) from None

    async def _action(self, action, data=None):
        if action not in {'discover', 'config', 'preview', 'start', 'pause', 'sync', 'accept-eula'}:
            raise ValueError('Unknown connector action.')
        if action == 'accept-eula':
            if not isinstance(data, dict) or set(data) != {'accepted'} or data['accepted'] is not True:
                raise ValueError('Confirm that you have read and accept the WorkIQ license terms.')
            if not self.status()['consent']['required']:
                raise ValueError('WorkIQ has not requested license acceptance. Refresh folders to check.')
        if action == 'pause':
            if self.sync or (self.directory / 'sync.sqlite3').exists():
                await (await self._load()).pause()
                await self.close()
            self.error = None
            return self.status()
        if action == 'config':
            required = {'folder_ids', 'lookback_days', 'interval_minutes'}
            optional = {'model', 'reasoning_effort', 'parallel_threads', 'prefilter_enabled', 'prefilter_model', 'prefilter_reasoning_effort'}
            if not isinstance(data, dict) or not required <= set(data) or set(data) - required - optional:
                raise ValueError('Choose folders, a lookback period, and a sync interval.')
        if not self.availability(refresh=True)['ready']:
            raise ValueError(self._check['message'])
        needs_consent = self.status()['consent']['required']
        if needs_consent and action in {'preview', 'start', 'sync'}:
            raise ValueError('Accept the WorkIQ license terms, or refresh folders if you accepted them in the terminal.')
        if action == 'accept-eula' or (action == 'discover' and needs_consent):
            await (await self._load()).pause()
            if action == 'accept-eula':
                await _accept_workiq_eula()
            await self.close()
        sync = await self._load()
        if action == 'accept-eula' or (action == 'discover' and needs_consent):
            self.error = None
            sync._run_update(state='paused', error=None, next_run=None)
        if action == 'config':
            await sync.configure(data)
        else:
            result = await getattr(sync, 'discover' if action == 'accept-eula' else action)()
            if action == 'preview':
                return result
        self.error = None
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
    from hindsightkit import connection
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
