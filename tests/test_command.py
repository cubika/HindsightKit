import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from hindsightkit.setup.command import install_short_command


class ShortCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'hindsightkit.exe'
        self.source.write_bytes(b'current HindsightKit launcher')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.output = io.StringIO()
        self.addCleanup(patch.stopall)
        patch('hindsightkit.setup.command.Path.cwd', return_value=self.root).start()
        patch.dict(os.environ, {'HINDSIGHTKIT_HK_CONFLICT': ''}).start()
        patch('sys.stdout', self.output).start()

    def test_free_name_installs_identical_launcher_and_repeat_is_idempotent(self):
        alias = install_short_command(self.source, self.bin, '')
        self.assertEqual(alias, self.bin / 'hk.exe')
        self.assertEqual(alias.read_bytes(), self.source.read_bytes())
        stamp = alias.stat().st_mtime_ns
        self.assertEqual(install_short_command(self.source, self.bin, str(self.bin)), alias)
        self.assertEqual(alias.stat().st_mtime_ns, stamp)

    def test_foreign_commands_anywhere_on_path_are_preserved(self):
        other = self.root / 'other'
        other.mkdir()
        for extension in ['.exe', '.cmd', '.ps1']:
            with self.subTest(extension=extension):
                occupied = other / ('hk' + extension)
                occupied.write_bytes(b'other tool')
                self.assertIsNone(install_short_command(self.source, self.bin, str(other)))
                self.assertEqual(occupied.read_bytes(), b'other tool')
                self.assertFalse((self.bin / 'hk.exe').exists())
                occupied.unlink()
        self.assertIn('Skipped hk:', self.output.getvalue())

    def test_unrelated_target_is_never_overwritten(self):
        target = self.bin / 'hk.exe'
        target.write_bytes(b'foreign launcher')
        self.assertIsNone(install_short_command(self.source, self.bin, ''))
        self.assertEqual(target.read_bytes(), b'foreign launcher')

    def test_previous_hindsightkit_launcher_is_updated(self):
        target = self.bin / 'hk.exe'
        previous = b'previous HindsightKit launcher'
        target.write_bytes(previous)
        self.assertEqual(install_short_command(self.source, self.bin, str(self.bin), previous), target)
        self.assertEqual(target.read_bytes(), self.source.read_bytes())

    def test_shell_function_conflict_skips_optional_command(self):
        with patch.dict(os.environ, {'HINDSIGHTKIT_HK_CONFLICT': 'Function hk'}):
            self.assertIsNone(install_short_command(self.source, self.bin, ''))
        self.assertFalse((self.bin / 'hk.exe').exists())
        self.assertIn('Function hk', self.output.getvalue())

    def test_new_conflict_is_not_hidden_by_our_earlier_path_entry(self):
        target = self.bin / 'hk.exe'
        target.write_bytes(self.source.read_bytes())
        other = self.root / 'other'
        other.mkdir()
        (other / 'hk.cmd').write_bytes(b'other tool')
        self.assertIsNone(install_short_command(self.source, self.bin, os.pathsep.join([str(self.bin), str(other)])))
        self.assertEqual(target.read_bytes(), self.source.read_bytes())

    @unittest.skipUnless(os.name == 'nt', 'Windows native launcher')
    def test_both_native_commands_accept_same_arguments_in_powershell_and_cmd(self):
        source = Path(sys.executable).parent / 'hindsightkit.exe'
        self.assertTrue(source.is_file(), 'Install HindsightKit before running launcher tests.')
        shutil.copy2(source, self.bin / 'hindsightkit.exe')
        alias = install_short_command(source, self.bin, '')
        self.assertIsNotNone(alias)
        env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}
        for shell, arguments in [(shutil.which('pwsh') or shutil.which('powershell'), ['-NoProfile', '-Command']),
                                 (os.environ['COMSPEC'], ['/d', '/c'])]:
            for name in ['hindsightkit', 'hk']:
                with self.subTest(shell=shell, name=name):
                    result = subprocess.run([shell, *arguments, name + ' connect --help'], env=env,
                        capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn('--server', result.stdout)
                    self.assertIn('--local', result.stdout)


if __name__ == '__main__':
    unittest.main()
