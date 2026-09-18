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
from mcp.shared.message import SessionMessage
from mcp import types

from hindsightkit import runtime as runtime_env, connection, mcp as memory_mcp
from hindsightkit import memory_control
from hindsightkit.memory import scope_for


class McpTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        environment = patch.dict(os.environ, {'HINDSIGHTKIT_HOME': self.home.name})
        environment.start()
        self.addCleanup(environment.stop)

    def test_modern_discovery_can_fall_back_to_handshake_and_repository_tools(self):
        async def check(context):
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                runtime_env.run(['git', 'init', root], capture=True)
                async def list_roots(_):
                    return types.ListRootsResult(roots=[types.Root(uri=root.as_uri())])
                params = StdioServerParameters(command=sys.executable,
                    args=['-u', str(Path(__file__).with_name('mcp_fixture.py')), context],
                    cwd=str(root), env={**os.environ, 'COPILOT_AGENT_SESSION_ID': '',
                        'FASTMCP_LOG_LEVEL': 'CRITICAL',
                        'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
                async with stdio_client(params) as (reader, writer):
                    await writer.send(SessionMessage(types.JSONRPCRequest(
                        jsonrpc='2.0', id='discovery', method='server/discover', params={
                            '_meta': {
                                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                                'io.modelcontextprotocol/clientCapabilities': {},
                                'io.modelcontextprotocol/clientInfo': {
                                    'name': 'compatibility-test', 'version': '1.0'},
                            }})))
                    response = (await reader.receive()).message
                    self.assertIsInstance(response, types.JSONRPCError, response)
                    self.assertEqual(response.id, 'discovery')
                    self.assertEqual(response.error.code, -32601)
                    async with ClientSession(reader, writer,
                            list_roots_callback=list_roots if context == 'vscode' else None) as client:
                        initialized = await client.initialize()
                        self.assertEqual(initialized.protocol_version, '2025-11-25')
                        tools = await client.list_tools()
                        self.assertEqual({tool.name for tool in tools.tools}, {'retain', 'recall', 'reflect'})
                        result = await client.call_tool('recall', {'query': 'Fixture query'})
                        self.assertFalse(result.is_error, result)
                        self.assertEqual(result.structured_content['memories'][0]['bank'], scope_for(root).bank)
                        with patch('builtins.print'):
                            memory_control.command('off', root)
                        result = await client.call_tool('recall', {'query': 'Fixture query'})
                        self.assertTrue(result.is_error, result)
                        self.assertIn('disabled for this repository', str(result.content))
        for context in ('cli', 'vscode'):
            with self.subTest(context=context):
                asyncio.run(asyncio.wait_for(check(context), timeout=45))

    def test_explicit_bank_requires_vscode_roots_to_honor_repository_switch(self):
        async def check():
            params = StdioServerParameters(command=sys.executable,
                args=['-u', str(Path(__file__).with_name('mcp_fixture.py')), 'vscode'],
                env={**os.environ, 'TEST_FIXED_BANK': 'shared-on-server', 'FASTMCP_LOG_LEVEL': 'CRITICAL',
                     'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer) as client:
                    await client.initialize()
                    result = await client.call_tool('recall', {'query': 'shared bank'})
                    self.assertTrue(result.is_error, result)
                    self.assertIn('did not supply workspace roots', str(result.content))
        asyncio.run(asyncio.wait_for(check(), timeout=45))

    def test_vscode_roots_and_cli_cwd_are_isolated_without_model_calls(self):
        async def check():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                a, b = root / 'a', root / 'b'
                for path in [a, b]:
                    path.mkdir()
                    runtime_env.run(['git', 'init', path], capture=True)

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
                            self.assertEqual({t.name for t in tools.tools}, {'recall', 'retain', 'reflect'})
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

    def test_vscode_session_observes_workspace_toggle_without_restart(self):
        async def check():
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                runtime_env.run(['git', 'init', root], capture=True)
                async def list_roots(_):
                    return types.ListRootsResult(roots=[types.Root(uri=root.as_uri())])
                params = StdioServerParameters(command=sys.executable,
                    args=['-u', str(Path(__file__).with_name('mcp_fixture.py')), 'vscode'],
                    env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
                with patch('builtins.print'):
                    memory_control.command('off', root)
                async with stdio_client(params) as (reader, writer):
                    async with ClientSession(reader, writer, list_roots_callback=list_roots) as client:
                        await client.initialize()
                        for action, disabled in [('off', True), ('on', False), ('off', True)]:
                            with patch('builtins.print'):
                                memory_control.command(action, root)
                            result = await client.call_tool('recall', {'query': 'Fixture query'})
                            self.assertEqual(result.is_error, disabled, result)
                            if disabled:
                                self.assertIn('disabled for this repository', str(result.content))
        asyncio.run(asyncio.wait_for(check(), timeout=90))


class MailToolConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_server_advertised_mail_is_available_without_local_import_state(self):
        config = {'apiUrl': 'https://memory.example.invalid', 'apiToken': 'synthetic-key',
                  'hindsightkit': {'mode': 'client', 'routing': 'repository', 'connectors': ['workiq']}}
        client = SimpleNamespace(arecall=AsyncMock(return_value=SimpleNamespace(
            model_dump=lambda **kwargs: {'results': []})), aclose=AsyncMock())
        async def action(server):
            tool = await server.get_tool('recall_mail')
            self.assertIsNotNone(tool)
            return (await server.call_tool('recall_mail', {'query': 'shared mail'})).structured_content
        result, constructor = await self.call_tools(config, action, client, saved_mail=False)
        self.assertEqual(result['bank'], 'hindsightkit-mail')
        constructor.assert_called_once_with(base_url=config['apiUrl'], api_key='synthetic-key', timeout=90)

    async def call_tools(self, config, action, sdk_client, *, saved_mail=True):
        server = memory_mcp.FastMCP("Mail connection fixture")
        with tempfile.TemporaryDirectory() as temp, \
             patch.dict(os.environ, {'HINDSIGHTKIT_HOME': temp}), \
             patch.object(connection, "load", return_value=config), \
             patch.object(connection, "Hindsight", return_value=sdk_client) as constructor, \
             patch.object(connection, "report", new=AsyncMock()), \
             patch.object(memory_mcp, "FastMCP", return_value=server), \
             patch.object(memory_mcp, "run_stdio"):
            if saved_mail:
                directory = Path(temp) / 'mail'
                directory.mkdir()
                (directory / 'sync.sqlite3').touch()
            # Keep a real MCP dispatch (including its repository guard), with
            # a non-Git fixture directory and deterministic bank discovery.
            with patch.object(memory_mcp, 'resolve', new=AsyncMock(side_effect=lambda config, scope: scope)):
                memory_mcp.serve("cli", temp)
                result = await action(server)
        return result, constructor

    async def test_recall_mail_uses_server_endpoint_auth_and_source_fact_options(self):
        secret = "synthetic-server-mail-secret"
        config = {"apiUrl": "https://memory.example.invalid", "apiToken": secret,
                  "hindsightkit": {"mode": "server"}}
        client = SimpleNamespace(arecall=AsyncMock(return_value=SimpleNamespace(
            model_dump=lambda **kwargs: {"results": [], "source_facts": {}})), aclose=AsyncMock())
        async def action(server):
            tool = await server.get_tool("recall_mail")
            self.assertNotIn("bank_id", tool.parameters.get("properties", {}))
            return (await server.call_tool("recall_mail", {"query": "Mail finding", "max_tokens": 1024})).structured_content
        result, constructor = await self.call_tools(config, action, client)
        constructor.assert_called_once_with(base_url=config["apiUrl"], api_key=secret, timeout=90)
        client.arecall.assert_awaited_once()
        arguments = client.arecall.await_args.kwargs
        self.assertEqual(arguments["bank_id"], "hindsightkit-mail")
        self.assertFalse(arguments["include_source_facts"])
        self.assertEqual(arguments["types"], ["world"])
        self.assertEqual(arguments["max_tokens"], 1024)
        self.assertNotIn(secret, str(result))
        client.aclose.assert_awaited_once()

    async def test_fixed_client_cannot_bypass_its_bank_through_recall_mail(self):
        config = {"apiUrl": "https://memory.example.invalid", "apiToken": "synthetic-client-mail-secret",
                  "hindsightkit": {"mode": "client", "bank": "allowed-shared-bank"}}
        client = SimpleNamespace(arecall=AsyncMock(return_value=SimpleNamespace(
            model_dump=lambda **kwargs: {"results": []})), aclose=AsyncMock())
        async def action(server):
            self.assertIsNone(await server.get_tool("recall_mail"))
            client.arecall.assert_not_awaited()
            normal = await server.get_tool("recall")
            return (await server.call_tool("recall", {"query": "Allowed shared finding", "max_tokens": 1024})).structured_content
        result, constructor = await self.call_tools(config, action, client)
        constructor.assert_called_once_with(base_url=config["apiUrl"], api_key=config["apiToken"], timeout=330)
        self.assertEqual([item["bank"] for item in result["memories"]], ["allowed-shared-bank"])
        self.assertEqual(client.arecall.await_args.kwargs["bank_id"], "allowed-shared-bank")
        client.aclose.assert_awaited_once()

    async def test_unused_mail_does_not_register_tool_or_construct_sdk(self):
        config = {'apiUrl': 'https://memory.example.invalid', 'apiToken': 'synthetic-unused-key'}
        client = SimpleNamespace(arecall=AsyncMock(), aclose=AsyncMock())
        async def action(server):
            self.assertIsNone(await server.get_tool('recall_mail'))
            for name in ['retain', 'recall', 'reflect']:
                self.assertIsNotNone(await server.get_tool(name))
            self.assertFalse((Path(os.environ['HINDSIGHTKIT_HOME']) / 'mail').exists())
        _, constructor = await self.call_tools(config, action, client, saved_mail=False)
        constructor.assert_not_called()
        client.arecall.assert_not_awaited()
