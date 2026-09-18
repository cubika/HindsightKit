"""Pin the session scope, retrieve context, and delegate transcript retention upstream."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from filelock import FileLock

from . import connection, lifecycle
from .cli import home, node, runtime
from .memory import Memory, Scope, scope_for
from .routing import resolve
from . import memory_control


def session_config(event: dict, config: dict, *, resolve_scope=True) -> tuple[Path, dict]:
    session_id = event.get('sessionId')
    if not isinstance(session_id, str) or not session_id:
        raise ValueError('Copilot did not provide a session ID; skipping memory to avoid mixing sessions.')
    bank = connection.fixed_bank(config)
    destination = json.dumps((config.get('apiUrl', ''), bank, config.get('hindsightkit', {}).get('routing'))) if config.get('hindsightkit') else ''
    name = hashlib.sha256((session_id + destination).encode()).hexdigest()
    path = home() / 'sessions' / (name + '.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + '.lock', timeout=5):
        if path.is_file():
            pinned = json.loads(path.read_text(encoding='utf-8'))
            directory = pinned['_directory']
            scope = Scope(pinned['bankId'], pinned['_repository'], pinned.get('_shared_bank', 'hindsightkit-shared'))
            repository = pinned['_memory_repository'] if '_memory_repository' in pinned else scope_for(directory).repository
            pending = pinned.get('_scope_pending', False)
            capture_epoch = pinned.get('_capture_epoch', '')
            service_epoch = pinned.get('_service_epoch', '')
        else:
            directory = str(Path(event.get('cwd') or os.getcwd()).resolve(strict=True))
            bank = connection.fixed_bank(config)
            local = scope_for(directory)
            repository = local.repository
            scope = Scope(bank) if bank else local
            pending = not bank
            current = memory_control.state(repository)
            capture_epoch = current.capture_epoch if current.enabled else None
            service = lifecycle.state()
            service_epoch = service.get('capture_epoch', '') if lifecycle.available(service) else None
        if pending and resolve_scope and lifecycle.available() and memory_control.state(repository).enabled:
            scope = asyncio.run(resolve(config, scope))
            pending = False
        resolved = {**config, 'bankId': scope.bank, 'dynamicBankId': False, 'optInOnly': False,
                    '_directory': directory, '_repository': scope.repository,
                    '_memory_repository': repository, '_scope_pending': pending,
                    '_capture_epoch': capture_epoch,
                    '_service_epoch': service_epoch,
                    '_shared_bank': scope.shared_bank,
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
        service = Memory(client, Scope(config['bankId'], config['_repository'], config.get('_shared_bank', 'hindsightkit-shared')))
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
    path, pinned = session_config(event, config, resolve_scope=False)
    service = lifecycle.state()
    if not lifecycle.available(service):
        return
    current = memory_control.state(pinned['_memory_repository'])
    if not current.enabled:
        return
    if event_name == 'sessionStart':
        return
    if event_name == 'agentStop':
        if config.get('retainSessions') is False:
            return
        if (pinned['_capture_epoch'] != current.capture_epoch
                or pinned['_service_epoch'] != service.get('capture_epoch', '')):
            print('HindsightKit: automatic session saving is paused for this session after memory was disabled. Start a new Copilot session to resume saving.', file=sys.stderr)
            return
    from .remote import prepare_client
    prepare_client(config)
    path, pinned = session_config(event, config)
    current = memory_control.state(pinned['_memory_repository'])
    service = lifecycle.state()
    if not current.enabled or not lifecycle.available(service):
        return
    if event_name == 'agentStop':
        if (pinned['_capture_epoch'] != current.capture_epoch
                or pinned['_service_epoch'] != service.get('capture_epoch', '')):
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
