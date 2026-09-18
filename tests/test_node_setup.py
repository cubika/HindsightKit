import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from hindsightkit import cli


@unittest.skipUnless(os.name == 'nt', 'Windows Node.js selection')
class NodeSetupTests(unittest.TestCase):
    def test_setup_reuses_suitable_node_and_saves_it_for_python_or_downloads_fallback(self):
        compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        shells = list(dict.fromkeys(filter(None, [shutil.which('powershell.exe'), shutil.which('pwsh')])))
        if not shells or not compiler.is_file():
            self.skipTest('PowerShell and the Windows .NET compiler are required.')
        with tempfile.TemporaryDirectory(prefix='node setup ') as temp:
            root = Path(temp)
            source = root / 'fixture.cs'
            source.write_text('''using System;
using System.IO;
class Fixture { static void Main(string[] args) {
  string path = System.Reflection.Assembly.GetExecutingAssembly().Location;
  if (Path.GetFileName(path) == "uv.exe") {
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("uv 0.12.15"); }
  } else if (Path.GetFileName(path) == "node.exe") {
    if (args.Length > 0 && args[0] == "-p") {
      string arch = Path.Combine(Path.GetDirectoryName(path), "arch.txt");
      Console.WriteLine(File.Exists(arch) ? File.ReadAllText(arch) : "x64"); return;
    }
    string version = File.ReadAllText(Path.Combine(Path.GetDirectoryName(path), "version.txt"));
    if (version == "broken") { Environment.Exit(2); }
    Console.WriteLine(version);
  } else if (args.Length == 1 && args[0] == "--version") {
    Console.WriteLine("Python 3.12.11");
  } else {
    File.WriteAllText(Environment.GetEnvironmentVariable("TEST_PYTHON_PATH"), Environment.GetEnvironmentVariable("PATH"));
    File.WriteAllText(Environment.GetEnvironmentVariable("TEST_PYTHON_PATH") + ".cache", Environment.GetEnvironmentVariable("UV_CACHE_DIR"));
  }
} }
''', encoding='utf-8')
            native = root / 'fixture.exe'
            subprocess.run([str(compiler), '/nologo', '/out:' + str(native), str(source)],
                           check=True, capture_output=True, timeout=30)
            archive = root / 'node.zip'
            with zipfile.ZipFile(archive, 'w') as zipped:
                prefix = 'node-v22.23.2-win-x64/'
                zipped.write(native, prefix + 'node.exe')
                zipped.writestr(prefix + 'version.txt', 'v22.23.2')
                zipped.writestr(prefix + 'node_modules/npm/bin/npm-cli.js', '// fixture')
            checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
            uv_archive = root / 'uv.zip'
            with zipfile.ZipFile(uv_archive, 'w') as zipped:
                zipped.write(native, 'uv.exe')
            uv_checksum = hashlib.sha256(uv_archive.read_bytes()).hexdigest()

            def put_node(directory, version, with_npm=True):
                directory.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(native, directory / 'node.exe')
                (directory / 'version.txt').write_text(version)
                if with_npm:
                    npm = directory / 'node_modules/npm/bin/npm-cli.js'
                    npm.parent.mkdir(parents=True)
                    npm.write_text('// fixture')
                return directory

            cases = ['node22', 'node24', 'old', 'missing-npm', 'broken', 'absent', 'ia32',
                     'old-before-good', 'ia32-before-good', 'checkout-before-good', 'source', 'shared-cache',
                     'cached-uv', 'broken-cached-uv']
            for shell in shells:
                for case_name in cases:
                    with self.subTest(shell=Path(shell).name, case=case_name):
                        case = root / Path(shell).stem / case_name
                        app = case / 'app'
                        app.mkdir(parents=True)
                        script = app / 'setup.ps1'
                        shutil.copyfile(Path(__file__).resolve().parents[1] / 'setup.ps1', script)
                        (app / 'python/wheels').mkdir(parents=True)
                        (app / 'python/wheels/fixture.whl').write_bytes(b'fixture')
                        for name in ('requirements-client.txt', 'requirements-server.txt'):
                            (app / 'python' / name).write_text('fixture')
                        python = app / '.venv/Scripts/python.exe'
                        python.parent.mkdir(parents=True)
                        shutil.copyfile(native, python)
                        binary = case / 'bin'
                        binary.mkdir()
                        (binary / 'uv.ps1').write_text(
                            'if ($args[0] -eq "--version") { "uv 0.12.15" }; $global:LASTEXITCODE = 0\n')
                        if case_name in ('cached-uv', 'broken-cached-uv'):
                            (binary / 'uv.ps1').unlink()
                            cached_uv = app / '.runtime/tools/uv-0.12.15/uv.exe'
                            cached_uv.parent.mkdir(parents=True)
                            if case_name == 'cached-uv':
                                shutil.copyfile(native, cached_uv)
                            else:
                                cached_uv.write_bytes(b'interrupted executable')
                        (binary / 'hindsightkit.ps1').write_text('$global:LASTEXITCODE = 0\n')
                        path = [str(binary)]
                        expected = app / '.runtime/tools/node-v22.23.2-win-x64/node.exe'
                        if case_name == 'shared-cache':
                            expected = case / 'shared-cache/tools/node-v22.23.2-win-x64/node.exe'
                        reused = case_name in ('node22', 'node24', 'old-before-good', 'ia32-before-good', 'checkout-before-good', 'source',
                                               'cached-uv', 'broken-cached-uv')
                        if case_name == 'checkout-before-good':
                            checkout = case / 'old checkout'
                            stale = put_node(checkout / '.runtime/tools/node-v22.23.2-win-x64', 'v22.23.2')
                            (checkout / 'setup.ps1').write_text('# source ZIP without .git')
                            (checkout / 'pyproject.toml').write_text('# fixture')
                            path.append(str(stale))
                        if case_name == 'old-before-good':
                            path.append(str(put_node(case / 'old node', 'v20.18.0')))
                        if case_name == 'ia32-before-good':
                            incompatible = put_node(case / '32 bit node', 'v22.18.0')
                            (incompatible / 'arch.txt').write_text('ia32')
                            path.append(str(incompatible))
                        if case_name != 'absent':
                            version = {'old': 'v20.18.0', 'node24': 'v24.0.0', 'broken': 'broken'}.get(case_name, 'v22.18.0')
                            selected = put_node(case / 'system node', version, case_name != 'missing-npm')
                            if case_name == 'ia32':
                                (selected / 'arch.txt').write_text('ia32')
                            path.append(str(selected))
                            if reused:
                                expected = selected / 'node.exe'
                        # Retain Git and PowerShell prerequisites, but never select the host Node.
                        path.extend(part for part in os.environ['PATH'].split(os.pathsep)
                                    if part and not (Path(part) / 'node.exe').is_file()
                                    and not (case_name in ('cached-uv', 'broken-cached-uv') and (Path(part) / 'uv.exe').is_file()))
                        state = case / 'state'
                        state.mkdir()
                        saved = state / 'node-path.txt'
                        saved.write_text(str(case / 'stale/node.exe'))
                        requests, trace = case / 'downloads.txt', case / 'python-path.txt'
                        wrapper = case / 'invoke.ps1'
                        wrapper.write_text('''function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    Add-Content -LiteralPath $env:TEST_DOWNLOADS -Value $Uri
    if ($Uri.EndsWith('uv-x86_64-pc-windows-msvc.zip.sha256')) {
        [IO.File]::WriteAllText($OutFile, $env:TEST_UV_CHECKSUM); return
    }
    if ($Uri.EndsWith('uv-x86_64-pc-windows-msvc.zip')) {
        Copy-Item -LiteralPath $env:TEST_UV_ARCHIVE -Destination $OutFile; return
    }
    if ($Uri.EndsWith("SHASUMS256.txt")) {
        return @{ Content = $env:TEST_CHECKSUM + "  node-v22.23.2-win-x64.zip" }
    }
    if (-not $Uri.EndsWith("node-v22.23.2-win-x64.zip")) { throw "Unexpected download: $Uri" }
    Copy-Item -LiteralPath $env:TEST_ARCHIVE -Destination $OutFile
}
& $env:TEST_SETUP -ServerOnly -NoOpen
exit $LASTEXITCODE
''', encoding='utf-8')
                        inherited = {key: value for key, value in os.environ.items()
                                     if key.lower() != 'psmodulepath' and not key.upper().startswith('HINDSIGHTKIT_')}
                        local, roaming = case / 'AppData/Local', case / 'AppData/Roaming'
                        local.mkdir(parents=True)
                        roaming.mkdir(parents=True)
                        env = {**inherited, 'PATH': os.pathsep.join(path), 'USERPROFILE': str(case),
                               'LOCALAPPDATA': str(local), 'APPDATA': str(roaming),
                               'COPILOT_HOME': '', 'HINDSIGHTKIT_HOME': str(state),
                               'HINDSIGHTKIT_RELEASE_MANIFEST': '' if case_name == 'source' else str(app / 'release.json'),
                               'HINDSIGHTKIT_INSTALL_LOG': '', 'TEST_SETUP': str(script),
                               'TEST_DOWNLOADS': str(requests), 'TEST_ARCHIVE': str(archive),
                               'TEST_CHECKSUM': checksum, 'TEST_PYTHON_PATH': str(trace)}
                        env.update(TEST_UV_ARCHIVE=str(uv_archive), TEST_UV_CHECKSUM=uv_checksum)
                        if case_name == 'shared-cache':
                            env['HINDSIGHTKIT_INSTALL_CACHE'] = str(case / 'shared-cache')
                            # No system Node: download into the shared tool cache on the first release.
                            env['PATH'] = os.pathsep.join(part for part in path
                                                       if not (Path(part) / 'node.exe').is_file())
                        result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                                 '-File', str(wrapper)], env=env,
                                                capture_output=True, text=True, encoding='utf-8', timeout=30)
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertTrue(Path(saved.read_text()).samefile(expected))
                        self.assertEqual(requests.exists(), not reused or case_name == 'broken-cached-uv')
                        if not reused or case_name == 'broken-cached-uv':
                            self.assertEqual(len(requests.read_text(encoding='utf-8-sig').splitlines()), 2)
                        self.assertIn('Reusing Node.js' if reused else 'Installed Node.js', result.stdout)
                        self.assertTrue(Path(trace.read_text().split(os.pathsep)[0]).samefile(expected.parent))
                        if case_name == 'shared-cache':
                            self.assertEqual(Path(Path(str(trace) + '.cache').read_text()), case / 'shared-cache/uv')
                            next_app = case / 'next-release'
                            shutil.copytree(app, next_app)
                            env['TEST_SETUP'] = str(next_app / 'setup.ps1')
                            env['HINDSIGHTKIT_RELEASE_MANIFEST'] = str(next_app / 'release.json')
                            repeated = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                '-File', str(wrapper)], env=env, capture_output=True, text=True, encoding='utf-8', timeout=30)
                            self.assertEqual(repeated.returncode, 0, repeated.stdout + repeated.stderr)
                            self.assertIn('Reusing Node.js', repeated.stdout)
                            self.assertEqual(len(requests.read_text(encoding='utf-8-sig').splitlines()), 2)
                        with patch.dict(os.environ, env, clear=True), patch.object(cli, 'home', return_value=state):
                            cli.prepare_env()
                            self.assertTrue(Path(os.environ['PATH'].split(os.pathsep)[0]).samefile(expected.parent))
