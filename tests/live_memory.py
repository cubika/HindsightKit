"""Explicit live acceptance: synthetic data only; consumes a few Copilot calls."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from hindsight_client import Hindsight
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from provenloop import cli


async def main():
    cli.prepare_env()
    _, paths = cli.profile_config()
    url = f'http://127.0.0.1:{paths.port}'
    bank = 'provenloop-acceptance-' + uuid.uuid4().hex
    marker = 'PL-' + uuid.uuid4().hex[:12]
    client = Hindsight(base_url=url)
    report = {'bank': bank}
    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp)
        config = project / 'coding-agent.json'
        config.write_text(json.dumps({
            'apiUrl': url, 'serverMode': 'self-hosted', 'bankId': bank,
            'autoUpdate': False, 'autoSeed': False, 'codebaseSurvey': False,
            'manageBankConfig': False, 'autoReflect': True, 'reflectTimeoutMs': 20000,
        }))
        env = {**os.environ, 'HINDSIGHT_CONFIG': str(config)}
        dist = cli.runtime() / 'node_modules/@vectorize-io/hindsight-coding-agents/dist'
        transcript = project / 'transcript.jsonl'
        transcript.write_text('\n'.join(json.dumps(event) for event in [
            {'type': 'user.message', 'data': {'content': f'Remember: project Peregrine uses release label {marker}.'}},
            {'type': 'assistant.message', 'data': {'content': f'I will use {marker} for project Peregrine releases.'}},
        ]), encoding='utf-8')

        def hook(name, payload):
            result = subprocess.run(
                [cli.node(), str(dist / name)], input=json.dumps(payload), capture_output=True,
                text=True, encoding='utf-8', errors='replace', env=env, timeout=80,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
            if result.returncode:
                raise RuntimeError(result.stderr)
            return result.stdout

        try:
            await client.acreate_bank(bank_id=bank)
            await asyncio.to_thread(hook, 'copilot-stop-hook.js', {
                'sessionId': uuid.uuid4().hex, 'cwd': str(project), 'transcriptPath': str(transcript),
            })
            deadline = time.monotonic() + 180
            while True:
                recall = await client.arecall(bank_id=bank, query='What release label does Peregrine use?')
                if marker in recall.model_dump_json():
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError('Official stop hook did not retain the synthetic session.')
                await asyncio.sleep(2)
            report['official_stop_hook_retains'] = True
            # The official prompt hook falls back to consolidated observations
            # when reflect exceeds its host deadline. Wait for normal learning.
            deadline = time.monotonic() + 180
            while True:
                observations = await client.arecall(bank_id=bank, query='Peregrine release label', types=['observation'])
                if marker in observations.model_dump_json():
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError('Background consolidation did not produce the learned observation.')
                await asyncio.sleep(2)
            report['background_consolidation'] = True

            output = await asyncio.to_thread(hook, 'copilot-hook.js', {
                'sessionId': uuid.uuid4().hex, 'cwd': str(project),
                'prompt': 'What release label does project Peregrine use?',
                'transformedPrompt': 'What release label does project Peregrine use?',
            })
            if marker not in output:
                raise RuntimeError('New-session prompt hook did not inject the retained experience: ' + output[:600])
            report['new_session_injects_memory'] = True

            async with streamable_http_client(url + '/mcp/' + bank + '/') as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    names = [tool.name for tool in tools.tools]
                    for required in ['recall', 'retain', 'reflect']:
                        if required not in names:
                            raise RuntimeError('Missing MCP tool ' + required)
                    result = await session.call_tool('recall', {'query': 'What release label does Peregrine use?'})
                    if result.is_error or marker not in result.model_dump_json():
                        raise RuntimeError('VS Code HTTP MCP recall failed.')
            report['vscode_http_mcp_recall'] = True

            # Stop/start uses the same official profile and checks persistence.
            await asyncio.to_thread(cli.run, [cli.executable('hindsight-embed'), '--profile', cli.PROFILE, 'daemon', 'stop'])
            await asyncio.to_thread(cli.run, [cli.executable('hindsight-embed'), '--profile', cli.PROFILE, 'daemon', 'start'])
            recall = await client.arecall(bank_id=bank, query='Peregrine release label')
            if marker not in recall.model_dump_json():
                raise RuntimeError('Memory did not survive the service restart.')
            report['restart_persists_memory'] = True
        finally:
            await client.adelete_bank(bank_id=bank)
            await client.aclose()
    output = Path('.validation/live-memory.json')
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


asyncio.run(main())
