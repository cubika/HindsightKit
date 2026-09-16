import asyncio
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from aiohttp import ClientSession
from aiohttp.test_utils import TestClient, TestServer
from provenloop import connection, connectors


class FakeSync:
    bank = 'provenloop-mail'

    def __init__(self):
        self.calls = []

    def status(self):
        return {'config': {'enabled': False}, 'run': {'state': 'paused'}}

    async def configure(self, data):
        self.calls.append(data)

    async def preview(self):
        return {'items': [{'subject': '<script>example</script>', 'source': 'raw', 'cleaned': 'clean', 'reason': ''}]}

    async def sync(self):
        self.calls.append('sync')


class ConnectorHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sync = FakeSync()
        self.stopped = asyncio.Event()
        self.client = TestClient(TestServer(connectors.make_app(
            self.sync, port=19078, token='test-token', instance='test-instance',
            hindsight_url='http://localhost:19077', shutdown=self.stopped)))
        await self.client.start_server()
        self.headers = {'Host': '127.0.0.1:19078'}
        self.write_headers = {**self.headers, 'X-ProvenLoop-Token': 'test-token'}

    async def asyncTearDown(self):
        await self.client.close()

    async def test_rebinding_cross_origin_and_missing_token_cannot_change_settings(self):
        for headers in [self.headers, {**self.write_headers, 'Host': 'attacker.example'},
                        {**self.write_headers, 'Origin': 'https://attacker.example'},
                        {**self.write_headers, 'Sec-Fetch-Site': 'cross-site'}]:
            response = await self.client.post('/api/sync', headers=headers, json={})
            self.assertEqual(response.status, 403)
        self.assertFalse(self.sync.calls)

    async def test_status_contains_official_bank_link_and_no_token(self):
        response = await self.client.get('/api/status', headers=self.headers)
        self.assertEqual(response.status, 200)
        value = await response.json()
        self.assertEqual(value['hindsight_url'], 'http://localhost:19077/banks/provenloop-mail')
        self.assertNotIn('test-token', json.dumps(value))
        self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_config_and_preview_are_explicit_and_bounded(self):
        config = {'folder_ids': ['inbox'], 'lookback_days': 7, 'interval_minutes': 0}
        response = await self.client.post('/api/config', headers=self.write_headers, json=config)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.sync.calls, [config])
        response = await self.client.post('/api/config', headers=self.write_headers, json={**config, 'account': 'other'})
        self.assertEqual(response.status, 400)
        response = await self.client.post('/api/config', headers=self.write_headers, data='[]')
        self.assertEqual(response.status, 400)
        response = await self.client.post('/api/preview', headers=self.write_headers, json={})
        self.assertEqual((await response.json())['items'][0]['cleaned'], 'clean')
        self.assertEqual(self.sync.calls, [config])

    async def test_page_replaces_csrf_marker_and_static_route_is_allowlisted(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'connectors.html').write_text('<meta content="__TOKEN__">', encoding='utf-8')
            with patch.object(connectors, 'WEB', directory):
                response = await self.client.get('/', headers=self.headers)
                self.assertEqual(await response.text(), '<meta content="test-token">')
                response = await self.client.get('/service.json', headers=self.headers)
                self.assertEqual(response.status, 404)

    async def test_shutdown_needs_token_and_preserves_sync_settings(self):
        response = await self.client.post('/api/shutdown', headers=self.write_headers, json={})
        self.assertEqual((await response.json())['instance'], 'test-instance')
        self.assertTrue(self.stopped.is_set())
        self.assertFalse(self.sync.calls)


