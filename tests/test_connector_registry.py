import asyncio
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from hindsightkit.connectors.registry import Connector, ConnectorHost, enabled_connectors, readable_connectors, readable_sources
from hindsightkit.memory.api import ReadSource
from hindsightkit.connectors.workiq.adapter import Adapter, EULA_ERROR, _accept_workiq_eula, saved_status
from hindsightkit.connectors.workiq.source import WorkIQError
from hindsightkit.connectors.workiq.ledger import initialize, new_config, new_run, new_status


def settings(root, enabled=False):
    directory = root / 'mail'
    directory.mkdir()
    db = sqlite3.connect(directory / 'sync.sqlite3')
    with db:
        db.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
        db.execute('INSERT INTO settings VALUES (?,?)', ('config', json.dumps({**new_config(), 'enabled':enabled})))
    db.close()
    return directory


class OptionalConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_unused_catalog_and_boot_do_not_create_runtime_or_call_dependencies(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch('hindsightkit.connectors.workiq.source.find_workiq', side_effect=WorkIQError('workiq_1_0_0_not_found')), \
             patch('hindsightkit.connectors.workiq.sync.MailSync') as runner, \
             patch('hindsightkit.connection.sdk') as sdk:
            root = Path(temp)
            host = ConnectorHost(root, {'apiUrl':'http://127.0.0.1:9077'})
            self.assertEqual(enabled_connectors(root), [])
            await host.boot()
            self.assertEqual(host.adapters, {})
            catalog = host.catalog()
            self.assertFalse(catalog[0]['availability']['ready'])
            self.assertFalse(host.status('workiq')['config']['enabled'])
            self.assertEqual(list(root.iterdir()), [])
            await host.close()
            runner.assert_not_called()
            sdk.assert_not_called()

    async def test_missing_workiq_prevents_actions_before_any_state_change(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch('hindsightkit.connectors.workiq.source.find_workiq', side_effect=WorkIQError('workiq_1_0_0_not_found')), \
             patch('hindsightkit.connectors.workiq.sync.MailSync') as runner, patch('hindsightkit.connection.sdk') as sdk:
            adapter = Adapter(Path(temp) / 'mail', {'apiUrl':'http://127.0.0.1:9077'})
            for action in ['discover','preview','start','sync']:
                with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'WorkIQ'):
                    await adapter.action(action)
            await adapter.action('pause')
            runner.assert_not_called()
            sdk.assert_not_called()
            self.assertFalse(adapter.directory.exists())

    async def test_only_enabled_adapter_restores_and_missing_dependency_stays_visible(self):
        for enabled in [False, True]:
            with self.subTest(enabled=enabled), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                directory = settings(root, enabled)
                before = (directory / 'sync.sqlite3').read_bytes()
                with patch('hindsightkit.connectors.workiq.source.find_workiq', side_effect=WorkIQError('missing')) as probe, \
                     patch('hindsightkit.connectors.workiq.sync.MailSync') as runner:
                    host = ConnectorHost(root, {'apiUrl':'http://127.0.0.1:9077'})
                    self.assertEqual(enabled_connectors(root), ['workiq'] if enabled else [])
                    await host.boot()
                    runner.assert_not_called()
                    if enabled:
                        self.assertIn('WorkIQ', host.adapters['workiq'].error)
                    else:
                        probe.assert_not_called()
                    await host.close()
                self.assertEqual(before, (directory / 'sync.sqlite3').read_bytes())

    async def test_lazy_runtime_uses_authenticated_sdk_and_pause_releases_resources(self):
        fake = Mock()
        fake.status.return_value = new_status()
        fake.discover = AsyncMock()
        fake.pause, fake.close, fake.boot = AsyncMock(), AsyncMock(), AsyncMock()
        config = {'apiUrl':'http://127.0.0.1:9077','apiToken':'test-private-token'}
        with tempfile.TemporaryDirectory() as temp, patch('hindsightkit.connectors.workiq.source.find_workiq', return_value='workiq.exe'), \
             patch('hindsightkit.connectors.workiq.sync.MailSync', return_value=fake) as make, \
             patch('hindsightkit.connection.sdk', return_value='authenticated-client') as sdk:
            adapter = Adapter(Path(temp)/'mail', config)
            adapter.status()
            sdk.assert_not_called()
            await adapter.action('discover')
            await adapter.action('discover')
            sdk.assert_called_once_with(config, timeout=120)
            make.assert_called_once_with(adapter.directory, config['apiUrl'], client='authenticated-client')
            await adapter.action('pause')
            fake.pause.assert_awaited_once()
            fake.close.assert_awaited_once()
            self.assertIsNone(adapter.sync)

    async def test_enabled_saved_connector_restores_once_without_discovery(self):
        fake = Mock()
        fake.boot, fake.close, fake.discover = AsyncMock(), AsyncMock(), AsyncMock()
        with tempfile.TemporaryDirectory() as temp, patch('hindsightkit.connectors.workiq.source.find_workiq', return_value='workiq.exe'), \
             patch('hindsightkit.connectors.workiq.sync.MailSync', return_value=fake) as make, \
             patch('hindsightkit.connection.sdk', return_value='client'):
            directory = settings(Path(temp), enabled=True)
            adapter = Adapter(directory, {'apiUrl':'local'})
            await adapter.boot()
            fake.boot.assert_awaited_once()
            fake.discover.assert_not_awaited()
            make.assert_called_once()
            await adapter.close()

    def test_paused_snapshot_keeps_pending_and_failures_without_constructing_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = settings(Path(temp))
            db = sqlite3.connect(directory/'sync.sqlite3')
            initialize(db)
            with db:
                db.execute('UPDATE settings SET value=? WHERE key=?',
                           (json.dumps({**new_config(), 'folder_ids':['inbox']}), 'config'))
                db.execute('INSERT INTO threads(id,conversation,payload,state,has_outcome,subject) VALUES (?,?,?,?,?,?)',
                           ('thread', 'conversation', 'pending-private-data', 'prepared', 1, 'Pending thread'))
                db.execute('INSERT INTO discovery_errors VALUES (?,?,?,?)', ('unavailable', 'inbox', 'protected', None))
            db.close()
            with patch('hindsightkit.connectors.workiq.sync.MailSync') as make:
                value = saved_status(directory)
            make.assert_not_called()
            self.assertEqual(value['run']['pending'],1)
            self.assertEqual(value['run']['failed'],1)
            self.assertEqual(value['failures'],[{'subject':'Unidentified thread','reason':'protected'}])
            self.assertNotIn('pending-private-data',json.dumps(value))

    async def test_public_start_requires_installed_source_before_enabling(self):
        from hindsightkit.connectors.workiq.sync import MailSync
        with tempfile.TemporaryDirectory() as temp:
            runner = MailSync(Path(temp), 'unused')
            runner._put('config', {**new_config(), 'folder_ids':['inbox']})
            try:
                with patch('hindsightkit.connectors.workiq.source.find_workiq', side_effect=WorkIQError('missing')):
                    for method in [runner.start, runner.sync]:
                        with self.assertRaises(WorkIQError):
                            await method()
                self.assertFalse(runner.status()['config']['enabled'])
                self.assertIsNone(runner._task)
            finally:
                await runner.close()


class WorkIQConsentTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_license_errors_require_consent_without_loading_runtime(self):
        for error in [EULA_ERROR, 'workiq_eula_required',
                      'WorkIQ requires license acceptance before mail access.']:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as temp:
                directory = settings(Path(temp))
                db = sqlite3.connect(directory / 'sync.sqlite3')
                try:
                    with db:
                        db.execute('INSERT INTO settings VALUES (?,?)', ('run', json.dumps({**new_run(), 'error': error})))
                finally:
                    db.close()
                adapter = Adapter(directory, {'apiUrl': 'unused'})
                with patch.object(adapter, 'availability', return_value={'ready': True}), \
                     patch.object(adapter, '_load') as load, \
                     patch('hindsightkit.connectors.workiq.adapter._accept_workiq_eula') as accept:
                    self.assertTrue(adapter.status()['consent']['required'])
                    load.assert_not_called()
                    accept.assert_not_called()

    async def test_accept_requires_exact_confirmation_and_detected_error(self):
        with tempfile.TemporaryDirectory() as temp:
            adapter = Adapter(Path(temp), {'apiUrl': 'unused'})
            with patch.object(adapter, 'availability', return_value={'ready': True}), \
                 patch.object(adapter, '_load') as load, \
                 patch('hindsightkit.connectors.workiq.adapter._accept_workiq_eula') as accept:
                for data in [None, [], {}, {'accepted': False}, {'accepted': 1}, {'accepted': 'true'},
                             {'accepted': True, 'path': 'arbitrary'}, {'accepted': True}]:
                    with self.subTest(data=data), self.assertRaises(ValueError):
                        await adapter.action('accept-eula', data)
                self.assertFalse(adapter.status()['consent']['required'])
                load.assert_not_called()
                accept.assert_not_called()

    async def test_discovery_failure_persists_and_blocks_sync_until_connection_refresh(self):
        from hindsightkit.connectors.workiq.sync import MailSync
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'mail'
            runner = MailSync(directory, 'unused')
            runner.discover = AsyncMock(side_effect=WorkIQError('workiq_eula_required'))
            adapter = Adapter(directory, {'apiUrl': 'unused'})
            adapter.sync = runner
            with patch.object(adapter, 'availability', return_value={'ready': True}):
                try:
                    with self.assertRaisesRegex(ValueError, 'workiq_eula_required'):
                        await adapter.action('discover')
                    self.assertTrue(adapter.status()['consent']['required'])
                    self.assertFalse(adapter.status()['config']['enabled'])
                    for action in ['start', 'sync', 'preview']:
                        with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'Accept the WorkIQ'):
                            await adapter.action(action)
                    self.assertIsNone(runner._task)
                finally:
                    await adapter.close()
                self.assertTrue(adapter.status()['consent']['required'])

    async def test_accept_and_manual_recovery_reopen_source_and_keep_schedule_paused(self):
        from hindsightkit.connectors.workiq.sync import MailSync
        for action in ['accept-eula', 'discover']:
            with self.subTest(action=action), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp) / 'mail'
                old = MailSync(directory, 'unused')
                old._run_update(error=EULA_ERROR)
                old._put('config', {**old._get('config'), 'enabled': True})
                old.source = Mock(__aexit__=AsyncMock())
                old._source_open = True
                adapter = Adapter(directory, {'apiUrl': 'unused'})
                adapter.sync = old
                instances = []
                def reopen(*args, **kwargs):
                    runner = MailSync(*args, **kwargs)
                    runner.discover = AsyncMock()
                    instances.append(runner)
                    return runner
                with patch.object(adapter, 'availability', return_value={'ready': True}), \
                     patch('hindsightkit.connection.sdk', return_value=None), \
                     patch('hindsightkit.connectors.workiq.sync.MailSync', side_effect=reopen), \
                     patch('hindsightkit.connectors.workiq.adapter._accept_workiq_eula', new_callable=AsyncMock) as accept:
                    try:
                        result = await adapter.action(action, {'accepted': True} if action == 'accept-eula' else None)
                        self.assertFalse(result['consent']['required'])
                        self.assertFalse(result['config']['enabled'])
                        self.assertEqual(result['run']['state'], 'paused')
                        self.assertIsNone(result['run']['next_run'])
                        old.source.__aexit__.assert_awaited_once()
                        self.assertEqual(len(instances), 1)
                        instances[0].discover.assert_awaited_once()
                        self.assertIsNone(instances[0]._task)
                        self.assertIsNone(instances[0]._scheduler)
                        self.assertEqual(accept.await_count, int(action == 'accept-eula'))
                    finally:
                        await adapter.close()

    async def test_official_accept_command_has_no_shell_or_private_output(self):
        import os
        import subprocess
        process = Mock(returncode=0, wait=AsyncMock(return_value=0))
        with patch('hindsightkit.connectors.workiq.source.find_workiq', return_value='verified-workiq.exe'), \
             patch('hindsightkit.connectors.workiq.adapter.asyncio.create_subprocess_exec', new_callable=AsyncMock, return_value=process) as spawn:
            await _accept_workiq_eula()
        self.assertEqual(spawn.call_args.args, ('verified-workiq.exe', 'accept-eula', '--log-level', 'None'))
        self.assertNotIn('shell', spawn.call_args.kwargs)
        for stream in ['stdin', 'stdout', 'stderr']:
            self.assertEqual(spawn.call_args.kwargs[stream], subprocess.DEVNULL)
        if os.name == 'nt':
            self.assertEqual(spawn.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)
        process.kill.assert_not_called()

    async def test_failed_accept_keeps_consent_required_and_does_not_discover(self):
        from hindsightkit.connectors.workiq.sync import MailSync
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'mail'
            runner = MailSync(directory, 'unused')
            runner._run_update(error=EULA_ERROR)
            runner.discover = AsyncMock()
            adapter = Adapter(directory, {'apiUrl': 'unused'})
            adapter.sync = runner
            with patch.object(adapter, 'availability', return_value={'ready': True}), \
                 patch('hindsightkit.connectors.workiq.adapter._accept_workiq_eula', new_callable=AsyncMock, side_effect=ValueError('Acceptance failed')):
                try:
                    with self.assertRaisesRegex(ValueError, 'Acceptance failed'):
                        await adapter.action('accept-eula', {'accepted': True})
                    self.assertTrue(adapter.status()['consent']['required'])
                    self.assertFalse(adapter.status()['config']['enabled'])
                    runner.discover.assert_not_awaited()
                finally:
                    await adapter.close()

    async def test_accept_process_failure_is_safe_and_timeout_reaps_child(self):
        for failure in [TimeoutError(), asyncio.CancelledError(), OSError('private upstream detail')]:
            with self.subTest(failure=type(failure).__name__):
                process = Mock(returncode=None, wait=AsyncMock(side_effect=[failure, 0]))
                with patch('hindsightkit.connectors.workiq.source.find_workiq', return_value='verified-workiq.exe'), \
                     patch('hindsightkit.connectors.workiq.adapter.asyncio.create_subprocess_exec', new_callable=AsyncMock, return_value=process):
                    expected = asyncio.CancelledError if isinstance(failure, asyncio.CancelledError) else ValueError
                    with self.assertRaises(expected) as caught:
                        await _accept_workiq_eula()
                    self.assertNotIn('private upstream detail', str(caught.exception))
                process.kill.assert_called_once()
                self.assertEqual(process.wait.await_count, 2)
        process = Mock(returncode=1, wait=AsyncMock(return_value=1))
        with patch('hindsightkit.connectors.workiq.source.find_workiq', return_value='verified-workiq.exe'), \
             patch('hindsightkit.connectors.workiq.adapter.asyncio.create_subprocess_exec', new_callable=AsyncMock, return_value=process):
            with self.assertRaisesRegex(ValueError, 'could not accept'):
                await _accept_workiq_eula()


class IndependentAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_registered_adapters_route_configuration_and_cleanup_independently(self):
        specs = (Connector('first','First','', 'fixture.first','first','first.html'),
                 Connector('second','Second','', 'fixture.second','second','second.html'))
        calls = []
        class Fake:
            def __init__(self, directory, config):
                self.directory, self.error = directory, None
            def status(self): return {'config':{'enabled':False},'availability':{'ready':True},'bank':self.directory.name}
            async def action(self, action, data): calls.append((self.directory.name,action,data)); return self.status()
            async def boot(self):
                calls.append((self.directory.name,'boot'))
                if self.directory.name == 'first': raise RuntimeError('isolated failure')
            async def close(self): calls.append((self.directory.name,'close'))
        with tempfile.TemporaryDirectory() as temp, patch('hindsightkit.connectors.registry.import_module', return_value=SimpleNamespace(Adapter=Fake)) as importer:
            root=Path(temp)
            for spec in specs: (root/spec.directory).mkdir()
            host=ConnectorHost(root, {}, registry=specs)
            self.assertEqual(host.adapters,{})
            with self.assertRaises(ValueError): await host.action('../arbitrary','start')
            importer.assert_not_called()
            await host.action('first','config',{'local':1})
            await host.action('second','config',{'remote':2})
            await host.boot()
            self.assertEqual(host.status('first')['bank'],'first')
            self.assertEqual(host.status('second')['bank'],'second')
            self.assertIn(('second','boot'),calls)
            await host.close()
            self.assertIn(('first','close'),calls)
            self.assertIn(('second','close'),calls)

    async def test_unused_optional_reads_do_not_import_adapters_or_create_state(self):
        with tempfile.TemporaryDirectory() as temp, patch('hindsightkit.connectors.registry.import_module') as importer:
            self.assertEqual(await readable_sources({}, Path(temp)), ())
            self.assertEqual(list(Path(temp).iterdir()), [])
            importer.assert_not_called()

    async def test_paused_sources_are_declared_without_loading_acquisition(self):
        with tempfile.TemporaryDirectory() as temp, patch('hindsightkit.connectors.registry.import_module') as importer:
            root = Path(temp)
            settings(root, enabled=False)
            self.assertEqual(readable_connectors(root), ['workiq'])
            sources = await readable_sources({}, root)
            self.assertEqual(sources, (ReadSource('workiq', 'hindsightkit-mail', ('world',), 'mid'),))
            importer.assert_not_called()

    async def test_remote_sources_refresh_and_never_use_local_state(self):
        config = {'hindsightkit': {'mode': 'client', 'connectors': ['workiq']}}
        with patch('hindsightkit.connection.discover', new_callable=AsyncMock,
                   side_effect=[{'connectors': []}, {'connectors': ['workiq']}]) as discover, \
             patch('hindsightkit.connectors.registry.readable_connectors') as local:
            self.assertEqual(await readable_sources(config), ())
            self.assertEqual([source.source for source in await readable_sources(config)], ['workiq'])
            self.assertEqual(discover.await_count, 2)
            local.assert_not_called()

    async def test_fixed_bank_skips_local_and_remote_discovery(self):
        with patch('hindsightkit.connection.discover', new_callable=AsyncMock) as discover, \
             patch('hindsightkit.connectors.registry.readable_connectors') as local:
            for mode in ('server', 'client'):
                self.assertEqual(await readable_sources({'hindsightkit': {'mode': mode, 'bank': 'fixed'}}), ())
            discover.assert_not_called()
            local.assert_not_called()

    async def test_registry_extends_retrieval_without_importing_adapter_code(self):
        specs = tuple(Connector(name, name, '', 'fixture.' + name, name, name + '.html',
                                memory=ReadSource(name, 'bank-' + name), memory_state='state.db')
                      for name in ('first', 'second'))
        with patch('hindsightkit.connection.discover', new_callable=AsyncMock,
                   return_value={'connectors': ['second', 'first', 'second']}), \
             patch('hindsightkit.connectors.registry.import_module') as importer:
            result = await readable_sources({'hindsightkit': {'mode': 'client'}}, registry=specs)
            self.assertEqual([source.bank for source in result], ['bank-second', 'bank-first'])
            importer.assert_not_called()

    async def test_unknown_or_malformed_remote_sources_are_not_silently_ignored(self):
        for advertised in (['unknown'], 'workiq', [None]):
            with self.subTest(advertised=advertised), \
                 patch('hindsightkit.connection.discover', new_callable=AsyncMock,
                       return_value={'connectors': advertised}):
                with self.assertRaisesRegex(ValueError, 'unsupported connector'):
                    await readable_sources({'hindsightkit': {'mode': 'client'}})


if __name__ == '__main__':
    unittest.main()
