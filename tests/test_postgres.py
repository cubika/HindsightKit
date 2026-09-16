import json
from pathlib import Path
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch, AsyncMock

from provenloop import postgres


class PostgresTests(unittest.TestCase):
    def test_legacy_installation_root_resolves_version_subdirectory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instance = root / 'instances/hindsight-embed-provenloop'
            data = instance / 'data'
            installation = root / 'installation'
            binaries = installation / '18.1.0/bin'
            data.mkdir(parents=True)
            binaries.mkdir(parents=True)
            (data / 'PG_VERSION').write_text('18')
            (data / 'postmaster.pid').write_text('123\ndata\n0\n5432\n')
            (binaries / 'postgres.exe').touch()
            (instance / 'instance.json').write_text(json.dumps({
                'installation_dir': str(installation), 'version': '18.1.0',
                'data_dir': str(data), 'port': 5432, 'username': 'test',
                'password': 'secret', 'database': 'hindsight'}))
            tools = Mock(root=root, sql=Mock(return_value=str(data)))
            def execute(command, **kwargs):
                if command[-1] == '--version':
                    self.assertEqual(command[0], binaries / 'postgres.exe')
                    return Mock(stdout='postgres (PostgreSQL) 18.1', returncode=0)
                self.assertEqual(command[0], binaries / 'pg_ctl.exe')
                return Mock(stdout='', returncode=0)
            with patch.object(postgres, 'execute', side_effect=execute):
                with postgres.legacy_connection(root, tools) as connection:
                    self.assertEqual(connection['database'], 'hindsight')
                    self.assertEqual(connection['port'], '5432')

    def test_profile_switch_preserves_settings_and_original_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'profile.env'
            original = '# user comment\nHINDSIGHT_API_LLM_MODEL=custom\nHINDSIGHT_API_DATABASE_URL=pg0\n'
            path.write_text(original)
            postgres.write_profile_database(path, 'postgresql://first')
            postgres.write_profile_database(path, 'postgresql://second')
            self.assertIn('# user comment', path.read_text())
            self.assertIn('HINDSIGHT_API_LLM_MODEL=custom', path.read_text())
            self.assertNotIn('HINDSIGHT_API_DATABASE_URL=', path.read_text())
            self.assertEqual(path.with_name('profile.env.before-postgresql').read_text(), original)
            self.assertEqual(path.read_text().count(postgres.DATABASE_KEY + '='), 1)

    def test_legacy_profiles_never_silently_start_pg0(self):
        for value in ('', 'pg0', 'pg0://hindsight-embed-provenloop'):
            with self.subTest(value=value), patch.dict('os.environ', {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, 'migrate'):
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

    def test_failed_switch_retries_from_source_even_with_old_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = Mock()
            server.root = root
            server.url = 'postgresql://new/hindsight'
            server.state = {'migration': {'backup': 'old.dump'}}
            source = {'database': 'source'}
            @contextmanager
            def legacy(*args):
                yield source
            with patch.object(postgres, 'Postgres', return_value=server), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres, 'legacy_connection', legacy), \
                 patch.object(postgres, 'write_profile_database') as switch:
                postgres.setup_database(root, {}, root/'profile', stop_api=Mock())
            server.restore_legacy.assert_called_once_with(source)
            switch.assert_called_once_with(root/'profile', server.url)

    def test_migration_failure_does_not_switch_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            server = Mock(root=root, url='postgresql://new/hindsight')
            server.restore_legacy.side_effect = RuntimeError('restore failed')
            @contextmanager
            def legacy(*args):
                yield {'database': 'source'}
            with patch.object(postgres, 'Postgres', return_value=server), \
                 patch.object(postgres, 'private_directory'), \
                 patch.object(postgres, 'legacy_connection', legacy), \
                 patch.object(postgres, 'write_profile_database') as switch:
                with self.assertRaisesRegex(RuntimeError, 'restore failed'):
                    postgres.setup_database(root, {}, root/'profile', stop_api=Mock())
                switch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
