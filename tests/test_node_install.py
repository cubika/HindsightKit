import base64
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit import cli, install_progress, node_bundle


class NodeInstallTests(unittest.TestCase):
    def test_failed_repair_invalidates_stamp_and_retry_installs_before_reuse(self):
        for client in (False, True):
            with self.subTest(client=client), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                directory = root / ('client-runtime' if client else 'runtime')
                directory.mkdir()
                source = cli.PACKAGE / 'client' if client else cli.PACKAGE
                digest = hashlib.sha256((source / 'package-lock.json').read_bytes()).hexdigest()
                stamp = directory / '.installed-lock'
                stamp.write_text(digest)
                component = ('hindsight-coding-agents/dist/installer.js' if client else
                             'hindsight-control-plane/standalone/server.js')
                entry = directory / 'node_modules/@vectorize-io' / component

                def fail_after_unpacking(*args, **kwargs):
                    self.assertFalse(stamp.exists())
                    entry.parent.mkdir(parents=True)
                    entry.write_text('partial installation')
                    raise install_progress.InstallError('TLS fixture', 1)

                with patch.object(cli, 'home', return_value=root), patch.object(cli, 'npm', return_value=['npm']), \
                     patch.object(cli, 'node', return_value='node'), \
                     patch.object(node_bundle, 'release_bundle', return_value=None), \
                     patch.object(node_bundle, 'verify_installed', side_effect=[ValueError('missing'), None, None]), \
                     patch.object(install_progress, 'run_install', side_effect=fail_after_unpacking) as install, \
                     contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(install_progress.InstallError):
                        cli.install_node_packages(client=client)
                    self.assertFalse(stamp.exists())
                    install.side_effect = None
                    cli.install_node_packages(client=client)
                    self.assertEqual(install.call_count, 2)
                    self.assertEqual(stamp.read_text(), digest)
                    self.assertNotIn('--registry', install.call_args.args[0])
                    cli.install_node_packages(client=client)
                    self.assertEqual(install.call_count, 2)

    def test_copilot_install_uses_same_npm_configuration_and_failure_reporting(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(cli, 'home', return_value=Path(temp)), \
             patch.object(cli, 'copilot_command', side_effect=[None, ['copilot']]), \
             patch.object(cli, 'copilot_authenticated', new_callable=AsyncMock, return_value=True), \
             patch.object(cli, 'npm', return_value=['node', 'npm-cli.js']), \
             patch.object(cli, 'node', return_value='node'), \
             patch.object(node_bundle, 'release_bundle', return_value=None), \
             patch.object(node_bundle, 'verify_installed'), \
             patch.object(install_progress, 'run_install') as install, \
             contextlib.redirect_stdout(io.StringIO()):
            cli.ensure_copilot()
            command = install.call_args.args[0]
            self.assertNotIn('--registry', command)
            self.assertIn('ci', command)
            lock = json.loads((Path(temp) / 'copilot/package-lock.json').read_text())
            self.assertEqual(lock['packages']['']['dependencies']['@github/copilot'], '1.0.85')
            self.assertEqual(install.call_args.kwargs['cwd'], Path(temp) / 'copilot')

    def test_real_npm_uses_user_registry_for_locked_tarball_and_checks_integrity(self):
        binary = shutil.which('node')
        if not binary:
            self.skipTest('Node.js is required for the local registry fixture.')
        npm = Path(binary).resolve().parent / 'node_modules/npm/bin/npm-cli.js'
        if not npm.is_file():
            self.skipTest('npm is required for the local registry fixture.')
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w:gz') as archive:
            content = b'{"name":"setup-fixture","version":"1.0.0"}'
            entry = tarfile.TarInfo('package/package.json')
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
        tarball = payload.getvalue()
        integrity = 'sha512-' + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
        requests = []

        class Registry(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header('Content-Length', str(len(tarball)))
                self.end_headers()
                self.wfile.write(tarball)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Registry)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / 'source'
                source.mkdir()
                package = {'name': 'installer-fixture', 'version': '1.0.0',
                           'dependencies': {'setup-fixture': '1.0.0'}}
                (source / 'package.json').write_text(json.dumps(package))
                lock = {**package, 'lockfileVersion': 3, 'requires': True, 'packages': {
                    '': package, 'node_modules/setup-fixture': {'version': '1.0.0',
                        'resolved': 'https://registry.npmjs.org/setup-fixture/-/setup-fixture-1.0.0.tgz',
                        'integrity': integrity}}}
                config = root / 'user.npmrc'
                config.write_text(f'registry=http://127.0.0.1:{server.server_port}/\n'
                                  'fetch-retries=0\nfetch-timeout=5000\nstrict-ssl=true\n')
                original_config = config.read_bytes()
                environment = {key: value for key, value in os.environ.items()
                               if not key.lower().startswith('npm_config_') and
                               key.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
                environment.update(NPM_CONFIG_USERCONFIG=str(config),
                                   NPM_CONFIG_GLOBALCONFIG=str(root / 'global.npmrc'),
                                   NPM_CONFIG_UPDATE_NOTIFIER='false', NO_PROXY='127.0.0.1')
                for valid in (True, False):
                    with self.subTest(valid_integrity=valid):
                        state = root / str(valid)
                        environment['NPM_CONFIG_CACHE'] = str(state / 'cache')
                        if not valid:
                            lock['packages']['node_modules/setup-fixture']['integrity'] = (
                                'sha512-' + base64.b64encode(bytes(64)).decode())
                        (source / 'package-lock.json').write_text(json.dumps(lock))
                        with patch.dict(os.environ, environment, clear=True), \
                             patch.object(cli, 'home', return_value=state), \
                             patch.object(cli, 'PACKAGE', source), \
                             patch.object(cli, 'npm', return_value=[binary, str(npm)]), \
                             patch.object(cli, 'node', return_value=binary), \
                             patch.object(node_bundle, 'release_bundle', return_value=None), \
                             patch.object(node_bundle, 'verify_installed'), \
                             contextlib.redirect_stdout(io.StringIO()):
                            if valid:
                                cli.install_node_packages()
                                installed = state / 'runtime/node_modules/setup-fixture/package.json'
                                self.assertEqual(json.loads(installed.read_text())['version'], '1.0.0')
                                self.assertTrue((state / 'runtime/.installed-lock').is_file())
                            else:
                                with self.assertRaisesRegex(install_progress.InstallError, 'EINTEGRITY'):
                                    cli.install_node_packages()
                                self.assertFalse((state / 'runtime/.installed-lock').exists())
                self.assertEqual(config.read_bytes(), original_config)
                self.assertGreaterEqual(len(requests), 2)
                self.assertTrue(all(path == '/setup-fixture/-/setup-fixture-1.0.0.tgz' for path in requests))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
