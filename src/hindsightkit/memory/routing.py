"""Resolve repository identity across machines without moving memory content."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

from hindsightkit.memory.api import Scope, SHARED_BANK, scope_for


def repository_identity(scope):
    if not scope.repository:
        return None
    result = subprocess.run(['git', '-C', scope.repository, 'config', '--get', 'remote.origin.url'],
        capture_output=True, text=True, encoding='utf-8', timeout=5,
        env={key: value for key, value in os.environ.items() if not key.startswith('GIT_')},
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot read repository origin.')
    origin = result.stdout.strip()
    if not origin:
        return None
    if '://' in origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in {'http', 'https', 'ssh', 'git'} or not parsed.hostname:
            return None
        defaults = {'http': 80, 'https': 443, 'ssh': 22, 'git': 9418}
        port = f':{parsed.port}' if parsed.port and parsed.port != defaults[parsed.scheme] else ''
        identity = parsed.hostname.lower() + port + '/' + parsed.path.strip('/')
    else:
        match = re.fullmatch(r'(?:[^/@:]+@)?([^/:]+):(.+)', origin)
        if not match or len(match[1]) == 1:
            return None
        identity = match[1].lower() + '/' + match[2].strip('/')
    identity = identity.removesuffix('.git')
    # Azure DevOps publishes different paths for the same repository over SSH/HTTPS.
    if identity.startswith('ssh.dev.azure.com/v3/'):
        parts = identity.split('/')
        if len(parts) == 5:
            identity = f'dev.azure.com/{parts[2]}/{parts[3]}/_git/{parts[4]}'
    return hashlib.sha256(identity.encode()).hexdigest()


async def resolve(config, scope):
    from hindsightkit import connection
    if config.get('hindsightkit', {}).get('routing') != 'repository':
        return scope
    identity = await asyncio.to_thread(repository_identity, scope)
    if scope.repository and identity is None:
        # Unpublished repositories remain separate on each device.
        identity = hashlib.sha256((config['hindsightkit']['deviceId'] + ':' + scope.bank).encode()).hexdigest()
    result = await connection.request(config, 'POST', '/ext/hindsightkit/scope', body={'repository': identity})
    return Scope(connection.validate_bank(result['bank']), scope.repository,
                 connection.validate_bank(result['sharedBank']))


def seed_aliases(path, sessions, old_config, device=None, api_url=None):
    """Map previously used server checkouts to their existing banks on first upgrade."""
    from filelock import FileLock
    path = Path(path)
    candidates = set(old_config.get('mapPathToBank', {}).items()) if not api_url or old_config.get('apiUrl') == api_url else set()
    for record in Path(sessions).glob('*.json'):
        value = json.loads(record.read_text(encoding='utf-8'))
        if api_url and value.get('apiUrl') != api_url:
            continue
        if value.get('_repository') and not value.get('_scope_pending'):
            candidates.add((value['_repository'], value.get('bankId')))
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + '.lock', timeout=5):
        aliases = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
        for repository, bank in sorted(candidates):
            if not Path(repository).is_dir():
                continue
            scope = scope_for(repository)
            if scope.bank != bank:
                continue
            identity = repository_identity(scope)
            if not identity:
                if not device:
                    continue
                identity = hashlib.sha256((device + ':' + scope.bank).encode()).hexdigest()
            if identity in aliases and aliases[identity] != bank:
                raise RuntimeError(f'Multiple existing memory banks refer to {repository}. Resolve the repository alias before setup; no memory was moved.')
            aliases[identity] = bank
        text = json.dumps(aliases, sort_keys=True)
        if len(text) > 256 * 1024:
            raise RuntimeError('Repository alias file exceeds its size limit.')
        temporary = path.with_suffix('.tmp')
        temporary.write_text(text, encoding='utf-8')
        os.replace(temporary, path)
