import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp import types

from provenloop import cli


class McpTests(unittest.TestCase):
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
                        args=[str(Path(__file__).with_name('mcp_fixture.py')), context], cwd=str(cwd),
                        env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')})
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
        asyncio.run(check())
