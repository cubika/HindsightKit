"""Run optional private Microsoft dev tunnels after local setup."""
from __future__ import annotations

import argparse
import ctypes
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener
import uuid

from filelock import FileLock, Timeout

from .postgres import atomic_json, private_directory, reject_links

DOWNLOAD_URL = 'https://aka.ms/TunnelsCliDownload/win-x64'
SERVICE = 'hindsightkit-relay-v1'
READY_TIMEOUT = 60
TUNNEL_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9.-]{0,127}')
OWNED_ID = re.compile(r'hk-[a-f0-9]{32}(?:\.[a-z0-9]+)?')
FORWARD = re.compile(r'^SSH: Forwarding from 127\.0\.0\.1:(\d+) to host port (\d+)\.$')
_WELCOME_BANNERS = {}


def validate_spec(spec):
    if (not isinstance(spec, dict) or spec.get('mode') not in {'host', 'connect'}
            or not isinstance(spec.get('tunnel_id'), str)
            or not TUNNEL_ID.fullmatch(spec['tunnel_id'])
            or type(spec.get('remote_port')) is not int or not 1 <= spec['remote_port'] <= 65535):
        raise ValueError('Invalid saved relay configuration. Run share or connect again.')
    expected = {'mode', 'tunnel_id', 'remote_port'}
    if spec['mode'] == 'connect':
        expected.add('local_port')
        if type(spec.get('local_port')) is not int or not 1 <= spec['local_port'] <= 65535:
            raise ValueError('Invalid local relay port.')
    if set(spec) != expected:
        raise ValueError('Unexpected saved relay configuration fields.')
    return dict(spec)


def load_spec(root):
    path = Path(root) / 'spec.json'
    reject_links(path)
    return validate_spec(json.loads(path.read_text(encoding='utf-8'))) if path.is_file() else None


def _flags():
    return subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


class CliError(RuntimeError):
    def __init__(self, command, result):
        super().__init__(f'Microsoft devtunnel {command} failed (exit {result.returncode}). '
                         'Check connectivity and run share --relay or connect to sign in again.')
        self.detail = (result.stdout or '') + (result.stderr or '')


def _json(executable, *arguments):
    result = subprocess.run([str(executable), *arguments, '--json'], capture_output=True,
                            text=True, encoding='utf-8', errors='replace', timeout=90,
                            creationflags=_flags())
    if result.returncode:
        raise CliError(' '.join(arguments[:2]), result)
    content = result.stdout.lstrip('\ufeff')
    # The official CLI periodically prefixes --json with its welcome/license
    # banner. Accept only that known prefix and a whole remaining JSON document.
    if content.startswith('Welcome to dev tunnels!\nCLI version: '):
        beginning = re.search(r'(?m)^[ \t]*\{', content)
        if beginning:
            banner, content = content[:beginning.start()], content[beginning.start():]
            _WELCOME_BANNERS[str(executable)] = banner.rstrip()
    try:
        return json.loads(content)
    except ValueError as exc:
        raise RuntimeError('Microsoft devtunnel returned an unsupported response.') from exc


def ensure_cli(interactive=True):
    if os.name != 'nt':
        raise RuntimeError('Managed relay installation currently supports Windows only.')
    from .cli import home
    managed = home() / 'tools/devtunnel.exe'
    existing = managed if managed.is_file() else shutil.which('devtunnel.exe')
    binary = Path(existing).resolve() if existing else managed
    if not existing and not interactive:
        raise RuntimeError('The relay CLI is missing. Run share --relay or connect first.')
    if not existing:
        private_directory(binary.parent)
    shell = shutil.which('powershell.exe')
    if not shell:
        raise RuntimeError('Windows PowerShell is required to verify Microsoft devtunnel.')
    # Values travel through environment variables, never interpolated shell code.
    env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
    env['HINDSIGHTKIT_RELAY_BINARY'] = str(binary)
    env['HINDSIGHTKIT_RELAY_DOWNLOAD'] = '' if existing else DOWNLOAD_URL
    script = r'''$ErrorActionPreference = 'Stop'
$target = $env:HINDSIGHTKIT_RELAY_BINARY
$download = $env:HINDSIGHTKIT_RELAY_DOWNLOAD
$candidate = if ($download) { $target + '.' + [guid]::NewGuid().ToString('N') + '.tmp' } else { $target }
try {
    if ($download) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $download -OutFile $candidate -UseBasicParsing -TimeoutSec 300
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
        throw 'A valid Microsoft signature is required for devtunnel.'
    }
    if ($download) { [IO.File]::Move($candidate, $target) }
} finally {
    if ($download -and (Test-Path -LiteralPath $candidate)) { Remove-Item -LiteralPath $candidate }
}
'''
    result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-Command', script], env=env,
                            capture_output=True, text=True, timeout=330, creationflags=_flags())
    if result.returncode:
        raise RuntimeError('Could not download or verify the Microsoft-signed devtunnel CLI.')
    return str(binary)


