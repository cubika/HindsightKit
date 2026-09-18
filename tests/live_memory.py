"""Live access-matrix acceptance. Uses synthetic facts and a few Copilot calls."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
from unittest.mock import patch
from io import StringIO

import aiohttp
from hindsight_client import Hindsight
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

from hindsightkit.platform import config as profile_env
from hindsightkit import services
from hindsightkit.platform import runtime as runtime_env
from hindsightkit import hooks
from hindsightkit import connection
from hindsightkit.memory.api import SHARED_BANK, scope_for


async def main():
    runtime_env.prepare_env()
    _, paths = profile_env.profile_config()
    url = f'http://127.0.0.1:{paths.port}'
    key = connection.load().get('apiToken')
    client = Hindsight(base_url=url, api_key=key)
    runtime = runtime_env.runtime()
    suffix = uuid.uuid4().hex[:10]
    marker_a, marker_b, marker_shared = [prefix + suffix for prefix in ['A-', 'B-', 'SHARED-']]
    report = {}
    shared_document = None
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        a, b, outside = base / 'a/repo', base / 'b/repo', base / 'ordinary folder'
        for path in [a, b, outside]: path.mkdir(parents=True)
        for path in [a, b]: runtime_env.run(['git', 'init', path], capture=True)
        bank_a, bank_b = scope_for(a).bank, scope_for(b).bank
        config = base / 'coding-agent.json'
        config.write_text(json.dumps({'apiUrl': url, 'apiToken':key, 'serverMode':'self-hosted','optInOnly':False}))
        env = {**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src'),
               'HINDSIGHT_CONFIG': str(config), 'HINDSIGHTKIT_HOME': str(base / 'state')}

        async def mcp(directory, operation, arguments, roots=False):
            async def list_roots(_):
                return types.ListRootsResult(roots=[types.Root(uri=directory.as_uri())])
            params = StdioServerParameters(command=sys.executable,
                args=['-m','hindsightkit.cli','mcp','--context','vscode' if roots else 'cli'],
                cwd=outside if roots else directory, env=env)
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer, list_roots_callback=list_roots if roots else None) as session:
                    await session.initialize()
                    response = await session.call_tool(operation, arguments)
                    if response.is_error: raise RuntimeError(str(response))
                    return response.structured_content

        def hook(event, payload):
            with patch.dict(os.environ, env), patch('hindsightkit.hooks.runtime', return_value=runtime), \
                 patch('sys.stdin', StringIO(json.dumps(payload))), patch('sys.stdout', new_callable=StringIO) as output:
                hooks.run(event)
                return output.getvalue()

        try:
            for bank in [bank_a, bank_b, SHARED_BANK]: await client.acreate_bank(bank_id=bank)
            result = await mcp(outside, 'retain', {'content': f'The shared test convention uses reference {marker_shared}.'})
            shared_document = result['document_id']
            assert result['bank'] == SHARED_BANK
            result = await mcp(a, 'retain', {'content': f'Repository A uses its private reference {marker_a}.'}, roots=True)
            assert result['bank'] == bank_a
            result = await mcp(b, 'retain', {'content': f'Repository B uses its private reference {marker_b}.'})
            assert result['bank'] == bank_b
            report['writes_follow_repo_or_shared'] = True

            for directory, included, excluded in [(a,[marker_a,marker_shared],[marker_b]),
                                                  (b,[marker_b,marker_shared],[marker_a]),
                                                  (outside,[marker_shared],[marker_a,marker_b])]:
                result = await mcp(directory, 'recall', {'query':'What are the test reference conventions?'}, roots=directory==a)
                text = json.dumps(result)
                assert all(marker in text for marker in included), text
                assert all(marker not in text for marker in excluded), text
            report['read_access_matrix'] = True
            result = await mcp(a, 'reflect', {'query':'Which private and shared reference conventions are available?', 'max_tokens':1024})
            assert marker_b not in json.dumps(result)
            assert {item['bank'] for item in result['memories']} == {bank_a, SHARED_BANK}
            report['reflect_only_accessible_banks'] = True

            session_id = uuid.uuid4().hex
            await asyncio.to_thread(hook, 'sessionStart', {'sessionId':session_id,'cwd':str(a)})
            output = await asyncio.to_thread(hook, 'userPromptTransformed', {
                'sessionId':session_id,'cwd':str(b),'prompt':'What are the test reference conventions?',
                'transformedPrompt':'What are the test reference conventions?'})
            assert marker_a in output and marker_shared in output and marker_b not in output
            report['prompt_pinned_after_directory_change'] = True
            transcript = base / 'transcript.jsonl'
            retained_marker = 'CAPTURE-' + suffix
            transcript.write_text(json.dumps({'type':'user.message','data':{'content':f'Repository A capture reference is {retained_marker}.'}}) + '\n')
            await asyncio.to_thread(hook, 'agentStop', {'sessionId':session_id,'cwd':str(b),'transcriptPath':str(transcript)})
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                value = await client.arecall(bank_id=bank_a, query=retained_marker)
                if retained_marker in value.model_dump_json(): break
                await asyncio.sleep(2)
            else: raise RuntimeError('Official stop hook did not write to the pinned repository.')
            for bank in [bank_b, SHARED_BANK]:
                assert retained_marker not in (await client.arecall(bank_id=bank, query=retained_marker)).model_dump_json()
            report['official_capture_remains_repo_only'] = True
        finally:
            if shared_document:
                async with aiohttp.ClientSession() as session:
                    async with session.delete(url + f'/v1/default/banks/{SHARED_BANK}/documents/{shared_document}') as response:
                        assert response.status in {200,204,404}
            for bank in [bank_a, bank_b]: await client.adelete_bank(bank_id=bank)
            await client.aclose()
    Path('.validation').mkdir(exist_ok=True)
    Path('.validation/live-memory.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


asyncio.run(main())
