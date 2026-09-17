from pathlib import Path
import copy
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile

from hindsightkit import postgres


class ReleaseManifestTests(unittest.TestCase):
    def manifest(self):
        return {'schema': 1, 'version': 'v1.0.0', 'repository': 'owner/HindsightKit',
                'release_url': 'https://github.com/owner/HindsightKit/releases/tag/v1.0.0',
                'postgres': {'url': 'https://github.com/owner/HindsightKit/releases/download/v1.0.0/postgres.zip',
                             'sha256': 'ab' * 32, 'postgres_version': '18.6', 'vector_version': '0.8.6'}}

    def test_release_manifest_selects_precompiled_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest()
            path = Path(directory) / 'release.json'
            path.write_text(json.dumps(manifest), encoding='utf-8')
            process = MagicMock()
            process.__enter__.return_value = process
            process.stdout = io.StringIO('Verified release.\n')
            process.wait.return_value = 0
            with patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(path)}), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres.shutil, 'which', return_value='powershell.exe'), \
                 patch.object(postgres.subprocess, 'Popen', return_value=process) as popen:
                postgres.Postgres(Path(directory) / 'postgresql').install()
            command = popen.call_args.args[0]
            self.assertEqual(command[-4:], ['-DistributionUrl', manifest['postgres']['url'],
                                            '-DistributionSha256', 'AB' * 32])

    def test_invalid_manifest_never_falls_back_to_compilation(self):
        changes = [({'schema': 2}, None), ({'schema': True}, None), ({'version': ''}, None),
                   ({'postgres': None}, None), ({}, {'postgres_version': '17.0'}),
                   ({}, {'vector_version': '0.8.5'}), ({}, {'sha256': 'not-a-digest'}),
                   ({}, {'url': 'http://example.com/postgres.zip'}),
                   ({}, {'url': 'https://user:password@example.com/postgres.zip'}),
                   ({}, {'url': 'https://example.com/postgres.zip#fragment'}),
                   ({}, {'url': 'https://example.com/a b.zip'})]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            for top, distribution in changes:
                manifest = self.manifest()
                manifest.update(top)
                if distribution:
                    manifest['postgres'].update(distribution)
                path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.subTest(top=top, distribution=distribution), \
                     patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(path)}), \
                     patch.object(postgres.subprocess, 'Popen') as popen, \
                     patch.object(postgres, 'private_directory') as prepare:
                    with self.assertRaisesRegex(RuntimeError, 'Invalid HindsightKit release manifest'):
                        postgres.Postgres(Path(directory)).install()
                    prepare.assert_not_called()
                    popen.assert_not_called()

    def test_missing_or_malformed_explicit_manifest_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            for value in (None, '{malformed', '[]'):
                if value is not None:
                    path.write_text(value, encoding='utf-8')
                with self.subTest(value=value), patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(path)}):
                    with self.assertRaisesRegex(RuntimeError, 'Invalid HindsightKit release manifest'):
                        postgres.release_distribution()

    def test_installed_app_manifest_is_used_after_bootstrap_environment_is_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / 'app'
            package = app / 'src/hindsightkit/postgres.py'
            package.parent.mkdir(parents=True)
            manifest = self.manifest()
            (app / 'release.json').write_text(json.dumps(manifest), encoding='utf-8')
            with patch.dict(os.environ, {}, clear=True), patch.object(postgres, '__file__', str(package)):
                self.assertEqual(postgres.release_distribution(), (manifest['postgres']['url'], 'AB' * 32, None, None))
                (app / 'release.json').write_text('{}', encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'Invalid HindsightKit release manifest'):
                    postgres.release_distribution()

    def test_explicit_manifest_has_priority_and_discovery_does_not_scan_ancestors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'app'
            package = app / 'src/hindsightkit/postgres.py'
            package.parent.mkdir(parents=True)
            explicit = root / 'release.json'
            manifest = self.manifest()
            explicit.write_text(json.dumps(manifest), encoding='utf-8')
            with patch.object(postgres, '__file__', str(package)), patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(postgres.release_distribution())
                (app / 'release.json').write_text('{}', encoding='utf-8')
                with patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(explicit)}):
                    self.assertEqual(postgres.release_distribution(), (manifest['postgres']['url'], 'AB' * 32, None, None))

    def test_authenticated_manifest_passes_repository_and_tag_to_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = self.manifest()
            manifest.update(requires_auth=True, repository='restricted-owner/HindsightKit',
                            release_url='https://git.example.com/restricted-owner/HindsightKit/releases/download/v1.0.0')
            manifest['postgres']['url'] = manifest['release_url'] + '/postgres.zip'
            path = Path(directory) / 'release.json'
            path.write_text(json.dumps(manifest), encoding='utf-8')
            process = MagicMock()
            process.__enter__.return_value = process
            process.stdout = io.StringIO('Verified release.\n')
            process.wait.return_value = 0
            with patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(path)}), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres.shutil, 'which', return_value='powershell.exe'), \
                 patch.object(postgres.subprocess, 'Popen', return_value=process) as popen:
                postgres.Postgres(Path(directory) / 'postgresql').install()
            self.assertEqual(popen.call_args.args[0][-8:],
                             ['-DistributionUrl', manifest['postgres']['url'], '-DistributionSha256', 'AB' * 32,
                              '-ReleaseRepository', 'restricted-owner/HindsightKit', '-ReleaseTag', 'v1.0.0'])

    def test_authenticated_manifest_rejects_nonboolean_or_mismatched_release(self):
        cases = [('requires_auth', 'true'), ('requires_auth', 1), ('repository', 'other/repo'),
                 ('version', 'v2.0.0'), ('release_url', 'https://other.example.com/owner/HindsightKit/releases/download/v1.0.0'),
                 ('url', 'https://github.com/owner/HindsightKit/releases/download/v1.0.0/*.zip'),
                 ('url', 'https://github.com/owner/HindsightKit/releases/download/v1.0.0/postgres.zip?token=secret')]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            for key, value in cases:
                manifest = self.manifest()
                manifest.update(requires_auth=True,
                                release_url='https://github.com/owner/HindsightKit/releases/download/v1.0.0')
                if key == 'url':
                    manifest['postgres']['url'] = value
                else:
                    manifest[key] = value
                path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.subTest(key=key, value=value), patch.dict(os.environ, {'HINDSIGHTKIT_RELEASE_MANIFEST': str(path)}):
                    with self.assertRaisesRegex(RuntimeError, 'Invalid HindsightKit release manifest'):
                        postgres.release_distribution()


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell release installation')
class PowerShellReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix='hindsightkit-release-tests-')
        cls.root = Path(cls.workspace.name)
        cls.shell = shutil.which('powershell.exe')
        if not cls.shell:
            cls.workspace.cleanup()
            raise unittest.SkipTest('Windows PowerShell is unavailable')
        cls.installer = Path(postgres.__file__).with_name('postgres_install.ps1')
        cls.environment = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        cls.harness = cls.root / 'install-fixture.ps1'
        cls.harness.write_text('''param([string]$Installer, [string]$Destination, [string]$Cache,
    [string]$Archive, [string]$Sha256)
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    Copy-Item -LiteralPath $Archive -Destination $OutFile
}
& $Installer -Destination $Destination -CacheDirectory $Cache -DistributionUrl 'https://example.com/postgres.zip' -DistributionSha256 $Sha256
''', encoding='utf-8')
        cls.auth_harness = cls.root / 'install-auth-fixture.ps1'
        cls.auth_harness.write_text('''param([string]$Installer, [string]$Root, [string]$Archive,
    [string]$Sha256, [string]$Url, [string]$Repository, [string]$Tag, [int]$GhExit = 0)
$ErrorActionPreference = 'Stop'
$env:HINDSIGHTKIT_TEST_ARCHIVE = $Archive
$env:HINDSIGHTKIT_TEST_CALLS = Join-Path $Root 'gh-calls.jsonl'
$env:HINDSIGHTKIT_TEST_GH_EXIT = [string]$GhExit
function Invoke-WebRequest { throw 'Anonymous download must not be called' }
function Start-Sleep {}
$ghFixture = Join-Path (Split-Path -Parent $PSCommandPath) 'gh-fixture.ps1'
function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'gh') { return [pscustomobject]@{ Source = $ghFixture } }
    Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}
& $Installer -Destination (Join-Path $Root 'installed') -CacheDirectory (Join-Path $Root 'cache') -DistributionUrl $Url -DistributionSha256 $Sha256 -ReleaseRepository $Repository -ReleaseTag $Tag
''', encoding='utf-8')
        (cls.root / 'gh-fixture.ps1').write_text('''$ErrorActionPreference = 'Stop'
Add-Content -LiteralPath $env:HINDSIGHTKIT_TEST_CALLS -Value (ConvertTo-Json -InputObject @($args) -Compress)
$outputIndex = [Array]::IndexOf($args, '--output')
if ($outputIndex -lt 0) { throw 'Missing output option' }
Copy-Item -LiteralPath $env:HINDSIGHTKIT_TEST_ARCHIVE -Destination $args[$outputIndex + 1]
Write-Output 'synthetic-sensitive-auth-diagnostic'
$global:LASTEXITCODE = [int]$env:HINDSIGHTKIT_TEST_GH_EXIT
''', encoding='utf-8')
        # A tiny version-reporting executable exercises the installer's real file,
        # archive and process checks without installing or starting PostgreSQL.
        executable = cls.root / 'version-fixture.exe'
        compile_script = cls.root / 'compile-fixture.ps1'
        compile_script.write_text('''param([string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'public class VersionFixture {
    public static void Main() { System.Console.WriteLine("postgres (PostgreSQL) 18.6"); }
}' -OutputAssembly $Output -OutputType ConsoleApplication
''', encoding='utf-8')
        result = subprocess.run([cls.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                 str(compile_script), '-Output', str(executable)],
                                env=cls.environment, capture_output=True, text=True, timeout=60)
        if result.returncode:
            cls.workspace.cleanup()
            raise RuntimeError(result.stdout + result.stderr)
        required = ['bin/postgres.exe', 'bin/initdb.exe', 'bin/pg_ctl.exe', 'bin/pg_isready.exe',
                    'bin/psql.exe', 'bin/pg_dump.exe', 'bin/pg_dumpall.exe', 'bin/pg_restore.exe',
                    'bin/pg_config.exe', 'bin/vcruntime140.dll', 'lib/postgres.lib',
                    'include/server/postgres.h', 'share/extension/vector--0.8.6.sql']
        for extension in ('vector', 'pg_trgm', 'btree_gin', 'btree_gist', 'pg_stat_statements',
                          'unaccent', 'pgcrypto', 'uuid-ossp'):
            required += [f'lib/{extension}.dll', f'share/extension/{extension}.control']
        cls.files = {name: b'test fixture\n' for name in required}
        cls.files['bin/postgres.exe'] = executable.read_bytes()
        cls.files['share/extension/vector.control'] = b"default_version = '0.8.6'\n"
        cls.manifest = {'schema': 1, 'architecture': 'windows-x64', 'postgres_version': '18.6',
                        'vector_version': '0.8.6',
                        'postgres_sha256': 'FBE23DA234EE31547BF8A36D29DFD81E82B849DF2D2B78D2EECB43D360252F8C',
                        'vector_sha256': 'E93A1567219C9CE523CA16473F6C41CC80E01345B2D91CCDEE40B473B7C5DD0A',
                        'files': {name: hashlib.sha256(value).hexdigest() for name, value in cls.files.items()}}

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def archive(self, root, *, manifest=None, files=None, extra=None):
        archive = root / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            for name, value in (self.files if files is None else files).items():
                output.writestr('pgsql/' + name, value)
            output.writestr('pgsql/hindsightkit-postgres.json', json.dumps(self.manifest if manifest is None else manifest))
            for name, value in (extra or {}).items():
                output.writestr(name, value)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def install(self, root, archive, digest):
        return subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                               str(self.harness), '-Installer', str(self.installer),
                               '-Destination', str(root / 'installed'), '-Cache', str(root / 'cache'),
                               '-Archive', str(archive), '-Sha256', digest],
                              env=self.environment, capture_output=True, text=True, timeout=60)

    def install_authenticated(self, root, archive, digest, *, gh_exit=0, url=None):
        return subprocess.run([self.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                               str(self.auth_harness), '-Installer', str(self.installer), '-Root', str(root),
                               '-Archive', str(archive), '-Sha256', digest, '-GhExit', str(gh_exit),
                               '-Repository', 'restricted-owner/HindsightKit', '-Tag', 'v1.0.0',
                               '-Url', url or 'https://git.example.com/restricted-owner/HindsightKit/releases/download/v1.0.0/postgres.zip'],
                              env=self.environment, capture_output=True, text=True, timeout=60)

    def assert_failed_cleanly(self, root, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(message, result.stdout + result.stderr)
        self.assertFalse((root / 'installed').exists())
        self.assertEqual(list(root.glob('.hindsightkit-postgres-*')), [])
        self.assertNotIn('Compiling pgvector', result.stdout)

    def test_verified_release_installs_and_existing_distribution_is_reused(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            root = Path(directory)
            archive, digest = self.archive(root)
            first = self.install(root, archive, digest)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertIn('Extracting the precompiled PostgreSQL release', first.stdout)
            self.assertNotIn('Microsoft C++ build tools', first.stdout)
            self.assertEqual((root / 'installed/bin/postgres.exe').read_bytes(), self.files['bin/postgres.exe'])
            archive.unlink()
            second = self.install(root, archive, digest)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn('Verified existing PostgreSQL', second.stdout)
            self.assertEqual(list(root.glob('.hindsightkit-postgres-*')), [])

    def test_authenticated_release_uses_current_gh_and_reuses_verified_cache(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            root = Path(directory)
            archive, digest = self.archive(root)
            result = self.install_authenticated(root, archive, digest)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = [json.loads(line) for line in (root / 'gh-calls.jsonl').read_text(encoding='utf-8-sig').splitlines()]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:-1], ['release', 'download', 'v1.0.0', '--repo',
                             'git.example.com/restricted-owner/HindsightKit', '--pattern', 'postgres.zip', '--output'])
            self.assertIn('.part-', calls[0][-1])
            self.assertNotIn('synthetic-sensitive-auth-diagnostic', result.stdout + result.stderr)
            installed = root / 'installed'
            # This fixture is an ordinary tree owned by this temporary test only.
            self.assertTrue(installed.resolve().is_relative_to(root.resolve()))
            shutil.rmtree(installed)
            archive.unlink()
            repeated = self.install_authenticated(root, archive, digest, gh_exit=1)
            self.assertEqual(repeated.returncode, 0, repeated.stdout + repeated.stderr)
            self.assertEqual(len((root / 'gh-calls.jsonl').read_text(encoding='utf-8-sig').splitlines()), 1)

    def test_authenticated_failure_never_falls_back_and_cleans_partial_files(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            root = Path(directory)
            archive, digest = self.archive(root)
            result = self.install_authenticated(root, archive, digest, gh_exit=1)
            self.assert_failed_cleanly(root, result, 'Authenticated release download failed')
            self.assertNotIn('Anonymous download must not be called', result.stdout + result.stderr)
            self.assertNotIn('synthetic-sensitive-auth-diagnostic', result.stdout + result.stderr)
            self.assertEqual(list((root / 'cache').glob('*.part-*')), [])

    def test_authenticated_asset_requires_expected_hash_and_matching_release_url(self):
        cases = [('0' * 64, None, 'SHA256 verification failed'),
                 (None, 'https://git.example.com/other/repo/releases/download/v1.0.0/postgres.zip', 'must match'),
                 (None, 'https://git.example.com/restricted-owner/HindsightKit/releases/download/v2.0.0/postgres.zip', 'must match'),
                 (None, 'https://git.example.com/restricted-owner/HindsightKit/releases/download/v1.0.0/*.zip', 'must match')]
        for checksum, url, expected in cases:
            with self.subTest(url=url), tempfile.TemporaryDirectory(dir=self.root) as directory:
                root = Path(directory)
                archive, digest = self.archive(root)
                result = self.install_authenticated(root, archive, checksum or digest, url=url)
                self.assert_failed_cleanly(root, result, expected)
                if url:
                    self.assertFalse((root / 'gh-calls.jsonl').exists())

    def test_compiler_path_mapping_removes_header_source_paths_and_preserves_options(self):
        with tempfile.TemporaryDirectory(prefix='compiler path ', dir=self.root) as directory:
            root = Path(directory)
            source = root / 'pgvector'
            (source / 'src').mkdir(parents=True)
            (root / 'cache').mkdir()
            (root / 'pgsql').mkdir()
            (source / 'src/probe.c').write_text('#include "header.h"\n', encoding='utf-8')
            (source / 'Makefile.win').write_text('''all: probe.obj
probe.obj: src/probe.c src/header.h
\tcl /nologo /c src\\probe.c /Foprobe.obj
install: all
''', encoding='utf-8')
            harness = root / 'build-fixture.ps1'
            harness.write_text('''param([string]$Installer, [string]$Root, [switch]$ShortPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer syntax error' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        Invoke-Expression $statement.Extent.Text
    }
}
$installation = Find-CppTools
if (-not $installation) { Write-Host 'SKIP_NO_COMPILER'; exit 0 }
if ($ShortPath) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class FixtureShortPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern uint GetShortPathNameW(string path, StringBuilder result, uint capacity);
}
'@
    $buffer = New-Object Text.StringBuilder 32768
    $length = [FixtureShortPath]::GetShortPathNameW($Root, $buffer, $buffer.Capacity)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot obtain short fixture path' }
    $Root = $buffer.ToString()
    if ($Root -notmatch '~[0-9]') { Write-Host 'SKIP_NO_SHORT_PATH'; exit 0 }
    [IO.File]::WriteAllText((Join-Path $Root 'short-path.txt'), $Root)
}
$CacheDirectory = Join-Path $Root 'cache'
$PostgresVersion = '18.6'; $VectorVersion = '0.8.6'
Build-Vector $installation (Join-Path $Root 'pgsql') (Join-Path $Root 'pgvector') $Root
''', encoding='utf-8')
            shells = list(dict.fromkeys(filter(None, [self.shell, shutil.which('pwsh')])))
            cases = [(shell, short_path, existing) for shell in shells
                     for short_path in (False, True) for existing in (False, True)]
            for shell, short_path, existing in cases:
                with self.subTest(shell=Path(shell).name, short_path=short_path, existing_options=existing):
                    environment = {key: value for key, value in self.environment.items()
                                   if key.upper() not in {'CL', '_CL_'}}
                    guard = ''
                    if existing:
                        environment.update(CL='/DFROM_CL=1', _CL_='/DFROM_TRAILING_CL=1')
                        guard = ('#if !defined(FROM_CL) || !defined(FROM_TRAILING_CL)\n'
                                 '#error Existing compiler options were lost\n#endif\n')
                    (source / 'src/header.h').write_text(
                        guard + 'const char* source_path(void) { return __FILE__; }\n', encoding='utf-8')
                    (source / 'probe.obj').unlink(missing_ok=True)
                    command = [shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                               str(harness), '-Installer', str(self.installer), '-Root', str(root)]
                    if short_path:
                        command.append('-ShortPath')
                    result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=60)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    if 'SKIP_NO_COMPILER' in result.stdout:
                        self.skipTest('MSVC is not installed')
                    if 'SKIP_NO_SHORT_PATH' in result.stdout:
                        self.skipTest('The fixture volume does not provide 8.3 path aliases')
                    compiled = (source / 'probe.obj').read_bytes()
                    absolute_paths = {str(root), str(root.resolve())}
                    if short_path:
                        absolute_paths.add((root / 'short-path.txt').read_text(encoding='utf-8-sig'))
                    for absolute in absolute_paths:
                        for spelling in (absolute, absolute.replace('\\', '/')):
                            self.assertNotIn(spelling.encode().lower(), compiled.lower())
                    self.assertIn(b'.\\pgvector\\src\\header.h', compiled)

    def test_bad_archive_hash_stops_without_compiling(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            root = Path(directory)
            archive, _ = self.archive(root)
            self.assert_failed_cleanly(root, self.install(root, archive, '0' * 64), 'SHA256 verification failed')

    def test_bad_file_hash_stops_before_install(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            root = Path(directory)
            files = dict(self.files, **{'bin/initdb.exe': b'changed'})
            archive, digest = self.archive(root, files=files)
            self.assert_failed_cleanly(root, self.install(root, archive, digest), 'failed SHA256 verification')

    def test_unlisted_file_and_wrong_manifest_version_are_rejected(self):
        for modification, expected in [('extra', 'absent from the distribution manifest'),
                                       ('version', 'differs from the pinned distribution')]:
            with self.subTest(modification=modification), tempfile.TemporaryDirectory(dir=self.root) as directory:
                root = Path(directory)
                manifest = copy.deepcopy(self.manifest)
                extra = {'pgsql/bin/unlisted.dll': b'extra'} if modification == 'extra' else None
                if modification == 'version':
                    manifest['postgres_version'] = '17.0'
                archive, digest = self.archive(root, manifest=manifest, extra=extra)
                self.assert_failed_cleanly(root, self.install(root, archive, digest), expected)

    def test_archive_root_traversal_and_alternate_stream_are_rejected(self):
        for entry, expected in [('outside.txt', 'Unexpected archive root'),
                                ('pgsql/../outside.txt', 'Unsafe archive entry'),
                                ('pgsql/bin/postgres.exe:stream', 'Unsafe archive entry')]:
            with self.subTest(entry=entry), tempfile.TemporaryDirectory(dir=self.root) as directory:
                root = Path(directory)
                archive, digest = self.archive(root, extra={entry: b'unsafe'})
                self.assert_failed_cleanly(root, self.install(root, archive, digest), expected)
                self.assertFalse((root / 'outside.txt').exists())


if __name__ == '__main__':
    unittest.main()