def _authenticate(executable, interactive):
    try:
        data = _json(executable, 'user', 'show')
    except CliError as exc:
        if not re.search(r'not logged in|not authenticated|sign in|log in', exc.detail, re.I):
            raise
        data = {}
    if interactive:
        _show_welcome(executable)
    if isinstance(data, dict) and data.get('status') == 'Logged in':
        return
    if not interactive:
        raise RuntimeError('Relay sign-in expired. Run share --relay or connect to sign in again.')
    print('Sign in to Microsoft dev tunnels. Use the same account on both computers.', flush=True)
    print('Open the URL shown below in your browser and enter the device code. '
          'Keep this terminal open; sign-in can take up to 10 minutes. Press Ctrl+C to cancel.', flush=True)
    # Interactive login must inherit the terminal so its URL and code stay visible.
    try:
        result = subprocess.run([str(executable), 'user', 'login', '--use-device-code-auth'],
                                timeout=600, creationflags=0)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('Microsoft dev tunnels sign-in timed out. Check network access to Microsoft sign-in '
                           'and Dev Tunnels, then rerun share --relay or connect for a new device code.') from exc
    if result.returncode:
        raise RuntimeError('Microsoft dev tunnels sign-in did not complete. Check the login message above, '
                           'then rerun share --relay or connect.')
    _authenticate(executable, False)


def _show_welcome(executable):
    banner = _WELCOME_BANNERS.pop(str(executable), None)
    if banner:
        print(banner, flush=True)


def _ports(value):
    if isinstance(value, list):
        return [port for item in value for port in _ports(item)]
    if isinstance(value, dict):
        if type(value.get('portNumber')) is int:
            return [value['portNumber']]
        return [port for item in value.values() for port in _ports(item)]
    return []


def create_host(root, api_port):
    root = Path(root)
    if type(api_port) is not int or not 1 <= api_port <= 65535:
        raise ValueError('Invalid server port.')
    private_directory(root)
    executable = ensure_cli()
    _authenticate(executable, True)
    with FileLock(str(root / 'setup.lock'), timeout=10):
        spec = load_spec(root)
        if spec and (spec['mode'] != 'host' or not OWNED_ID.fullmatch(spec['tunnel_id'])):
            raise ValueError('This directory does not contain a HindsightKit-owned host tunnel.')
        if spec:
            try:
                _json(executable, 'show', spec['tunnel_id'])
            except CliError as exc:
                if not re.search(r'not found|does not exist|404', exc.detail, re.I):
                    raise
                stop(root)
                spec = None
        if spec is None:
            spec = {'mode': 'host', 'tunnel_id': 'hk-' + uuid.uuid4().hex, 'remote_port': api_port}
            created = _json(executable, 'create', spec['tunnel_id'], '--expiration', '30d',
                            '--description', 'HindsightKit private memory relay')
            returned_id = created.get('tunnel', {}).get('tunnelId') if isinstance(created, dict) else None
            if (not isinstance(returned_id, str) or not OWNED_ID.fullmatch(returned_id)
                    or returned_id.split('.')[0] != spec['tunnel_id']):
                raise RuntimeError('Microsoft devtunnel returned an unexpected tunnel identity.')
            spec['tunnel_id'] = returned_id
            # Save ownership immediately so retry can repair an interrupted port creation.
            atomic_json(root / 'spec.json', spec)
        ports = _ports(_json(executable, 'port', 'list', spec['tunnel_id']))
        if len(set(ports)) != len(ports) or set(ports) - {spec['remote_port']}:
            raise RuntimeError('The saved relay has unexpected ports. Existing tunnel settings were preserved.')
        if spec['remote_port'] != api_port:
            stop(root)
            if spec['remote_port'] in ports:
                _json(executable, 'port', 'delete', spec['tunnel_id'], '-p', str(spec['remote_port']))
            ports = []
            spec['remote_port'] = api_port
            atomic_json(root / 'spec.json', spec)
        if api_port not in ports:
            _json(executable, 'port', 'create', spec['tunnel_id'], '-p', str(api_port), '--protocol', 'http')
        _show_welcome(executable)
        return spec


