from pathlib import Path
import io
import os
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch, AsyncMock, MagicMock

from hindsightkit.setup import postgres


class PostgresTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell integration')
    def test_installer_finds_builtin_modules_despite_inherited_powershell_core_path(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {'PSModulePath': directory}), \
             patch.object(postgres, 'private_directory'):
            original_popen = subprocess.Popen
            def probe(command, **kwargs):
                return original_popen([command[0], '-NoProfile', '-Command',
                    '$ErrorActionPreference="Stop"; (Get-Command Get-FileHash).Name'], **kwargs)
            with patch.object(postgres.subprocess, 'Popen', side_effect=probe):
                postgres.Postgres(Path(directory)).install()
            self.assertEqual(os.environ['PSModulePath'], directory)

    def test_installer_failure_includes_actionable_stderr(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.StringIO('extension build failed\n')
        process.wait.return_value = 1
        with tempfile.TemporaryDirectory() as directory, patch.object(postgres, 'private_directory'), \
             patch.object(postgres.shutil, 'which', return_value='powershell.exe'), \
             patch.object(postgres.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(RuntimeError, 'extension build failed'):
                postgres.Postgres(Path(directory)).install()

    def test_installer_streams_output_before_waiting_for_exit(self):
        output = io.StringIO()
        process = MagicMock()
        process.__enter__.return_value = process
        def lines():
            yield 'Downloading PostgreSQL...\n'
            self.assertIn('Downloading PostgreSQL...', output.getvalue())
            process.wait.assert_not_called()
            yield 'Verified release.\n'
        process.stdout = lines()
        process.wait.return_value = 0
        with tempfile.TemporaryDirectory() as directory, patch.object(postgres, 'private_directory'), \
             patch.object(postgres.shutil, 'which', return_value='powershell.exe'), \
             patch.dict(os.environ, {}, clear=True), patch('sys.stdout', output), \
             patch.object(postgres.subprocess, 'Popen', return_value=process) as popen:
            postgres.Postgres(Path(directory)).install()
        self.assertIn('Verified release.', output.getvalue())
        self.assertNotIn('-DistributionUrl', popen.call_args.args[0])
        self.assertEqual(popen.call_args.kwargs['stderr'], subprocess.STDOUT)

    def test_profile_write_preserves_settings_and_replaces_only_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'profile.env'
            original = '# user comment\nHINDSIGHT_API_LLM_MODEL=custom\n'
            path.write_text(original)
            postgres.write_profile_database(path, 'postgresql://first')
            postgres.write_profile_database(path, 'postgresql://second')
            self.assertIn('# user comment', path.read_text())
            self.assertIn('HINDSIGHT_API_LLM_MODEL=custom', path.read_text())
            self.assertEqual(list(Path(directory).iterdir()), [path])
            self.assertIn('postgresql://second', path.read_text())
            self.assertEqual(path.read_text().count(postgres.DATABASE_KEY + '='), 1)

    def test_database_connection_is_required_and_must_be_postgresql(self):
        for value in ('', 'sqlite:///memory.db', 'https://server'):
            with self.subTest(value=value), patch.dict('os.environ', {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'PostgreSQL connection is required'):
                    postgres.require_postgresql({postgres.DATABASE_KEY: value})

    def test_existing_unrecognized_data_is_never_initialized(self):
        with tempfile.TemporaryDirectory() as directory:
            server = postgres.Postgres(Path(directory))
            server.data.mkdir()
            marker = server.data / 'precious'
            marker.write_text('preserve')
            with patch.object(postgres, 'private_directory'), patch.object(postgres, 'execute') as execute:
                with self.assertRaisesRegex(RuntimeError, 'refusing'):
                    server.initialize()
                execute.assert_not_called()
            self.assertEqual(marker.read_text(), 'preserve')

    def test_external_setup_validates_and_restarts_api_without_installing(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(postgres, 'private_directory'), \
             patch.object(postgres, 'check_external', new_callable=AsyncMock) as check, \
             patch.object(postgres.Postgres, 'install') as install:
            stop = Mock()
            url = 'postgresql://external/hindsight'
            postgres.setup_database(Path(directory), {postgres.DATABASE_KEY: url}, Path(directory)/'profile', stop_api=stop)
            check.assert_awaited_once_with(url)
            stop.assert_called_once_with()
            install.assert_not_called()

    def test_repeated_setup_keeps_configured_database_and_running_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = Mock()
            server.root = root
            server.url = 'postgresql://new/hindsight'
            stop = Mock()
            with patch.object(postgres, 'Postgres', return_value=server), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres, 'write_profile_database') as switch:
                postgres.setup_database(root, {postgres.DATABASE_KEY: server.url}, root/'profile', stop_api=stop)
            server.prepare_database.assert_called_once_with()
            stop.assert_not_called()
            switch.assert_not_called()

    def test_failed_database_validation_does_not_switch_profile_or_stop_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = Mock(root=root, url='postgresql://new/hindsight')
            server.prepare_database.side_effect = RuntimeError('extension missing')
            stop = Mock()
            with patch.object(postgres, 'Postgres', return_value=server), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres, 'write_profile_database') as switch:
                with self.assertRaisesRegex(RuntimeError, 'extension missing'):
                    postgres.setup_database(root, {}, root/'profile', stop_api=stop)
                switch.assert_not_called()
                stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
