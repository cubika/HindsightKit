import asyncio
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import aiohttp
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hindsight_client_api.exceptions import ApiException

from hindsightkit import connection
from hindsightkit.server import Activity, ClientsExtension, Inventory, MAX_DEVICES


TOKEN = "synthetic-test-key"
HEADERS = {"Authorization": "Bearer " + TOKEN}
CLIENTS_PATH = "/ext/hindsightkit/clients"


def activity(device=None, **changes):
    return {"deviceId": device or str(uuid4()), "name": "Test Dev Box",
            "clients": ["vscode", "copilot-cli"], "used": False, **changes}


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "clients.json"
        self.inventory = Inventory(self.path)
        env = patch.dict(os.environ, {"HINDSIGHT_API_TENANT_API_KEY": TOKEN})
        env.start()
        self.addCleanup(env.stop)
        app = FastAPI()
        extension = ClientsExtension({"clients_file": str(self.path)})
        app.include_router(extension.get_router(None), prefix="/ext")
        self.http = TestClient(app)
        self.addCleanup(self.http.close)

    def test_get_and_post_require_authentication(self):
        body = activity()
        for headers in [{}, {"Authorization": "Bearer wrong"},
                        {"Authorization": TOKEN}, {"Authorization": "Basic " + TOKEN}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.http.get(CLIENTS_PATH, headers=headers).status_code, 401)
                self.assertEqual(self.http.post(CLIENTS_PATH, headers=headers, json=body).status_code, 401)
        self.assertFalse(self.path.exists())
        with patch.dict(os.environ, {"HINDSIGHT_API_TENANT_API_KEY": ""}):
            self.assertEqual(self.http.get(CLIENTS_PATH, headers=HEADERS).status_code, 401)
            self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS, json=body).status_code, 401)

    def test_registration_is_idempotent_and_keeps_two_clients_per_device(self):
        first = activity(name="Dev Box A")
        second = activity(name="Dev Box B")
        for body in [first, second]:
            self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS, json=body).status_code, 200)
        original = self.path.read_bytes()
        for body in [first, second, first]:
            self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS, json=body).status_code, 200)
        self.assertEqual(self.path.read_bytes(), original)
        response = self.http.get(CLIENTS_PATH, headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        snapshot = response.json()
        self.assertEqual(snapshot["recentSeconds"], 300)
        self.assertEqual(len(snapshot["devices"]), 2)
        for device in snapshot["devices"]:
            self.assertEqual({client["kind"] for client in device["clients"]}, {"vscode", "copilot-cli"})
            self.assertTrue(all(client["lastUsed"] is None and not client["recent"]
                                for client in device["clients"]))
        used = {**first, "clients": ["vscode"], "used": True}
        self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS, json=used).status_code, 200)
        devices = {item["deviceId"]: item for item in self.http.get(CLIENTS_PATH, headers=HEADERS).json()["devices"]}
        clients = {item["kind"]: item for item in devices[first["deviceId"]]["clients"]}
        self.assertTrue(clients["vscode"]["recent"])
        self.assertIsNone(clients["copilot-cli"]["lastUsed"])
        self.assertTrue(all(item["lastUsed"] is None for item in devices[second["deviceId"]]["clients"]))

    def test_recent_means_last_use_within_five_minutes_not_registration(self):
        body = activity(clients=["vscode"])
        self.inventory.update(Activity(**body), now=1000)
        self.assertFalse(self.inventory.snapshot(now=1000)["devices"][0]["clients"][0]["recent"])
        self.inventory.update(Activity(**{**body, "used": True}), now=1100)
        for now, expected in [(1099, False), (1100, True), (1400, True), (1400.001, False)]:
            with self.subTest(now=now):
                item = self.inventory.snapshot(now=now)["devices"][0]["clients"][0]
                self.assertEqual(item["recent"], expected)
                self.assertEqual(item["lastUsed"], 1100)
                self.assertEqual(item["registeredAt"], 1000)
        self.inventory.update(Activity(**body), now=1500)
        self.assertFalse(self.inventory.snapshot(now=1500)["devices"][0]["clients"][0]["recent"])

    def test_activity_limits_reject_bad_inputs_without_mutating_inventory(self):
        body = activity()
        invalid = [{"deviceId": "not-a-uuid"}, {"name": ""}, {"name": "x" * 81},
                   {"name": "bad\nname"}, {"name": "bad\x00name"}, {"name": "bad\x7fname"},
                   {"clients": []}, {"clients": ["unknown"]},
                   {"clients": ["vscode", "copilot-cli", "vscode"]}]
        for changes in invalid:
            with self.subTest(changes=changes):
                response = self.http.post(CLIENTS_PATH, headers=HEADERS, json={**body, **changes})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS,
                                       json={**body, "name": "x" * 80}).status_code, 200)

    def test_capacity_rejects_new_devices_but_allows_existing_device_updates(self):
        for index in range(MAX_DEVICES):
            self.inventory.update(Activity(**activity(str(UUID(int=index + 1)))), now=1000)
        before = self.path.read_bytes()
        response = self.http.post(CLIENTS_PATH, headers=HEADERS, json=activity())
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.path.read_bytes(), before)
        existing = activity(str(UUID(int=1)), name="Renamed Dev Box", clients=["vscode"], used=True)
        self.assertEqual(self.http.post(CLIENTS_PATH, headers=HEADERS, json=existing).status_code, 200)
        self.assertEqual(len(self.inventory.snapshot()["devices"]), MAX_DEVICES)
        self.assertEqual(self.inventory.read()[existing["deviceId"]]["name"], "Renamed Dev Box")

    def test_oversized_inventory_is_rejected_before_loading(self):
        self.path.write_text(" " * (256 * 1024 + 1), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "size limit"):
            self.inventory.snapshot()