class ConnectorLifecycleTests(unittest.TestCase):
    def test_open_reuses_healthy_api_without_triggering_database_setup(self):
        from provenloop import cli
        from types import SimpleNamespace
        with patch.object(cli, 'prepare_env'), patch.object(cli, 'require_local'), \
             patch.object(cli, 'profile_config', return_value=({}, SimpleNamespace(port=9077,ui_port=19077))), \
             patch.object(cli.connection, 'server_load', return_value={'apiUrl':'http://127.0.0.1:9077'}), \
             patch.object(cli.connection, 'request', new_callable=AsyncMock), \
             patch.object(cli, 'start') as start, \
             patch.object(connectors, 'ensure_running', return_value='http://127.0.0.1:19078'), \
             patch.object(cli.webbrowser, 'open') as browser:
            self.assertEqual(cli.main(['connectors']), 0)
        start.assert_not_called()
        browser.assert_called_once_with('http://127.0.0.1:19078')

    def test_stop_waits_when_http_was_already_closed(self):
        info = {'port':19078,'token':'token','instance':'instance'}
        with patch.object(connectors, 'read_service', side_effect=[info, info, None, None]), \
             patch.object(connectors, 'is_running', return_value=False), \
             patch.object(connectors.time, 'sleep') as sleep, \
             patch.object(connectors, 'service_request') as request:
            connectors.stop(Path('unused'))
        sleep.assert_called_once()
        request.assert_not_called()

    def test_stop_waits_for_worker_state_removal_after_http_stops(self):
        info = {"port": 19078, "token": "local-csrf", "instance": "worker-instance"}
        with patch.object(connectors, "read_service", side_effect=[info, info, info, None, None]), \
             patch.object(connectors, "is_running", return_value=True), \
             patch.object(connectors, "service_request") as request, \
             patch.object(connectors.time, "sleep") as sleep:
            connectors.stop(Path("unused-fixture-directory"))
        request.assert_called_once_with(info, "/api/shutdown", post=True)
        self.assertEqual(sleep.call_count, 2)

    def test_stop_reports_unfinished_worker_without_forcing_termination(self):
        info = {"port": 19078, "token": "local-csrf", "instance": "worker-instance"}
        with patch.object(connectors, "read_service", return_value=info), \
             patch.object(connectors, "is_running", return_value=True), \
             patch.object(connectors, "service_request"), \
             patch.object(connectors.time, "monotonic", side_effect=[0, 61]), \
             patch.object(connectors.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "Hindsight was left running"):
                connectors.stop(Path("unused-fixture-directory"))
        spawn.assert_not_called()

    def test_child_argv_contains_only_origin_and_no_api_credential(self):
        secret = "synthetic-server-api-secret"
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            listener.close()
            process = Mock()
            process.poll.return_value = None
            with patch.object(connectors, "is_running", side_effect=[False, True]), \
                 patch.object(connectors.subprocess, "Popen", return_value=process) as spawn, \
                 patch.object(connection, "load", return_value={"apiUrl": "http://127.0.0.1:9077", "apiToken": secret}) as load:
                connectors.ensure_running(Path(temp), "http://127.0.0.1:9077", "http://localhost:19077", port)
            argv = spawn.call_args.args[0]
            self.assertNotIn(secret, repr(spawn.call_args))
            self.assertNotIn("--api-token", argv)
            self.assertEqual(argv[argv.index("--api-url") + 1], "http://127.0.0.1:9077")
            load.assert_not_called()
            process.terminate.assert_not_called()

    def test_occupied_port_never_launches_or_kills_another_service(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            with patch.object(connectors.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'already in use'):
                    connectors.ensure_running(Path(temp), 'api', 'ui', port)
                spawn.assert_not_called()
            with socket.create_connection(('127.0.0.1', port), timeout=2):
                pass


class ConnectorAuthenticatedServeTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_loads_authenticated_sdk_without_exposing_api_key_in_state(self):
        secret = "synthetic-server-api-secret"
        config = {"apiUrl": "http://127.0.0.1:9077", "apiToken": secret, "provenloop": {"mode": "server"}}
        sdk_client = Mock()
        sync = FakeSync()
        sync.boot, sync.close = AsyncMock(), AsyncMock()
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            directory = Path(temp)
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            listener.close()
            with patch.object(connection, "server_load", return_value=config), \
                 patch.object(connection, "sdk", wraps=connection.sdk) as sdk, \
                 patch.object(connection, "Hindsight", return_value=sdk_client) as hindsight, \
                 patch("provenloop.mail_sync.MailSync", return_value=sync) as make_sync:
                service = asyncio.create_task(connectors.serve(directory, config["apiUrl"], "http://localhost:19077", port))
                try:
                    for _ in range(200):
                        if (directory / "service.json").exists(): break
                        if service.done(): await service
                        await asyncio.sleep(0.01)
                    record = connectors.read_service(directory)
                    self.assertIsNotNone(record)
                    sdk.assert_called_once_with(config, timeout=120)
                    hindsight.assert_called_once_with(base_url=config["apiUrl"], api_key=secret, timeout=120)
                    make_sync.assert_called_once_with(directory, config["apiUrl"], client=sdk_client)
                    self.assertNotIn(secret, (directory / "service.json").read_text())
                    async with ClientSession() as client:
                        async with client.get(f"http://127.0.0.1:{port}/api/status") as response:
                            self.assertEqual(response.status, 200)
                            self.assertNotIn(secret, await response.text())
                        async with client.post(f"http://127.0.0.1:{port}/api/shutdown",
                                               headers={"X-ProvenLoop-Token": record["token"]}) as response:
                            self.assertEqual(response.status, 200)
                    await asyncio.wait_for(service, 3)
                    self.assertFalse((directory / "service.json").exists())
                    sync.boot.assert_awaited_once()
                    sync.close.assert_awaited_once()
                finally:
                    if not service.done(): service.cancel()
                    await asyncio.gather(service, return_exceptions=True)

    async def test_client_installation_rejected_before_sdk_or_mail_runner_created(self):
        config = {"apiUrl": "https://memory.example.invalid", "apiToken": "synthetic-client-secret",
                  "provenloop": {"mode": "client", "bank": "shared-on-server"}}
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(connection, "server_load", side_effect=RuntimeError('No local Hindsight server')), \
             patch.object(connection, "sdk") as sdk, \
             patch("provenloop.mail_sync.MailSync") as runner:
            with self.assertRaisesRegex(RuntimeError, "local Hindsight server"):
                await connectors.serve(Path(temp), config["apiUrl"], "http://localhost:19077", 19078)
            sdk.assert_not_called()
            runner.assert_not_called()
            self.assertFalse((Path(temp) / "service.json").exists())


if __name__ == '__main__':
    unittest.main()
