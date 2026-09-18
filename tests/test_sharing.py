import asyncio
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hindsight_api.extensions import HttpExtension, TenantExtension, load_extension
from hindsight_api.extensions.builtin.tenant import ApiKeyTenantExtension
from hindsight_api.extensions.tenant import AuthenticationError
from hindsight_api.models import RequestContext
from hindsight_embed.profile_manager import ProfileManager

from hindsightkit.platform import config as profile_env
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env
from hindsightkit.server import ClientsExtension


TOKEN = "synthetic-sharing-key"
TENANT_EXTENSION = "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension"
HTTP_EXTENSION = "hindsightkit.server:ClientsExtension"


class SharingConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "hindsightkit.env"
        self.paths = SimpleNamespace(config=self.path)
        self.path.write_text("# Keep this comment.\nHINDSIGHT_API_PORT=9077\n"
                             "HINDSIGHT_API_HOST=127.0.0.1\nHINDSIGHT_API_LLM_MODEL=existing-model\n"
                             "CUSTOM_SETTING=keep=this-value\n", encoding="utf-8")
        for patcher in [patch.object(profile_env, "profile_config", side_effect=self.profile),
                        patch.object(runtime_env, "home", return_value=self.root),
                        patch.object(runtime_env, "executable", return_value="fixture-hindsight-embed")]:
            patcher.start()
            self.addCleanup(patcher.stop)
        manager = patch("hindsight_embed.daemon_embed_manager.DaemonEmbedManager")
        self.manager = manager.start()
        self.addCleanup(manager.stop)
        self.manager.return_value.is_ui_running.return_value = True
        self.manager.return_value.is_running.side_effect = AssertionError('Stopping must not depend on API health')
        runner = patch.object(runtime_env, "run")
        self.run = runner.start()
        self.addCleanup(runner.stop)

    def profile(self):
        manager = ProfileManager.__new__(ProfileManager)
        with patch.object(manager, "resolve_profile_paths", return_value=self.paths):
            return manager.load_profile_config(runtime_env.PROFILE), self.paths

    def test_sharing_preserves_profile_and_enables_official_extensions(self):
        original = self.path.read_bytes()
        services.configure_sharing(TOKEN, "hindsightkit-shared")
        config, _ = self.profile()
        self.assertEqual(config["HINDSIGHT_API_HOST"], "0.0.0.0")
        self.assertEqual(config["HINDSIGHT_API_TENANT_EXTENSION"], TENANT_EXTENSION)
        self.assertEqual(config["HINDSIGHT_API_TENANT_API_KEY"], TOKEN)
        self.assertEqual(config["HINDSIGHT_API_HTTP_EXTENSION"], HTTP_EXTENSION)
        self.assertEqual(config["HINDSIGHT_API_HTTP_CLIENTS_FILE"], str(self.root / "clients.json"))
        self.assertEqual(config["HINDSIGHT_API_LLM_MODEL"], "existing-model")
        self.assertEqual(config["CUSTOM_SETTING"], "keep=this-value")
        self.assertEqual(config["HINDSIGHT_API_PORT"], "9077")
        self.assertTrue(self.path.read_text(encoding="utf-8").startswith("# Keep this comment.\n"))
        self.assertEqual(self.path.with_name("hindsightkit.env.hindsightkit-backup").read_bytes(), original)
        self.assertEqual(self.run.call_args_list, [
            call(["fixture-hindsight-embed", "--profile", runtime_env.PROFILE, "ui", "stop"]),
        ])
        self.manager.return_value.stop.assert_called_once_with(runtime_env.PROFILE)
        self.manager.return_value.is_running.assert_not_called()
        self.assertFalse((self.root / "clients.json").exists())

    def test_repeating_sharing_does_not_stop_services_or_rewrite_config(self):
        services.configure_sharing(TOKEN, "hindsightkit-shared")
        original = self.path.read_bytes()
        self.manager.reset_mock()
        self.run.reset_mock()
        with patch.object(runtime_env, "backup") as backup:
            services.configure_sharing(TOKEN, "hindsightkit-shared")
        self.manager.assert_not_called()
        self.run.assert_not_called()
        backup.assert_not_called()
        self.assertEqual(self.path.read_bytes(), original)

    def test_stopped_dashboard_is_not_restarted_or_stopped_but_api_stop_is_attempted(self):
        self.manager.return_value.is_ui_running.return_value = False
        services.configure_sharing(TOKEN, "hindsightkit-shared")
        self.run.assert_not_called()
        self.manager.return_value.stop.assert_called_once_with(runtime_env.PROFILE)
        self.manager.return_value.is_running.assert_not_called()
        self.assertEqual(self.profile()[0]["HINDSIGHT_API_HOST"], "0.0.0.0")

    def test_conflicting_extensions_and_mcp_auth_reject_before_service_changes(self):
        original = self.path.read_text(encoding="utf-8")
        conflicts = [("HINDSIGHT_API_TENANT_EXTENSION", "another.module:Tenant"),
                     ("HINDSIGHT_API_HTTP_EXTENSION", "another.module:Http"),
                     ("HINDSIGHT_API_MCP_AUTH_TOKEN", "different-key"),
                     ("HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED", "true"),
                     ("HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED", "1"),
                     ("HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED", "YES")]
        for name, value in conflicts:
            with self.subTest(name=name, value=value):
                self.path.write_text(original + name + "=" + value + "\n", encoding="utf-8")
                before = self.path.read_bytes()
                with self.assertRaises(RuntimeError):
                    services.configure_sharing(TOKEN, "hindsightkit-shared")
                self.assertEqual(self.path.read_bytes(), before)
        self.manager.assert_not_called()
        self.run.assert_not_called()
        self.assertFalse(self.path.with_name("hindsightkit.env.hindsightkit-backup").exists())

