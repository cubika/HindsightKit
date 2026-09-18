import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from hindsightkit import installer, runtime as runtime_env, node_bundle


class NodeBundleTests(unittest.TestCase):
    def fixture(self, root, extra=None):
        package, bundle = root / 'package', root / 'node'
        (package / 'client').mkdir(parents=True)
        bundle.mkdir()
        package_json = {'name': 'fixture', 'version': '1.0.0'}
        lock = {'lockfileVersion': 3, 'packages': {'': package_json,
                'node_modules/required': {'version': '1.0.0'}}}
        (package / 'client/package.json').write_text(json.dumps(package_json))
        lock_path = package / 'client/package-lock.json'
        lock_path.write_text(json.dumps(lock))
        files = {name: '// fixture' for name in node_bundle.ENTRYPOINTS['client']}
        files['node_modules/required/package.json'] = json.dumps(package_json)
        files['node_modules/required/LICENSE'] = 'Preserved upstream license'
        files.update(extra or {})
        with zipfile.ZipFile(bundle / 'client.zip', 'w') as archive:
            for name, payload in files.items():
                info = zipfile.ZipInfo()
                info.filename = name
                archive.writestr(info, payload)
        self.manifest(bundle, lock_path)
        return package, bundle

    def manifest(self, bundle, lock_path):
        manifest = {'schema': 1, 'platform': 'windows-x64', 'bundles': {'client': {
            'archive': 'client.zip', 'sha256': node_bundle.sha256(bundle / 'client.zip'),
            'lock_sha256': node_bundle.sha256(lock_path)}}}
        (bundle / node_bundle.MANIFEST).write_text(json.dumps(manifest))

    def test_release_install_and_repair_are_offline_and_preserve_existing_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            state = root / 'state'
            state.mkdir()
            (state / 'settings.json').write_text('saved settings')
            with patch.object(runtime_env, 'home', return_value=state), patch.object(runtime_env, 'PACKAGE', package), \
                 patch.object(runtime_env, 'node', return_value='node'), \
                 patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('npm network')), \
                 patch.object(node_bundle, 'verify_installed') as verify, contextlib.redirect_stdout(io.StringIO()):
                installer.install_node_packages(client=True)
                installer.install_node_packages(client=True)
                directory = state / 'client-runtime'
                self.assertEqual((directory / 'node_modules/required/LICENSE').read_text(), 'Preserved upstream license')
                verify.side_effect = [ValueError('damaged installation'), None]
                installer.install_node_packages(client=True)
                self.assertTrue((directory / '.installed-lock').is_file())
                self.assertEqual((state / 'settings.json').read_text(), 'saved settings')
                self.assertFalse(list(directory.glob('.node-install-*')))

    def test_corrupt_bundle_leaves_existing_installation_and_never_calls_npm(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'state/client-runtime'
            (directory / 'node_modules').mkdir(parents=True)
            marker = directory / 'node_modules/preserve.txt'
            marker.write_text('previous runtime')
            (bundle / 'client.zip').write_bytes(b'corrupted')
            with patch.object(runtime_env, 'home', return_value=root / 'state'), patch.object(runtime_env, 'PACKAGE', package), \
                 patch.object(runtime_env, 'node', return_value='node'), patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('no fallback')), \
                 contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'SHA256'):
                installer.install_node_packages(client=True)
            self.assertEqual(marker.read_text(), 'previous runtime')
            self.assertFalse((directory / '.installed-lock').exists())

    def test_reuse_detects_missing_and_same_size_changed_files(self):
        for damage in ('missing', 'changed'):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                package, bundle = self.fixture(root)
                directory = root / 'runtime'
                with patch.object(node_bundle, 'verify_installed'):
                    node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
                target = directory / 'node_modules/required/LICENSE'
                if damage == 'missing':
                    target.unlink()
                else:
                    target.write_bytes(b'x' * target.stat().st_size)
                with self.assertRaisesRegex(ValueError, 'missing or changed|file changed'):
                    node_bundle.verify_bundle_files(bundle, package, 'client', directory)

    def test_reuse_checks_all_batches_and_propagates_worker_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            extra = {f'node_modules/required/file-{index:03d}.txt': f'content-{index:03d}'
                     for index in range(260)}
            package, bundle = self.fixture(root, extra)
            directory = root / 'runtime'
            with patch.object(node_bundle, 'verify_installed'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            node_bundle.verify_bundle_files(bundle, package, 'client', directory)
            for name in ('file-000.txt', 'file-130.txt', 'file-259.txt'):
                target = directory / 'node_modules/required' / name
                original = target.read_bytes()
                target.write_bytes(b'x' * len(original))
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'file changed'):
                    node_bundle.verify_bundle_files(bundle, package, 'client', directory)
                target.write_bytes(original)

    def test_repair_replaces_node_modules_that_became_a_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            directory.mkdir()
            (directory / 'node_modules').write_text('damaged runtime')
            with patch.object(node_bundle, 'verify_installed'), contextlib.redirect_stdout(io.StringIO()):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            node_bundle.verify_bundle_files(bundle, package, 'client', directory)
            self.assertFalse((directory / '.previous-node_modules').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows junction validation')
    def test_reuse_and_replacement_reject_junctions_without_touching_the_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            with patch.object(node_bundle, 'verify_installed'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            external = root / 'external'
            external.mkdir()
            marker = external / 'keep.txt'
            marker.write_text('keep this data')
            junction = directory / 'node_modules/linked'
            subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                'New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET | Out-Null'],
                env={**os.environ, 'TEST_LINK': str(junction), 'TEST_TARGET': str(external)},
                check=True, capture_output=True, timeout=15)
            try:
                with self.assertRaisesRegex(ValueError, 'Linked npm bundle path'):
                    node_bundle.verify_bundle_files(bundle, package, 'client', directory)
                with self.assertRaisesRegex(ValueError, 'Linked npm bundle path'):
                    node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
                self.assertEqual(marker.read_text(), 'keep this data')
                self.assertTrue((directory / node_bundle.ENTRYPOINTS['client'][0]).is_file())
            finally:
                junction.rmdir()

    def test_failed_entrypoint_validation_does_not_replace_existing_node_modules(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            (directory / 'node_modules').mkdir(parents=True)
            marker = directory / 'node_modules/old'
            marker.write_text('previous')
            with patch.object(node_bundle, 'verify_installed', side_effect=ValueError('broken runtime')), \
                 self.assertRaisesRegex(ValueError, 'broken runtime'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            self.assertEqual(marker.read_text(), 'previous')
            self.assertFalse(list(directory.glob('.node-install-*')))

    def test_unsafe_archive_paths_are_rejected_before_writing(self):
        for name in ('node_modules/../../escape', 'node_modules/pkg/CON.txt',
                     'node_modules/pkg/a:stream', 'node_modules/pkg/a.', 'node_modules/required/Package.json',
                     'node_modules/required/LICENSE/child', 'node_modules/pkg\\escape'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                package, bundle = self.fixture(Path(temp), {name: 'bad'})
                with self.assertRaises(ValueError):
                    node_bundle.validate_bundle(bundle, package, roles=('client',))

    def test_missing_required_package_and_wrong_lock_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            package, bundle = self.fixture(Path(temp), {'node_modules/required/package.json': '{"version":"2.0.0"}'})
            with self.assertRaisesRegex(ValueError, 'missing locked package'):
                node_bundle.validate_bundle(bundle, package, roles=('client',))
            (package / 'client/package-lock.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'lockfile'):
                node_bundle.validate_bundle(bundle, package, roles=('client',))

    def test_failed_replacement_and_rollback_preserve_previous_runtime_for_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            (directory / 'node_modules').mkdir(parents=True)
            (directory / 'node_modules/old').write_text('keep previous')
            native_rename = Path.rename

            def fail_replacement_and_rollback(path, target):
                if path != directory / 'node_modules':
                    raise PermissionError('locked')
                return native_rename(path, target)

            with patch.object(node_bundle, 'verify_installed'), \
                 patch.object(Path, 'rename', fail_replacement_and_rollback), \
                 self.assertRaisesRegex(RuntimeError, 'previous runtime is preserved'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            previous = directory / '.previous-node_modules'
            self.assertEqual((previous / 'old').read_text(), 'keep previous')
            with patch.object(node_bundle, 'verify_installed'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            self.assertFalse(previous.exists())
            self.assertTrue((directory / node_bundle.ENTRYPOINTS['client'][0]).exists())

    def test_nonobject_package_metadata_is_a_repairable_validation_error(self):
        for metadata in ('null', '[]'):
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as temp:
                package, bundle = self.fixture(Path(temp), {'node_modules/required/package.json': metadata})
                with self.assertRaisesRegex(ValueError, 'missing locked package'):
                    node_bundle.validate_bundle(bundle, package, roles=('client',))

    def test_locked_old_runtime_cleanup_does_not_block_install_or_reuse(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            state = root / 'state'
            directory = state / 'client-runtime'
            (directory / 'node_modules').mkdir(parents=True)
            (directory / 'node_modules/old').write_text('locked previous runtime')
            previous = directory / '.previous-node_modules'
            native_rmtree = node_bundle.shutil.rmtree
            cleanup_attempts = []

            def keep_locked_previous(path, *args, **kwargs):
                if Path(path) == previous:
                    cleanup_attempts.append(Path(path))
                    raise PermissionError('Previous runtime file is still open')
                return native_rmtree(path, *args, **kwargs)

            output = io.StringIO()
            with patch.object(runtime_env, 'home', return_value=state), patch.object(runtime_env, 'PACKAGE', package), \
                 patch.object(runtime_env, 'node', return_value='node'), \
                 patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch.object(node_bundle, 'verify_installed'), \
                 patch.object(node_bundle.shutil, 'rmtree', side_effect=keep_locked_previous), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('npm network')), \
                 contextlib.redirect_stdout(output):
                installer.install_node_role('client')
                node_bundle.verify_bundle_files(bundle, package, 'client', directory)
                expected = hashlib.sha256((package / 'client/package-lock.json').read_bytes()).hexdigest()
                self.assertEqual((directory / '.installed-lock').read_text(), expected)
                self.assertEqual((previous / 'old').read_text(), 'locked previous runtime')
                with patch.object(node_bundle, 'install_bundle', side_effect=AssertionError('Already installed')):
                    installer.install_node_role('client')
            self.assertEqual(cleanup_attempts, [previous])
            self.assertIn('Reusing Copilot client integration', output.getvalue())
            self.assertFalse(list(directory.glob('.node-install-*')))

    def test_release_path_is_detected_after_bootstrap_environment_is_gone(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp)
            (app / 'release.json').write_text('{}')
            with patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': ''}), \
                 patch.object(node_bundle.sys, 'executable', str(app / '.venv/Scripts/python.exe')):
                self.assertEqual(node_bundle.release_bundle(), app.resolve() / 'node')

    def test_setup_preflight_install_reuse_and_repair_validate_each_zip_once(self):
        for operation in ('install', 'reuse', 'repair'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                package, bundle = self.fixture(root)
                state = root / 'state'
                directory = state / 'client-runtime'
                args = argparse.Namespace(server=None, client_only=True, server_only=False)
                with patch.object(runtime_env, 'home', return_value=state), patch.object(runtime_env, 'PACKAGE', package), \
                     patch.object(runtime_env, 'node', return_value='node'), \
                     patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                     patch.object(node_bundle, 'verify_installed'), contextlib.redirect_stdout(io.StringIO()):
                    if operation != 'install':
                        installer.install_node_role('client')
                        if operation == 'repair':
                            target = directory / 'node_modules/required/LICENSE'
                            target.write_bytes(b'x' * target.stat().st_size)
                    opened = []
                    digested = []
                    original_open = node_bundle._open_bundle_file
                    original_digest = hashlib.file_digest

                    def record_open(path):
                        stream = original_open(path)
                        if path.suffix == '.zip':
                            opened.append(stream)
                        return stream

                    def record_digest(stream, *arguments, **keywords):
                        if stream in opened:
                            digested.append(stream)
                        return original_digest(stream, *arguments, **keywords)

                    with patch.object(node_bundle, '_open_bundle_file', side_effect=record_open), \
                         patch.object(hashlib, 'file_digest', side_effect=record_digest), \
                         patch.object(node_bundle, '_members', wraps=node_bundle._members) as members, \
                         patch.object(installer, 'validate_setup_options'), patch.object(installer, 'require_client_prerequisites'), \
                         patch.object(installer, 'setup_client_only', side_effect=lambda: installer.install_node_packages(client=True)), \
                         patch('hindsightkit.command.install', return_value=state / 'bin/hindsightkit'):
                        installer.setup(args)
                    self.assertEqual(len(opened), 1)
                    self.assertEqual(digested, opened)
                    members.assert_called_once()
                    self.assertTrue(opened[0].closed)
                    self.assertIsNone(node_bundle._active_bundle.get())
                    self.assertEqual((directory / 'node_modules/required/LICENSE').read_text(), 'Preserved upstream license')
                    self.assertTrue((directory / '.installed-lock').is_file())

    @unittest.skipUnless(os.name == 'nt', 'Windows archive sharing modes')
    def test_session_prevents_archive_manifest_and_lock_mutation_and_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            paths = (bundle / 'client.zip', bundle / node_bundle.MANIFEST, package / 'client/package-lock.json')
            with node_bundle.bundle_session(bundle, package, roles=('client',)) as verified:
                for index, path in enumerate(paths):
                    with self.subTest(path=path.name):
                        original = path.read_bytes()
                        with self.assertRaises(PermissionError):
                            path.write_bytes(original)
                        replacement = root / f'replacement-{index}'
                        replacement.write_bytes(original)
                        with self.assertRaises(PermissionError):
                            replacement.replace(path)
                        self.assertEqual(path.read_bytes(), original)
                        verified.check_unchanged()
            self.assertTrue(all(source.stream.closed for source in verified.inputs))
            for path in paths:
                path.write_bytes(path.read_bytes())

    @unittest.skipUnless(os.name == 'nt', 'Windows archive sharing modes')
    def test_session_rejects_existing_writer_and_releases_partial_validation_handles(self):
        with tempfile.TemporaryDirectory() as temp:
            package, bundle = self.fixture(Path(temp))
            with (bundle / 'client.zip').open('r+b'):
                with self.assertRaises(OSError):
                    node_bundle.validate_bundle(bundle, package, roles=('client',))
            self.assertIsNone(node_bundle._active_bundle.get())
            manifest = bundle / node_bundle.MANIFEST
            manifest.write_bytes(manifest.read_bytes())
            lock = package / 'client/package-lock.json'
            lock.write_bytes(lock.read_bytes())
            node_bundle.validate_bundle(bundle, package, roles=('client',))

    def test_changed_archive_is_rejected_before_replacing_existing_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            (directory / 'node_modules').mkdir(parents=True)
            marker = directory / 'node_modules/old'
            marker.write_text('previous')
            # Exercise the metadata guard independently of Windows deny-write
            # handles, as used when tests or bundle tools run on another OS.
            with patch.object(node_bundle, '_open_bundle_file', side_effect=lambda path: path.open('rb')):
                with self.assertRaisesRegex(ValueError, 'changed during installation'):
                    with node_bundle.bundle_session(bundle, package, roles=('client',)):
                        archive = bundle / 'client.zip'
                        with archive.open('r+b') as writer:
                            writer.seek(40)
                            writer.write(b'changed')
                        info = archive.stat()
                        os.utime(archive, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
                        node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            self.assertEqual(marker.read_text(), 'previous')
            self.assertFalse(list(directory.glob('.node-install-*')))
            self.assertIsNone(node_bundle._active_bundle.get())

    def test_session_failure_closes_handles_and_next_call_revalidates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                with node_bundle.bundle_session(bundle, package, roles=('client',)) as verified:
                    manifest = node_bundle.validate_bundle(bundle, package, roles=('client',))
                    self.assertEqual(manifest, json.loads((bundle / node_bundle.MANIFEST).read_text()))
                    raise RuntimeError('interrupted')
            self.assertTrue(all(source.stream.closed for source in verified.inputs))
            self.assertIsNone(node_bundle._active_bundle.get())
            (bundle / 'client.zip').write_bytes(b'changed after setup')
            for operation in (
                    lambda: node_bundle.validate_bundle(bundle, package, roles=('client',)),
                    lambda: node_bundle.verify_bundle_files(bundle, package, 'client', root / 'runtime'),
                    lambda: node_bundle.install_bundle(bundle, package, 'client', root / 'runtime', 'node')):
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    operation()
            self.assertFalse((root / 'runtime').exists())

    def test_combined_setup_shares_preflight_handles_for_both_roles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            for name in ('package.json', 'package-lock.json'):
                shutil.copyfile(package / 'client' / name, package / name)
            shutil.copyfile(bundle / 'client.zip', bundle / 'server.zip')
            with zipfile.ZipFile(bundle / 'server.zip', 'a') as archive:
                archive.writestr(node_bundle.ENTRYPOINTS['server'][-1], '// server fixture')
            manifest = json.loads((bundle / node_bundle.MANIFEST).read_text())
            manifest['bundles']['server'] = {'archive': 'server.zip',
                'sha256': node_bundle.sha256(bundle / 'server.zip'),
                'lock_sha256': node_bundle.sha256(package / 'package-lock.json')}
            (bundle / node_bundle.MANIFEST).write_text(json.dumps(manifest))
            args = argparse.Namespace(server=None, client_only=False, server_only=False)
            opened = {}
            digested = []
            original_open = node_bundle._open_bundle_file
            original_digest = hashlib.file_digest

            def record_open(path):
                stream = original_open(path)
                if path.suffix == '.zip':
                    opened[path.name] = stream
                return stream

            def record_digest(stream, *arguments, **keywords):
                if stream in opened.values():
                    digested.append(stream)
                return original_digest(stream, *arguments, **keywords)

            def server_setup(_args):
                installer.install_node_packages()
                return {'apiUrl': 'http://localhost:9077'}

            with patch.object(runtime_env, 'home', return_value=root / 'state'), patch.object(runtime_env, 'PACKAGE', package), \
                 patch.object(runtime_env, 'node', return_value='node'), patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch.object(node_bundle, 'verify_installed'), patch.object(installer, 'validate_setup_options'), \
                 patch.object(installer, 'require_client_prerequisites'), patch.object(installer, 'can_connect_local_client', return_value=True), \
                 patch.object(installer, 'setup_server', side_effect=server_setup), \
                 patch.object(installer, 'setup_client', side_effect=lambda *a, **k: installer.install_node_packages(client=True)), \
                 patch('hindsightkit.command.install', return_value=root / 'bin/hindsightkit'), \
                 patch.object(node_bundle, '_open_bundle_file', side_effect=record_open) as opener, \
                 patch.object(hashlib, 'file_digest', side_effect=record_digest), contextlib.redirect_stdout(io.StringIO()):
                installer.setup(args)
            self.assertEqual(set(opened), {'client.zip', 'server.zip'})
            self.assertCountEqual(digested, opened.values())
            self.assertEqual(sum(call.args[0].suffix == '.zip' for call in opener.call_args_list), 2)
            self.assertTrue(all(stream.closed for stream in opened.values()))

    def test_archive_change_during_extraction_is_detected_before_runtime_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package, bundle = self.fixture(root)
            directory = root / 'runtime'
            (directory / 'node_modules').mkdir(parents=True)
            marker = directory / 'node_modules/old'
            marker.write_text('previous')
            original_extract = zipfile.ZipFile.extract
            changed = False

            def change_during_extract(archive, *args, **kwargs):
                nonlocal changed
                result = original_extract(archive, *args, **kwargs)
                if not changed:
                    changed = True
                    path = bundle / 'client.zip'
                    info = path.stat()
                    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
                return result

            with patch.object(node_bundle, '_open_bundle_file', side_effect=lambda path: path.open('rb')), \
                 patch.object(zipfile.ZipFile, 'extract', change_during_extract), \
                 patch.object(node_bundle, 'verify_installed') as verify, \
                 self.assertRaisesRegex(ValueError, 'changed during installation'):
                node_bundle.install_bundle(bundle, package, 'client', directory, 'node')
            verify.assert_not_called()
            self.assertEqual(marker.read_text(), 'previous')
            self.assertFalse(list(directory.glob('.node-install-*')))
