import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastmcp.exceptions import ToolError

from hindsightkit.platform import config as profile_env
from hindsightkit import cli
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env
from hindsightkit import connection
from hindsightkit import hooks
from hindsightkit.platform import lifecycle
from hindsightkit import mcp
from hindsightkit.sharing import remote
from hindsightkit.memory.api import Scope


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config_path = self.root / 'client.json'
        self.config = {'apiUrl': 'https://memory.example.invalid', 'apiToken': 'fixture-key',
                       'hindsightkit': {'mode': 'client', 'routing': 'repository',
                                       'deviceId': 'fixture', 'connectors': ['workiq']}}
        self.config_path.write_text(json.dumps(self.config))
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'HINDSIGHTKIT_HOME': str(self.root / 'state'),
                                'HINDSIGHT_CONFIG': str(self.config_path),
                                'COPILOT_AGENT_SESSION_ID': '', 'HINDSIGHT_DISABLE_HOOKS': ''}).start()
        patch.object(runtime_env, 'prepare_env').start()

    def test_running_mcp_honors_stop_start_and_disconnect_before_any_transport(self):
        async def check():
            server = mcp.FastMCP('Lifecycle fixture')
            result = SimpleNamespace(model_dump=lambda **kwargs: {'results': []})
            client = SimpleNamespace(aretain=AsyncMock(return_value=result),
                                     arecall=AsyncMock(return_value=result),
                                     areflect=AsyncMock(return_value=result), aclose=AsyncMock())
            with patch.object(mcp, 'FastMCP', return_value=server), patch.object(mcp, 'run_stdio'), \
                 patch.object(mcp, 'resolve', new_callable=AsyncMock, return_value=Scope('fixture')) as resolve, \
                 patch.object(connection, 'sdk', return_value=client) as sdk, \
                 patch.object(connection, 'discover', new_callable=AsyncMock, return_value={'connectors': ['workiq']}) as discover, \
                 patch.object(remote, 'prepare_client') as prepare:
                mcp.serve('cli', str(self.root))
                await server.call_tool('recall', {'query': 'fixture'})
                sdk.reset_mock(); prepare.reset_mock(); resolve.reset_mock(); discover.reset_mock()
                lifecycle.stop()
                for name, arguments in [('recall', {'query': 'fixture'}), ('retain', {'content': 'fixture'}),
                                        ('reflect', {'query': 'fixture'})]:
                    with self.assertRaisesRegex(ToolError, 'stopped'):
                        await server.call_tool(name, arguments)
                for operation in (sdk, prepare, resolve, discover):
                    operation.assert_not_called()
                lifecycle.start()
                await server.call_tool('recall', {'query': 'fixture'})
                self.assertTrue(sdk.called)
                sdk.reset_mock(); prepare.reset_mock()
                lifecycle.disconnect()
                with self.assertRaisesRegex(ToolError, 'disconnected'):
                    await server.call_tool('recall', {'query': 'fixture'})
                lifecycle.start()
                with self.assertRaisesRegex(ToolError, 'disconnected'):
                    await server.call_tool('recall', {'query': 'fixture'})
                lifecycle.connected()
                with self.assertRaisesRegex(ToolError, 'connection changed'):
                    await server.call_tool('recall', {'query': 'fixture'})
                sdk.assert_not_called(); prepare.assert_not_called()
        asyncio.run(check())

    def test_stop_direct_client_blocks_memory_and_relay_recovery_until_start(self):
        with patch.object(connection, 'has_server', return_value=False), \
             patch('hindsightkit.sharing.relay.stop') as stop, patch('hindsightkit.sharing.relay.ensure_running') as ensure, \
             patch('hindsightkit.sharing.relay.load_spec', return_value=None):
            self.assertEqual(cli.main(['stop']), 0)
            self.assertTrue(lifecycle.state()['stopped'])
            with self.assertRaisesRegex(RuntimeError, 'stopped'):
                remote.prepare_client(self.config)
            remote.resume()
            ensure.assert_not_called()
            self.assertEqual(cli.main(['start']), 0)
            remote.prepare_client(self.config)
            self.assertFalse(lifecycle.state()['stopped'])
            stop.assert_called_once()

    def test_client_unshare_forgets_credentials_and_does_not_resume_on_start(self):
        with patch.object(connection, 'has_server', return_value=False), \
             patch('hindsightkit.sharing.relay.stop'), patch('hindsightkit.sharing.relay.ensure_running') as ensure, \
             patch('hindsightkit.sharing.relay.load_spec', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            remote.unshare()
            self.assertNotIn('apiToken', json.loads(self.config_path.read_text()))
            self.assertTrue(lifecycle.state()['disconnected'])
            lifecycle.start()
            remote.resume()
            ensure.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, 'disconnected'):
                remote.prepare_client(self.config)

    def hook(self, name, session):
        event = {'sessionId': session, 'cwd': str(self.root), 'prompt': 'fixture'}
        with patch('sys.stdin', io.StringIO(json.dumps(event))), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            hooks.run(name)

    def test_hooks_never_backfill_sessions_spanning_stop_or_started_while_stopped(self):
        with patch.object(hooks, 'resolve', new_callable=AsyncMock, return_value=Scope('fixture')), \
             patch.object(hooks, 'prompt_memory', new_callable=AsyncMock, return_value={'memories': []}) as recall, \
             patch.object(remote, 'prepare_client') as prepare, patch.object(hooks, 'runtime') as runtime:
            self.hook('sessionStart', 'before')
            lifecycle.stop()
            self.hook('sessionStart', 'during')
            self.hook('agentStop', 'before')
            self.hook('userPromptTransformed', 'during')
            prepare.assert_not_called(); recall.assert_not_called(); runtime.assert_not_called()
            lifecycle.start()
            self.hook('agentStop', 'before')
            self.hook('agentStop', 'during')
            runtime.assert_not_called()
            self.hook('userPromptTransformed', 'before')
            recall.assert_awaited_once()
            self.hook('sessionStart', 'fresh')
            record = next(json.loads(path.read_text()) for path in (runtime_env.home() / 'sessions').glob('*.json')
                          if json.loads(path.read_text())['_service_epoch'] == lifecycle.state()['capture_epoch'])
            self.assertIsNotNone(record['_service_epoch'])

    def test_status_memory_test_uses_local_memory_and_only_discovers_remote(self):
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'local-key'}
        with patch.object(connection, 'has_server', return_value=True), \
             patch.object(connection, 'server_load', return_value=local), \
             patch.object(services, 'server_status', return_value=True) as server_status, \
             patch.object(connection, 'request', new_callable=AsyncMock, return_value={'protocol': 1, 'routing': 'repository', 'sharedBank': 'fixture'}) as request, \
             patch.object(profile_env, 'profile_config', return_value=({'HINDSIGHT_EMBED_API_DATABASE_URL': 'postgresql://fixture'}, None)), \
             patch('hindsightkit.setup.postgres.Postgres') as database, \
             patch('hindsightkit.setup.postgres.check_external', new_callable=AsyncMock), \
             patch.object(services, 'check_memory', new_callable=AsyncMock) as memory, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            database.return_value.state_path.is_file.return_value = False
            self.assertEqual(cli.main(['status', '--test-memory']), 0)
            memory.assert_awaited_once_with(local['apiUrl'], local['apiToken'])
            request.assert_awaited_once_with(self.config, 'GET', '/ext/hindsightkit/connection', timeout=5)
            memory.reset_mock()
            request.side_effect = None
            server_status.return_value = False
            self.assertEqual(cli.main(['status', '--test-memory']), 1)
            memory.assert_awaited_once_with(local['apiUrl'], local['apiToken'])
            self.assertIn(self.config['apiUrl'], output.getvalue())
            self.assertIn(local['apiUrl'], output.getvalue())
            memory.reset_mock()
            server_status.return_value = True
            request.side_effect = RuntimeError('unreachable')
            self.assertEqual(cli.main(['status', '--test-memory']), 1)
            memory.assert_awaited_once_with(local['apiUrl'], local['apiToken'])

    def test_status_memory_test_client_only_never_writes_a_remote_test_bank(self):
        with patch.object(connection, 'has_server', return_value=False), \
             patch.object(connection, 'request', new_callable=AsyncMock, return_value={'protocol': 1, 'routing': 'repository', 'sharedBank': 'fixture'}) as request, \
             patch.object(services, 'check_memory', new_callable=AsyncMock) as memory, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['status', '--test-memory']), 0)
            request.assert_awaited_once()
            memory.assert_not_awaited()
            self.assertIn('skipped (no local server', output.getvalue())

    def test_status_does_not_call_models_without_explicit_flag(self):
        for has_server in (False, True):
            with self.subTest(has_server=has_server), \
                 patch.object(connection, 'has_server', return_value=has_server), \
                 patch.object(connection, 'discover', new_callable=AsyncMock), \
                 patch('hindsightkit.sharing.remote.status') as relay_status, \
                 patch.object(services, 'server_status', return_value=True) as local_status, \
                 patch.object(services, 'check_memory', new_callable=AsyncMock) as memory, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['status']), 0)
                relay_status.assert_called_once()
                self.assertEqual(local_status.call_count, int(has_server))
                memory.assert_not_awaited()

    def test_stopped_status_keeps_service_output_but_skips_memory_test(self):
        lifecycle.stop()
        with patch.object(connection, 'has_server', return_value=True), \
             patch('hindsightkit.sharing.remote.status') as relay_status, \
             patch.object(services, 'server_status', return_value=False) as local_status, \
             patch.object(services, 'check_memory', new_callable=AsyncMock) as memory, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['status', '--test-memory']), 1)
            relay_status.assert_called_once()
            local_status.assert_called_once()
            memory.assert_not_awaited()
            self.assertIn('Run hindsightkit start', output.getvalue())

    def test_memory_test_failure_does_not_hide_status_and_has_nonzero_exit(self):
        with patch.object(connection, 'has_server', return_value=True), \
             patch.object(connection, 'discover', new_callable=AsyncMock), \
             patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077'}), \
             patch.object(services, 'server_status', return_value=True) as local_status, \
             patch.object(profile_env, 'profile_config', return_value=({'HINDSIGHT_EMBED_API_DATABASE_URL': 'postgresql://fixture'}, None)), \
             patch('hindsightkit.setup.postgres.Postgres') as database, \
             patch('hindsightkit.setup.postgres.check_external', new_callable=AsyncMock), \
             patch.object(services, 'check_memory', new_callable=AsyncMock, side_effect=RuntimeError('memory fixture failed')), \
             contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as error:
            database.return_value.state_path.is_file.return_value = False
            self.assertEqual(cli.main(['status', '--test-memory']), 1)
            local_status.assert_called_once()
            self.assertIn('Client: connected', output.getvalue())
            self.assertIn('memory fixture failed', error.getvalue())

    def test_removed_public_commands_are_not_accepted(self):
        for name in ['setup', 'copilot', 'check']:
            with self.subTest(name=name), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cli.main([name])

    def test_server_unshare_revokes_old_key_preserves_local_client_and_survives_start(self):
        from hindsight_api.extensions.builtin.tenant import ApiKeyTenantExtension
        from hindsight_api.extensions.tenant import AuthenticationError
        from hindsight_api.models import RequestContext
        from hindsight_embed.profile_manager import ProfileManager
        profile_path = self.root / 'profile.env'
        profile_path.write_text('HINDSIGHT_API_HOST=0.0.0.0\nHINDSIGHT_API_PORT=9077\n'
                                'HINDSIGHT_API_TENANT_API_KEY=old-key\n')
        paths = SimpleNamespace(config=profile_path, port=9077)
        manager = ProfileManager.__new__(ProfileManager)
        def profile():
            with patch.object(manager, 'resolve_profile_paths', return_value=paths):
                return manager.load_profile_config(runtime_env.PROFILE), paths
        local = {**self.config, 'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'old-key'}
        self.config_path.write_text(json.dumps(local))
        shared = runtime_env.home() / 'remote/host/spec.json'
        shared.parent.mkdir(parents=True)
        shared.write_text('{}')
        with patch.object(connection, 'has_server', return_value=True), \
             patch.object(profile_env, 'profile_config', side_effect=profile), \
             patch.object(services, 'stop_profile_services') as stop, patch.object(services, 'start_local') as start, \
             patch('hindsightkit.sharing.remote.stop'), \
             patch('hindsight_embed.daemon_embed_manager.DaemonEmbedManager') as daemon, \
             contextlib.redirect_stdout(io.StringIO()):
            daemon.return_value.is_running.return_value = True
            remote.unshare()
            updated, _ = profile()
            new_key = updated['HINDSIGHT_API_TENANT_API_KEY']
            self.assertNotEqual(new_key, 'old-key')
            self.assertEqual(updated['HINDSIGHT_API_HOST'], '127.0.0.1')
            self.assertEqual(json.loads(self.config_path.read_text())['apiToken'], new_key)
            self.assertEqual((runtime_env.home() / 'server/connection-key.txt').read_text(), new_key)
            self.assertFalse(shared.exists())
            self.assertTrue(lifecycle.available())
            stop.assert_called_once_with(remote_connections=False)
            start.assert_called_once_with(message='Restarting local Hindsight services to revoke shared access...')
            extension = ApiKeyTenantExtension({'api_key': new_key})
            with self.assertRaises(AuthenticationError):
                asyncio.run(extension.authenticate(RequestContext(api_key='old-key')))
            with patch('hindsight_api.extensions.builtin.tenant.get_config',
                       return_value=SimpleNamespace(database_schema='fixture')):
                self.assertEqual(asyncio.run(extension.authenticate(RequestContext(api_key=new_key))).schema_name, 'fixture')
            # An ordinary upgrade must preserve disabled sharing.
            services.configure_sharing(new_key, 'hindsightkit-shared', enabled=None)
            self.assertEqual(profile()[0]['HINDSIGHT_API_HOST'], '127.0.0.1')

    def test_stop_attempts_api_shutdown_even_when_dashboard_stop_fails(self):
        with patch.object(connection, 'has_server', return_value=True), patch.object(remote, 'stop'), \
             patch('hindsightkit.connectors.host.stop'), patch.object(runtime_env, 'run') as run, \
             patch('hindsight_embed.daemon_embed_manager.DaemonEmbedManager') as daemon, \
             patch.object(profile_env, 'profile_config', return_value=({'HINDSIGHT_EMBED_API_DATABASE_URL': 'postgresql://fixture'}, None)), \
             patch('hindsightkit.setup.postgres.Postgres') as database, contextlib.redirect_stderr(io.StringIO()):
            run.side_effect = [RuntimeError('dashboard failure'), None]
            database.return_value.state_path.is_file.return_value = False
            self.assertEqual(cli.main(['stop']), 1)
            self.assertEqual([call.args[0][-2:] for call in run.call_args_list], [['ui', 'stop']])
            daemon.return_value.stop.assert_called_once_with(runtime_env.PROFILE)
            self.assertTrue(lifecycle.state()['stopped'])

    def test_busy_api_is_stopped_without_health_gate_and_failure_is_reported(self):
        with patch('hindsightkit.sharing.remote.stop'), patch('hindsightkit.connectors.host.stop'), \
             patch('hindsight_embed.daemon_embed_manager.DaemonEmbedManager') as daemon:
            daemon.return_value.is_ui_running.return_value = False
            daemon.return_value.is_running.return_value = False
            daemon.return_value.stop.return_value = False
            with self.assertRaisesRegex(RuntimeError, 'could not be stopped'):
                services.stop_profile_services()
            daemon.return_value.stop.assert_called_once_with(runtime_env.PROFILE)
            daemon.return_value.is_running.assert_not_called()


if __name__ == '__main__':
    unittest.main()
