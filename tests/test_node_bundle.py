import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from hindsightkit import cli, node_bundle


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
            with patch.object(cli, 'home', return_value=state), patch.object(cli, 'PACKAGE', package), \
                 patch.object(cli, 'node', return_value='node'), \
                 patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('npm network')), \
                 patch.object(node_bundle, 'verify_installed') as verify, contextlib.redirect_stdout(io.StringIO()):
                cli.install_node_packages(client=True)
                cli.install_node_packages(client=True)
                directory = state / 'client-runtime'
                self.assertEqual((directory / 'node_modules/required/LICENSE').read_text(), 'Preserved upstream license')
                verify.side_effect = [ValueError('damaged installation'), None]
                cli.install_node_packages(client=True)
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
            with patch.object(cli, 'home', return_value=root / 'state'), patch.object(cli, 'PACKAGE', package), \
                 patch.object(cli, 'node', return_value='node'), patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('no fallback')), \
                 contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'SHA256'):
                cli.install_node_packages(client=True)
            self.assertEqual(marker.read_text(), 'previous runtime')
            self.assertFalse((directory / '.installed-lock').exists())

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
            with patch.object(cli, 'home', return_value=state), patch.object(cli, 'PACKAGE', package), \
                 patch.object(cli, 'node', return_value='node'), \
                 patch.object(node_bundle, 'release_bundle', return_value=bundle), \
                 patch.object(node_bundle, 'verify_installed'), \
                 patch.object(node_bundle.shutil, 'rmtree', side_effect=keep_locked_previous), \
                 patch('hindsightkit.install_progress.run_install', side_effect=AssertionError('npm network')), \
                 contextlib.redirect_stdout(output):
                cli.install_node_role('client')
                node_bundle.verify_bundle_files(bundle, package, 'client', directory)
                expected = hashlib.sha256((package / 'client/package-lock.json').read_bytes()).hexdigest()
                self.assertEqual((directory / '.installed-lock').read_text(), expected)
                self.assertEqual((previous / 'old').read_text(), 'locked previous runtime')
                with patch.object(node_bundle, 'install_bundle', side_effect=AssertionError('Already installed')):
                    cli.install_node_role('client')
            self.assertEqual(cleanup_attempts, [previous])
            self.assertIn('Reusing Copilot client integration', output.getvalue())
            self.assertFalse(list(directory.glob('.node-install-*')))

    def test_release_path_is_detected_after_bootstrap_environment_is_gone(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp)
            (app / 'release.json').write_text('{}')
            with patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': ''}), \
                 patch.object(node_bundle.sys, 'executable', str(app / '.venv/Scripts/python.exe')):
                self.assertEqual(node_bundle.release_bundle(), app / 'node')

    def test_managed_copilot_with_leftover_loader_is_repaired_before_authentication(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            loader = root / 'copilot/node_modules/@github/copilot/npm-loader.js'
            loader.parent.mkdir(parents=True)
            loader.write_text('// unpacked before failure')
            with patch.object(cli, 'home', return_value=root), \
                 patch.object(cli, 'copilot_command', return_value=['node', loader]), \
                 patch.object(cli, 'install_node_role', side_effect=RuntimeError('repair incomplete')) as install, \
                 patch.object(cli, 'copilot_authenticated') as authenticate:
                with self.assertRaisesRegex(RuntimeError, 'repair incomplete'):
                    cli.ensure_copilot()
                install.assert_called_once_with('copilot')
                authenticate.assert_not_called()