def _control(root, action='status'):
    path = Path(root) / 'worker.json'
    reject_links(path)
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
        port, token, identity = receipt['port'], receipt['token'], receipt['identity']
        if (type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str)
                or not re.fullmatch(r'[a-f0-9]{64}', token) or not isinstance(identity, str)
                or not re.fullmatch(r'[a-f0-9]{32}', identity)):
            raise ValueError('Invalid relay worker receipt.')
        request = Request(f'http://127.0.0.1:{port}/{action}',
                          data=b'' if action == 'stop' else None,
                          headers={'Authorization': 'Bearer ' + token})
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            data = json.loads(response.read(16384))
        if data.get('service') != SERVICE or data.get('identity') != identity:
            return None
        return data
    except (OSError, ValueError, KeyError, TypeError, URLError):
        return None


def status(root):
    data = _control(root) or {'running': False, 'ready': False}
    data['state'] = 'ready' if data['ready'] else 'starting' if data['running'] else 'stopped'
    return data


def stop(root):
    current = _control(root)
    if current:
        if not _control(root, 'stop'):
            raise RuntimeError('Could not authenticate the relay stop request.')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and _control(root):
            time.sleep(0.1)
        if _control(root):
            raise RuntimeError('The relay worker did not stop. Its process was not forcibly killed.')


def ensure_running(root, spec, interactive=False):
    root, spec = Path(root), validate_spec(spec)
    private_directory(root)
    with FileLock(str(root / 'start.lock'), timeout=15):
        current = _control(root)
        if current and current.get('spec') != spec:
            raise RuntimeError('A different relay is running in this directory. Stop it before changing the connection.')
        if current and interactive and not current.get('ready'):
            executable = ensure_cli(interactive=True)
            _authenticate(executable, True)
        if not current:
            executable = ensure_cli(interactive=interactive)
            _authenticate(executable, interactive)
            atomic_json(root / 'spec.json', spec)
            atomic_json(root / 'launch.json', {'executable': executable})
            flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0
            with (root / 'supervisor.log').open('ab') as output:
                subprocess.Popen([sys.executable, '-m', 'hindsightkit.relay', '--worker', str(root)],
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                 creationflags=flags, close_fds=True,
                                 start_new_session=os.name != 'nt')
        deadline = time.monotonic() + READY_TIMEOUT
        while time.monotonic() < deadline:
            current = _control(root)
            if current and current.get('spec') == spec and current.get('ready'):
                return spec.get('local_port')
            time.sleep(0.2)
    raise RuntimeError('The private relay is not ready. Check connectivity and sign in with the server account; '
                       'run share --relay on the server if its tunnel expired.')


class _State:
    def __init__(self, spec):
        self.spec = spec
        self.lock = threading.Lock()
        self.ready = False
        self.upstream = None
        self.child = None
        self.sockets = set()
        self.stop = threading.Event()

    def reset(self):
        with self.lock:
            self.ready, self.upstream = False, None
            for connection in self.sockets:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            self.sockets.clear()

    def line(self, text):
        text = text.strip()
        with self.lock:
            if self.spec['mode'] == 'host':
                self.ready |= text == 'Ready to accept connections for tunnel: ' + self.spec['tunnel_id']
            else:
                match = FORWARD.fullmatch(text)
                if match and int(match[2]) == self.spec['remote_port']:
                    port = int(match[1])
                    if 1 <= port <= 65535 and port != self.spec['local_port']:
                        self.upstream, self.ready = port, True


def _proxy(state):
    class Forward(socketserver.BaseRequestHandler):
        def handle(self):
            with state.lock:
                upstream = state.upstream
                child = state.child
                if (upstream is None or child is None or child.poll() is not None
                        or not _listener_owned(upstream, child.pid)):
                    return
            try:
                with socket.create_connection(('127.0.0.1', upstream), timeout=5) as target:
                    target.settimeout(None)
                    peers = [self.request, target]
                    with state.lock:
                        if (state.upstream != upstream or state.child is not child or child.poll() is not None
                                or not _listener_owned(upstream, child.pid)):
                            return
                        state.sockets.update(peers)
                    try:
                        while not state.stop.is_set():
                            ready, _, _ = select.select(peers, [], [], 1)
                            for source in ready:
                                payload = source.recv(65536)
                                if not payload:
                                    return
                                (target if source is self.request else self.request).sendall(payload)
                    finally:
                        with state.lock:
                            state.sockets.difference_update(peers)
            except OSError:
                return

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = False

    return Server(('127.0.0.1', state.spec['local_port']), Forward)


