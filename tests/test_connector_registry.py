import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from provenloop.connector_registry import Connector, ConnectorHost, enabled_connectors, register_tools
from provenloop.workiq_connector import Adapter, DEFAULT, saved_status
from provenloop.mail_source import WorkIQError


def settings(root, enabled=False):
    directory = root / 'mail'
    directory.mkdir()
    db = sqlite3.connect(directory / 'sync.sqlite3')
    with db:
        db.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
        db.execute('INSERT INTO settings VALUES (?,?)', ('config', json.dumps({**DEFAULT['config'], 'enabled':enabled})))
    db.close()
    return directory


class OptionalConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_unused_catalog_and_boot_do_not_create_runtime_or_call_dependencies(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch('provenloop.mail_source.find_workiq', side_effect=WorkIQError('workiq_1_0_0_not_found')), \
             patch('provenloop.mail_sync.MailSync') as runner, \
             patch('provenloop.connection.sdk') as sdk:
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
             patch('provenloop.mail_source.find_workiq', side_effect=WorkIQError('workiq_1_0_0_not_found')), \
             patch('provenloop.mail_sync.MailSync') as runner, patch('provenloop.connection.sdk') as sdk:
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
                with patch('provenloop.mail_source.find_workiq', side_effect=WorkIQError('missing')) as probe, \
                     patch('provenloop.mail_sync.MailSync') as runner:
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
        fake.status.return_value = deepcopy(DEFAULT)
        fake.discover = AsyncMock()
        fake.pause, fake.close, fake.boot = AsyncMock(), AsyncMock(), AsyncMock()
        config = {'apiUrl':'http://127.0.0.1:9077','apiToken':'test-private-token'}
        with tempfile.TemporaryDirectory() as temp, patch('provenloop.mail_source.find_workiq', return_value='workiq.exe'), \
             patch('provenloop.mail_sync.MailSync', return_value=fake) as make, \
             patch('provenloop.connection.sdk', return_value='authenticated-client') as sdk:
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
        with tempfile.TemporaryDirectory() as temp, patch('provenloop.mail_source.find_workiq', return_value='workiq.exe'), \
             patch('provenloop.mail_sync.MailSync', return_value=fake) as make, \
             patch('provenloop.connection.sdk', return_value='client'):
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
            with db:
                db.execute('CREATE TABLE messages(payload TEXT)')
                db.execute('INSERT INTO messages VALUES (?)', ('pending-private-data',))
                db.execute('CREATE TABLE receipts(metadata TEXT, error TEXT)')
                db.execute('INSERT INTO receipts VALUES (?,?)', (json.dumps({'subject':'Unavailable mail'}), 'protected'))
            db.close()
            with patch('provenloop.mail_sync.MailSync') as make:
                value = saved_status(directory)
            make.assert_not_called()
            self.assertEqual(value['run']['pending'],1)
            self.assertEqual(value['failures'],[{'subject':'Unavailable mail','reason':'protected'}])
            self.assertNotIn('pending-private-data',json.dumps(value))

    async def test_public_start_requires_installed_source_before_enabling(self):
        from provenloop.mail_sync import MailSync
        with tempfile.TemporaryDirectory() as temp:
            runner = MailSync(Path(temp), 'unused')
            runner._put('config', {**DEFAULT['config'], 'folder_ids':['inbox']})
            try:
                with patch('provenloop.mail_source.find_workiq', side_effect=WorkIQError('missing')):
                    for method in [runner.start, runner.sync]:
                        with self.assertRaises(WorkIQError):
                            await method()
                self.assertFalse(runner.status()['config']['enabled'])
                self.assertIsNone(runner._task)
            finally:
                await runner.close()


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
        with tempfile.TemporaryDirectory() as temp, patch('provenloop.connector_registry.import_module', return_value=SimpleNamespace(Adapter=Fake)) as importer:
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

    def test_unused_optional_tools_do_not_import_adapters(self):
        with tempfile.TemporaryDirectory() as temp, patch('provenloop.connector_registry.import_module') as importer:
            register_tools(Mock(), {}, Path(temp))
            importer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
