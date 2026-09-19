import argparse
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import aiohttp
import hindsightkit
from hindsightkit.platform import config as profile_env
from hindsightkit import cli
from hindsightkit.setup import installer
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env
from hindsightkit import connection
from hindsightkit.sharing import remote
from hindsightkit.sharing import log as relay_log


def options(**values):
    return argparse.Namespace(**dict(dict(local=False, server=None, api_key_env=None,
                                         relay=False, address=None, relay_provider=None), **values))


class InvitationTests(unittest.TestCase):
    def test_invitation_round_trip_preserves_only_connection_fields(self):
        invitation = {'version': 1, 'url': 'https://memory.example.com/', 'key': 'synthetic-secret',
                      'relay': {'tunnel_id': 'test-tunnel.euw', 'remote_port': 9077, 'command': 'ignored'},
                      'command': 'ignored'}
        code = remote.encode_invitation(invitation)
        self.assertNotIn('synthetic-secret', code)
        self.assertEqual(remote.decode_invitation(code),
                         {'version': 1, 'url': 'https://memory.example.com', 'key': 'synthetic-secret',
                          'relay': {'tunnel_id': 'test-tunnel.euw', 'remote_port': 9077}})

    def test_invalid_invitation_never_accepts_executable_or_malformed_transport(self):
        base = {'version': 1, 'url': 'https://memory.example.com', 'key': 'synthetic-secret'}
        mutations = [{'version': True}, {'version': 2}, {'url': 42}, {'url': 'file:///C:/secret'},
                     {'url': 'https://user:password@memory.example.com'}, {'url': 'https://memory.example.com/path'},
                     {'key': 'secret\nvalue'}, {'key': 3}, {'relay': {'tunnel_id': '../other', 'remote_port': 9077}},
                     {'relay': {'tunnel_id': '--command', 'remote_port': 9077}},
                     {'relay': {'tunnel_id': 'safe', 'remote_port': True}},
                     {'relay': {'tunnel_id': 'safe', 'remote_port': 65536}}]
        for changes in mutations:
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError) as error:
                    remote.decode_invitation(remote.encode_invitation(dict(base, **changes)))
                self.assertNotIn('synthetic-secret', str(error.exception))
        for code in ('hk1.???', 'hk1.' + 'a' * 5000, 'wrong', None):
            with self.subTest(code=str(code)[:10]), self.assertRaises(ValueError):
                remote.decode_invitation(code)


class ClipboardTests(unittest.TestCase):
    def test_copy_passes_only_the_code_over_stdin_with_a_timeout(self):
        code = remote.encode_invitation({'version': 1, 'url': 'http://memory-host:9077', 'key': 'fixture-key'})
        with patch.object(remote, 'os', SimpleNamespace(name='nt')), \
                patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
                patch.object(remote.subprocess, 'run') as run:
            self.assertTrue(remote.copy_connection_code(code))
        self.assertEqual(run.call_args.kwargs['input'], code)
        self.assertNotIn(code, repr(run.call_args.args))
        self.assertEqual(run.call_args.kwargs['timeout'], 5)

    def test_unsupported_platform_skips_clipboard_process(self):
        with patch.object(remote, 'os', SimpleNamespace(name='posix')), \
                patch.object(remote.subprocess, 'run') as run:
            self.assertFalse(remote.copy_connection_code('hk1.fixture'))
        run.assert_not_called()


