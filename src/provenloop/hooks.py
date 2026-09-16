"""Pin the session scope, retrieve context, and delegate transcript retention upstream."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from filelock import FileLock

from . import connection
from .cli import home, node, runtime
from .memory import Memory, Scope, scope_for


def session_config(event: dict, config: dict) -> tuple[Path, dict]:
    session_id = event.get('sessionId')
    if not isinstance(session_id, str) or not session_id:
        raise ValueError('Copilot did not provide a session ID; skipping memory to avoid mixing sessions.')
    bank = connection.fixed_bank(config)
    destination = json.dumps((config.get('apiUrl', ''), bank)) if bank else ''
    name = hashlib.sha256((session_id + destination).encode()).hexdigest()
    path = home() / 'sessions' / (name + '.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + '.lock', timeout=5):
        if path.is_file():
            pinned = json.loads(path.read_text(encoding='utf-8'))
            directory = pinned['_directory']
            scope = Scope(pinned['bankId'], pinned['_repository'])
        else:
            directory = str(Path(event.get('cwd') or os.getcwd()).resolve(strict=True))
            bank = connection.fixed_bank(config)
            scope = Scope(bank) if bank else scope_for(directory)
        resolved = {**config, 'bankId': scope.bank, 'dynamicBankId': False, 'optInOnly': False,
                    '_directory': directory, '_repository': scope.repository,
                    'autoSeed': False, 'codebaseSurvey': False, 'manageBankConfig': False}
        for key in ['mapPathToBank', 'optInPaths', 'harnesses', 'banks']:
            resolved.pop(key, None)
        text = json.dumps(resolved)
        if not path.is_file() or path.read_text(encoding='utf-8') != text:
            temporary = path.with_suffix('.tmp')
            temporary.write_text(text, encoding='utf-8')
            os.replace(temporary, path)
        return path, resolved


async def prompt_memory(config, event):
    client = connection.sdk(config, timeout=6, max_attempts=1)
    try:
        service = Memory(client, Scope(config['bankId'], config['_repository']))
        result = await asyncio.wait_for(service.read('recall', event.get('prompt') or '', 2048), timeout=7)
        await connection.report(config, 'copilot-cli')
        return result
    finally:
        await client.aclose()


def run(event_name: str):
    if os.environ.get('HINDSIGHT_DISABLE_HOOKS'):
        return
    config_path = Path(os.environ.get('HINDSIGHT_CONFIG', Path.home() / '.hindsight/coding-agent.json'))
    config = json.loads(config_path.read_text(encoding='utf-8'))
    if config.get('disabled'):
        return
    event = json.load(sys.stdin)
    path, pinned = session_config(event, config)
    if event_name == 'sessionStart':
        return
    if event_name == 'agentStop':
        if config.get('retainSessions') is False:
            return
        # Keep the official parser, retries and idempotent document writes unchanged.
        event['cwd'] = pinned['_directory']
        script = runtime() / 'node_modules/@vectorize-io/hindsight-coding-agents/dist/copilot-stop-hook.js'
        result = subprocess.run([node(), str(script)], input=json.dumps(event), text=True,
                                encoding='utf-8', capture_output=True, timeout=60,
                                env={**os.environ, 'HINDSIGHT_CONFIG': str(path)},
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.stderr:
            print(result.stderr, file=sys.stderr, end='')
        if result.returncode:
            raise RuntimeError('Official Hindsight retain hook failed: ' + result.stderr[-1000:])
        return
    if not event.get('prompt'):
        return
    recalled = asyncio.run(prompt_memory(pinned, event))
    blocks = []
    for item in recalled['memories']:
        facts = item['result'].get('results', [])
        if facts:
            blocks.append({'bank': item['bank'], 'facts': [fact['text'] for fact in facts]})
    if blocks:
        # Upstream strips this tag from captured transcripts, preventing reinsertion.
        context = '<hindsight_memory>\n' + json.dumps(blocks, ensure_ascii=False) + '\n</hindsight_memory>'
        original = event.get('transformedPrompt') or event['prompt']
        print(json.dumps({'modifiedTransformedPrompt': original + '\n\n' + context}))
