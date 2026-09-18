import argparse
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
from hindsightkit import cli
from hindsightkit import connection
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env


class UiTests(unittest.TestCase):
    def test_ui_starts_services_before_opening_browser(self):
        events = []
        url = 'http://localhost:19077'
        with patch.object(runtime_env, 'prepare_env'), patch.object(services, 'require_local') as require_local, \
             patch.object(services, 'start', side_effect=lambda: events.append('ready') or ('api', url)), \
             patch('webbrowser.open', side_effect=lambda value: events.append(value)):
            self.assertEqual(cli.main(['ui']), 0)
        require_local.assert_called_once_with()
        self.assertEqual(events, ['ready', url])

    def test_startup_failure_does_not_open_browser(self):
        with patch.object(runtime_env, 'prepare_env'), patch.object(services, 'require_local'), \
             patch.object(services, 'start', side_effect=RuntimeError('startup failed')), \
             patch('webbrowser.open') as browser, \
             contextlib.redirect_stderr(io.StringIO()) as error:
            self.assertEqual(cli.main(['ui']), 1)
        browser.assert_not_called()
        self.assertIn('startup failed', error.getvalue())

    def test_existing_ui_is_checked_and_reused(self):
        with tempfile.TemporaryDirectory() as temp:
            paths = argparse.Namespace(ui_port=19077, ui_log=Path(temp) / 'test.ui.log')
            with patch.object(DaemonEmbedManager, 'is_ui_running', return_value=True), \
                 patch.object(services, 'check_ui', new_callable=AsyncMock) as check, \
                 patch.object(services, 'launch_ui') as launch:
                self.assertEqual(services.start_ui(paths), 'http://localhost:19077')
                check.assert_awaited_once_with('http://localhost:19077')
                launch.assert_not_called()
            self.assertEqual(paths.ui_log.with_suffix('.port').read_text(), '19077')

    def test_failure_or_interruption_terminates_only_the_spawned_process(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.close()
            paths = argparse.Namespace(port=9077, ui_port=port, ui_log=Path(temp) / 'test.ui.log')
            process = Mock()
            process.poll.return_value = None
            for error, expected in [(TimeoutError('dashboard unavailable'), RuntimeError),
                                    (KeyboardInterrupt(), KeyboardInterrupt)]:
                with self.subTest(error=type(error).__name__), \
                     patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077'}), \
                     patch.object(Path, 'is_file', return_value=True), \
                     patch.object(runtime_env, 'node', return_value='node'), \
                     patch.object(services.subprocess, 'Popen', return_value=process), \
                     patch.object(services, 'wait_ui', side_effect=error):
                    with self.assertRaises(expected) as caught:
                        services.launch_ui(paths, 'http://localhost:19077')
                    if expected is RuntimeError:
                        self.assertIn('test.ui.log', str(caught.exception))
                process.kill.assert_called_once_with()
                process.wait.assert_called_once_with()
                process.reset_mock()

    def test_exited_server_fails_without_waiting_for_timeout(self):
        process = Mock(returncode=7)
        process.poll.return_value = 7
        with self.assertRaisesRegex(RuntimeError, 'code 7'):
            asyncio.run(services.wait_ui('http://localhost:1', process))

    def test_occupied_port_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp, socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            port = listener.getsockname()[1]
            paths = argparse.Namespace(port=9077, ui_port=port, ui_log=Path(temp) / 'test.ui.log')
            with patch.object(Path, 'is_file', return_value=True), \
                 patch.object(DaemonEmbedManager, 'is_ui_running', return_value=False), \
                 patch.object(services.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, f'port {port} is already in use'):
                    services.start_ui(paths)
            spawn.assert_not_called()
            self.assertFalse(paths.ui_log.with_suffix('.port').exists())
            with socket.create_connection(('127.0.0.1', port), timeout=2):
                pass

    @unittest.skipUnless(sys.platform == 'win32', 'Windows console behavior')
    def test_windows_server_has_no_console_and_survives_launcher_exit(self):
        # A small HTTP fixture verifies actual process flags and inherited handles.
        with tempfile.TemporaryDirectory(prefix='hindsightkit ui ') as temp, socket.socket() as listener:
            root = Path(temp)
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            listener.close()
            server = root / 'runtime/node_modules/@vectorize-io/hindsight-control-plane/standalone/server.js'
            server.parent.mkdir(parents=True)
            server.write_text('''import ctypes, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
Path('process.json').write_text(json.dumps({
    'pid': os.getpid(), 'console': ctypes.windll.kernel32.GetConsoleWindow(),
    'stdin': os.read(0, 1).decode(), 'api': os.environ['HINDSIGHT_CP_DATAPLANE_API_URL'],
    'hostname': os.environ['HOSTNAME'], 'node_options': os.environ['NODE_OPTIONS'],
}))
print('UI fixture started', flush=True)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'Hindsight')
HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
''', encoding='utf-8')
            launcher = root / 'launch.py'
            launcher.write_text('''import argparse, sys
from pathlib import Path
from hindsightkit import connection, services
from hindsightkit.platform import runtime as runtime_env
root, port = Path(sys.argv[1]), int(sys.argv[2])
runtime_env.home = lambda: root
connection.server_load = lambda: {'apiUrl': 'http://127.0.0.1:9077'}
runtime_env.node = lambda: sys._base_executable
paths = argparse.Namespace(port=9077, ui_port=port, ui_log=root / 'ui.log')
services.launch_ui(paths, f'http://localhost:{port}')
''', encoding='utf-8')
            env = os.environ.copy()
            env['PYTHONPATH'] = str(Path(cli.__file__).resolve().parents[1])
            env['NODE_OPTIONS'] = '--max-old-space-size=512'
            info = server.parent / 'process.json'
            try:
                result = subprocess.run([sys.executable, str(launcher), str(root), str(port)],
                                        env=env, capture_output=True, text=True, timeout=45,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                process = json.loads(info.read_text())
                self.assertEqual(process['console'], 0)
                self.assertEqual(process['stdin'], '')
                self.assertEqual(process['api'], 'http://127.0.0.1:9077')
                self.assertEqual(process['hostname'], 'localhost')
                self.assertIn('--max-old-space-size=512', process['node_options'])
                self.assertIn('--dns-result-order=ipv4first', process['node_options'])
                asyncio.run(services.check_ui(f'http://localhost:{port}'))
                self.assertIn('UI fixture started', (root / 'ui.log').read_text())
            finally:
                if info.exists():
                    import _winapi
                    import signal
                    try:
                        pid = json.loads(info.read_text())['pid']
                        handle = _winapi.OpenProcess(0x00100000, False, pid)
                    except OSError:
                        pass
                    else:
                        try:
                            os.kill(pid, signal.SIGTERM)
                            self.assertEqual(_winapi.WaitForSingleObject(handle, 5000), 0)
                        finally:
                            _winapi.CloseHandle(handle)


if __name__ == '__main__':
    unittest.main()
