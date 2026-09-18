"""Exercise the published PowerShell entry point without downloads or installation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


TEMPLATE = Path(__file__).resolve().parents[1] / 'distribution/install.ps1'
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
        self.shell = shutil.which('powershell.exe')
        self.env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        self.env.update(TEST_ARCHIVE=str(self.archive), TEST_SETUP_LOG=str(self.log),
                        TEST_HASH_LOG=str(self.hash_log),
                        TEST_DOWNLOAD_LOG=str(self.download_log), TEST_INSTALL_DIR=str(self.destination),
                        LOCALAPPDATA=str(self.root / 'local app data'),
                        USERPROFILE=str(self.root / 'profile'),
                        HINDSIGHTKIT_HOME=str(self.root / 'settings'),
                        HINDSIGHT_CONFIG=str(self.root / 'profile/.hindsight/coding-agent.json'),
                        HINDSIGHTKIT_INSTALL_MODE='',
                        HINDSIGHTKIT_RELEASE_MANIFEST='original-manifest',
                        HINDSIGHTKIT_INSTALL_LOG='original-log',
                        UV_PYTHON_INSTALL_DIR='original-python', UV_PYTHON_PREFERENCE='original-preference',
                        HINDSIGHTKIT_HK_CONFLICT='original-conflict')

    def package(self, entries=None, version='v0.1.0'):
        self.version = version
        self.release_url = RELEASE_URL.replace('v0.1.0', version)
        manifest = {'schema': 1, 'version': version, 'release_url': self.release_url}
        payload = {
            'app/setup.ps1': '''param([switch]$ServerOnly, [switch]$ClientOnly, [string]$Server, [switch]$NoOpen)
@{ directory=$PSScriptRoot; serverOnly=[bool]$ServerOnly; clientOnly=[bool]$ClientOnly; server=$Server;
   manifest=$env:HINDSIGHTKIT_RELEASE_MANIFEST; python=$env:UV_PYTHON_INSTALL_DIR;
   preference=$env:UV_PYTHON_PREFERENCE; hkConflict=$env:HINDSIGHTKIT_HK_CONFLICT;
   installLog=$env:HINDSIGHTKIT_INSTALL_LOG; installMode=$env:HINDSIGHTKIT_INSTALL_MODE } | ConvertTo-Json | Set-Content -LiteralPath $env:TEST_SETUP_LOG
exit 0
''',
            'app/pyproject.toml': '[project]\nname="fixture"\n',
            'app/uv.lock': 'version = 1\n',
            'app/src/hindsightkit/cli.py': '# harmless test fixture\n',
            'app/src/hindsightkit/installer.py': '# harmless installer fixture\n',
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
        wrapper.write_text('''$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility
function hk { 'unrelated user function' }
function gh {
    $expected = @('release', 'download', $env:TEST_VERSION, '--repo', 'github.com/example/HindsightKit', '--pattern', $env:TEST_PACKAGE_NAME, '--output')
    if ($args.Count -ne 10) { throw 'Unexpected authenticated arguments.' }
    for ($index=0; $index -lt $expected.Count; $index++) {
        if ($args[$index] -ne $expected[$index]) { throw 'Unexpected authenticated download target.' }
    }
    if ($args[9] -ne '--clobber') { throw 'Missing overwrite option for interrupted download.' }
    Add-Content -LiteralPath $env:TEST_DOWNLOAD_LOG -Value 'authenticated'
    Copy-Item -LiteralPath $env:TEST_ARCHIVE -Destination $args[8]
    $global:LASTEXITCODE = 0
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    if ($Uri -ne $env:TEST_RELEASE_URL) { throw 'Unexpected download destination.' }
    Add-Content -LiteralPath $env:TEST_DOWNLOAD_LOG -Value $Uri
    Copy-Item -LiteralPath $env:TEST_ARCHIVE -Destination $OutFile
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
        self.assertEqual(self.download_log.read_text().strip(), 'authenticated')

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
        self.assertEqual(len(self.download_log.read_text().splitlines()), 1)
        self.assertEqual((self.app / 'keep.txt').read_text(), 'existing runtime')
        self.assertFalse(list(self.destination.glob('.install-*')))

    def test_explicit_roles_reach_setup(self):
        digest = self.package()
        self.run_installer(digest, '-ServerOnly')
        self.assertTrue(json.loads(self.log.read_text(encoding='utf-8-sig'))['serverOnly'])
        self.run_installer(digest, '-Server http://memory-host:9077')
        self.assertEqual(json.loads(self.log.read_text(encoding='utf-8-sig'))['server'], 'http://memory-host:9077')

    def test_client_only_selects_client_archive_and_no_server_address(self):
        digest = self.package()
        self.run_installer(digest, '-ClientOnly')
        receipt = json.loads(self.log.read_text(encoding='utf-8-sig'))
        self.assertTrue(receipt['clientOnly'])
        self.assertFalse(receipt['serverOnly'])
        self.assertFalse(receipt['server'])
        self.assertIn('hindsightkit-client-windows-x64.zip', self.download_log.read_text())

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
        digest = self.package()
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
        self.assertEqual(len(self.download_log.read_text().splitlines()), 2)

    def test_checksum_failure_never_executes_setup(self):
        self.package()
        result = self.run_installer('0' * 64, expected=1)
        self.assertIn('SHA256 mismatch', result.stdout)
        self.assertFalse(self.log.exists())
        self.assertFalse(list(self.destination.glob('.install-*')))

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
Expand-InstallPackage $env:TEST_ARCHIVE $env:TEST_DESTINATION
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


if __name__ == '__main__':
    unittest.main()
