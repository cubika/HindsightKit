"""One configured API destination for MCP, hooks, and command-line checks."""
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp
from hindsight_client import Hindsight


def config_path() -> Path:
    return Path(os.environ.get('HINDSIGHT_CONFIG', Path.home() / '.hindsight/coding-agent.json'))


def device_id(previous=None):
    from .runtime import home
    from filelock import FileLock
    path = home() / 'device-id'
    path.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(path) + '.lock', timeout=5):
        if path.is_file():
            return str(uuid.UUID(path.read_text(encoding='utf-8').strip()))
        identity = str(uuid.UUID(previous)) if previous else str(uuid.uuid4())
        path.write_text(identity, encoding='utf-8')
        return identity


def load() -> dict:
    path = config_path()
    if path.is_file():
        return json.loads(path.read_text(encoding='utf-8'))
    if has_server():
        return server_load()
    raise RuntimeError('This client is not connected. Run hindsightkit connect or hindsightkit connect --server URL.')


def server_load() -> dict:
    """Server processes never inherit a coding client's remote destination or key."""
    from .services import profile_config
    profile, paths = profile_config()
    return {'apiUrl': f'http://127.0.0.1:{paths.port}',
            'apiToken': profile.get('HINDSIGHT_API_TENANT_API_KEY'), 'hindsightkit': {'mode': 'server'}}


def has_server() -> bool:
    return (Path.home() / '.hindsight/profiles/hindsightkit.env').is_file()


def management() -> dict:
    return server_load() if has_server() else load()


def validate_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or parsed.path not in {'', '/'} or
            any(char.isspace() for char in value)):
        raise ValueError('Use an HTTP(S) API origin without credentials, path, query, or fragment.')
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('Invalid API port.')
    return value.rstrip('/')


def validate_bank(value: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', value):
        raise ValueError('Bank must contain 1-128 letters, digits, dots, underscores, colons, or hyphens.')
    return value


def client_mode(config: dict) -> bool:
    return config.get('hindsightkit', {}).get('mode') == 'client'


def fixed_bank(config: dict) -> str | None:
    return config.get('hindsightkit', {}).get('bank')


def sdk(config: dict, **options) -> Hindsight:
    return Hindsight(base_url=validate_url(config['apiUrl']), api_key=config.get('apiToken'), **options)


async def request(config, method, path, *, body=None, timeout=10):
    origin = validate_url(config['apiUrl'])
    headers = {'Authorization': 'Bearer ' + config['apiToken']} if config.get('apiToken') else {}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), trust_env=True) as session:
            async with session.request(method, origin + path,
                                       headers=headers, json=body, allow_redirects=False) as response:
                if response.status >= 300:
                    raise RuntimeError(f'Memory API returned HTTP {response.status} for {path}.')
                return await response.json()
    except TimeoutError as exc:
        # Keep the type so direct connection timeouts still trigger relay fallback.
        raise TimeoutError(f'Memory API request timed out after {timeout:g}s: {method} {origin}{path}.') from exc


async def discover(config):
    result = await request(config, 'GET', '/ext/hindsightkit/connection', timeout=5)
    if not isinstance(result, dict) or result.get('protocol') != 1 or result.get('routing') != 'repository':
        raise RuntimeError('This server is not compatible. Update its HindsightKit installation.')
    validate_bank(result.get('sharedBank', ''))
    return result


def identity(config):
    return (config.get('apiUrl', '').rstrip('/'), fixed_bank(config),
            config.get('hindsightkit', {}).get('routing'),
            config.get('hindsightkit', {}).get('transport'))


async def register(config):
    info = config.get('hindsightkit', {})
    if not info.get('activity'):
        return
    await request(config, 'POST', '/ext/hindsightkit/clients', body={
        'deviceId': info['deviceId'], 'name': info['name'],
        'clients': ['vscode', 'copilot-cli'], 'used': False,
    })


async def report(config, kind):
    info = config.get('hindsightkit', {})
    if not info.get('activity'):
        return
    try:
        await request(config, 'POST', '/ext/hindsightkit/clients', timeout=2, body={
            'deviceId': info['deviceId'], 'name': info['name'], 'clients': [kind], 'used': True,
        })
    except (aiohttp.ClientError, TimeoutError, RuntimeError, ValueError):
        # Inventory is optional; a reporting outage must not fail a memory operation.
        pass