def _listener_owned(port, pid):
    """Do not forward credentials to a port recycled by another process."""
    if os.name != 'nt':
        return False

    class Row(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulong) for name in
                    ('state', 'address', 'port', 'remote_address', 'remote_port', 'pid')]

    size = ctypes.c_ulong()
    function = ctypes.windll.iphlpapi.GetExtendedTcpTable
    # AF_INET, TCP_TABLE_OWNER_PID_LISTENER; this is a read-only socket table.
    if function(None, ctypes.byref(size), False, 2, 3, 0) not in (0, 122):
        return False
    for _ in range(2):
        table = ctypes.create_string_buffer(size.value)
        code = function(table, ctypes.byref(size), False, 2, 3, 0)
        if code == 122:
            continue
        if code:
            return False
        count = ctypes.c_ulong.from_buffer(table).value
        offset = ctypes.sizeof(ctypes.c_ulong)
        if offset + count * ctypes.sizeof(Row) > len(table):
            return False
        for index in range(count):
            row = Row.from_buffer(table, offset + index * ctypes.sizeof(Row))
            if (row.pid == pid and row.address == 0x0100007f
                    and socket.ntohs(row.port & 0xffff) == port):
                return True
        return False
    return False


def _child_command(executable, spec):
    return [str(executable), spec['mode'], spec['tunnel_id']]


def _run_child(state, executable):
    delay = 1
    while not state.stop.is_set():
        state.reset()
        try:
            child = subprocess.Popen(_child_command(executable, state.spec),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1, creationflags=_flags())
        except OSError:
            if state.stop.wait(delay):
                break
            delay = min(30, delay * 2)
            continue
        with state.lock:
            state.child = child
        started = time.monotonic()
        def read_lines():
            for line in child.stdout:
                if child.poll() is None and not state.stop.is_set():
                    state.line(line)

        reader = threading.Thread(target=read_lines, daemon=True)
        reader.start()
        while child.poll() is None and not state.stop.wait(0.2):
            pass
        state.reset()
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        reader.join(timeout=2)
        child.stdout.close()
        with state.lock:
            state.child = None
        if time.monotonic() - started > 30:
            delay = 1
        if state.stop.wait(delay):
            break
        delay = min(30, delay * 2)


def serve_worker(root, executable, spec):
    root, spec = Path(root), validate_spec(spec)
    private_directory(root)
    with FileLock(str(root / 'worker.lock'), timeout=0):
        state = _State(spec)
        token, identity = secrets.token_hex(32), uuid.uuid4().hex

        class Control(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.respond(False)

            def do_POST(self):
                self.respond(True)

            def respond(self, stopping):
                if (self.path != ('/stop' if stopping else '/status') or
                        not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token)):
                    self.send_error(403)
                    return
                with state.lock:
                    payload = {'service': SERVICE, 'identity': identity, 'running': True,
                               'ready': state.ready, 'spec': spec}
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                if stopping:
                    state.stop.set()

        control = ThreadingHTTPServer(('127.0.0.1', 0), Control)
        proxy = None
        runner = None
        try:
            # Reserve the stable port before CLI connect chooses its forwarding port.
            if spec['mode'] == 'connect':
                proxy = _proxy(state)
                threading.Thread(target=proxy.serve_forever, daemon=True).start()
            threading.Thread(target=control.serve_forever, daemon=True).start()
            atomic_json(root / 'worker.json', {'port': control.server_port, 'token': token,
                                              'identity': identity, 'pid': os.getpid()})
            runner = threading.Thread(target=_run_child, args=(state, executable), daemon=True)
            runner.start()
            state.stop.wait()
        finally:
            state.stop.set()
            state.reset()
            if runner:
                runner.join(timeout=12)
            if proxy:
                proxy.shutdown()
                proxy.server_close()
            if runner:
                control.shutdown()
            control.server_close()
            receipt = root / 'worker.json'
            if receipt.is_file():
                data = json.loads(receipt.read_text(encoding='utf-8'))
                if data.get('identity') == identity:
                    receipt.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker', required=True, type=Path)
    root = parser.parse_args().worker
    try:
        spec = load_spec(root)
        reject_links(root / 'launch.json')
        executable = json.loads((root / 'launch.json').read_text(encoding='utf-8'))['executable']
        serve_worker(root, executable, spec)
    except Timeout:
        return
    except Exception:
        # CLI output and authentication data never enter worker logs.
        print('Relay worker could not start. Check the saved configuration and local port availability.', flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