class OfficialExtensionTests(unittest.TestCase):
    def test_official_api_key_extension_authenticates_rest_and_mcp_with_same_key(self):
        config = {"HINDSIGHT_API_TENANT_EXTENSION": TENANT_EXTENSION,
                  "HINDSIGHT_API_TENANT_API_KEY": TOKEN,
                  "HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED": "false"}
        with patch.dict(os.environ, config, clear=True):
            extension = load_extension("TENANT", TenantExtension)
        self.assertIsInstance(extension, ApiKeyTenantExtension)
        for method in [extension.authenticate, extension.authenticate_mcp]:
            with self.subTest(method=method.__name__):
                with patch("hindsight_api.extensions.builtin.tenant.get_config",
                           return_value=SimpleNamespace(database_schema="fixture_schema")):
                    result = asyncio.run(method(RequestContext(api_key=TOKEN)))
                self.assertEqual(result.schema_name, "fixture_schema")
                for key in [None, "", "wrong", "Bearer " + TOKEN]:
                    with self.subTest(key=key), self.assertRaises(AuthenticationError):
                        asyncio.run(method(RequestContext(api_key=key)))

    def test_official_loader_mounts_clients_extension_with_temporary_inventory(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "clients.json"
            config = {"HINDSIGHT_API_HTTP_EXTENSION": HTTP_EXTENSION,
                      "HINDSIGHT_API_HTTP_CLIENTS_FILE": str(path),
                      "HINDSIGHT_API_TENANT_API_KEY": TOKEN}
            with patch.dict(os.environ, config):
                extension = load_extension("HTTP", HttpExtension)
                self.assertIsInstance(extension, ClientsExtension)
                self.assertEqual(extension.config["clients_file"], str(path))
                app = FastAPI()
                app.include_router(extension.get_router(None), prefix="/ext")
                with TestClient(app) as client:
                    self.assertEqual(client.get("/ext/hindsightkit/clients").status_code, 401)
                    headers = {"Authorization": "Bearer " + TOKEN}
                    result = client.post("/ext/hindsightkit/clients", headers=headers, json={
                        "deviceId": str(uuid4()), "name": "Loader fixture", "clients": ["vscode"]})
                    self.assertEqual(result.status_code, 200)
                    result = client.get("/ext/hindsightkit/clients", headers=headers)
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.json()["devices"][0]["name"], "Loader fixture")
            self.assertTrue(path.is_file())


if __name__ == "__main__":
    unittest.main()
