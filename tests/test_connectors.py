import asyncio
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from provenloop import connectors


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


if __name__ == '__main__':
    unittest.main()
