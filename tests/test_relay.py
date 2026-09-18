from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from hindsightkit import relay


def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def spec(**changes):
    return {'mode': 'connect', 'tunnel_id': 'hk-' + 'a' * 32,
            'remote_port': 19077, 'local_port': port(), **changes}


class RelayConfigurationTests(unittest.TestCase):
    def setUp(self):
        prompt = patch('builtins.input', side_effect=AssertionError('Unexpected account prompt'))
        self.prompt = prompt.start()
        self.addCleanup(prompt.stop)

    def test_known_cli_welcome_preserves_license_and_parses_json(self):
        banner = ('Welcome to dev tunnels!\nCLI version: 1.0.1972+07cc55c789\n\n'
                  'By using the software, you agree to the terms.\n\n')
        payload = banner + '{"status":"Logged in"}\n'
        with patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0, stdout=payload, stderr='')), \
                patch('builtins.print') as output:
            self.assertEqual(relay._json('fixture-cli', 'user', 'show'), {'status': 'Logged in'})
            output.assert_not_called()
            relay._show_welcome('fixture-cli')
            output.assert_called_once_with(banner.rstrip(), flush=True)

    def test_unknown_prefix_or_trailing_output_is_not_accepted_as_json(self):
        for payload in ('unknown output\n{"status":"Logged in"}',
                        'Welcome to dev tunnels!\nCLI version: 1\n{"status":"Logged in"}\nextra',
                        'Welcome to dev tunnels!\nCLI version: 1\nno json'):
            with self.subTest(payload=payload), \
                    patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0, stdout=payload, stderr='')):
                with self.assertRaisesRegex(RuntimeError, 'unsupported response'):
                    relay._json('fixture-cli', 'user', 'show')
        relay._WELCOME_BANNERS.pop('fixture-cli', None)

    def test_invalid_spec_cannot_add_arguments_or_secrets(self):
        for change in ({'mode': '--help'}, {'tunnel_id': '-bad'}, {'tunnel_id': 'a b'},
                       {'remote_port': True}, {'remote_port': 0}, {'local_port': 65536},
                       {'key': 'private-secret'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                relay.validate_spec(spec(**change))

    def test_missing_spec_and_status_are_inactive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'unused'
            self.assertIsNone(relay.load_spec(root))
            self.assertEqual(relay.status(root)['state'], 'stopped')
            relay.stop(root)
            self.assertFalse(root.exists())

    def test_logged_out_background_use_never_opens_login(self):
        with patch.object(relay, '_json', return_value={'status': 'Not logged in'}), \
                patch.object(relay.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'sign-in expired'):
                relay._authenticate('devtunnel.exe', False)
            run.assert_not_called()

    def test_interactive_login_shows_device_code_in_the_calling_terminal(self):
        self.prompt.side_effect = None
        self.prompt.return_value = ''
        with patch.object(relay, '_json', side_effect=[{'status': 'Not logged in'},
                          {'status': 'Logged in', 'provider': 'microsoft'}]), \
                patch.object(relay, '_flags', return_value=0x08000000), \
                patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            relay._authenticate('devtunnel.exe', True)
            self.assertEqual(run.call_args.args[0],
                             ['devtunnel.exe', 'user', 'login', '--entra', '--use-device-code-auth'])
            self.assertEqual(run.call_args.kwargs.get('creationflags', 0), 0)
            self.assertFalse(run.call_args.kwargs.get('capture_output', False))
            for stream in ('stdin', 'stdout', 'stderr'):
                self.assertIsNone(run.call_args.kwargs.get(stream))
            self.prompt.assert_called_once()

    def test_existing_login_is_preserved_without_opening_another_flow(self):
        with patch.object(relay, '_json', return_value={'status': 'Logged in'}), \
                patch.object(relay.subprocess, 'run') as run:
            relay._authenticate('devtunnel.exe', True)
            run.assert_not_called()

    def test_device_login_timeout_explains_how_to_retry(self):
        with patch.object(relay, '_json', return_value={'status': 'Not logged in'}) as status, \
                patch.object(relay.subprocess, 'run',
                             side_effect=subprocess.TimeoutExpired('devtunnel', 600)):
            with self.assertRaisesRegex(RuntimeError, 'sign-in timed out.*connect'):
                relay._authenticate('devtunnel.exe', True, provider='microsoft')
            status.assert_called_once()

    def test_failed_device_login_explains_how_to_retry(self):
        with patch.object(relay, '_json', return_value={'status': 'Not logged in'}) as status, \
                patch.object(relay.subprocess, 'run', return_value=Mock(returncode=1)):
            with self.assertRaisesRegex(RuntimeError, 'sign-in did not complete.*connect'):
                relay._authenticate('devtunnel.exe', True, provider='microsoft')
            status.assert_called_once()

    def test_successful_login_exit_still_requires_authenticated_status(self):
        with patch.object(relay, '_json', return_value={'status': 'Not logged in'}) as status, \
                patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            with self.assertRaisesRegex(RuntimeError, 'sign-in expired'):
                relay._authenticate('devtunnel.exe', True, provider='microsoft')
            self.assertEqual(status.call_count, 2)
            run.assert_called_once()

    def test_nonzero_logged_out_status_can_authenticate_interactively(self):
        error = relay.CliError('user show', Mock(returncode=1, stdout='Not logged in', stderr=''))
        with patch.object(relay, '_json', side_effect=[error, {'status': 'Logged in', 'provider': 'github'}]), \
                patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            relay._authenticate('devtunnel.exe', True, provider='github')
            run.assert_called_once()

    def test_each_provider_logs_in_directly_and_verifies_the_selected_identity_type(self):
        for provider, flag in (('microsoft', '--entra'), ('github', '--github')):
            with self.subTest(provider=provider), \
                    patch.object(relay, '_json', side_effect=[{'status': 'Not logged in'},
                                  {'status': 'Logged in', 'provider': provider}]), \
                    patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                self.assertTrue(relay._authenticate('devtunnel.exe', True, provider=provider))
                self.assertEqual(run.call_args.args[0],
                                 ['devtunnel.exe', 'user', 'login', flag, '--use-device-code-auth'])
        self.prompt.assert_not_called()

    def test_cached_matching_provider_is_reused_but_explicit_different_provider_logs_in(self):
        for provider in ('microsoft', 'github'):
            cached = {'status': 'Logged in', 'provider': provider}
            with self.subTest(provider=provider), patch.object(relay, '_json', return_value=cached), \
                    patch.object(relay.subprocess, 'run') as run:
                self.assertFalse(relay._authenticate('devtunnel.exe', True, provider=provider))
                run.assert_not_called()
            other = 'github' if provider == 'microsoft' else 'microsoft'
            with patch.object(relay, '_json', side_effect=[cached, {'status': 'Logged in', 'provider': other}]), \
                    patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                self.assertTrue(relay._authenticate('devtunnel.exe', True, provider=other))
                self.assertIn(relay.LOGIN_PROVIDERS[other], run.call_args.args[0])
        self.prompt.assert_not_called()

    def test_wrong_or_missing_provider_after_login_is_not_accepted(self):
        for reported in ('microsoft', None):
            with self.subTest(reported=reported), \
                    patch.object(relay, '_json', side_effect=[{'status': 'Not logged in'},
                                  {'status': 'Logged in', 'provider': reported}]), \
                    patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
                with self.assertRaisesRegex(RuntimeError, 'requested github'):
                    relay._authenticate('devtunnel.exe', True, provider='github')
                run.assert_called_once()

    def test_prompt_retries_invalid_choice_and_can_select_github(self):
        self.prompt.side_effect = ['invalid', '2']
        with patch.object(relay, '_json', side_effect=[{'status': 'Not logged in'},
                          {'status': 'Logged in', 'provider': 'github'}]), \
                patch.object(relay.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            self.assertTrue(relay._authenticate('devtunnel.exe', True))
            self.assertIn('--github', run.call_args.args[0])
        self.assertEqual(self.prompt.call_count, 2)

    def test_closed_input_explains_provider_option_without_starting_login(self):
        self.prompt.side_effect = EOFError
        with patch.object(relay, '_json', return_value={'status': 'Not logged in'}), \
                patch.object(relay.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, '--relay-provider github'):
                relay._authenticate('devtunnel.exe', True)
            run.assert_not_called()

    def test_background_cannot_switch_provider_or_prompt(self):
        with patch.object(relay, '_json', return_value={'status': 'Logged in', 'provider': 'microsoft'}), \
                patch.object(relay.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'requested github'):
                relay._authenticate('devtunnel.exe', False, provider='github')
            run.assert_not_called()
            self.prompt.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows signed CLI installation')
    def test_background_missing_cli_never_downloads(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('hindsightkit.runtime.home', return_value=Path(directory)), \
                patch.object(relay.shutil, 'which', return_value=None), \
                patch.object(relay.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'CLI is missing'):
                relay.ensure_cli(interactive=False)
            run.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows signed CLI installation')
    def test_existing_cli_requires_microsoft_signature_without_downloading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'tools/devtunnel.exe'
            binary.parent.mkdir()
            binary.write_bytes(b'fixture')
            with patch('hindsightkit.runtime.home', return_value=root), \
                    patch.object(relay.shutil, 'which', return_value='powershell.exe'), \
                    patch.object(relay.subprocess, 'run', return_value=Mock(returncode=1)) as run:
                with self.assertRaisesRegex(RuntimeError, 'verify'):
                    relay.ensure_cli(False)
                environment = run.call_args.kwargs['env']
                self.assertEqual(environment['HINDSIGHTKIT_RELAY_DOWNLOAD'], '')
                self.assertTrue(Path(environment['HINDSIGHTKIT_RELAY_BINARY']).samefile(binary))
                self.assertIn('Get-AuthenticodeSignature', run.call_args.args[0][-1])
                self.assertIn('O=Microsoft Corporation', run.call_args.args[0][-1])
                self.assertEqual(binary.read_bytes(), b'fixture')

    def test_ready_worker_reuse_does_not_sign_in_or_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            configuration = spec()
            with patch.object(relay, '_control', return_value={'spec': configuration, 'ready': True}), \
                    patch.object(relay, 'ensure_cli') as cli, patch.object(relay, '_authenticate') as auth, \
                    patch.object(relay, 'private_directory'), patch.object(relay.subprocess, 'Popen') as process:
                self.assertEqual(relay.ensure_running(Path(directory), configuration), configuration['local_port'])
                cli.assert_not_called()
                auth.assert_not_called()
                process.assert_not_called()

    def test_explicit_provider_checks_ready_worker_and_restarts_only_after_new_login(self):
        for signed_in in (False, True):
            with self.subTest(signed_in=signed_in), tempfile.TemporaryDirectory() as directory:
                configuration = spec()
                current = {'spec': configuration, 'ready': True}
                with patch.object(relay, '_control', return_value=current), \
                        patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                        patch.object(relay, '_authenticate', return_value=signed_in) as auth, \
                        patch.object(relay, 'stop') as stop, patch.object(relay, 'private_directory'), \
                        patch.object(relay.subprocess, 'Popen') as process:
                    self.assertEqual(relay.ensure_running(directory, configuration, True, provider='github'),
                                     configuration['local_port'])
                    auth.assert_called_once_with('devtunnel.exe', True, provider='github')
                    self.assertEqual(stop.call_count, int(signed_in))
                    self.assertEqual(process.call_count, int(signed_in))
                    if signed_in:
                        stop.assert_called_once_with(Path(directory))
                        self.assertEqual(relay.load_spec(directory), configuration)

    def test_failed_provider_login_preserves_the_running_worker_and_saved_spec(self):
        with tempfile.TemporaryDirectory() as directory:
            root, configuration = Path(directory), spec()
            path = root / 'spec.json'
            path.write_text(json.dumps(configuration))
            previous = path.read_bytes()
            with patch.object(relay, '_control', return_value={'spec': configuration, 'ready': True}), \
                    patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate', side_effect=RuntimeError('login failed')), \
                    patch.object(relay, 'private_directory'), \
                    patch.object(relay, 'stop') as stop, patch.object(relay.subprocess, 'Popen') as process:
                with self.assertRaisesRegex(RuntimeError, 'login failed'):
                    relay.ensure_running(root, configuration, True, provider='github')
                stop.assert_not_called()
                process.assert_not_called()
            self.assertEqual(path.read_bytes(), previous)

    def test_unavailable_host_after_new_login_preserves_existing_tunnel_and_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configuration = {'mode': 'host', 'tunnel_id': 'hk-' + 'a' * 32, 'remote_port': 19077}
            path = root / 'spec.json'
            path.write_text(json.dumps(configuration))
            previous = path.read_bytes()
            error = relay.CliError('show', Mock(returncode=1, stdout='404 Not found', stderr=''))
            with patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate', side_effect=[True, False]) as auth, \
                    patch.object(relay, '_json', side_effect=error) as invoke, patch.object(relay, 'stop') as stop:
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, 'saved relay.*original account'):
                        relay.create_host(root, 19077, provider='github')
                self.assertEqual(auth.call_count, 2)
                auth.assert_called_with('devtunnel.exe', True, provider='github')
                self.assertEqual(invoke.call_count, 2)
                invoke.assert_called_with('devtunnel.exe', 'show', configuration['tunnel_id'])
                stop.assert_not_called()
            self.assertEqual(path.read_bytes(), previous)

    def test_accessible_host_after_login_stops_old_worker_only_after_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configuration = {'mode': 'host', 'tunnel_id': 'hk-' + 'a' * 32, 'remote_port': 19077}
            (root / 'spec.json').write_text(json.dumps(configuration))
            with patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate', return_value=True), \
                    patch.object(relay, '_json', side_effect=[{}, {'ports': [{'portNumber': 19077}]}]) as invoke, \
                    patch.object(relay, 'stop', side_effect=lambda _: self.assertEqual(invoke.call_count, 2)) as stop:
                self.assertEqual(relay.create_host(root, 19077, provider='github'), configuration)
                stop.assert_called_once_with(root)

    def test_host_creation_is_private_and_retry_reuses_one_tunnel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ports = []
            commands = []

            def invoke(executable, *arguments):
                commands.append(arguments)
                if arguments[0] == 'create':
                    return {'tunnel': {'tunnelId': arguments[1] + '.asse'}}
                if arguments[:2] == ('port', 'list'):
                    return {'ports': [{'portNumber': value} for value in ports]}
                if arguments[:2] == ('port', 'create'):
                    ports.append(int(arguments[4]))
                return {}

            with patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate'), patch.object(relay, '_json', side_effect=invoke):
                created = relay.create_host(root, 12345)
                self.assertEqual(created, relay.create_host(root, 12345))
            self.assertEqual(sum(command[0] == 'create' for command in commands), 1)
            self.assertNotIn('--allow-anonymous', str(commands))
            self.assertEqual(relay.load_spec(root), created)
            self.assertEqual(ports, [12345])

    def test_existing_unrelated_ports_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = {'mode': 'host', 'tunnel_id': 'hk-' + 'a' * 32, 'remote_port': 12345}
            (root / 'spec.json').write_text(json.dumps(owned))
            with patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate'), \
                    patch.object(relay, '_json', side_effect=[{}, {'ports': [{'portNumber': 54321}]}]) as invoke:
                with self.assertRaisesRegex(RuntimeError, 'unexpected ports'):
                    relay.create_host(root, 12345)
                self.assertFalse(any(call.args[1] in {'create', 'delete'} for call in invoke.call_args_list))
            self.assertEqual(relay.load_spec(root), owned)

    def test_forbidden_owned_tunnel_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            owned = {'mode': 'host', 'tunnel_id': 'hk-' + 'a' * 32, 'remote_port': 12345}
            (root / 'spec.json').write_text(json.dumps(owned))
            error = relay.CliError('show', Mock(returncode=1, stdout='Forbidden', stderr=''))
            with patch.object(relay, 'ensure_cli', return_value='devtunnel.exe'), \
                    patch.object(relay, '_authenticate'), \
                    patch.object(relay, '_json', side_effect=error), patch.object(relay, 'stop') as stop:
                with self.assertRaises(relay.CliError):
                    relay.create_host(root, 12345)
                stop.assert_not_called()
            self.assertEqual(relay.load_spec(root), owned)

    def test_foreign_control_server_never_receives_stop(self):
        requests = []

        class Foreign(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append('GET')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"service":"unrelated","identity":"wrong"}')

            def do_POST(self):
                requests.append('POST')
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(('127.0.0.1', 0), Foreign) as server, tempfile.TemporaryDirectory() as directory:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            root = Path(directory)
            (root / 'worker.json').write_text(json.dumps({'port': server.server_port,
                'token': 'a' * 64, 'identity': 'b' * 32, 'pid': os.getpid()}))
            try:
                relay.stop(root)
                self.assertEqual(requests, ['GET'])
            finally:
                server.shutdown()
                thread.join(3)

    def test_forwarding_requires_exact_expected_ipv4_port(self):
        state = relay._State(spec(local_port=19078))
        for line in ('SSH: Forwarding from [::1]:19077 to host port 19077.',
                     'SSH: Forwarding from 127.0.0.1:20000 to host port 9999.',
                     'SSH: Forwarding from 127.0.0.1:19078 to host port 19077.',
                     'prefix SSH: Forwarding from 127.0.0.1:20000 to host port 19077.'):
            state.line(line)
            self.assertFalse(state.ready)
        state.line('SSH: Forwarding from 127.0.0.1:20000 to host port 19077.\n')
        self.assertTrue(state.ready)
        self.assertEqual(state.upstream, 20000)
        state.reset()
        self.assertIsNone(state.upstream)

    @unittest.skipUnless(os.name == 'nt', 'Windows socket owner table')
    def test_forwarded_listener_must_belong_to_expected_process(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            selected = listener.getsockname()[1]
            self.assertTrue(relay._listener_owned(selected, os.getpid()))
            self.assertFalse(relay._listener_owned(selected, os.getpid() + 1))
        self.assertFalse(relay._listener_owned(selected, os.getpid()))


class RelayWorkerTests(unittest.TestCase):
    def wait_ready(self, root, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if relay.status(root).get('ready'):
                return
            time.sleep(0.05)
        self.fail('Synthetic relay did not become ready.')

    def fixture(self, root, lines, extra=''):
        script = root / 'cli_fixture.py'
        script.write_text('import socket, time\n' + extra + '\n'
                          + '\n'.join('print(' + repr(line) + ', flush=True)' for line in lines)
                          + '\ntime.sleep(120)\n', encoding='utf-8')
        return script

    def run_worker(self, root, configuration, script):
        failures = []

        def run():
            try:
                relay.serve_worker(root, 'synthetic-cli', configuration)
            except Exception as exc:
                failures.append(exc)

        patcher = patch.object(relay, '_child_command', return_value=[sys.executable, str(script)])
        patcher.start()
        worker = threading.Thread(target=run, daemon=True)
        worker.start()

        def cleanup():
            relay.stop(root)
            worker.join(15)
            patcher.stop()
            self.assertFalse(worker.is_alive(), 'Worker did not stop.')
            self.assertEqual(failures, [])

        self.addCleanup(cleanup)
        return worker

    def test_private_control_and_restart_keep_unrelated_process_running(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        configuration = {'mode': 'host', 'tunnel_id': 'hk-' + 'a' * 32, 'remote_port': 19077}
        counter = root / 'attempts.txt'
        extra = ('from pathlib import Path\n'
                 f'counter = Path({str(counter)!r})\n'
                 'number = int(counter.read_text()) + 1 if counter.exists() else 1\n'
                 'counter.write_text(str(number))\n'
                 'if number == 1: raise SystemExit(1)\n')
        script = self.fixture(root, ['Ready to accept connections for tunnel: ' + configuration['tunnel_id']], extra)
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        self.addCleanup(lambda: (unrelated.terminate(), unrelated.wait(timeout=5)))
        self.run_worker(root, configuration, script)
        self.wait_ready(root)
        self.assertGreaterEqual(int(counter.read_text()), 2)
        receipt = json.loads((root / 'worker.json').read_text())
        opener = build_opener(ProxyHandler({}))
        with self.assertRaises(HTTPError) as error:
            opener.open(Request(f'http://127.0.0.1:{receipt["port"]}/stop', data=b'',
                                headers={'Authorization': 'Bearer wrong'}), timeout=2)
        self.assertEqual(error.exception.code, 403)
        self.assertTrue(relay.status(root)['ready'])
        relay.stop(root)
        self.assertIsNone(unrelated.poll())
        self.assertFalse((root / 'worker.json').exists())

    def test_connect_proxy_reserves_stable_port_and_forwards_bytes(self):
        class Echo(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.sendall(self.request.recv(65536))

        upstream = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Echo)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (upstream.shutdown(), upstream.server_close()))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        configuration = spec()
        owner = patch.object(relay, '_listener_owned', return_value=True)
        owner.start()
        self.addCleanup(owner.stop)
        remote = configuration['remote_port']
        extra = ('test = socket.socket()\ntry:\n'
                 f'    test.bind(("127.0.0.1", {configuration["local_port"]}))\n'
                 'except OSError:\n    pass\nelse:\n    raise SystemExit(3)\nfinally:\n    test.close()')
        script = self.fixture(root, [f'SSH: Forwarding from 127.0.0.1:{upstream.server_address[1]} to host port {remote}.'], extra)
        self.run_worker(root, configuration, script)
        self.wait_ready(root)
        with socket.create_connection(('127.0.0.1', configuration['local_port']), timeout=3) as connection:
            connection.sendall(b'synthetic relay check')
            self.assertEqual(connection.recv(65536), b'synthetic relay check')
        with patch.object(relay, 'ensure_cli') as ensure, patch.object(relay, '_authenticate') as login:
            self.assertEqual(relay.ensure_running(root, configuration), configuration['local_port'])
            ensure.assert_not_called()
            login.assert_not_called()


if __name__ == '__main__':
    unittest.main()
