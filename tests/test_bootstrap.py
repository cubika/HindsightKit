"""Exercise the published PowerShell entry point without downloads or installation."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import zipfile


TEMPLATE = Path(__file__).resolve().parents[1] / 'distribution/install.ps1'
INSTALL_OPTIONS = TEMPLATE.parent.parent / 'src/hindsightkit/scripts/install_options.ps1'
RELEASE_URL = 'https://github.com/example/HindsightKit/releases/download/v0.1.0'


@unittest.skipUnless(os.name == 'nt', 'Windows installer integration')
class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hindsightkit bootstrap ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.destination = self.root / 'local app data/HindsightKit'
        self.archive = self.root / 'package.zip'
        self.log = self.root / 'setup.json'
        self.download_log = self.root / 'downloads.txt'
        self.hash_log = self.root / 'hashes.txt'
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.shell = shutil.which('powershell.exe')
        self.env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        self.env.update(TEST_ARCHIVE=str(self.archive), TEST_SETUP_LOG=str(self.log),
                        TEST_ASSETS=str(self.assets),
                        TEST_HASH_LOG=str(self.hash_log),
                        TEST_DOWNLOAD_LOG=str(self.download_log), TEST_INSTALL_DIR=str(self.destination),
                        LOCALAPPDATA=str(self.root / 'local app data'),
                        APPDATA=str(self.root / 'roaming'),
                        USERPROFILE=str(self.root / 'profile'),
                        HINDSIGHTKIT_HOME=str(self.root / 'settings'),
                        HINDSIGHT_CONFIG=str(self.root / 'profile/.hindsight/coding-agent.json'),
                        HINDSIGHTKIT_INSTALL_MODE='',
                        HINDSIGHTKIT_RELEASE_MANIFEST='original-manifest',
                        HINDSIGHTKIT_INSTALL_LOG='original-log',
                        HINDSIGHTKIT_INSTALL_CACHE='original-cache',
                        UV_PYTHON_INSTALL_DIR='original-python', UV_PYTHON_PREFERENCE='original-preference',
                        HINDSIGHTKIT_HK_CONFLICT='original-conflict')

    def package(self, entries=None, version='v0.1.0', dependencies=None, profile='full'):
        self.version = version
        self.release_url = RELEASE_URL.replace('v0.1.0', version)
        dependencies = dependencies if dependencies is not None else {
            'python-client': {'python/wheels/client-1.0-py3-none-any.whl': b'client dependency'},
            'python-server': {'python/wheels/server-1.0-py3-none-any.whl': b'server dependency'},
            'node-client': {'node/client.zip': b'client node archive'},
            'node-server': {'node/server.zip': b'server node archive'},
        }
        self.components = []
        for name, files in dependencies.items():
            if profile == 'client' and name.endswith('-server'):
                continue
            component_archive = self.assets / 'component.zip'
            with zipfile.ZipFile(component_archive, 'w') as archive:
                for relative, content in sorted(files.items()):
                    archive.writestr(zipfile.ZipInfo('app/' + relative), content)
            digest = hashlib.sha256(component_archive.read_bytes()).hexdigest()
            asset = 'hindsightkit-' + name + '-' + digest + '.zip'
            component_archive.replace(self.assets / asset)
            self.components.append({'name': name, 'asset': asset, 'sha256': digest,
                                    'files': {relative: hashlib.sha256(content).hexdigest() for relative, content in files.items()}})
        manifest = {'schema': 1, 'version': version, 'release_url': self.release_url,
                    'package_role': profile, 'components': self.components}
        payload = {
            'app/setup.ps1': '''param([switch]$ServerOnly, [switch]$ClientOnly, [string]$Server, [switch]$NoOpen)
@{ directory=$PSScriptRoot; serverOnly=[bool]$ServerOnly; clientOnly=[bool]$ClientOnly; server=$Server;
   manifest=$env:HINDSIGHTKIT_RELEASE_MANIFEST; python=$env:UV_PYTHON_INSTALL_DIR;
   preference=$env:UV_PYTHON_PREFERENCE; hkConflict=$env:HINDSIGHTKIT_HK_CONFLICT;
   cache=$env:HINDSIGHTKIT_INSTALL_CACHE;
   installLog=$env:HINDSIGHTKIT_INSTALL_LOG; installMode=$env:HINDSIGHTKIT_INSTALL_MODE } | ConvertTo-Json | Set-Content -LiteralPath $env:TEST_SETUP_LOG
exit 0
''',
            'app/pyproject.toml': '[project]\nname="fixture"\n',
            'app/uv.lock': 'version = 1\n',
            'app/src/hindsightkit/cli.py': '# harmless test fixture\n',
            'app/src/hindsightkit/setup/installer.py': '# harmless installer fixture\n',
            'app/src/hindsightkit/scripts/install_options.ps1': INSTALL_OPTIONS.read_text(encoding='utf-8'),
            'app/release.json': json.dumps(manifest),
        }
        payload.update(entries or {})
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name, content in payload.items():
                archive.writestr(name, content)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.app = self.destination / 'versions' / (version + '-' + digest[:12])
        return digest

    def run_installer(self, digest, args='', *, expected=0, authenticated=False, client_package=None):
        template = TEMPLATE.read_text(encoding='utf-8')
        for key, value in {'VERSION': self.version, 'RELEASE_URL': self.release_url,
                           'PACKAGE_NAME': 'hindsightkit-windows-x64.zip',
                           'PACKAGE_SHA256': digest, 'REPOSITORY': 'example/HindsightKit',
                           'CLIENT_PACKAGE_NAME': 'hindsightkit-client-windows-x64.zip',
                           'CLIENT_PACKAGE_SHA256': digest,
                           'INSTALL_OPTIONS': INSTALL_OPTIONS.read_text(encoding='utf-8'),
                           'REQUIRES_AUTH': '$true' if authenticated else '$false'}.items():
            template = template.replace('@@' + key + '@@', value)
        installer = self.root / 'install.ps1'
        installer.write_text(template, encoding='utf-8')
        wrapper = self.root / 'invoke.ps1'
        invocation = ('& $script ' + args) if args else "(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Raw) | iex"
        wants_client = ('-ClientOnly' in args and '-ClientOnly:$false' not in args) or '-Server ' in args
        has_server = (Path(self.env['USERPROFILE']) / '.hindsight/profiles/hindsightkit.env').is_file()
        if client_package is None:
            client_package = wants_client and not has_server
        self.env['TEST_PACKAGE_NAME'] = 'hindsightkit-client-windows-x64.zip' if client_package else 'hindsightkit-windows-x64.zip'
        self.env['TEST_RELEASE_URL'] = self.release_url + '/' + self.env['TEST_PACKAGE_NAME']
        self.env['TEST_RELEASE_BASE'] = self.release_url + '/'
        self.env['TEST_VERSION'] = self.version
        wrapper.write_text('''$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility
function hk { 'unrelated user function' }
function Get-CimInstance {
    param($ClassName, $Property, $OperationTimeoutSec, $ErrorAction)
    if ($env:TEST_PROCESS_FAILURE) { throw 'Synthetic process inspection failure' }
    if ($env:TEST_PROCESS_RECORDS) {
        Get-Content -LiteralPath $env:TEST_PROCESS_RECORDS -Raw | ConvertFrom-Json
    } else {
        [pscustomobject]@{ Name='powershell.exe'; ExecutablePath='C:/Windows/powershell.exe'; CommandLine='installer fixture' }
    }
}
function Remove-Item {
    param($LiteralPath, [switch]$Force, [switch]$Recurse)
    if ($env:TEST_DELETE_FAILURE -and
        (Get-Item -LiteralPath $LiteralPath -Force).FullName -eq (Get-Item -LiteralPath $env:TEST_DELETE_FAILURE -Force).FullName) {
        throw 'Synthetic cleanup interruption'
    }
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -Recurse:$Recurse
}
function Copy-TestAsset($Name, $Destination) {
    if ($Name -eq $env:TEST_FAIL_ASSET) {
        [IO.File]::WriteAllText($Destination, 'interrupted partial download')
        throw 'Synthetic interrupted download'
    }
    if ($Name -eq $env:TEST_PACKAGE_NAME) { $source = $env:TEST_ARCHIVE }
    else {
        if ($Name -notmatch '^hindsightkit-(python|node)-(client|server)-[a-f0-9]{64}[.]zip$') { throw 'Unexpected asset' }
        $source = Join-Path $env:TEST_ASSETS $Name
    }
    Copy-Item -LiteralPath $source -Destination $Destination
}
function gh {
    $expected = @('release', 'download', $env:TEST_VERSION, '--repo', 'github.com/example/HindsightKit', '--pattern', $args[6], '--output')
    if ($args.Count -ne 10) { throw 'Unexpected authenticated arguments.' }
    for ($index=0; $index -lt $expected.Count; $index++) {
        if ($args[$index] -ne $expected[$index]) { throw 'Unexpected authenticated download target.' }
    }
    if ($args[9] -ne '--clobber') { throw 'Missing overwrite option for interrupted download.' }
    Add-Content -LiteralPath $env:TEST_DOWNLOAD_LOG -Value ('authenticated:' + $args[6])
    Copy-TestAsset $args[6] $args[8]
    $global:LASTEXITCODE = 0
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    if (-not $Uri.StartsWith($env:TEST_RELEASE_BASE, [StringComparison]::Ordinal)) { throw 'Unexpected download destination.' }
    Add-Content -LiteralPath $env:TEST_DOWNLOAD_LOG -Value $Uri
    Copy-TestAsset $Uri.Substring($env:TEST_RELEASE_BASE.Length) $OutFile
}
function Get-FileHash {
    param([string]$LiteralPath, [string]$Algorithm)
    Add-Content -LiteralPath $env:TEST_HASH_LOG -Value $LiteralPath
    Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
}
try {
    $script = [scriptblock]::Create((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Raw))
    ''' + invocation + '''
    if ($env:HINDSIGHTKIT_RELEASE_MANIFEST -ne 'original-manifest' -or
        $env:UV_PYTHON_INSTALL_DIR -ne 'original-python' -or
        $env:UV_PYTHON_PREFERENCE -ne 'original-preference' -or
        $env:HINDSIGHTKIT_INSTALL_LOG -ne 'original-log' -or
        $env:HINDSIGHTKIT_INSTALL_CACHE -ne 'original-cache' -or
        $env:HINDSIGHTKIT_HK_CONFLICT -ne 'original-conflict' -or
        $env:HINDSIGHTKIT_INSTALL_MODE) { throw 'Installer did not restore its environment.' }
} catch { Write-Output $_; exit 1 }
''', encoding='utf-8')
        result = subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(wrapper)],
                                env=self.env, text=True, capture_output=True, timeout=45)
        if expected == 0:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_internal_release_download_uses_exact_authenticated_asset(self):
        if not shutil.which('gh'):
            self.skipTest('GitHub CLI is required for command prerequisite discovery')
        digest = self.package()
        self.env['TEST_VERSION'] = self.version
        self.run_installer(digest, authenticated=True)
        downloads = self.download_log.read_text().splitlines()
        self.assertEqual(downloads, ['authenticated:hindsightkit-windows-x64.zip'] +
                         ['authenticated:' + component['asset'] for component in self.components])

    def test_pipe_install_uses_managed_directory_and_reuses_same_version(self):
        digest = self.package()
        self.run_installer(digest, '-NoOpen')
        fresh_hashes = self.hash_log.read_text(encoding='utf-8-sig').splitlines()
        self.assertEqual(sum(Path(path).name == 'setup.ps1' for path in fresh_hashes), 1)
        receipt = json.loads(self.log.read_text(encoding='utf-8-sig'))
        self.assertTrue(Path(receipt['directory']).samefile(self.app))
        self.assertTrue(Path(receipt['manifest']).samefile(self.app / 'release.json'))
        # The fixture records this target but does not install Python there.
        self.assertEqual(Path(receipt['python']).resolve(), (self.destination / 'python').resolve())
        self.assertEqual(receipt['preference'], 'only-managed')
        self.assertEqual(Path(receipt['cache']).resolve(), (self.destination / 'cache').resolve())
        self.assertEqual(receipt['hkConflict'], 'Function hk')
        log = Path(receipt['installLog'])
        self.assertTrue(log.is_file())
        self.assertTrue(log.resolve().is_relative_to((self.destination / 'logs').resolve()))
        self.assertIn('installed successfully', log.read_text(encoding='utf-8'))
        self.assertFalse(receipt['serverOnly'])
        (self.app / 'keep.txt').write_text('existing runtime')
        self.run_installer(digest)
        retry_hashes = self.hash_log.read_text(encoding='utf-8-sig').splitlines()[len(fresh_hashes):]
        self.assertEqual(sum(Path(path).name == 'setup.ps1' for path in retry_hashes), 1)
        self.assertEqual(len(self.download_log.read_text().splitlines()), 5)
        self.assertEqual((self.app / 'keep.txt').read_text(), 'existing runtime')
        self.assertFalse(list(self.destination.glob('.install-*')))

    def test_explicit_roles_reach_setup(self):
        digest = self.package()
        self.run_installer(digest, '-ServerOnly')
        self.assertTrue(json.loads(self.log.read_text(encoding='utf-8-sig'))['serverOnly'])
        self.run_installer(digest, '-Server http://memory-host:9077')
        self.assertEqual(json.loads(self.log.read_text(encoding='utf-8-sig'))['server'], 'http://memory-host:9077')

    def test_client_only_selects_client_archive_and_no_server_address(self):
        digest = self.package(profile='client')
        self.run_installer(digest, '-ClientOnly')
        receipt = json.loads(self.log.read_text(encoding='utf-8-sig'))
        self.assertTrue(receipt['clientOnly'])
        self.assertFalse(receipt['serverOnly'])
        self.assertFalse(receipt['server'])
        self.assertIn('hindsightkit-client-windows-x64.zip', self.download_log.read_text())
        self.assertEqual(len(self.download_log.read_text().splitlines()), 3)
        self.assertFalse((self.app / 'node/server.zip').exists())

    def test_existing_local_server_keeps_full_management_package_without_server_setup(self):
        profile = Path(self.env['USERPROFILE']) / '.hindsight/profiles/hindsightkit.env'
        profile.parent.mkdir(parents=True)
        profile.write_text('existing server settings')
        digest = self.package()
        result = self.run_installer(digest, '-ClientOnly')
        self.assertTrue(json.loads(self.log.read_text(encoding='utf-8-sig'))['clientOnly'])
        self.assertIn('Existing local server detected', result.stdout)
        self.assertNotIn('hindsightkit-client-windows-x64.zip', self.download_log.read_text())
        self.assertEqual(profile.read_text(), 'existing server settings')

    def test_default_upgrade_keeps_unconnected_legacy_client_only(self):
        stamp = Path(self.env['HINDSIGHTKIT_HOME']) / 'client-runtime/.installed-lock'
        stamp.parent.mkdir(parents=True)
        stamp.write_text('verified client runtime')
        digest = self.package(profile='client')
        self.run_installer(digest, client_package=True)
        receipt = json.loads(self.log.read_text(encoding='utf-8-sig'))
        self.assertTrue(receipt['clientOnly'])
        self.assertFalse(receipt['server'])
        self.assertEqual(receipt['installMode'], 'client-only')

    def test_saved_client_mode_wins_over_an_existing_server(self):
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        settings.mkdir()
        (settings / 'installation.json').write_text(json.dumps({'schema': 1, 'mode': 'client-only'}))
        profile = Path(self.env['USERPROFILE']) / '.hindsight/profiles/hindsightkit.env'
        profile.parent.mkdir(parents=True)
        profile.write_text('existing server')
        digest = self.package()
        self.run_installer(digest, client_package=False)
        self.assertTrue(json.loads(self.log.read_text(encoding='utf-8-sig'))['clientOnly'])
        self.assertEqual(profile.read_text(), 'existing server')

    def test_explicit_full_install_overrides_saved_client_mode_in_child(self):
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        settings.mkdir()
        record = settings / 'installation.json'
        record.write_text(json.dumps({'schema': 1, 'mode': 'client-only'}))
        before = record.read_bytes()
        digest = self.package()
        self.run_installer(digest, '-ClientOnly:$false', client_package=False)
        receipt = json.loads(self.log.read_text(encoding='utf-8-sig'))
        self.assertFalse(receipt['clientOnly'])
        self.assertFalse(receipt['serverOnly'])
        self.assertEqual(receipt['installMode'], 'full')
        # The bootstrap cannot commit the role before the Python installer succeeds.
        self.assertEqual(record.read_bytes(), before)

    def test_new_version_keeps_old_runtime_and_existing_settings(self):
        digest = self.package()
        self.run_installer(digest)
        old_app = self.app
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        settings.mkdir()
        (settings / 'retained.txt').write_text('existing memory settings')
        digest = self.package(version='v0.2.0')
        self.run_installer(digest)
        self.assertTrue(old_app.is_dir())
        self.assertTrue(self.app.is_dir())
        self.assertEqual((settings / 'retained.txt').read_text(), 'existing memory settings')
        self.assertEqual(len(self.download_log.read_text().splitlines()), 6)

    def test_checksum_failure_never_executes_setup(self):
        self.package()
        result = self.run_installer('0' * 64, expected=1)
        self.assertIn('SHA256 mismatch', result.stdout)
        self.assertFalse(self.log.exists())
        self.assertFalse(list(self.destination.glob('.install-*')))

    def install_version(self, version):
        digest = self.package(version=version)
        result = self.run_installer(digest)
        self.assertTrue((self.app / '.install-success.json').is_file(), result.stdout)
        return self.app, digest, result

    def short_path(self, path):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        get_short = kernel.GetShortPathNameW
        get_short.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
        get_short.restype = ctypes.c_uint32
        buffer = ctypes.create_unicode_buffer(32768)
        length = get_short(str(path), buffer, len(buffer))
        self.assertGreater(length, 0, ctypes.get_last_error())
        self.assertLess(length, len(buffer))
        result = Path(buffer.value)
        self.assertTrue(result.samefile(path))
        return result

    def test_retention_keeps_two_successful_versions_and_reuses_retries(self):
        first, _, _ = self.install_version('v0.1.0')
        second, _, _ = self.install_version('v0.2.0')
        # Large per-version environments, including hidden files, are removed too.
        runtime = first / '.venv/Lib/site-packages/fixture.py'
        runtime.parent.mkdir(parents=True)
        runtime.write_text('old dependency')
        third, digest, result = self.install_version('v0.3.0')
        self.assertFalse(first.exists(), result.stdout)
        self.assertTrue(second.is_dir())
        self.assertTrue(third.is_dir())
        self.assertIn('removed 1 older version(s)', result.stdout)
        self.run_installer(digest)
        self.assertEqual(set((self.destination / 'versions').iterdir()), {second, third})

    def test_failed_setup_never_prunes_or_records_success(self):
        first, _, _ = self.install_version('v0.1.0')
        second, _, _ = self.install_version('v0.2.0')
        digest = self.package(version='v0.3.0', entries={'app/setup.ps1': 'exit 1'})
        self.run_installer(digest, expected=1)
        failed = self.app
        self.assertTrue(first.is_dir())
        self.assertTrue(second.is_dir())
        self.assertFalse((failed / '.install-success.json').exists())
        fourth, _, result = self.install_version('v0.4.0')
        self.assertFalse(first.exists(), result.stdout)
        self.assertTrue(second.is_dir())
        self.assertTrue(failed.is_dir())
        self.assertTrue(fourth.is_dir())

    def test_retention_uses_success_time_not_version_or_directory_time(self):
        first, _, _ = self.install_version('v0.9.0')
        second, _, _ = self.install_version('v0.2.0')
        os.utime(first, (time.time() + 86400, time.time() + 86400))
        _, _, result = self.install_version('v0.1.0')
        self.assertFalse(first.exists(), result.stdout)
        self.assertTrue(second.is_dir())

    def test_retention_preserves_config_launcher_and_process_references(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        digest = self.package(version='v0.3.0')
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        profile = Path(self.env['USERPROFILE'])
        references = {
            settings / 'bin/hk.exe': b'MZ\x00\xff#!' + str(first / '.venv/Scripts/python.exe').encode() + b'\nPK',
            profile / '.copilot/hooks/hindsight-coding-agents.json': json.dumps({'exec': str(first / '.venv/Scripts/python.exe')}).encode(),
            Path(self.env['APPDATA']) / 'Code - Insiders/User/profiles/work/mcp.json':
                ('// retained client\n' + json.dumps({'command': str(first).upper().replace('\\', '/') + '/.venv/Scripts/python.exe'})).encode(),
            profile / '.hindsight/profiles/hindsightkit.env': ('MODEL_PATH=' + str(first / 'model')).encode(),
            settings / 'remote/clients/fixture/launch.json': json.dumps({'command': str(first / '.venv/Scripts/hindsightkit.exe')}, ensure_ascii=True).encode(),
        }
        for path, content in references.items():
            with self.subTest(reference=path):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                result = self.run_installer(digest, '-ServerOnly')
                self.assertTrue(first.is_dir(), result.stdout)
                self.assertIn('still referenced', result.stdout)
                path.unlink()
        processes = self.root / 'processes.json'
        self.env['TEST_PROCESS_RECORDS'] = str(processes)
        processes.write_text(json.dumps([{'Name': 'pythonw.exe', 'ExecutablePath': 'C:/shared/python.exe',
            'CommandLine': f'"{first}/.venv/Scripts/pythonw.exe" -m hindsight_api'}]))
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        del self.env['TEST_PROCESS_RECORDS']
        self.run_installer(digest)
        self.assertFalse(first.exists())

    def test_retention_preserves_mixed_short_and_long_path_references(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        long_path, short_path = first.resolve(), self.short_path(first)
        self.assertEqual(len(long_path.parts), len(short_path.parts))
        if str(long_path).casefold() == str(short_path).casefold():
            self.skipTest('The fixture volume does not provide 8.3 path aliases')
        aliases = list(dict.fromkeys([short_path, short_path.parent / long_path.name,
            long_path.parent / short_path.name,
            Path(*(short if index % 2 else long for index, (long, short)
                   in enumerate(zip(long_path.parts, short_path.parts))))]))
        self.assertTrue(all(path.samefile(first) for path in aliases))
        digest = self.package(version='v0.3.0')
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        config = settings / 'clients.json'
        config.parent.mkdir(parents=True, exist_ok=True)
        for alias in aliases:
            with self.subTest(alias=alias):
                config.write_text(json.dumps({'command': str(alias / '.venv/Scripts/python.exe')}))
                result = self.run_installer(digest)
                self.assertTrue(first.is_dir(), result.stdout)
                self.assertIn('still referenced', result.stdout)
        config.unlink()
        launcher = settings / 'bin/hk.exe'
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_bytes(b'MZ\x00#!' + str(aliases[-1] / '.venv/Scripts/python.exe').encode() + b'\nPK')
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('still referenced', result.stdout)
        launcher.unlink()
        processes = self.root / 'processes.json'
        self.env['TEST_PROCESS_RECORDS'] = str(processes)
        processes.write_text(json.dumps([{'Name': 'pythonw.exe', 'ExecutablePath': 'C:/shared/python.exe',
            'CommandLine': f'"{short_path.parent / long_path.name}/.venv/Scripts/pythonw.exe" -m hindsight_api'}]))
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('still referenced', result.stdout)
        del self.env['TEST_PROCESS_RECORDS']
        result = self.run_installer(digest)
        self.assertFalse(first.exists(), result.stdout)

    def test_retention_skips_unsafe_or_uninspectable_candidates(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        digest = self.package(version='v0.3.0')
        unknown = first / 'user-notes.txt'
        unknown.write_text('precious')
        result = self.run_installer(digest)
        self.assertEqual(unknown.read_text(), 'precious', result.stdout)
        unknown.unlink()
        unknown_directory = first / 'user-files'
        unknown_directory.mkdir()
        self.run_installer(digest)
        self.assertTrue(unknown_directory.is_dir())
        unknown_directory.rmdir()
        self.env['TEST_PROCESS_FAILURE'] = '1'
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('Synthetic process inspection failure', result.stdout)
        del self.env['TEST_PROCESS_FAILURE']
        processes = self.root / 'processes.json'
        processes.write_text(json.dumps([{'Name': 'python.exe', 'ExecutablePath': None, 'CommandLine': None}]))
        self.env['TEST_PROCESS_RECORDS'] = str(processes)
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('Cannot inspect a process', result.stdout)
        del self.env['TEST_PROCESS_RECORDS']
        # A missing success receipt cannot be inferred from a newer directory timestamp.
        (first / '.install-success.json').unlink()
        self.run_installer(digest)
        self.assertTrue(first.is_dir())

    def test_retention_rejects_nested_junction_and_preserves_external_data(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        external = self.root / 'external-memory'
        external.mkdir()
        marker = external / 'memory.db'
        marker.write_text('preserve')
        junction = first / '.venv'
        result = subprocess.run([self.shell, '-NoProfile', '-Command',
            'New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET | Out-Null'],
            env={**self.env, 'TEST_LINK': str(junction), 'TEST_TARGET': str(external)},
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        try:
            _, _, result = self.install_version('v0.3.0')
            self.assertTrue(first.is_dir(), result.stdout)
            self.assertEqual(marker.read_text(), 'preserve')
            self.assertIn('linked file or directory', result.stdout)
        finally:
            if junction.is_junction():
                junction.rmdir()

    def test_legacy_versions_are_pruned_after_verification_with_one_copy_kept(self):
        first, _, _ = self.install_version('v0.1.0')
        second, _, _ = self.install_version('v0.2.0')
        for app in (first, second):
            (app / '.install-success.json').unlink()
            (app / '.install-started').unlink()
        # A legacy directory has no trustworthy success timestamp.
        # Keep the newest legacy copy; still validate ownership and live references.
        _, _, result = self.install_version('v0.3.0')
        self.assertFalse(first.exists(), result.stdout)
        self.assertTrue(second.is_dir())

    def test_cleanup_retries_after_payload_and_metadata_deletion_failures(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        digest = self.package(version='v0.3.0')
        self.env['TEST_DELETE_FAILURE'] = str(self.short_path(first / 'setup.ps1'))
        result = self.run_installer(digest)
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('Synthetic cleanup interruption', result.stdout)
        # Next retry finishes the payload but fails after the first ownership file is gone.
        self.env['TEST_DELETE_FAILURE'] = str(self.short_path(first) / '.package-files.json')
        result = self.run_installer(digest)
        self.assertFalse((first / '.package-sha256').exists(), result.stdout)
        self.assertTrue((first / '.package-files.json').is_file())
        del self.env['TEST_DELETE_FAILURE']
        result = self.run_installer(digest)
        self.assertFalse(first.exists(), result.stdout)
        self.assertFalse(list(self.destination.glob('.cleanup-*.json')))

    def test_incomplete_cleanup_receipts_do_not_block_other_cleanup(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        temporary = self.destination / ('.cleanup-' + first.name + '.json.tmp')
        temporary.write_text('{interrupted')
        orphan = self.destination / '.cleanup-unknown.json'
        orphan.write_text('{unrecognized')
        expired_log = self.destination / 'logs/install-20200101-000000-12345678.log'
        expired_log.write_text('expired')
        old = time.time() - 40 * 86400
        os.utime(expired_log, (old, old))
        _, _, result = self.install_version('v0.3.0')
        self.assertFalse(first.exists(), result.stdout)
        self.assertFalse(temporary.exists())
        self.assertFalse(expired_log.exists())
        self.assertEqual(orphan.read_text(), '{unrecognized')

    def test_reinstalled_pending_release_becomes_the_previous_success(self):
        self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        current, digest, _ = self.install_version('v0.3.0')
        # A cleanup interruption before deleting payload leaves the package intact.
        record = {'schema': 1, 'Digest': digest,
                  'Files': json.loads((current / '.package-files.json').read_text(encoding='utf-8-sig')),
                  'Archives': [digest + '.zip']}
        current_pending = self.destination / ('.cleanup-' + current.name + '.json')
        current_pending.write_text(json.dumps(record))
        result = self.run_installer(digest)
        self.assertFalse(current_pending.exists(), result.stdout)
        self.install_version('v0.4.0')
        self.assertTrue(current.is_dir())

    def test_config_location_inside_release_prevents_cleanup(self):
        first, _, _ = self.install_version('v0.1.0')
        self.install_version('v0.2.0')
        # The missing file is still a configured destination that must not be removed.
        self.env['HINDSIGHT_CONFIG'] = str(first / '.venv/user-settings.json')
        _, _, result = self.install_version('v0.3.0')
        self.assertTrue(first.is_dir(), result.stdout)
        self.assertIn('still referenced', result.stdout)

    def test_cache_and_log_retention_preserves_reused_archives_and_user_data(self):
        first, digest, _ = self.install_version('v0.1.0')
        cache = self.destination / 'downloads'
        old = time.time() - 40 * 86400
        obsolete = cache / ('a' * 64 + '.zip')
        partial = cache / ('b' * 64 + '.zip.partial')
        recent = cache / ('c' * 64 + '.zip')
        unknown = cache / 'my-archive.zip'
        expired_log = self.destination / 'logs/install-20200101-000000-12345678.log'
        for path in (obsolete, partial, recent, unknown, expired_log):
            path.write_bytes(b'fixture')
        for path in cache.iterdir():
            if path != recent:
                os.utime(path, (old, old))
        os.utime(expired_log, (old, old))
        settings = Path(self.env['HINDSIGHTKIT_HOME'])
        data = [settings / 'postgresql/data/memory.db', settings / 'models/model.onnx', settings / 'clients.json']
        for path in data:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('persistent data')
        result = self.run_installer(digest)
        self.assertFalse(obsolete.exists(), result.stdout)
        self.assertFalse(partial.exists())
        self.assertFalse(expired_log.exists())
        self.assertTrue(recent.is_file())
        self.assertTrue(unknown.is_file())
        self.assertTrue((cache / (digest + '.zip')).is_file())
        self.assertTrue(all((cache / (component['sha256'] + '.zip')).is_file() for component in self.components))
        self.assertTrue(all(path.read_text() == 'persistent data' for path in data))
        self.assertTrue(first.is_dir())

    def test_upgrade_downloads_only_changed_component_and_keeps_old_files(self):
        digest = self.package()
        self.run_installer(digest)
        old_app = self.app
        dependencies = {
            'python-client': {'python/wheels/client-1.0-py3-none-any.whl': b'client dependency'},
            'python-server': {'python/wheels/server-2.0-py3-none-any.whl': b'changed server dependency'},
            'node-client': {'node/client.zip': b'client node archive'},
            'node-server': {'node/server.zip': b'server node archive'},
        }
        digest = self.package(version='v0.2.0', dependencies=dependencies)
        self.run_installer(digest)
        downloads = self.download_log.read_text().splitlines()
        self.assertEqual(len(downloads), 7)
        self.assertTrue(downloads[-1].endswith(self.components[1]['asset']))
        self.assertEqual((old_app / 'python/wheels/server-1.0-py3-none-any.whl').read_bytes(), b'server dependency')
        self.assertEqual((self.app / 'python/wheels/server-2.0-py3-none-any.whl').read_bytes(), b'changed server dependency')

    def test_interrupted_upgrade_keeps_old_version_and_verified_downloads(self):
        digest = self.package()
        self.run_installer(digest)
        old_app = self.app
        old_setup_receipt = self.log.read_bytes()
        dependencies = {
            'python-client': {'python/wheels/client-2.0-py3-none-any.whl': b'new client'},
            'python-server': {'python/wheels/server-2.0-py3-none-any.whl': b'new server'},
            'node-client': {'node/client.zip': b'client node archive'},
            'node-server': {'node/server.zip': b'server node archive'},
        }
        digest = self.package(version='v0.2.0', dependencies=dependencies)
        self.env['TEST_FAIL_ASSET'] = self.components[1]['asset']
        self.run_installer(digest, expected=1)
        self.assertEqual(self.log.read_bytes(), old_setup_receipt)
        self.assertTrue(old_app.is_dir())
        self.assertFalse(self.app.exists())
        self.assertFalse(list(self.destination.glob('.install-*')))
        cache = self.destination / 'downloads'
        self.assertTrue((cache / (digest + '.zip')).is_file())
        self.assertTrue((cache / (self.components[0]['sha256'] + '.zip')).is_file())
        previous_requests = len(self.download_log.read_text().splitlines())
        del self.env['TEST_FAIL_ASSET']
        self.run_installer(digest)
        retry_requests = self.download_log.read_text().splitlines()[previous_requests:]
        self.assertEqual(len(retry_requests), 1)
        self.assertTrue(retry_requests[0].endswith(self.components[1]['asset']))

    def test_damaged_cache_is_redownloaded_and_never_used(self):
        digest = self.package()
        self.run_installer(digest)
        damaged = self.components[0]
        (self.destination / 'downloads' / (damaged['sha256'] + '.zip')).write_bytes(b'corrupt')
        digest = self.package(version='v0.2.0')
        self.run_installer(digest)
        self.assertEqual(len(self.download_log.read_text().splitlines()), 7)
        self.assertEqual((self.app / 'python/wheels/client-1.0-py3-none-any.whl').read_bytes(), b'client dependency')

    def test_component_with_wrong_files_is_rejected_before_setup(self):
        self.package()
        component = self.components[0]
        asset = self.assets / component['asset']
        with zipfile.ZipFile(asset, 'w') as archive:
            archive.writestr('app/setup.ps1', 'unexpected override')
        component['sha256'] = hashlib.sha256(asset.read_bytes()).hexdigest()
        replacement = 'hindsightkit-' + component['name'] + '-' + component['sha256'] + '.zip'
        asset.replace(self.assets / replacement)
        component['asset'] = replacement
        manifest = {'schema': 1, 'version': self.version, 'release_url': self.release_url,
                    'package_role': 'full', 'components': self.components}
        with zipfile.ZipFile(self.archive) as archive:
            contents = {info.filename: archive.read(info) for info in archive.infolist()}
        contents['app/release.json'] = json.dumps(manifest).encode()
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name, content in contents.items():
                archive.writestr(name, content)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        result = self.run_installer(digest, expected=1)
        self.assertIn('Unexpected component file', result.stdout)
        self.assertFalse(self.log.exists())

    def test_empty_python_components_are_supported(self):
        digest = self.package(dependencies={
            'python-client': {}, 'python-server': {},
            'node-client': {'node/client.zip': b'client'},
            'node-server': {'node/server.zip': b'server'},
        })
        self.run_installer(digest)
        self.assertTrue(self.log.is_file())

    def test_cached_archive_is_locked_from_verification_through_extraction(self):
        digest = self.package()
        self.run_installer(digest)
        harness = self.root / 'locked-archive.ps1'
        harness.write_text('''$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_TEMPLATE, [ref]$tokens, [ref]$errors)
foreach ($function in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $function.Extent.Text
}
$stream = Open-VerifiedAsset $env:TEST_INSTALL_DIR 'fixture.zip' $env:TEST_DIGEST
try {
    $blocked = $false
    try { [IO.File]::WriteAllText($stream.Name, 'replace verified contents') } catch [IO.IOException] { $blocked = $true }
    if (-not $blocked) { throw 'Verified archive allowed a writer' }
    Expand-InstallFiles $stream $env:TEST_DESTINATION | Out-Null
} finally { $stream.Dispose() }
$writer = [IO.File]::Open($stream.Name, [IO.FileMode]::Open, [IO.FileAccess]::Write)
$writer.Dispose()
''', encoding='utf-8')
        destination = self.root / 'locked-extraction'
        result = subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(harness)],
            env={**self.env, 'TEST_TEMPLATE': str(TEMPLATE), 'TEST_DIGEST': digest,
                 'TEST_DESTINATION': str(destination)}, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((destination / 'setup.ps1').is_file())

    def test_archive_traversal_is_rejected(self):
        digest = self.package({'app/../../escaped.txt': 'unexpected'})
        result = self.run_installer(digest, expected=1)
        self.assertIn('Invalid release package entry', result.stdout)
        self.assertFalse(self.log.exists())
        self.assertFalse((self.root / 'escaped.txt').exists())

    def test_extraction_rejects_linked_parent_before_writing(self):
        self.package({'app/linked/keep.txt': 'overwrite'})
        external = self.root / 'external'
        external.mkdir()
        marker = external / 'keep.txt'
        marker.write_text('preserve')
        destination = self.root / 'staged'
        destination.mkdir()
        harness = self.root / 'extract.ps1'
        harness.write_text('''$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:TEST_TEMPLATE, [ref]$tokens, [ref]$errors)
foreach ($function in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $function.Extent.Text
}
New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET | Out-Null
$stream = [IO.File]::OpenRead($env:TEST_ARCHIVE)
try { Expand-InstallPackage $stream $env:TEST_DESTINATION } finally { $stream.Dispose() }
''', encoding='utf-8')
        junction = destination / 'linked'
        try:
            result = subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(harness)],
                env={**self.env, 'TEST_TEMPLATE': str(TEMPLATE), 'TEST_LINK': str(junction),
                     'TEST_TARGET': str(external), 'TEST_DESTINATION': str(destination)},
                capture_output=True, text=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ordinary directories', result.stderr)
            self.assertEqual(marker.read_text(), 'preserve')
        finally:
            if junction.is_junction():
                junction.rmdir()

    def test_unknown_existing_installation_is_preserved(self):
        digest = self.package()
        self.app.mkdir(parents=True)
        marker = self.app / 'precious.txt'
        marker.write_text('preserve')
        result = self.run_installer(digest, expected=1)
        self.assertIn('not owned', result.stdout)
        self.assertEqual(marker.read_text(), 'preserve')
        self.assertFalse(self.download_log.exists())

    def test_damaged_installed_source_is_not_executed_on_retry(self):
        digest = self.package()
        self.run_installer(digest)
        (self.app / 'setup.ps1').write_text("throw 'changed source'")
        self.log.unlink()
        result = self.run_installer(digest, expected=1)
        self.assertIn('application files changed', result.stdout)
        self.assertFalse(self.log.exists())

    def test_setup_failure_retains_diagnostic_log_and_reports_location(self):
        digest = self.package({'app/setup.ps1': "Write-Output 'Synthetic dependency failure'; exit 1\n"})
        result = self.run_installer(digest, expected=1)
        self.assertIn('Setup stopped', result.stdout)
        self.assertIn('Log:', result.stdout)
        logs = list((self.destination / 'logs').glob('install-*.log'))
        self.assertEqual(len(logs), 1)
        self.assertIn('HindsightKit installation failed', logs[0].read_text(encoding='utf-8'))

    def test_conflicting_roles_fail_before_writing_installation(self):
        digest = self.package()
        self.run_installer(digest, '-ServerOnly -Server http://memory-host:9077', expected=1)
        self.assertFalse(self.destination.exists())
        self.run_installer(digest, '-ServerOnly -ClientOnly', expected=1)
        self.assertFalse(self.destination.exists())

    def test_invalid_api_ports_fail_before_writing_installation(self):
        digest = self.package()
        for port in (-1, 1, 1023, 55535, 65535):
            with self.subTest(port=port):
                result = self.run_installer(digest, f'-Port {port}', expected=1)
                self.assertIn('between 1024 and 55534', result.stdout)
                self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
