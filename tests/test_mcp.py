import asyncio
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp import types

from provenloop import cli, connection, mcp as memory_mcp


class McpTests(unittest.TestCase):
    def test_explicit_bank_works_without_vscode_roots(self):
        async def check():
            params = StdioServerParameters(command=sys.executable,
                args=['-u', str(Path(__file__).with_name('mcp_fixture.py')), 'vscode'],
                env={**os.environ, 'TEST_FIXED_BANK': 'shared-on-server', 'FASTMCP_LOG_LEVEL': 'CRITICAL',
                     'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    result = await client.call_tool('recall', {'query': 'shared bank'})
                    self.assertFalse(result.is_error, result)
                    self.assertEqual([item['bank'] for item in result.structured_content['memories']], ['shared-on-server'])
        asyncio.run(asyncio.wait_for(check(), timeout=45))

    def test_vscode_roots_and_cli_cwd_are_isolated_without_model_calls(self):
        async def check():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                a, b = root / 'a', root / 'b'
                for path in [a, b]:
                    path.mkdir()
                    cli.run(['git', 'init', path], capture=True)

                async def session(context, cwd, roots=None, changed_roots=None):
                    active_roots = roots
                    async def list_roots(_):
                        return types.ListRootsResult(roots=[types.Root(uri=path.as_uri()) for path in active_roots])
                    params = StdioServerParameters(command=sys.executable,
                        args=['-u', str(Path(__file__).with_name('mcp_fixture.py')), context], cwd=str(cwd),
                        env={**os.environ, 'FASTMCP_LOG_LEVEL': 'CRITICAL',
                             'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
                    async with stdio_client(params) as (reader, writer):
                        async with ClientSession(reader, writer, list_roots_callback=list_roots if roots is not None else None) as client:
                            await client.initialize()
                            tools = await client.list_tools()
                            self.assertEqual({t.name for t in tools.tools}, {'recall', 'retain', 'reflect', 'recall_mail'})
                            for tool in tools.tools:
                                self.assertNotIn('bank_id', tool.input_schema.get('properties', {}))
                            result = await client.call_tool('recall', {'query':'isolation test for an empty bank'})
                            if changed_roots is not None:
                                self.assertFalse(result.is_error)
                                active_roots = changed_roots
                                result = await client.call_tool('recall', {'query':'isolation after workspace change'})
                            return result

                result = await session('vscode', root, [a])
                self.assertFalse(result.is_error, result)
                result = await session('vscode', root, [a, b])
                self.assertTrue(result.is_error)
                result = await session('vscode', root, None)
                self.assertTrue(result.is_error)
                result = await session('cli', a)
                self.assertFalse(result.is_error, result)
                result = await session('vscode', root, [a], changed_roots=[b])
                self.assertTrue(result.is_error)
        asyncio.run(asyncio.wait_for(check(), timeout=120))


class MailToolConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def call_tools(self, config, action, sdk_client):
        server = memory_mcp.FastMCP("Mail connection fixture")
        with patch.object(connection, "load", return_value=config), \
             patch.object(connection, "Hindsight", return_value=sdk_client) as constructor, \
             patch.object(connection, "report", new=AsyncMock()), \
             patch.object(memory_mcp, "FastMCP", return_value=server), \
             patch.object(server, "run"):
            memory_mcp.serve("vscode")
            result = await action(server)
        return result, constructor

    async def test_recall_mail_uses_server_endpoint_auth_and_source_fact_options(self):
        secret = "synthetic-server-mail-secret"
        config = {"apiUrl": "https://memory.example.invalid", "apiToken": secret,
                  "provenloop": {"mode": "server"}}
        client = SimpleNamespace(arecall=AsyncMock(return_value=SimpleNamespace(
            model_dump=lambda **kwargs: {"results": [], "source_facts": {}})), aclose=AsyncMock())
        async def action(server):
            tool = await server.get_tool("recall_mail")
            self.assertNotIn("bank_id", tool.parameters.get("properties", {}))
            return await tool.fn(query="Mail finding", max_tokens=1024)
        result, constructor = await self.call_tools(config, action, client)
        constructor.assert_called_once_with(base_url=config["apiUrl"], api_key=secret, timeout=90)
        client.arecall.assert_awaited_once()
        arguments = client.arecall.await_args.kwargs
        self.assertEqual(arguments["bank_id"], "provenloop-mail")
        self.assertTrue(arguments["include_source_facts"])
        self.assertTrue(arguments["prefer_observations"])
        self.assertEqual(arguments["max_source_facts_tokens"], 512)
        self.assertNotIn(secret, str(result))
        client.aclose.assert_awaited_once()

    async def test_fixed_client_cannot_bypass_its_bank_through_recall_mail(self):
        config = {"apiUrl": "https://memory.example.invalid", "apiToken": "synthetic-client-mail-secret",
                  "provenloop": {"mode": "client", "bank": "allowed-shared-bank"}}
        client = SimpleNamespace(arecall=AsyncMock(return_value=SimpleNamespace(
            model_dump=lambda **kwargs: {"results": []})), aclose=AsyncMock())
        async def action(server):
            mail = await server.get_tool("recall_mail")
            with self.assertRaisesRegex(ValueError, "local mail-import installation"):
                await mail.fn(query="Mail finding")
            client.arecall.assert_not_awaited()
            normal = await server.get_tool("recall")
            return await normal.fn(query="Allowed shared finding", ctx=None, max_tokens=1024)
        result, constructor = await self.call_tools(config, action, client)
        constructor.assert_called_once_with(base_url=config["apiUrl"], api_key=config["apiToken"], timeout=330)
        self.assertEqual([item["bank"] for item in result["memories"]], ["allowed-shared-bank"])
        self.assertEqual(client.arecall.await_args.kwargs["bank_id"], "allowed-shared-bank")
        client.aclose.assert_awaited_once()
