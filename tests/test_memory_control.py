import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastmcp.exceptions import ToolError

from hindsightkit import cli, runtime as runtime_env, hooks, mcp, memory_control as control
from hindsightkit.memory import Scope


class RepositoryMemoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.other = self.root / "other"
        for directory in (self.repo, self.other):
            directory.mkdir()
            runtime_env.run(["git", "init", directory], capture=True)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"HINDSIGHTKIT_HOME": str(self.root / "state"),
                                "HINDSIGHT_DISABLE_HOOKS": "", "COPILOT_AGENT_SESSION_ID": ""}).start()

    def command(self, action, directory=None):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            control.command(action, directory or self.repo)
        return output.getvalue()

    def hook(self, name, session="session", directory=None):
        event = {"sessionId": session, "cwd": str(directory or self.repo),
                 "prompt": "Fixture request", "transcriptPath": str(self.root / "transcript.jsonl")}
        with patch("sys.stdin", io.StringIO(json.dumps(event))), contextlib.redirect_stdout(io.StringIO()):
            hooks.run(name)

    def configure_hooks(self):
        config = self.root / "coding-agent.json"
        config.write_text(json.dumps({"apiUrl": "https://memory.example.invalid",
                                     "hindsightkit": {"routing": "repository", "deviceId": "fixture"}}))
        patch.dict(os.environ, {"HINDSIGHT_CONFIG": str(config)}).start()
        return config

    def test_cli_switch_is_local_shared_with_worktrees_and_ignores_git_environment(self):
        runtime_env.run(["git", "-C", self.repo, "-c", "user.name=Fixture", "-c",
                 "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], capture=True)
        worktree = self.root / "worktree"
        runtime_env.run(["git", "-C", self.repo, "worktree", "add", "-b", "fixture", worktree], capture=True)
        subdirectory = worktree / "sub"
        subdirectory.mkdir()
        with patch("hindsightkit.runtime.prepare_env"), patch("hindsightkit.memory_control.Path.cwd", return_value=subdirectory), \
             patch.dict(os.environ, {"GIT_DIR": str(self.other / ".git"), "GIT_CONFIG_COUNT": "1",
                                     "GIT_CONFIG_KEY_0": control.ENABLED, "GIT_CONFIG_VALUE_0": "true"}), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(["memory", "off"]), 0)
            self.assertEqual(cli.main(["memory", "status"]), 0)
            self.assertIn("memory: off", output.getvalue())
        self.assertFalse(control.state(str(self.repo)).enabled)
        self.assertTrue(control.state(str(self.other)).enabled)
        self.command("on", worktree)
        self.assertTrue(control.state(str(self.repo)).enabled)
        epoch = control.state(str(self.repo)).capture_epoch
        self.command("on")
        self.assertEqual(control.state(str(self.repo)).capture_epoch, epoch)
        self.assertEqual(runtime_env.run(["git", "-C", self.repo, "status", "--porcelain"], capture=True), "")

    def test_outside_git_and_invalid_config_fail_without_changing_other_scopes(self):
        for action in ("on", "off", "status"):
            with self.assertRaisesRegex(ValueError, "inside a Git repository"):
                self.command(action, self.root)
        control.git(self.repo, "config", "--local", control.ENABLED, "invalid")
        with self.assertRaisesRegex(ValueError, "Invalid repository"):
            control.state(str(self.repo))
        self.command("off")
        self.assertFalse(control.state(str(self.repo)).enabled)
        self.assertTrue(control.state(None).enabled)

    def test_git_boolean_empty_and_bare_values_have_distinct_meanings(self):
        path = self.repo / ".git/config"
        original = path.read_text()
        for setting, expected in [("enabled =", False), ("enabled", True),
                                  ("enabled = 0", False), ("enabled = 1", True)]:
            path.write_text(original + "\n[hindsightkit \"memory\"]\n    " + setting + "\n")
            self.assertEqual(control.state(str(self.repo)).enabled, expected)

    def test_disabled_hooks_never_prepare_transport_resolve_or_save_and_pin_original_repo(self):
        self.configure_hooks()
        self.command("off")
        with patch("hindsightkit.remote.prepare_client") as prepare, \
             patch("hindsightkit.hooks.resolve", new_callable=AsyncMock) as resolve, \
             patch("hindsightkit.hooks.prompt_memory", new_callable=AsyncMock) as recall, \
             patch("hindsightkit.hooks.runtime") as runtime:
            self.hook("sessionStart")
            self.hook("userPromptTransformed", directory=self.other)
            self.hook("agentStop", directory=self.other)
            for operation in (prepare, resolve, recall, runtime):
                operation.assert_not_called()
        record = json.loads(next((self.root / "state/sessions").glob("*.json")).read_text())
        self.assertTrue(Path(record["_memory_repository"]).samefile(self.repo))
        self.assertTrue(record["_scope_pending"])

    def test_off_on_never_backfills_old_transcript_but_new_session_can_use_official_hook(self):
        self.configure_hooks()
        with patch("hindsightkit.remote.prepare_client"), \
             patch("hindsightkit.hooks.resolve", new_callable=AsyncMock, return_value=Scope("resolved", str(self.repo))), \
             patch("hindsightkit.hooks.prompt_memory", new_callable=AsyncMock, return_value={"memories": []}) as recall, \
             patch("hindsightkit.hooks.runtime", return_value=self.root / "runtime") as runtime, \
             patch("hindsightkit.hooks.node", return_value="node"):
            self.hook("sessionStart")
            self.hook("userPromptTransformed")
            self.command("off")
            self.command("on")
            self.hook("userPromptTransformed")
            self.assertEqual(recall.await_count, 2)
            with contextlib.redirect_stderr(io.StringIO()) as message:
                self.hook("agentStop")
            self.assertIn("new Copilot session", message.getvalue())
            runtime.assert_not_called()
            self.hook("sessionStart", session="fresh")
            # Session scope is pinned already, so this patch affects only the
            # official stop subprocess; Git settings remain real in this test.
            original = hooks.subprocess.run
            calls = []
            def run(arguments, **options):
                if arguments[0] == "node":
                    calls.append((arguments, options))
                    return SimpleNamespace(returncode=0, stderr="")
                return original(arguments, **options)
            with patch("hindsightkit.hooks.subprocess.run", side_effect=run):
                self.hook("agentStop", session="fresh")
            self.assertEqual(len(calls), 1)
            self.assertTrue(calls[0][0][1].endswith("copilot-stop-hook.js"))

    def test_session_started_while_off_resolves_on_demand_but_never_saves_old_transcript(self):
        self.configure_hooks()
        self.command("off")
        self.hook("sessionStart")
        self.command("on")
        with patch("hindsightkit.remote.prepare_client"), \
             patch("hindsightkit.hooks.resolve", new_callable=AsyncMock, return_value=Scope("resolved", str(self.repo))) as resolve, \
             patch("hindsightkit.hooks.prompt_memory", new_callable=AsyncMock, return_value={"memories": []}) as recall, \
             patch("hindsightkit.hooks.runtime") as runtime:
            self.hook("userPromptTransformed", directory=self.other)
            resolve.assert_awaited_once()
            self.assertEqual(recall.call_args.args[0]["bankId"], "resolved")
            self.assertTrue(Path(recall.call_args.args[0]["_memory_repository"]).samefile(self.repo))
            with contextlib.redirect_stderr(io.StringIO()):
                self.hook("agentStop")
            runtime.assert_not_called()

    def test_mcp_uses_existing_session_repository_after_cli_directory_changes(self):
        self.configure_hooks()
        self.hook("sessionStart")
        self.command("off")
        async def check():
            server = mcp.FastMCP("Pinned session toggle fixture")
            with patch.dict(os.environ, {"COPILOT_AGENT_SESSION_ID": "session"}), \
                 patch.object(mcp.connection, "sdk") as sdk, \
                 patch.object(mcp, "FastMCP", return_value=server), patch.object(mcp, "run_stdio"):
                mcp.serve("cli", str(self.other))
                with self.assertRaisesRegex(ToolError, "disabled for this repository"):
                    await server.call_tool("recall", {"query": "Fixture query"})
                sdk.assert_not_called()
        asyncio.run(check())

    def test_all_mcp_tools_honor_live_toggle_without_network_while_off(self):
        async def check():
            config = {"apiUrl": "https://memory.example.invalid",
                      "hindsightkit": {"routing": "repository", "connectors": ["workiq"]}}
            result = SimpleNamespace(model_dump=lambda **kwargs: {"results": []})
            client = SimpleNamespace(aretain=AsyncMock(return_value=result), arecall=AsyncMock(return_value=result),
                                     areflect=AsyncMock(return_value=result), aclose=AsyncMock())
            server = mcp.FastMCP("Toggle fixture")
            self.command("off")
            with patch.object(mcp.connection, "load", return_value=config), \
                 patch.object(mcp.connection, "sdk", return_value=client) as sdk, \
                 patch.object(mcp, "resolve", new_callable=AsyncMock, return_value=Scope("resolved", str(self.repo))) as resolve, \
                 patch("hindsightkit.remote.prepare_client") as prepare, \
                 patch.object(mcp, "FastMCP", return_value=server), patch.object(mcp, "run_stdio"):
                mcp.serve("cli", str(self.repo))
                calls = {"retain": {"content": "Fixture fact"}, "recall": {"query": "Fixture query"},
                         "reflect": {"query": "Fixture query"}, "recall_mail": {"query": "Fixture mail"}}
                for name, arguments in calls.items():
                    with self.assertRaisesRegex(ToolError, "disabled for this repository"):
                        await server.call_tool(name, arguments)
                sdk.assert_not_called()
                prepare.assert_not_called()
                resolve.assert_not_called()
                self.command("on")
                for name, arguments in calls.items():
                    await server.call_tool(name, arguments)
                resolve.assert_awaited_once()
                self.assertTrue(client.aretain.called)
                sdk.reset_mock(); prepare.reset_mock()
                self.command("off")
                for name, arguments in calls.items():
                    with self.assertRaisesRegex(ToolError, "disabled for this repository"):
                        await server.call_tool(name, arguments)
                sdk.assert_not_called()
                prepare.assert_not_called()
        asyncio.run(check())

    def test_fixed_bank_mcp_still_respects_local_repository_switch(self):
        async def check():
            config = {"apiUrl": "https://memory.example.invalid", "hindsightkit": {"bank": "fixed"}}
            server = mcp.FastMCP("Fixed bank toggle fixture")
            self.command("off")
            with patch.object(mcp.connection, "load", return_value=config), \
                 patch.object(mcp.connection, "sdk") as sdk, \
                 patch.object(mcp, "FastMCP", return_value=server), patch.object(mcp, "run_stdio"):
                mcp.serve("cli", str(self.repo))
                with self.assertRaisesRegex(ToolError, "disabled for this repository"):
                    await server.call_tool("retain", {"content": "Fixture fact"})
                sdk.assert_not_called()
        asyncio.run(check())
