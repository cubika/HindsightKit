"""Install release npm archives in isolation and exercise their real entry points."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import urlopen
from unittest.mock import patch


def dashboard(directory, node, env):
    class API(BaseHTTPRequestHandler):
        def do_GET(self):
            payload = b'{"banks":[]}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    backend = ThreadingHTTPServer(('127.0.0.1', 0), API)
    worker = threading.Thread(target=backend.serve_forever, daemon=True)
    worker.start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    log = directory / 'dashboard.log'
    server = directory / 'node_modules/@vectorize-io/hindsight-control-plane/standalone/server.js'
    child_env = {**env, 'PORT': str(port), 'HOSTNAME': 'localhost',
                 'HINDSIGHT_CP_DATAPLANE_API_URL': f'http://127.0.0.1:{backend.server_port}',
                 'NEXT_TELEMETRY_DISABLED': '1'}
    process = None
    try:
        with log.open('wb') as output:
            process = subprocess.Popen([node, str(server)], env=child_env, cwd=server.parent,
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    with urlopen(f'http://localhost:{port}/dashboard', timeout=3) as response:
                        html = response.read().decode('utf-8')
                        if response.status == 200 and 'hindsight' in html.lower():
                            assets = set(re.findall(r'(?:src|href)="(/_next/static/[^"?]+)', html))
                            if not assets:
                                raise RuntimeError('Dashboard did not reference its static assets')
                            for asset in assets:
                                with urlopen(f'http://localhost:{port}{asset}', timeout=5) as resource:
                                    if resource.status != 200 or b'<html' in resource.read(100).lower():
                                        raise RuntimeError('Bundled dashboard asset failed: ' + asset)
                            if process.poll() is not None:
                                raise RuntimeError('Dashboard exited during verification')
                            print(f'Dashboard and {len(assets)} static assets returned HTTP 200.', flush=True)
                            return
                except OSError:
                    pass
                time.sleep(0.25)
        raise RuntimeError('Bundled dashboard failed its HTTP check: ' + log.read_text(errors='replace')[-3000:])
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        backend.shutdown()
        backend.server_close()
        worker.join(timeout=5)


def verify(bundle: Path, package: Path):
    from hindsightkit import cli, node_bundle
    bundle, package = bundle.resolve(strict=True), package.resolve(strict=True)
    manifest = json.loads((bundle / node_bundle.MANIFEST).read_text())
    roles = tuple(manifest['bundles'])
    node_bundle.validate_bundle(bundle, package, roles=roles)
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js is required for bundle verification')
    with tempfile.TemporaryDirectory(prefix='hindsightkit-node-verify-') as temp:
        root = Path(temp)
        profile = root / 'profile'
        profile.mkdir()
        env = {key: value for key, value in os.environ.items()
               if not key.upper().startswith(('HINDSIGHT', 'COPILOT', 'GH_', 'GITHUB_', 'NODE_', 'NPM_'))}
        guard = root / 'local-only.cjs'
        guard.write_text('''const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  if (host && !['localhost','127.0.0.1','::1'].includes(host)) {
    throw new Error('External network blocked by bundle verification: ' + host);
  }
  return original.apply(this,args);
};
''', encoding='utf-8')
        env.update(USERPROFILE=str(profile), HOME=str(profile), LOCALAPPDATA=str(profile / 'local'),
                   APPDATA=str(profile / 'roaming'), NODE_OPTIONS=f'--require="{guard.as_posix()}"',
                   HINDSIGHT_CONFIG=str(profile / 'coding-agent.json'),
                   HINDSIGHT_LOG_FILE=str(profile / 'hooks.log'), NEXT_TELEMETRY_DISABLED='1')
        with patch.dict(os.environ, env, clear=True), patch.object(cli, 'PACKAGE', package), \
             patch.object(cli, 'home', return_value=root / 'kit'), patch.object(cli, 'node', return_value=node), \
             patch.object(node_bundle, 'release_bundle', return_value=bundle), \
             patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('Release invoked npm')):
            for role in roles:
                cli.install_node_role(role)
                cli.install_node_role(role)
                directory = cli.home() / {'client': 'client-runtime', 'server': 'runtime', 'copilot': 'copilot'}[role]
                if role != 'copilot':
                    target = profile / role
                    target.mkdir()
                    cli.integrate('install-cli', target, target / '.hindsight/coding-agent.json',
                                  'http://127.0.0.1:9', node, sys.executable, runtime_path=directory)
                    hook = target / '.copilot/hooks/hindsight-coding-agents.json'
                    if not hook.is_file():
                        raise RuntimeError('Bundled installer did not generate Copilot hooks')
                if role == 'server':
                    dashboard(directory, node, env)
            # Damage a real transitive dependency and prove retry repairs it from the archive.
            if 'client' in roles:
                dependency = cli.home() / 'client-runtime/node_modules/jsonc-parser/lib/umd/main.js'
                dependency.unlink()
                cli.install_node_role('client')
                if not dependency.is_file():
                    raise RuntimeError('Bundled retry did not repair a missing dependency')
    print('Verified bundled npm install, repeat, repair, and entry points without npm downloads.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.package.resolve().parent))
    verify(**vars(args))


if __name__ == '__main__':
    main()
