import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from hindsightkit import hooks
from hindsightkit.platform import lifecycle
from hindsightkit.memory.api import Scope, scope_for


class SessionCaptureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo, self.other = self.root / "repo", self.root / "other"
        for directory in (self.repo, self.other):
            directory.mkdir()
            subprocess.run(["git", "init", str(directory)], check=True, capture_output=True)
        self.config_path = self.root / "client.json"
        self.config = {"apiUrl": "https://first.example.invalid", "apiToken": "fixture",
                       "hindsightkit": {"mode": "client", "routing": "repository", "deviceId": "fixture"}}
        self.write_config()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HINDSIGHTKIT_HOME": str(self.root / "state"),
                                "HINDSIGHT_CONFIG": str(self.config_path),
                                "HINDSIGHT_DISABLE_HOOKS": ""}).start()
        patch("hindsightkit.sharing.remote.prepare_client").start()
        self.resolve = patch.object(hooks, "resolve", new_callable=AsyncMock).start()
        self.resolve.side_effect = lambda config, scope: Scope(
            "second" if "second" in config["apiUrl"] else "first", scope.repository)
        patch.object(hooks, "prompt_memory", new_callable=AsyncMock, return_value={"memories": []}).start()
        self.runtime = patch.object(hooks, "runtime", return_value=self.root / "runtime").start()
        patch.object(hooks, "node", return_value="fixture-node").start()
        original_run = subprocess.run
        self.saved = []

        def run(arguments, **options):
            if arguments[0] == "fixture-node":
                self.saved.append(json.loads(Path(options["env"]["HINDSIGHT_CONFIG"]).read_text()))
                return SimpleNamespace(returncode=0, stderr="")
            return original_run(arguments, **options)

        patch.object(hooks.subprocess, "run", side_effect=run).start()

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config))

    def hook(self, name, session="session", directory=None):
        event = {"sessionId": session, "cwd": str(directory or self.repo), "prompt": "fixture",
                 "transcriptPath": str(self.root / "transcript.jsonl")}
        with patch("sys.stdin", io.StringIO(json.dumps(event))), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            hooks.run(name)

    def record_path(self, session="session"):
        return self.root / "state/sessions" / (hashlib.sha256(session.encode()).hexdigest() + ".json")

    def record(self, session="session"):
        return json.loads(self.record_path(session).read_text())

    def assert_epochs_unchanged(self, before, after):
        for key in ("_capture_epoch", "_service_epoch", "_connection_epoch"):
            self.assertEqual(before[key], after[key], key)

    def test_server_switch_and_return_preserve_repository_and_never_backfill(self):
        self.hook("sessionStart")
        self.hook("userPromptTransformed")
        original = self.record()
        for server in ("second", "first"):
            self.config["apiUrl"] = f"https://{server}.example.invalid"
            self.write_config()
            # Even a missing connection-epoch rotation cannot reauthorize the
            # transcript when destination changes are observed by the hooks.
            self.hook("userPromptTransformed", directory=self.other)
            self.hook("sessionStart", directory=self.other)
            self.hook("agentStop", directory=self.other)
            current = self.record()
            self.assertEqual(current["bankId"], server)
            self.assertEqual(current["_directory"], original["_directory"])
            self.assertEqual(current["_memory_repository"], original["_memory_repository"])
            self.assertEqual(current["_local_bank"], original["_local_bank"])
            self.assert_epochs_unchanged(original, current)
            self.assertFalse(current["_capture_allowed"])
        self.assertEqual(len(list(self.record_path().parent.glob("*.json"))), 1)
        for call in self.resolve.call_args_list:
            self.assertEqual(call.args[1], scope_for(self.repo))
        self.runtime.assert_not_called()
        self.hook("sessionStart", "fresh")
        self.hook("agentStop", "fresh")
        self.assertEqual(len(self.saved), 1)

    def test_stop_start_and_disconnect_reconnect_do_not_resume_old_capture(self):
        for action, suspend, resume in (("stop", lifecycle.stop, lifecycle.start),
                                        ("disconnect", lifecycle.disconnect, lifecycle.connected)):
            with self.subTest(action=action):
                before, during, after = action + "-before", action + "-during", action + "-after"
                self.hook("sessionStart", before)
                original = self.record(before)
                suspend()
                self.hook("sessionStart", during)
                self.hook("agentStop", before)
                resume()
                self.hook("sessionStart", before)
                self.hook("agentStop", before)
                self.hook("agentStop", during)
                self.assert_epochs_unchanged(original, self.record(before))
                self.assertIsNone(self.record(during)["_service_epoch"])
                self.assertFalse(self.saved)
                self.hook("sessionStart", after)
                self.hook("agentStop", after)
                self.assertEqual(len(self.saved), 1)
                self.saved.clear()

    def test_missing_start_record_is_never_authorized_by_a_late_start(self):
        for first_event in ("agentStop", "userPromptTransformed"):
            with self.subTest(first_event=first_event):
                self.hook(first_event, first_event)
                self.assertFalse(self.record(first_event)["_capture_allowed"])
                self.hook("sessionStart", first_event)
                self.hook("agentStop", first_event)
                self.assertFalse(self.record(first_event)["_capture_allowed"])
        self.runtime.assert_not_called()

    def test_lost_or_legacy_record_cannot_backfill_after_reconnect(self):
        self.hook("sessionStart", "lost")
        self.record_path("lost").unlink()
        self.hook("sessionStart", "legacy")
        legacy = self.record("legacy")
        for key in ("_capture_allowed", "_connection_epoch", "_local_bank"):
            legacy.pop(key)
        self.record_path("legacy").write_text(json.dumps(legacy))
        lifecycle.disconnect()
        lifecycle.connected()
        for session in ("lost", "legacy"):
            self.hook("agentStop", session)
            self.assertFalse(self.record(session)["_capture_allowed"])
        self.runtime.assert_not_called()

    def test_token_refresh_and_duplicate_start_preserve_fresh_capture_and_scope(self):
        lifecycle.connected()
        self.hook("sessionStart")
        self.hook("userPromptTransformed")
        original = self.record()
        self.config["apiToken"] = "rotated-fixture"
        self.config["apiUrl"] += "/"
        self.write_config()
        self.hook("sessionStart", directory=self.other)
        self.hook("userPromptTransformed", directory=self.other)
        self.hook("agentStop", directory=self.other)
        self.assertEqual(len(self.saved), 1)
        self.assert_epochs_unchanged(original, self.saved[0])
        self.assertEqual(self.saved[0]["_directory"], original["_directory"])
        self.assertEqual(self.saved[0]["bankId"], original["bankId"])
        self.assertEqual(self.saved[0]["apiToken"], "rotated-fixture")
        self.resolve.assert_awaited_once()

    def test_connection_epoch_change_alone_blocks_capture_after_return_to_same_server(self):
        lifecycle.connected()
        self.hook("sessionStart")
        original = self.record()
        lifecycle.update(connection_epoch="different-connection")
        self.hook("sessionStart")
        self.hook("agentStop")
        self.assert_epochs_unchanged(original, self.record())
        self.runtime.assert_not_called()


if __name__ == "__main__":
    unittest.main()