class RemoteTests(unittest.TestCase):
    @contextlib.contextmanager
    def environment(self, *, invitation=None, previous=None):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            path = root / 'coding-agent.json'
            previous = previous or {'apiUrl': 'http://old-host:9077', 'apiToken': 'old-key',
                                    'hindsightkit': {'mode': 'client'}, 'unrelated': 'preserve'}
            path.write_text(json.dumps(previous), encoding='utf-8')
            saved = path.read_bytes()
            invitation = invitation or {'version': 1, 'url': 'http://new-host:9077', 'key': 'new-key',
                                       'relay': {'tunnel_id': 'new-tunnel', 'remote_port': 9077}}
            relay = ModuleType('hindsightkit.sharing.relay')
            relay.ensure_running = Mock()
            relay.create_host = Mock(return_value={'mode': 'host', 'tunnel_id': 'test-tunnel', 'remote_port': 9077})
            relay.stop = Mock()
            relay.load_spec = Mock(return_value=None)
            stack.enter_context(patch.dict('sys.modules', {'hindsightkit.sharing.relay': relay}))
            stack.enter_context(patch.object(hindsightkit.sharing, 'relay', relay, create=True))
            stack.enter_context(patch.object(runtime_env, 'home', return_value=root))
            stack.enter_context(patch.object(profile_env, 'profile_config', return_value=({}, None)))
            stack.enter_context(patch.object(connection, 'config_path', return_value=path))
            prompt = stack.enter_context(patch.object(remote.getpass, 'getpass', return_value=remote.encode_invitation(invitation)))
            setup = stack.enter_context(patch.object(installer, 'setup_client'))
            stop_clients = stack.enter_context(patch.object(remote, 'stop_clients'))
            clipboard = stack.enter_context(patch.object(remote, 'copy_connection_code', return_value=True))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield SimpleNamespace(root=root, path=path, previous=previous, saved=saved, invitation=invitation,
                                  relay=relay, prompt=prompt, setup=setup, stop_clients=stop_clients,
                                  clipboard=clipboard, output=output)

    def test_direct_success_never_starts_or_creates_relay(self):
        with self.environment() as state, patch.object(connection, 'discover', new_callable=AsyncMock) as discover:
            remote.connect(options())
            state.prompt.assert_called_once_with('Connection code (hidden): ')
            self.assertEqual(discover.await_args.args[0], {'apiUrl': 'http://new-host:9077', 'apiToken': 'new-key'})
            state.relay.ensure_running.assert_not_called()
            state.relay.create_host.assert_not_called()
            state.setup.assert_called_once()
            self.assertIsNone(state.setup.call_args.kwargs['transport'])
            state.stop_clients.assert_called_once_with(except_transport=None)
            self.assertNotIn('new-key', state.output.getvalue())

    def test_http_auth_and_incompatible_protocol_never_fall_back_or_change_config(self):
        for status, payload in [(401, {'error': 'unauthorized'}), (200, {'protocol': 2, 'routing': 'repository'})]:
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.server.authorization = self.headers.get('Authorization')
                    body = json.dumps(payload).encode()
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

                def log_message(self, *args):
                    pass

            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            invitation = {'version': 1, 'url': f'http://127.0.0.1:{server.server_port}', 'key': 'new-key',
                          'relay': {'tunnel_id': 'new-tunnel', 'remote_port': 9077}}
            try:
                with self.subTest(status=status), self.environment(invitation=invitation) as state:
                    with self.assertRaises(RuntimeError):
                        remote.connect(options())
                    state.relay.ensure_running.assert_not_called()
                    state.setup.assert_not_called()
                    state.stop_clients.assert_not_called()
                    self.assertEqual(state.path.read_bytes(), state.saved)
                    self.assertEqual(server.authorization, 'Bearer new-key')
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_network_failure_without_relay_leaves_saved_connection(self):
        invitation = {'version': 1, 'url': 'http://unreachable:9077', 'key': 'new-key'}
        with self.environment(invitation=invitation) as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock, side_effect=aiohttp.ClientConnectionError()):
            with self.assertRaisesRegex(RuntimeError, 'share --relay'):
                remote.connect(options())
            state.setup.assert_not_called()
            state.relay.ensure_running.assert_not_called()
            self.assertEqual(state.path.read_bytes(), state.saved)

    def test_tls_validation_error_never_triggers_relay(self):
        error = aiohttp.ClientConnectorCertificateError(Mock(), ssl.CertificateError('untrusted certificate'))
        with self.environment() as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock, side_effect=error):
            with self.assertRaises(aiohttp.ClientConnectorCertificateError):
                remote.connect(options())
            state.relay.ensure_running.assert_not_called()
            state.setup.assert_not_called()
            self.assertEqual(state.path.read_bytes(), state.saved)

    def test_network_failure_allocates_a_free_port_and_passes_transport(self):
        with self.environment() as state, patch.object(connection, 'discover', new_callable=AsyncMock) as discover:
            discover.side_effect = [aiohttp.ClientConnectionError(), {'protocol': 1, 'routing': 'repository'}]
            listener = Mock()
            listener.getsockname.return_value = ('127.0.0.1', 41234)
            context = Mock()
            context.__enter__ = Mock(return_value=listener)
            context.__exit__ = Mock(return_value=False)
            socket_module = SimpleNamespace(socket=Mock(return_value=context), gaierror=remote.socket.gaierror)
            with patch.object(remote, 'socket', socket_module):
                remote.connect(options())
            listener.bind.assert_called_once_with(('127.0.0.1', 0))
            transport = {'mode': 'connect', 'tunnel_id': 'new-tunnel', 'remote_port': 9077, 'local_port': 41234}
            state.relay.ensure_running.assert_called_once_with(remote.client_root(transport), transport,
                                                               interactive=True, provider=None)
            self.assertEqual(state.setup.call_args.kwargs['transport'], transport)
            self.assertEqual(state.setup.call_args.kwargs['local_server']['apiUrl'], 'http://127.0.0.1:41234')
            state.stop_clients.assert_called_once_with(except_transport=transport)
            self.assertNotIn('key', state.relay.ensure_running.call_args.args[1])

    def test_reconnecting_same_relay_keeps_saved_local_port(self):
        transport = {'mode': 'connect', 'tunnel_id': 'new-tunnel', 'remote_port': 9077, 'local_port': 43210}
        previous = {'apiUrl': 'http://127.0.0.1:43210', 'apiToken': 'old-key',
                    'hindsightkit': {'mode': 'client', 'transport': transport}}
        with self.environment(previous=previous) as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock, side_effect=[TimeoutError(), {'protocol': 1, 'routing': 'repository', 'sharedBank': 'fixture'}]), \
             patch.object(remote, 'socket', SimpleNamespace(socket=Mock(), gaierror=remote.socket.gaierror)) as socket_module:
            remote.connect(options())
            socket_module.socket.assert_not_called()
            self.assertEqual(state.setup.call_args.kwargs['transport'], transport)
            state.relay.stop.assert_not_called()

    def test_failed_relay_candidate_stops_only_its_process_and_preserves_configuration(self):
        for failure in ('discovery', 'setup'):
            with self.subTest(failure=failure), self.environment() as state, \
                 patch.object(connection, 'discover', new_callable=AsyncMock) as discover:
                discover.side_effect = [TimeoutError(), RuntimeError('candidate rejected') if failure == 'discovery' else {}]
                if failure == 'setup':
                    state.setup.side_effect = RuntimeError('candidate rejected')
                with self.assertRaisesRegex(RuntimeError, 'candidate rejected'):
                    remote.connect(options())
                state.relay.stop.assert_called_once_with(state.relay.ensure_running.call_args.args[0])
                state.stop_clients.assert_not_called()
                self.assertEqual(state.path.read_bytes(), state.saved)

    def test_failed_existing_relay_candidate_keeps_previous_process(self):
        transport = {'mode': 'connect', 'tunnel_id': 'new-tunnel', 'remote_port': 9077, 'local_port': 43210}
        previous = {'apiUrl': 'http://127.0.0.1:43210', 'apiToken': 'old-key',
                    'hindsightkit': {'mode': 'client', 'transport': transport}}
        with self.environment(previous=previous) as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock,
                          side_effect=[TimeoutError(), RuntimeError('wrong key')]):
            with self.assertRaisesRegex(RuntimeError, 'wrong key'):
                remote.connect(options())
            state.relay.stop.assert_not_called()
            state.setup.assert_not_called()
            self.assertEqual(state.path.read_bytes(), state.saved)

    def test_relay_api_timeout_identifies_the_stage_and_preserves_stopped_client(self):
        from hindsightkit.platform import lifecycle
        for reused in (False, True):
            transport = {'mode': 'connect', 'tunnel_id': 'new-tunnel', 'remote_port': 9077, 'local_port': 43210}
            previous = {'apiUrl': 'http://127.0.0.1:43210', 'apiToken': 'old-key',
                        'hindsightkit': {'mode': 'client', 'transport': transport}} if reused else None
            with self.subTest(reused=reused), self.environment(previous=previous) as state, \
                 patch.object(runtime_env, 'prepare_env'), \
                 patch.object(connection, 'discover', new_callable=AsyncMock,
                              side_effect=[TimeoutError(), TimeoutError()]), \
                 contextlib.redirect_stderr(io.StringIO()) as errors:
                lifecycle.stop()
                stopped = lifecycle.path().read_bytes()
                self.assertEqual(cli.main(['connect']), 1)
                self.assertIn('Private relay is ready. Checking the memory server', state.output.getvalue())
                self.assertIn('private relay started, but the memory server could not be reached', errors.getvalue())
                self.assertIn('TimeoutError', errors.getvalue())
                self.assertNotIn('new-key', errors.getvalue())
                self.assertNotIn('old-key', errors.getvalue())
                self.assertEqual(state.path.read_bytes(), state.saved)
                self.assertEqual(lifecycle.path().read_bytes(), stopped)
                log = relay_log.path(state.relay.ensure_running.call_args.args[0])
                self.assertIn(str(log), state.output.getvalue())
                records = [json.loads(line) for line in log.read_text().splitlines()]
                self.assertTrue(any(item['event'] == 'server.discovery.failed'
                                    and item['error'] == 'TimeoutError' for item in records))
                state.setup.assert_not_called()
                state.stop_clients.assert_not_called()
                if reused:
                    state.relay.stop.assert_not_called()
                else:
                    state.relay.stop.assert_called_once_with(state.relay.ensure_running.call_args.args[0])

    def test_cleanup_failure_does_not_hide_the_original_connection_error(self):
        with self.environment() as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock,
                          side_effect=[TimeoutError(), RuntimeError('discovery rejected')]):
            state.relay.stop.side_effect = RuntimeError('stop rejected')
            with self.assertRaisesRegex(RuntimeError, 'discovery rejected'):
                remote.connect(options())
            self.assertEqual(state.path.read_bytes(), state.saved)
            log = relay_log.path(state.relay.ensure_running.call_args.args[0])
            records = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(records[-1]['event'], 'connect.cleanup_failed')
            self.assertIn('server.discovery.failed', [item['event'] for item in records])

    def test_local_reset_stops_clients_only_after_local_configuration_succeeds(self):
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'local-key'}
        with self.environment() as state, patch.object(services, 'require_local') as require, \
             patch.object(services, 'start_local') as start, patch.object(connection, 'server_load', return_value=local):
            calls = Mock()
            calls.attach_mock(state.setup, 'setup')
            calls.attach_mock(state.stop_clients, 'stop')
            remote.connect(options(local=True))
            require.assert_called_once()
            start.assert_called_once()
            state.prompt.assert_not_called()
            self.assertEqual(state.setup.call_args.kwargs['local_server'], local)
            self.assertEqual([call[0] for call in calls.mock_calls], ['setup', 'stop'])
            state.stop_clients.reset_mock()
            state.setup.side_effect = RuntimeError('editor conflict')
            with self.assertRaisesRegex(RuntimeError, 'editor conflict'):
                remote.connect(options(local=True))
            state.stop_clients.assert_not_called()

    def test_local_share_and_reset_do_not_resume_an_unrelated_broken_client(self):
        transport = {'mode': 'connect', 'tunnel_id': 'old-tunnel', 'remote_port': 9077, 'local_port': 40123}
        previous = {'apiUrl': 'http://127.0.0.1:40123', 'apiToken': 'old-key',
                    'hindsightkit': {'mode': 'client', 'transport': transport}}
        for command in ('share', 'local'):
            with self.subTest(command=command), self.environment(previous=previous) as state, \
                 patch.object(services, 'require_local'), patch.object(services, 'start_api'), \
                 patch.object(services, 'start_ui', return_value='http://localhost:19077'), \
                 patch.object(profile_env, 'profile_config', return_value=({'HINDSIGHT_EMBED_API_DATABASE_URL': 'postgresql://local'},
                              SimpleNamespace(port=9077, ui_port=19077, ui_log=state.root / 'ui.log'))), \
                 patch('hindsightkit.setup.postgres.Postgres') as database, \
                 patch('hindsightkit.connectors.registry.enabled_connectors', return_value=[]), \
                 patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'local-key'}):
                database.return_value.url = 'postgresql://local'
                database.return_value.state_path.is_file.return_value = True
                state.relay.ensure_running.side_effect = ValueError('unrelated client transport is invalid')
                if command == 'share':
                    remote.share(options())
                else:
                    remote.connect(options(local=True))
                state.relay.ensure_running.assert_not_called()

    def test_late_client_registration_failure_restores_previous_destination(self):
        real_setup = installer.setup_client
        with self.environment() as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock, side_effect=[TimeoutError(), {'protocol': 1, 'routing': 'repository', 'sharedBank': 'fixture'}]), \
             patch.object(installer, 'require_client_prerequisites'), patch.object(installer, 'install_node_packages'), \
             patch.object(installer, 'vscode_user_directories', return_value=[state.root / 'Code']), \
             patch.object(installer, 'remove_project_registration'), patch.object(runtime_env, 'backup'), \
             patch.object(runtime_env, 'node', return_value='node'), \
             patch.object(connection, 'device_id', return_value='11111111-1111-1111-1111-111111111111'), \
             patch.object(connection, 'request', new_callable=AsyncMock,
                          return_value={'protocol': 1, 'routing': 'repository', 'sharedBank': 'hindsightkit-shared'}), \
             patch.object(connection, 'register', new_callable=AsyncMock, side_effect=RuntimeError('registration failed')), \
             patch('hindsight_copilot.instructions.write_rule'):
            state.setup.side_effect = real_setup
            def integrate(action, *args, **kwargs):
                if action == 'config':
                    state.path.write_text(json.dumps({'apiUrl': args[1], **kwargs['data']}), encoding='utf-8')
            with patch.object(installer, 'integrate', side_effect=integrate):
                with self.assertRaisesRegex(RuntimeError, 'registration failed'):
                    remote.connect(options())
            self.assertEqual(state.path.read_bytes(), state.saved)
            state.relay.stop.assert_called_once_with(state.relay.ensure_running.call_args.args[0])
            state.stop_clients.assert_not_called()

    def test_direct_reconfiguration_removes_saved_transport_metadata(self):
        real_setup = installer.setup_client
        previous = {'apiUrl': 'http://127.0.0.1:43210', 'apiToken': 'old-key',
                    'hindsightkit': {'mode': 'client', 'transport': {'mode': 'connect',
                      'tunnel_id': 'old-tunnel', 'remote_port': 9077, 'local_port': 43210}}}
        with self.environment(previous=previous) as state, \
             patch.object(connection, 'discover', new_callable=AsyncMock, return_value={'protocol': 1, 'routing': 'repository', 'sharedBank': 'fixture'}), \
             patch.object(installer, 'require_client_prerequisites'), patch.object(installer, 'install_node_packages'), \
             patch.object(installer, 'vscode_user_directories', return_value=[state.root / 'Code']), \
             patch.object(installer, 'remove_project_registration'), patch.object(runtime_env, 'backup'), \
             patch.object(runtime_env, 'node', return_value='node'), \
             patch.object(connection, 'device_id', return_value='11111111-1111-1111-1111-111111111111'), \
             patch.object(connection, 'request', new_callable=AsyncMock,
                          return_value={'protocol': 1, 'routing': 'repository', 'sharedBank': 'hindsightkit-shared'}), \
             patch.object(connection, 'register', new_callable=AsyncMock), \
             patch('hindsight_copilot.instructions.write_rule'):
            state.setup.side_effect = real_setup
            def integrate(action, *args, **kwargs):
                if action == 'config':
                    state.path.write_text(json.dumps({'apiUrl': args[1], **kwargs['data']}), encoding='utf-8')
            with patch.object(installer, 'integrate', side_effect=integrate):
                remote.connect(options())
            configured = json.loads(state.path.read_text(encoding='utf-8'))
            self.assertEqual(configured['apiUrl'], 'http://new-host:9077')
            self.assertNotIn('transport', configured['hindsightkit'])
            state.relay.ensure_running.assert_not_called()
            state.stop_clients.assert_called_once_with(except_transport=None)

    def test_stop_completes_local_shutdown_when_a_relay_cannot_stop(self):
        with self.environment() as state, patch.object(runtime_env, 'prepare_env'), \
             patch.object(services, 'require_local'), patch.object(runtime_env, 'run') as run, \
             patch.object(profile_env, 'profile_config', return_value=({'HINDSIGHT_EMBED_API_DATABASE_URL': 'postgresql://local'}, None)), \
             patch.object(connection, 'has_server', return_value=True), \
             patch.object(remote, 'stop', side_effect=RuntimeError('remote stop failed')), \
             patch('hindsightkit.connectors.host.stop') as stop_connectors, \
             patch('hindsight_embed.daemon_embed_manager.DaemonEmbedManager') as daemon, \
             patch('hindsightkit.setup.postgres.Postgres') as database, contextlib.redirect_stderr(io.StringIO()) as error:
            database.return_value.url = 'postgresql://local'
            database.return_value.state_path.is_file.return_value = True
            self.assertEqual(cli.main(['stop']), 1)
            self.assertEqual([call.args[0][-2:] for call in run.call_args_list], [['ui', 'stop']])
            daemon.return_value.stop.assert_called_once_with(runtime_env.PROFILE)
            stop_connectors.assert_called_once_with(state.root / 'connectors')
            database.return_value.stop.assert_called_once()
            self.assertIn('remote stop failed', error.getvalue())

    def test_share_direct_does_not_create_relay_and_outputs_separate_hidden_prompt_code(self):
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'share-secret'}
        with self.environment() as state, patch.object(services, 'require_local'), patch.object(services, 'start_local'), \
             patch.object(connection, 'server_load', return_value=local), \
             patch.object(remote.socket, 'gethostname', return_value='memory-host'):
            remote.share(options())
            state.relay.create_host.assert_not_called()
            state.relay.ensure_running.assert_not_called()
            code = next(line for line in state.output.getvalue().splitlines() if line.startswith(remote.PREFIX))
            self.assertEqual(remote.decode_invitation(code), {'version': 1, 'url': 'http://memory-host:9077', 'key': 'share-secret'})
            self.assertNotIn('share-secret', state.output.getvalue())
            self.assertIn('hidden prompt', state.output.getvalue())
            state.clipboard.assert_called_once_with(code)
            self.assertIn('Connection code copied to clipboard.', state.output.getvalue())

    def test_share_relay_returns_only_routing_metadata_in_invitation(self):
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'share-secret'}
        with self.environment() as state, patch.object(services, 'require_local'), patch.object(services, 'start_local'), \
             patch.object(connection, 'server_load', return_value=local):
            remote.share(options(relay=True, address='https://memory.example.com'))
            root = state.root / 'remote/host'
            state.relay.create_host.assert_called_once_with(root, 9077, provider=None)
            state.relay.ensure_running.assert_called_once_with(root, state.relay.create_host.return_value, interactive=True)
            code = next(line for line in state.output.getvalue().splitlines() if line.startswith(remote.PREFIX))
            self.assertEqual(remote.decode_invitation(code)['relay'], {'tunnel_id': 'test-tunnel', 'remote_port': 9077})
            self.assertNotIn('share-secret', repr(state.relay.ensure_running.call_args))
            state.clipboard.assert_called_once_with(code)
            self.assertIn('Connection code copied to clipboard.', state.output.getvalue())

    def test_share_succeeds_with_manual_copy_when_clipboard_is_unavailable(self):
        copy = remote.copy_connection_code
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'share-secret'}
        for error in (OSError('clipboard unavailable'),
                      subprocess.CalledProcessError(1, 'powershell.exe', stderr='private diagnostic'),
                      subprocess.TimeoutExpired('powershell.exe', 5)):
            with self.subTest(error=type(error).__name__), self.environment() as state, \
                    patch.object(runtime_env, 'prepare_env'), patch.object(services, 'require_local'), \
                    patch.object(services, 'start_local'), \
                    patch.object(connection, 'server_load', return_value=local), \
                    patch.object(remote, 'os', SimpleNamespace(name='nt')), \
                    patch.object(remote.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
                    patch.object(remote.subprocess, 'run', side_effect=error), \
                    contextlib.redirect_stderr(io.StringIO()) as stderr:
                state.clipboard.side_effect = copy
                self.assertEqual(cli.main(['share']), 0)
                output = state.output.getvalue()
                code = next(line for line in output.splitlines() if line.startswith(remote.PREFIX))
                self.assertEqual(remote.decode_invitation(code)['key'], 'share-secret')
                self.assertIn('Copy the connection code above manually.', output)
                self.assertNotIn('Connection code copied to clipboard.', output)
                self.assertNotIn('share-secret', output)
                self.assertNotIn('private diagnostic', output)
                self.assertEqual(stderr.getvalue(), '')

    def test_saved_transport_is_checked_before_starting_relay(self):
        transport = {'mode': 'connect', 'tunnel_id': 'saved-tunnel', 'remote_port': 9077, 'local_port': 40123}
        with self.environment() as state:
            config = {'apiUrl': 'http://other-host:40123', 'hindsightkit': {'transport': transport}}
            with self.assertRaises(ValueError):
                remote.prepare_client(config)
            state.relay.ensure_running.assert_not_called()
            config['apiUrl'] = 'http://127.0.0.1:40123'
            remote.prepare_client(config)
            state.relay.ensure_running.assert_called_once_with(remote.client_root(transport), transport, interactive=False)

    def test_selected_provider_reaches_relay_login_on_both_computers(self):
        local = {'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'share-secret'}
        for provider in ('microsoft', 'github'):
            with self.subTest(provider=provider), self.environment() as state, \
                    patch.object(services, 'require_local'), patch.object(services, 'start_local'), \
                    patch.object(connection, 'server_load', return_value=local):
                remote.share(options(relay=True, relay_provider=provider))
                state.relay.create_host.assert_called_once_with(state.root / 'remote/host', 9077, provider=provider)
            with self.environment() as state, \
                    patch.object(connection, 'discover', new_callable=AsyncMock,
                                 side_effect=[aiohttp.ClientConnectionError(), {}]):
                remote.connect(options(relay_provider=provider))
                self.assertEqual(state.relay.ensure_running.call_args.kwargs,
                                 {'interactive': True, 'provider': provider})

    def test_provider_option_with_direct_success_does_not_start_login(self):
        with self.environment() as state, patch.object(connection, 'discover', new_callable=AsyncMock):
            remote.connect(options(relay_provider='github'))
            state.relay.ensure_running.assert_not_called()

    def test_provider_option_rejects_incompatible_commands_before_side_effects(self):
        with self.environment() as state, patch.object(services, 'require_local') as require, \
                patch.object(services, 'start_local') as start:
            with self.assertRaisesRegex(ValueError, 'requires share --relay'):
                remote.share(options(relay_provider='github'))
            for destination in ({'local': True}, {'server': 'http://memory-host:9077'}):
                with self.subTest(destination=destination), self.assertRaisesRegex(ValueError, 'connection code'):
                    remote.connect(options(relay_provider='github', **destination))
            require.assert_not_called()
            start.assert_not_called()
            state.prompt.assert_not_called()
            state.setup.assert_not_called()

    def test_cli_remote_commands_accept_no_secret_argument_and_setup_is_internal(self):
        with patch.object(runtime_env, 'prepare_env'), patch.object(remote, 'connect') as connect, \
             patch.object(remote, 'share') as share, patch.object(installer, 'setup') as setup:
            self.assertEqual(cli.main(['connect']), 0)
            self.assertFalse(connect.call_args.args[0].local)
            self.assertEqual(cli.main(['connect', '--local']), 0)
            self.assertTrue(connect.call_args.args[0].local)
            self.assertEqual(cli.main(['share', '--relay']), 0)
            self.assertTrue(share.call_args.args[0].relay)
            for provider in ('microsoft', 'github'):
                self.assertEqual(cli.main(['connect', '--relay-provider', provider]), 0)
                self.assertEqual(connect.call_args.args[0].relay_provider, provider)
                self.assertEqual(cli.main(['share', '--relay', '--relay-provider', provider]), 0)
                self.assertEqual(share.call_args.args[0].relay_provider, provider)
            setup.assert_not_called()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cli.main(['setup'])
            setup.assert_not_called()
            for args in (['connect', '--code', 'secret'], ['connect', '--key', 'secret'],
                         ['connect', 'secret'], ['connect', '--local', '--server', 'http://host:9077'],
                         ['connect', '--relay-provider', 'unknown'], ['share', '--relay-provider', 'unknown']):
                with self.subTest(args=args[:-1]), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    cli.main(args)


if __name__ == '__main__':
    unittest.main()
