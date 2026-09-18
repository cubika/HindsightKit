import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit import cli, connection, installer, lifecycle, remote, services
from hindsightkit import runtime as runtime_env
from test_remote import options as remote_options
import test_remote_setup as setup_fixture


class CliBehaviorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.start = services.start
        self.environment = setup_fixture.RemoteSetupTests().client_environment(self.root)
        self.state = self.environment.__enter__()
        self.addCleanup(self.environment.__exit__, None, None, None)
        self.previous = {'apiUrl': 'https://old.invalid', 'apiToken': 'saved-key',
                         'hindsightkit': {'mode': 'client', 'routing': 'repository', 'deviceId': '11111111-1111-1111-1111-111111111111'}}
        self.state.path.write_text(json.dumps(self.previous))

    def test_full_upgrade_refreshes_client_without_changing_remote_connection(self):
        original = self.state.path.read_bytes()
        with patch.object(installer, 'setup_server', return_value={'apiUrl': 'http://127.0.0.1:9077'}), \
             patch('hindsightkit.command.install', return_value=self.root / 'hk.exe'), \
             patch.object(installer, 'install_client_integrations') as integrate:
            installer.setup(setup_fixture.options())
        self.state.packages.assert_called_once_with(client=True)
        integrate.assert_called_once_with(self.previous, self.previous, write_config=False)
        self.state.request.assert_not_awaited()
        self.assertEqual(self.state.path.read_bytes(), original)

    def test_installer_and_connect_failures_restore_connection_and_stopped_state(self):
        for entry in ('installer', 'local'):
            with self.subTest(entry=entry):
                lifecycle.stop()
                before = lifecycle.path().read_bytes()
                original = self.state.path.read_bytes()
                self.state.register.side_effect = RuntimeError('registration failed')
                with patch.object(runtime_env, 'prepare_env'), patch.object(services, 'start_local') as start, \
                     patch.object(services, 'stop') as stop, \
                     patch.object(services, 'require_local'), \
                     patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'local-key'}), \
                     contextlib.redirect_stderr(io.StringIO()):
                    if entry == 'installer':
                        self.assertEqual(installer.main(['--server', 'https://new.invalid', '--api-key-env', 'TEST_MEMORY_KEY']), 1)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'registration failed'):
                            remote.connect(remote_options(local=True))
                        start.assert_called_once()
                    stop.assert_called_once()
                self.assertEqual(self.state.path.read_bytes(), original)
                self.assertEqual(lifecycle.path().read_bytes(), before)
                self.assertFalse(lifecycle.available())

    def test_reconnecting_same_destination_preserves_running_mcp_epoch(self):
        lifecycle.connected()
        before = lifecycle.state()
        installer.setup_client(setup_fixture.options(server=self.previous['apiUrl']))
        self.assertEqual(lifecycle.state(), before)
        lifecycle.require_memory(connection_epoch=before['connection_epoch'])

    def test_share_rejects_bad_address_before_changing_services(self):
        with patch.object(services, 'require_local'), \
             patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'fixture'}), \
             patch.object(services, 'configure_sharing') as sharing, patch.object(services, 'start_local') as start:
            with self.assertRaises(ValueError):
                remote.share(remote_options(address='https://fixture.invalid/path'))
            sharing.assert_not_called()
            start.assert_not_called()

    def test_successful_share_resumes_the_local_memory_state(self):
        lifecycle.stop()
        with patch.object(services, 'require_local'), patch.object(services, 'start_local'), \
             patch.object(remote, 'copy_connection_code', return_value=True), \
             patch.object(services, 'profile_config', return_value=({'HINDSIGHT_API_HOST': '0.0.0.0'}, None)), \
             patch.object(connection, 'server_load', return_value={'apiUrl': 'http://127.0.0.1:9077', 'apiToken': 'fixture'}):
            remote.share(remote_options())
        self.assertFalse(lifecycle.state()['stopped'])

    def test_status_rejects_incompatible_discovery_without_writing_memory(self):
        for response in ({}, {'protocol': 2, 'routing': 'repository'},
                         {'protocol': 1, 'routing': 'repository', 'sharedBank': ''}):
            with self.subTest(response=response), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(connection, 'has_server', return_value=False), \
                 patch.object(connection, 'request', new_callable=AsyncMock, return_value=response), \
                 patch.object(services, 'check_memory') as memory:
                self.assertEqual(cli.main(['status', '--test-memory']), 1)
                memory.assert_not_called()

    def test_start_reports_relay_failure_consistently_for_both_roles(self):
        self.state.start.side_effect = self.start
        for has_server in (False, True):
            lifecycle.stop()
            with self.subTest(has_server=has_server), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(connection, 'has_server', return_value=has_server), \
                 patch.object(services, 'start_local'), \
                 patch.object(services, 'stop_profile_services') as stop_local, \
                 patch.object(remote, 'stop') as stop_remote, \
                 patch.object(remote, 'resume', side_effect=RuntimeError('login expired')), \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main(['start']), 1)
                self.assertTrue(lifecycle.state()['stopped'])
                if has_server:
                    stop_local.assert_called_once_with(database=True)
                else:
                    stop_remote.assert_called_once()

    def test_help_excludes_internal_entry_points_and_describes_user_commands(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            cli.main(['--help'])
        help_text = output.getvalue()
        for internal in ('mcp', 'hook', 'setup', 'copilot', 'check'):
            self.assertNotIn(internal, help_text)
        self.assertIn('Show local services', help_text)

    def test_empty_exception_message_still_reports_its_type(self):
        for error in (TimeoutError(), RuntimeError('   ')):
            with self.subTest(error=type(error).__name__), patch.object(runtime_env, 'prepare_env'), \
                 patch.object(remote, 'connect', side_effect=error), \
                 contextlib.redirect_stderr(io.StringIO()) as output:
                self.assertEqual(cli.main(['connect']), 1)
                self.assertEqual(output.getvalue().strip(), 'HindsightKit: ' + type(error).__name__)


if __name__ == '__main__':
    unittest.main()
