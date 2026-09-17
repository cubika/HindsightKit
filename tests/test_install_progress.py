import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from hindsightkit import install_progress


class InstallProgressTests(unittest.TestCase):
    def test_silent_process_reports_heartbeats_then_completion(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            install_progress.run_install([sys.executable, "-c", "import time; time.sleep(0.3)"],
                cwd=directory, label="test dependencies", heartbeat_seconds=0.05)
        recorded = output.getvalue()
        self.assertIn("Starting test dependencies...", recorded)
        self.assertGreaterEqual(recorded.count("Still installing test dependencies"), 2)
        self.assertIn("Completed test dependencies (elapsed", recorded)
        self.assertNotIn("%", recorded)

    def test_stdout_and_stderr_stream_before_process_finishes_and_log_appends(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "install.log"
            log.write_text("earlier stage\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                install_progress.run_install([sys.executable, "-u", "-c",
                    "import sys,time; print('first output'); time.sleep(0.25); print('last output',file=sys.stderr)"],
                    cwd=directory, label="test packages", log_path=log, heartbeat_seconds=0.05)
            recorded = output.getvalue()
            heartbeat = recorded.index("Still installing", recorded.index("first output"))
            self.assertLess(heartbeat, recorded.index("last output"))
            self.assertLess(recorded.index("last output"), recorded.index("Completed"))
            self.assertEqual(log.read_text(encoding="utf-8"), "earlier stage\n" + recorded)

    def test_nonzero_exit_preserves_first_error_and_last_output(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "failure.log"
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(install_progress.InstallError) as failure:
                install_progress.run_install([sys.executable, "-u", "-c",
                    "import sys; print('npm error code ETIMEDOUT'); [print('detail '+str(i)) for i in range(12)]; sys.exit(17)"],
                    cwd=directory, label="npm test", log_path=log)
            message = str(failure.exception)
            self.assertEqual(failure.exception.returncode, 17)
            self.assertIn("First error: npm error code ETIMEDOUT", message)
            self.assertIn("detail 11", message)
            self.assertNotIn("detail 0\n", message)
            self.assertIn(str(Path(directory).resolve()), message)
            self.assertIn(str(log), message)
            self.assertIn("exit 17", message)
            self.assertIn("detail 0\n", log.read_text(encoding="utf-8"))
            self.assertNotIn("Completed", message)

    def test_credentials_are_redacted_in_console_log_and_error(self):
        lines = [
            "npm error GET https://user:password@registry.example.test/package?token=query-secret&other=value",
            "Authorization: Bearer bearer-secret",
            "_authToken=npm-secret",
            '"password": "quoted secret"',
            "https://registry.example.test/file#fragment-secret",
            "raw npm_ABCdef012 ghp_XYz987 github_pat_123abc",
            "\x1b[31maccess_token=ansi-secret\x1b[0m",
            "Basic dXNlcjpwYXNz",
        ]
        secrets = ("user:password", "query-secret", "bearer-secret", "npm-secret",
                   "quoted secret", "fragment-secret", "npm_ABCdef012", "ghp_XYz987",
                   "github_pat_123abc", "ansi-secret", "dXNlcjpwYXNz")
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "redacted.log"
            with patch.dict(os.environ, {"HINDSIGHTKIT_INSTALL_LOG": str(log)}), \
                    contextlib.redirect_stdout(io.StringIO()) as output, \
                    self.assertRaises(install_progress.InstallError) as failure:
                install_progress.run_install([sys.executable, "-u", "-c",
                    "import sys; " + "; ".join("print(" + repr(line) + ")" for line in lines) + "; sys.exit(1)"],
                    cwd=directory, label="npm dependencies")
            for recorded in (output.getvalue(), log.read_text(encoding="utf-8"), str(failure.exception)):
                for secret in secrets:
                    self.assertNotIn(secret, recorded)
                self.assertIn("registry.example.test/package", recorded)
                self.assertIn("[REDACTED]", recorded)

    def test_tls_failure_explains_retry_even_when_error_has_left_the_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "tls.log"
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(install_progress.InstallError) as failure:
                install_progress.run_install([sys.executable, "-u", "-c",
                    "import sys; print('npm error earlier failure'); "
                    "print('npm http fetch attempt 1 failed with ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE'); "
                    "[print('detail '+str(i)) for i in range(12)]; sys.exit(1)"],
                    cwd=directory, label="npm dependencies", log_path=log)
            for recorded in (str(failure.exception), log.read_text(encoding="utf-8")):
                self.assertIn("registry, proxy, and CA settings", recorded)
                self.assertIn("NODE_EXTRA_CA_CERTS", recorded)
                self.assertIn("no uninstall or npm cache cleanup", recorded)
                self.assertIn("Keep certificate verification enabled", recorded)

    def test_recovered_tls_retry_does_not_report_installation_failure(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            install_progress.run_install([sys.executable, "-c",
                "print('npm http fetch attempt 1 failed with ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE')"],
                cwd=directory, label="npm dependencies")
        self.assertIn("Completed npm dependencies", output.getvalue())
        self.assertNotIn("Check the registry", output.getvalue())

    def test_spawn_failure_is_explained_and_logged_without_command_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "failure.log"
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(install_progress.InstallError) as failure:
                install_progress.run_install([str(Path(directory) / "missing-tool.exe"), "unused-secret-argument"],
                    cwd=directory, label="npm dependencies", log_path=log)
            self.assertIsNone(failure.exception.returncode)
            self.assertIn("could not start", str(failure.exception))
            self.assertNotIn("unused-secret-argument", log.read_text(encoding="utf-8"))

    def test_invalid_heartbeat_does_not_start_a_process(self):
        for interval in (0, -1, float("nan"), float("inf")):
            with self.subTest(interval=interval), patch.object(subprocess, "Popen") as start:
                with self.assertRaises(ValueError):
                    install_progress.run_install(["unused"], cwd=".", label="test", heartbeat_seconds=interval)
                start.assert_not_called()

    def test_keyboard_interrupt_stops_only_the_process_it_started(self):
        native_popen = subprocess.Popen
        command = [sys.executable, "-c", "import time; time.sleep(30)"]
        unrelated = native_popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        owned = []
        def spawn(*args, **kwargs):
            process = native_popen(*args, **kwargs)
            owned.append(process)
            return process
        try:
            with tempfile.TemporaryDirectory() as directory:
                log = Path(directory) / "interrupted.log"
                with patch.object(install_progress.subprocess, "Popen", side_effect=spawn), \
                        patch.object(install_progress.queue.Queue, "get", side_effect=KeyboardInterrupt), \
                        contextlib.redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
                    install_progress.run_install(command, cwd=directory, label="test packages", log_path=log)
                self.assertEqual(len(owned), 1)
                self.assertIsNotNone(owned[0].poll())
                self.assertIsNone(unrelated.poll())
                self.assertIn("Interrupted test packages", log.read_text(encoding="utf-8"))
        finally:
            for process in [*owned, unrelated]:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