class _MemoryHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond()

    def do_POST(self):
        self.respond()

    def respond(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append({"method": self.command, "path": self.path,
                                     "authorization": self.headers.get("Authorization"),
                                     "body": json.loads(raw) if raw else None})
        status = 200
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            status, body = 401, {"detail": "Invalid API key"}
        elif self.path == "/redirect":
            status, body = 307, {"detail": "Redirect"}
        elif self.path.endswith("/memories/recall"):
            body = {"results": [{"id": "synthetic-memory", "text": "Fixture response"}]}
        else:
            body = {"ok": True}
        payload = json.dumps(body).encode()
        self.send_response(status)
        if status == 307:
            self.send_header("Location", "/redirect-target")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class _Forwarder(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            with socket.create_connection(self.server.destination, timeout=3) as upstream:
                sockets = [self.request, upstream]
                while True:
                    readable, _, _ = select.select(sockets, [], [], 3)
                    if not readable:
                        return
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        target = upstream if source is self.request else self.request
                        target.sendall(data)
        except OSError:
            return


@contextmanager
def running(server):
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    worker.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_address[1])
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        if worker.is_alive():
            raise RuntimeError("Fixture server did not stop.")


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
                                     "http_proxy": "", "https_proxy": "", "all_proxy": "",
                                     "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
        env.start()
        self.addCleanup(env.stop)

    def test_direct_http_and_tcp_forwarding_preserve_request_and_sdk_bearer(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _MemoryHandler)
        server.requests = []
        with running(server) as direct:
            forwarder = _Forwarder(("127.0.0.1", 0), _ForwardHandler)
            forwarder.destination = server.server_address
            with running(forwarder) as forwarded:
                for url in [direct, forwarded]:
                    with self.subTest(url=url):
                        config = {"apiUrl": url, "apiToken": TOKEN}
                        result = asyncio.run(connection.request(config, "POST", "/echo", body={"value": 7}))
                        self.assertEqual(result, {"ok": True})
                        response = asyncio.run(self.recall(config))
                        self.assertEqual(response.results[0].text, "Fixture response")
        self.assertEqual(len(server.requests), 4)
        for entry in server.requests:
            self.assertEqual(entry["authorization"], "Bearer " + TOKEN)
        self.assertEqual(server.requests[0]["body"], {"value": 7})
        self.assertEqual(server.requests[1]["path"], "/v1/default/banks/test-bank/memories/recall")
        self.assertEqual(server.requests[3]["body"]["query"], "Fixture query")

    @staticmethod
    async def recall(config):
        client = connection.sdk(config, timeout=2, max_attempts=1)
        try:
            return await client.arecall(bank_id="test-bank", query="Fixture query")
        finally:
            await client.aclose()

    def test_wrong_authentication_fails_for_request_and_sdk(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _MemoryHandler)
        server.requests = []
        with running(server) as url:
            for token in [None, "wrong"]:
                with self.subTest(token=token):
                    config = {"apiUrl": url, "apiToken": token}
                    with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                        asyncio.run(connection.request(config, "GET", "/echo"))
                    with self.assertRaises(ApiException) as error:
                        asyncio.run(self.recall(config))
                    self.assertEqual(error.exception.status, 401)

    def test_disconnected_forwarder_reports_network_failure_without_changing_config(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _MemoryHandler)
        server.requests = []
        with running(server):
            forwarder = _Forwarder(("127.0.0.1", 0), _ForwardHandler)
            forwarder.destination = server.server_address
            with running(forwarder) as url:
                config = {"apiUrl": url, "apiToken": TOKEN}
                self.assertEqual(asyncio.run(connection.request(config, "GET", "/echo")), {"ok": True})
            original = dict(config)
            with self.assertRaises((aiohttp.ClientError, TimeoutError, OSError)):
                asyncio.run(connection.request(config, "GET", "/echo", timeout=1))
            with self.assertRaises((aiohttp.ClientError, TimeoutError, OSError)):
                asyncio.run(self.recall(config))
            self.assertEqual(config, original)
        self.assertEqual(len(server.requests), 1)

    def test_request_does_not_forward_credentials_through_redirects(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _MemoryHandler)
        server.requests = []
        with running(server) as url:
            with self.assertRaisesRegex(RuntimeError, "HTTP 307"):
                asyncio.run(connection.request({"apiUrl": url, "apiToken": TOKEN}, "GET", "/redirect"))
        self.assertEqual([item["path"] for item in server.requests], ["/redirect"])

    def test_request_timeout_reports_destination_and_operation_without_credentials(self):
        received = threading.Event()
        release = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.set()
                release.wait(3)

            do_POST = do_GET

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        try:
            with running(server) as url:
                config = {"apiUrl": url, "apiToken": TOKEN}
                original = dict(config)
                for method, path in [("GET", "/ext/hindsightkit/connection"),
                                     ("POST", "/ext/hindsightkit/clients")]:
                    received.clear()
                    with self.subTest(method=method), self.assertRaises(TimeoutError) as error:
                        asyncio.run(connection.request(config, method, path, timeout=0.1))
                    self.assertTrue(received.is_set())
                    self.assertIn("timed out after 0.1s", str(error.exception))
                    self.assertIn(method + " " + url + path, str(error.exception))
                    self.assertNotIn(TOKEN, str(error.exception))
                    self.assertIsInstance(error.exception.__cause__, TimeoutError)
                self.assertEqual(config, original)
        finally:
            release.set()

    def test_origins_accept_ip_dns_and_forwarded_ports_and_reject_ambiguous_urls(self):
        for value in ["http://192.0.2.10:9077", "https://memory.example.invalid", "http://127.0.0.1:18077/",
                      "http://[::1]:9077"]:
            self.assertEqual(connection.validate_url(value), value.rstrip("/"))
        for value in ["memory.example.invalid", "ftp://memory.example.invalid", "http://user:secret@host",
                      "http://host/path", "http://host/?query=1", "http://host/#fragment",
                      "http://host:0", "http://host:65536", "http://host:bad", "http://host ", "http://"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                connection.validate_url(value)

    def test_optional_activity_failure_does_not_fail_memory_caller(self):
        config = {"apiUrl": "http://127.0.0.1:1", "apiToken": TOKEN,
                  "hindsightkit": {"activity": True, "deviceId": str(uuid4()), "name": "Dev Box"}}
        for error in [aiohttp.ClientConnectionError(), TimeoutError(), RuntimeError("HTTP 503")]:
            with self.subTest(error=type(error).__name__), patch.object(connection, "request",
                                                                       new=AsyncMock(side_effect=error)):
                asyncio.run(connection.report(config, "vscode"))
        with patch.object(connection, "request", new=AsyncMock()) as request:
            asyncio.run(connection.register({"hindsightkit": {"activity": False}}))
            asyncio.run(connection.report({"hindsightkit": {"activity": False}}, "vscode"))
            request.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
