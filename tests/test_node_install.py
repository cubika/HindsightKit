import base64
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit.setup import installer
from hindsightkit.platform import runtime as runtime_env
from hindsightkit.setup import progress as install_progress
from hindsightkit.setup import node_bundle


class NodeInstallTests(unittest.TestCase):
    def test_failed_repair_invalidates_stamp_and_retry_installs_before_reuse(self):
        for client in (False, True):
            with self.subTest(client=client), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                directory = root / ('client-runtime' if client else 'runtime')
                directory.mkdir()
                source = node_bundle.package_directory(runtime_env.PACKAGE, 'client' if client else 'server')
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

                with patch.object(runtime_env, 'home', return_value=root), patch.object(runtime_env, 'npm', return_value=['npm']), \
                     patch.object(runtime_env, 'node', return_value='node'), \
                     patch.object(node_bundle, 'release_bundle', return_value=None), \
                     patch.object(node_bundle, 'verify_installed', side_effect=[ValueError('missing'), None, None]), \
                     patch.object(install_progress, 'run_install', side_effect=fail_after_unpacking) as install, \
                     contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(install_progress.InstallError):
                        installer.install_node_packages(client=client)
                    self.assertFalse(stamp.exists())
                    install.side_effect = None
                    installer.install_node_packages(client=client)
                    self.assertEqual(install.call_count, 2)
                    self.assertEqual(stamp.read_text(), digest)
                    self.assertNotIn('--registry', install.call_args.args[0])
                    installer.install_node_packages(client=client)
                    self.assertEqual(install.call_count, 2)

    def test_copilot_install_uses_same_npm_configuration_and_failure_reporting(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(runtime_env, 'home', return_value=Path(temp)), \
             patch.object(installer, 'copilot_command', side_effect=[None, ['copilot']]), \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock, return_value=True), \
             patch.object(runtime_env, 'npm', return_value=['node', 'npm-cli.js']), \
             patch.object(runtime_env, 'node', return_value='node'), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.0.86-2.\n', '')), \
             patch.object(install_progress, 'run_install') as install, \
             contextlib.redirect_stdout(io.StringIO()):
            installer.ensure_copilot()
            command = install.call_args.args[0]
            self.assertNotIn('--registry', command)
            self.assertEqual(command[2:5], ['install', '--global', '@github/copilot@1.0.85'])
            self.assertNotIn('--prefix', command)
            self.assertFalse((Path(temp) / 'copilot').exists())

    def test_existing_copilot_is_checked_and_reused_without_install_or_update(self):
        with patch.object(installer, 'copilot_command', return_value=['installed/copilot.exe']), \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock, return_value=True), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.2.0\n', '')) as check, \
             patch('hindsightkit.setup.progress.run_install') as install, \
             contextlib.redirect_stdout(io.StringIO()):
            installer.ensure_copilot()
            self.assertEqual(check.call_args.args[0], ['installed/copilot.exe', '--version'])
            install.assert_not_called()

    def test_broken_existing_copilot_is_not_overwritten(self):
        with patch.object(installer, 'copilot_command', return_value=['existing/copilot.exe']), \
             patch.object(subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['copilot'])), \
             patch('hindsightkit.setup.progress.run_install') as install, \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock) as authenticate:
            with self.assertRaisesRegex(RuntimeError, 'not overwritten'):
                installer.ensure_copilot()
            install.assert_not_called()
            authenticate.assert_not_awaited()

    def test_npm_global_copilot_is_found_when_its_prefix_is_not_on_path(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            loader = root / 'npm prefix/node_modules/@github/copilot/npm-loader.js'
            loader.parent.mkdir(parents=True)
            loader.write_text('// installed by npm')
            with patch.object(runtime_env, 'home', return_value=root / 'kit'), \
                 patch.object(installer.shutil, 'which', return_value=None), \
                 patch.object(runtime_env, 'npm', return_value=['node', 'npm-cli.js']), \
                 patch.object(runtime_env, 'node', return_value='node'), \
                 patch.object(runtime_env, 'run', return_value=str(root / 'npm prefix')) as read:
                self.assertEqual(installer.copilot_command(), ['node', loader])
                read.assert_called_once_with(['node', 'npm-cli.js', 'prefix', '--global'], capture=True)

    def test_separate_install_failure_never_starts_authentication(self):
        with patch.object(installer, 'copilot_command', return_value=None), \
             patch.object(runtime_env, 'npm', return_value=['node', 'npm-cli.js']), \
             patch('hindsightkit.setup.progress.run_install', side_effect=install_progress.InstallError('TLS failure')), \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock) as authenticate:
            with self.assertRaisesRegex(install_progress.InstallError, 'TLS failure'):
                installer.ensure_copilot()
            authenticate.assert_not_awaited()

    def test_broken_npm_launcher_does_not_trigger_a_second_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            launcher = Path(temp) / 'copilot.cmd'
            launcher.write_text('@echo off')
            with patch.object(installer.shutil, 'which', return_value=str(launcher)), \
                 patch('hindsightkit.setup.progress.run_install') as install:
                with self.assertRaisesRegex(RuntimeError, 'will not overwrite'):
                    installer.ensure_copilot()
                install.assert_not_called()

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
                source = root / 'source/node/server'
                source.mkdir(parents=True)
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
                             patch.object(runtime_env, 'home', return_value=state), \
                             patch.object(runtime_env, 'PACKAGE', root / 'source'), \
                             patch.object(runtime_env, 'npm', return_value=[binary, str(npm)]), \
                             patch.object(runtime_env, 'node', return_value=binary), \
                             patch.object(node_bundle, 'release_bundle', return_value=None), \
                             patch.object(node_bundle, 'verify_installed'), \
                             contextlib.redirect_stdout(io.StringIO()):
                            if valid:
                                installer.install_node_packages()
                                installed = state / 'runtime/node_modules/setup-fixture/package.json'
                                self.assertEqual(json.loads(installed.read_text())['version'], '1.0.0')
                                self.assertTrue((state / 'runtime/.installed-lock').is_file())
                            else:
                                with self.assertRaisesRegex(install_progress.InstallError, 'EINTEGRITY'):
                                    installer.install_node_packages()
                                self.assertFalse((state / 'runtime/.installed-lock').exists())
                self.assertEqual(config.read_bytes(), original_config)
                self.assertGreaterEqual(len(requests), 2)
                self.assertTrue(all(path == '/setup-fixture/-/setup-fixture-1.0.0.tgz' for path in requests))
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
