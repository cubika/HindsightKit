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
        self.shell = shutil.which('powershell.exe')
        self.env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        self.env.update(TEST_ARCHIVE=str(self.archive), TEST_SETUP_LOG=str(self.log),
                        TEST_DOWNLOAD_LOG=str(self.download_log), TEST_INSTALL_DIR=str(self.destination),
                        LOCALAPPDATA=str(self.root / 'local app data'),
                        HINDSIGHTKIT_HOME=str(self.root / 'settings'),
                        HINDSIGHTKIT_RELEASE_MANIFEST='original-manifest',
                        HINDSIGHTKIT_INSTALL_LOG='original-log',
                        UV_PYTHON_INSTALL_DIR='original-python', UV_PYTHON_PREFERENCE='original-preference',
                        HINDSIGHTKIT_HK_CONFLICT='original-conflict')

    def package(self, entries=None, version='v0.1.0'):
        self.version = version
        self.release_url = RELEASE_URL.replace('v0.1.0', version)
        manifest = {'schema': 1, 'version': version, 'release_url': self.release_url}
        payload = {
            'app/setup.ps1': '''param([switch]$ServerOnly, [string]$Server, [switch]$NoOpen)
@{ directory=$PSScriptRoot; serverOnly=[bool]$ServerOnly; server=$Server;
   manifest=$env:HINDSIGHTKIT_RELEASE_MANIFEST; python=$env:UV_PYTHON_INSTALL_DIR;
   preference=$env:UV_PYTHON_PREFERENCE; hkConflict=$env:HINDSIGHTKIT_HK_CONFLICT;
   installLog=$env:HINDSIGHTKIT_INSTALL_LOG } | ConvertTo-Json | Set-Content -LiteralPath $env:TEST_SETUP_LOG
exit 0
''',
            'app/pyproject.toml': '[project]\nname="fixture"\n',
            'app/uv.lock': 'version = 1\n',
            'app/src/hindsightkit/cli.py': '# harmless test fixture\n',
            'app/release.json': json.dumps(manifest),
        }
        payload.update(entries or {})
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name, content in payload.items():
                archive.writestr(name, content)
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.app = self.destination / 'versions' / (version + '-' + digest[:12])
        return digest

    def run_installer(self, digest, args='', *, expected=0, authenticated=False):
        template = TEMPLATE.read_text(encoding='utf-8')
        for key, value in {'VERSION': self.version, 'RELEASE_URL': self.release_url,
                           'PACKAGE_NAME': 'hindsightkit-windows-x64.zip',
                           'PACKAGE_SHA256': digest, 'REPOSITORY': 'example/HindsightKit',
                           'REQUIRES_AUTH': '$true' if authenticated else '$false'}.items():
            template = template.replace('@@' + key + '@@', value)
        installer = self.root / 'install.ps1'
        installer.write_text(template, encoding='utf-8')
        wrapper = self.root / 'invoke.ps1'
        invocation = ('& $script ' + args) if args else "(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Raw) | iex"
        self.env['TEST_RELEASE_URL'] = self.release_url + '/hindsightkit-windows-x64.zip'
        wrapper.write_text('''$ErrorActionPreference = 'Stop'
function hk { 'unrelated user function' }
function gh {
    $expected = @('release', 'download', $env:TEST_VERSION, '--repo', 'github.com/example/HindsightKit', '--pattern', 'hindsightkit-windows-x64.zip', '--output')
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
try {
    $script = [scriptblock]::Create((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Raw))
    ''' + invocation + '''
    if ($env:HINDSIGHTKIT_RELEASE_MANIFEST -ne 'original-manifest' -or
        $env:UV_PYTHON_INSTALL_DIR -ne 'original-python' -or
        $env:UV_PYTHON_PREFERENCE -ne 'original-preference' -or
        $env:HINDSIGHTKIT_INSTALL_LOG -ne 'original-log' -or
        $env:HINDSIGHTKIT_HK_CONFLICT -ne 'original-conflict') { throw 'Installer did not restore its environment.' }
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
        self.assertEqual(len(self.download_log.read_text().splitlines()), 1)
        self.assertEqual((self.app / 'keep.txt').read_text(), 'existing runtime')
        self.assertFalse(list(self.destination.glob('.install-*')))

    def test_explicit_roles_reach_setup(self):
        digest = self.package()
        self.run_installer(digest, '-ServerOnly')
        self.assertTrue(json.loads(self.log.read_text(encoding='utf-8-sig'))['serverOnly'])
        self.run_installer(digest, '-Server http://memory-host:9077')
        self.assertEqual(json.loads(self.log.read_text(encoding='utf-8-sig'))['server'], 'http://memory-host:9077')

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


if __name__ == '__main__':
    unittest.main()
