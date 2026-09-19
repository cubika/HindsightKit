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
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='hk-node-install-')
        self.addCleanup(directory.cleanup)
        home = patch.object(runtime_env, 'home', return_value=Path(directory.name))
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict(os.environ, {'COPILOT_CLI_PATH': ''})
        environment.start()
        self.addCleanup(environment.stop)

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
             patch.object(installer, 'find_copilot', side_effect=[None, (['copilot'], 'GitHub Copilot CLI 1.0.86-2.')]), \
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
        with patch.object(installer, 'copilot_candidates', return_value=[Path('installed/copilot.exe')]), \
             patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock, return_value=True), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.2.0\n', '')) as check, \
             patch('hindsightkit.setup.progress.run_install') as install, \
             contextlib.redirect_stdout(io.StringIO()):
            installer.ensure_copilot()
            self.assertEqual(check.call_args.args[0], [str(Path('installed/copilot.exe')), '--version'])
            install.assert_not_called()

    def test_broken_existing_copilot_is_not_overwritten(self):
        with patch.object(installer, 'copilot_candidates', return_value=[Path('existing/copilot.exe')]), \
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
                 patch.object(os, 'get_exec_path', return_value=[]), \
                 patch.object(runtime_env, 'npm', return_value=['node', 'npm-cli.js']), \
                 patch.object(runtime_env, 'node', return_value='node'), \
                 patch.object(runtime_env, 'run', return_value=str(root / 'npm prefix')) as read, \
                 patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.0.85\n', '')):
                self.assertEqual(installer.find_copilot(), (['node', str(loader)], 'GitHub Copilot CLI 1.0.85'))
                read.assert_called_once_with(['node', 'npm-cli.js', 'prefix', '--global'], capture=True)

    def test_separate_install_failure_never_starts_authentication(self):
        with patch.object(installer, 'find_copilot', return_value=None), \
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
            with patch.object(installer, 'copilot_candidates', return_value=[launcher]), \
                 patch('hindsightkit.setup.progress.run_install') as install:
                with self.assertRaisesRegex(RuntimeError, 'not overwritten'):
                    installer.ensure_copilot()
                install.assert_not_called()

    @unittest.skipUnless(os.name == 'nt', 'Windows PATH and application aliases')
    def test_broken_windows_alias_uses_later_cli_for_version_and_login(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            alias = root / 'WindowsApps/copilot.exe'
            binary = root / 'WinGet/Links/copilot.exe'
            for path in (alias, binary):
                path.parent.mkdir(parents=True)
                path.write_bytes(b'fixture')
            path_value = os.pathsep.join([str(alias.parent), str(alias.parent), str(binary.parent)])
            log = root / 'install.log'
            failure = OSError('The file cannot be accessed by the system')
            failure.winerror = 1920
            failure.strerror = 'The file cannot be accessed by the system'
            output = io.StringIO()
            with patch.dict(os.environ, {'PATH': path_value, 'PATHEXT': '.EXE', 'HINDSIGHTKIT_INSTALL_LOG': str(log)}), \
                 patch.object(subprocess, 'run', side_effect=[failure,
                    subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.0.86-2.\n', '')]) as run, \
                 patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock, side_effect=[False, True]), \
                 patch.object(runtime_env, 'run') as login, patch.object(runtime_env, 'npm') as npm, \
                 patch.object(install_progress, 'run_install') as install, contextlib.redirect_stdout(output):
                installer.ensure_copilot()
                self.assertEqual(os.environ['PATH'], path_value)
            self.assertEqual([Path(call.args[0][0]) for call in run.call_args_list], [alias, binary])
            self.assertTrue(all(call.args[0][1:] == ['--version'] for call in run.call_args_list))
            self.assertEqual(login.call_count, 1)
            self.assertEqual(Path(login.call_args.args[0][0]), binary)
            self.assertEqual(login.call_args.args[0][1:], ['login'])
            npm.assert_not_called()
            install.assert_not_called()
            self.assertIn(str(alias).lower(), log.read_text().lower())
            self.assertIn('1920', log.read_text())
            self.assertIn('Reusing GitHub Copilot CLI 1.0.86-2.', log.read_text())
            self.assertNotIn('Sign in through Copilot', log.read_text())
            self.assertEqual(alias.read_bytes(), b'fixture')
            self.assertEqual(binary.read_bytes(), b'fixture')

    def test_working_windows_alias_is_kept_without_trying_later_installations(self):
        alias, other = Path('WindowsApps/copilot.exe'), Path('WinGet/Links/copilot.exe')
        with patch.object(installer, 'copilot_candidates', return_value=[alias, other]), \
             patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.0.86-2.\n', '')) as run:
            self.assertEqual(installer.find_copilot(), ([str(alias)], 'GitHub Copilot CLI 1.0.86-2.'))
            self.assertEqual(run.call_count, 1)

    def test_all_unusable_entries_report_paths_and_safe_failure_details(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'install.log'
            binaries = [Path(name) / 'copilot.exe' for name in ['timeout', 'exit-error', 'wrong-program']]
            errors = [subprocess.TimeoutExpired(['copilot', '--version'], 30),
                subprocess.CalledProcessError(17, ['copilot'], stderr='token=private-value permission denied'),
                subprocess.CompletedProcess([], 0, '2.0.0\n', '')]
            with patch.dict(os.environ, {'HINDSIGHTKIT_INSTALL_LOG': str(log)}), \
                 patch.object(installer, 'copilot_candidates', return_value=[binaries[0], binaries[0], *binaries[1:]]), \
                 patch.object(subprocess, 'run', side_effect=errors) as run, \
                 patch.object(install_progress, 'run_install') as install, \
                 patch.object(installer, 'copilot_authenticated', new_callable=AsyncMock) as auth, \
                 contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError) as error:
                    installer.ensure_copilot()
            text = str(error.exception)
            for binary in binaries:
                self.assertIn(str(binary), text)
            self.assertIn('timed out after 30 seconds', text)
            self.assertIn('exited with code 17', text)
            self.assertIn('permission denied', text)
            self.assertIn('unrecognized', text)
            self.assertIn('not overwritten', text)
            self.assertNotIn('private-value', text + log.read_text())
            self.assertEqual(sum(line.startswith('Skipped unusable') for line in log.read_text().splitlines()), 3)
            self.assertEqual(run.call_count, 3)
            auth.assert_not_awaited()
            install.assert_not_called()

    def test_npm_launchers_use_node_and_share_one_version_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            loader = root / 'node_modules/@github/copilot/npm-loader.js'
            loader.parent.mkdir(parents=True)
            loader.touch()
            candidates = [root / 'copilot.cmd', root / 'copilot.ps1', root / 'copilot.exe']
            with patch.object(installer, 'copilot_candidates', return_value=candidates), \
                 patch.object(runtime_env, 'node', return_value='node'), \
                 patch.object(subprocess, 'run', side_effect=[subprocess.CalledProcessError(1, []),
                    subprocess.CompletedProcess([], 0, 'GitHub Copilot CLI 1.0.85\n', '')]) as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(installer.find_copilot(), ([str(candidates[2])], 'GitHub Copilot CLI 1.0.85'))
            self.assertEqual([call.args[0] for call in run.call_args_list],
                             [['node', str(loader), '--version'], [str(candidates[2]), '--version']])

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
