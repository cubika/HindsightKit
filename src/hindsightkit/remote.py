"""Configure optional remote access after the ordinary local installation."""
import argparse
import asyncio
import base64
import getpass
import hashlib
import json
import re
import socket
import os
import secrets
import subprocess
from urllib.parse import urlsplit

import aiohttp

from . import connection, lifecycle, installer, services
from . import runtime as runtime_env


PREFIX = 'hk1.'


def encode_invitation(value):
    return PREFIX + base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')


def decode_invitation(value):
    if not isinstance(value, str) or len(value) > 4096 or not value.startswith(PREFIX):
        raise ValueError('Paste the connection code produced by hindsightkit share.')
    try:
        encoded = value[len(PREFIX):]
        data = json.loads(base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True))
        if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1:
            raise ValueError()
        if not isinstance(data.get('url'), str):
            raise ValueError()
        url = connection.validate_url(data['url'])
        key = data['key']
        if not isinstance(key, str) or not key or len(key) > 1024 or not key.isascii() or any(char.isspace() for char in key):
            raise ValueError()
        result = {'version': 1, 'url': url, 'key': key}
        if 'relay' in data:
            relay = data['relay']
            if (not isinstance(relay, dict) or not isinstance(relay.get('tunnel_id'), str)
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,127}', relay['tunnel_id'])
                    or type(relay.get('remote_port')) is not int or not 1 <= relay['remote_port'] <= 65535):
                raise ValueError()
            result['relay'] = {name: relay[name] for name in ('tunnel_id', 'remote_port')}
        return result
    except (KeyError, TypeError, ValueError, UnicodeError) as exc:
        raise ValueError('The connection code is invalid. Copy a fresh code from the server.') from exc


def options(**values):
    return argparse.Namespace(**dict(dict(server=None, server_only=False, api_key_env=None,
        model=None, model_dir=None, port=None, reasoning_effort=None, no_open=True), **values))


def client_root(transport):
    identity = hashlib.sha256(json.dumps(transport, sort_keys=True).encode()).hexdigest()[:16]
    return runtime_env.home() / 'remote/clients' / identity


def prepare_client(config, *, interactive=False):
    lifecycle.require_memory()
    transport = config.get('hindsightkit', {}).get('transport')
    if transport:
        from . import relay
        if (transport.get('mode') != 'connect' or
                config.get('apiUrl') != f'http://127.0.0.1:{transport.get("local_port")}'):
            raise ValueError('Saved remote transport does not match the configured connection.')
        relay.ensure_running(client_root(transport), transport, interactive=interactive)


def resume_host():
    from . import relay
    host = runtime_env.home() / 'remote/host'
    spec = relay.load_spec(host)
    if spec:
        relay.ensure_running(host, spec)


def resume():
    current = lifecycle.state()
    if current.get('stopped'):
        return
    resume_host()
    path = connection.config_path()
    if path.is_file() and not current.get('disconnected'):
        prepare_client(json.loads(path.read_text(encoding='utf-8')))


def stop():
    from . import relay
    root = runtime_env.home() / 'remote'
    errors = []
    directories = [root / 'host'] + [item for item in (root / 'clients').glob('*') if item.is_dir()]
    for directory in directories:
        try:
            relay.stop(directory)
        except (RuntimeError, OSError, ValueError) as exc:
            errors.append(str(exc))
    if errors:
        raise RuntimeError('; '.join(errors))


def status():
    from . import relay
    host_root = runtime_env.home() / 'remote/host'
    host = relay.status(host_root) if (host_root / 'spec.json').is_file() else None
    if host:
        print('Remote sharing: ' + str(host.get('state', 'stopped')))
    path = connection.config_path()
    if path.is_file():
        config = json.loads(path.read_text(encoding='utf-8'))
        transport = config.get('hindsightkit', {}).get('transport')
        if transport:
            current = relay.status(client_root(transport))
            print('Remote connection: ' + str(current.get('state', 'stopped') if current else 'stopped'))


def unshare():
    from .postgres import private_directory, restrict_access
    root = runtime_env.home() / 'remote/host'
    # Remove saved recovery before stopping processes.
    (root / 'spec.json').unlink(missing_ok=True)
    path = connection.config_path()
    client = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None
    local = connection.server_load() if connection.has_server() else None
    uses_local = bool(local and client and is_local(client, local))
    if not uses_local and (client or not local):
        lifecycle.disconnect()
    if not uses_local and client:
        client.pop('apiToken', None)
        client.get('hindsightkit', {}).pop('transport', None)
        save_client(path, client)
    errors = []
    try:
        stop()
    except (RuntimeError, OSError, ValueError) as exc:
        errors.append(str(exc))
    if local:
        from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
        from .memory import SHARED_BANK
        running = DaemonEmbedManager().is_running(runtime_env.PROFILE)
        # Revoke old codes even if a relay process failed to stop. The official
        # API-key extension reads the replacement key on restart.
        key = secrets.token_urlsafe(32)
        profile, paths = services.profile_config()
        services.configure_sharing(key, profile.get('HINDSIGHT_API_HTTP_MEMORY_BANK', SHARED_BANK), enabled=False)
        key_path = runtime_env.home() / 'server/connection-key.txt'
        private_directory(key_path.parent)
        key_path.write_text(key, encoding='utf-8')
        restrict_access(key_path)
        restrict_access(paths.config)
        if uses_local:
            client['apiToken'] = key
            save_client(path, client)
        if running and not lifecycle.state().get('stopped'):
            services.start_local(message='Restarting local Hindsight services to revoke shared access...')
        print('Sharing disabled. Previous connection codes were revoked; local memory is preserved.')
    else:
        print('Client disconnected. Run hindsightkit connect to choose a server.')
    if errors:
        raise RuntimeError('; '.join(errors))


def is_local(client, local):
    target, server = urlsplit(client.get('apiUrl', '')), urlsplit(local['apiUrl'])
    return (target.scheme == server.scheme and target.port == server.port
            and target.hostname in {'127.0.0.1', 'localhost', '::1'}
            and not client.get('hindsightkit', {}).get('transport'))


def save_client(path, config):
    from .postgres import restrict_access
    temporary = path.with_name(path.name + '.update')
    temporary.write_text(json.dumps(config), encoding='utf-8')
    restrict_access(temporary)
    os.replace(temporary, path)


def copy_connection_code(code):
    if os.name != 'nt':
        return False
    try:
        subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command',
             "$ErrorActionPreference = 'Stop'; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
            input=code, text=True, encoding='utf-8', capture_output=True, check=True,
            timeout=5, creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def share(args):
    from . import relay
    if args.relay_provider and not args.relay:
        raise ValueError('--relay-provider requires share --relay.')
    services.require_local()
    config = connection.server_load()
    port = urlsplit(config['apiUrl']).port
    url = connection.validate_url(args.address or f'http://{socket.gethostname()}:{port}')
    profile, _ = services.profile_config()
    if profile.get('HINDSIGHT_API_HOST') == '127.0.0.1':
        from .memory import SHARED_BANK
        services.configure_sharing(profile['HINDSIGHT_API_TENANT_API_KEY'],
                              profile.get('HINDSIGHT_API_HTTP_MEMORY_BANK', SHARED_BANK), enabled=True)
    services.start_local()
    invitation = {'version': 1, 'url': url, 'key': config['apiToken']}
    if args.relay:
        root = runtime_env.home() / 'remote/host'
        spec = relay.create_host(root, port, provider=args.relay_provider)
        relay.ensure_running(root, spec, interactive=True)
        invitation['relay'] = {name: spec[name] for name in ('tunnel_id', 'remote_port')}
    lifecycle.start()
    print('On the other computer, run hindsightkit connect and paste this code at its hidden prompt.')
    print('This code grants access to this memory server. Share it privately with your own computer.')
    code = encode_invitation(invitation)
    print(code)
    if copy_connection_code(code):
        print('Connection code copied to clipboard.')
    else:
        print('Could not copy to clipboard. Copy the connection code above manually.')
    if args.relay:
        print('Remote relay is running in the background. Sign in with the same account on both computers.')
    else:
        print('Direct connection is ready. If the other computer cannot reach it, run hindsightkit share --relay here.')


def connect(args):
    from . import relay
    if args.relay_provider and (args.local or args.server):
        raise ValueError('--relay-provider requires a connection code; omit --local and --server.')
    if args.api_key_env and not args.server:
        raise ValueError('--api-key-env requires --server.')
    if args.local:
        services.require_local()
        with services.startup():
            services.start_local()
            configure_client(connection.server_load())
            stop_clients()
        return
    if args.server:
        invitation = {'url': connection.validate_url(args.server),
                      'key': installer.api_key(options(api_key_env=args.api_key_env))}
    else:
        invitation = decode_invitation(getpass.getpass('Connection code (hidden): ').strip())
    candidate = {'apiUrl': invitation['url'], 'apiToken': invitation['key']}
    transport = None
    try:
        discovered = asyncio.run(connection.discover(candidate))
        print('Direct connection verified.')
    except (aiohttp.ClientConnectorCertificateError, aiohttp.ClientConnectorSSLError):
        raise
    except (aiohttp.ClientConnectionError, TimeoutError, socket.gaierror) as exc:
        if not invitation.get('relay'):
            raise RuntimeError('The server is not reachable. Check its address and service, or run hindsightkit share --relay on the server and use the new code.') from exc
        print('Direct connection is unavailable. Setting up a private relay; sign in with the server account if prompted.')
        previous = connection.load() if connection.config_path().is_file() else {}
        saved = previous.get('hindsightkit', {}).get('transport', {})
        transport = {'mode': 'connect', **invitation['relay']}
        if all(saved.get(name) == transport[name] for name in transport):
            transport['local_port'] = saved['local_port']
        else:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                transport['local_port'] = listener.getsockname()[1]
        root = client_root(transport)
        try:
            relay.ensure_running(root, transport, interactive=True, provider=args.relay_provider)
            candidate['apiUrl'] = f'http://127.0.0.1:{transport["local_port"]}'
            print('Private relay is ready. Checking the memory server through it...', flush=True)
            try:
                discovered = asyncio.run(connection.discover(candidate))
            except (aiohttp.ClientConnectionError, TimeoutError, socket.gaierror) as exc:
                detail = str(exc).strip() or type(exc).__name__
                raise RuntimeError('The private relay started, but the memory server could not be reached through it. '
                                   'Run hindsightkit status --test-memory on the server. ' + detail) from exc
        except Exception:
            if transport != saved:
                relay.stop(root)
            raise
    # setup_client validates discovery and editor conflicts before saving the new destination.
    try:
        configure_client(candidate, transport=transport, discovered=discovered)
    except Exception:
        if transport and transport != saved:
            relay.stop(client_root(transport))
        raise
    stop_clients(except_transport=transport)


def configure_client(candidate, *, transport=None, discovered=None):
    installer.setup_client(options(), local_server=candidate, transport=transport, discovered=discovered)


def stop_clients(*, except_transport=None):
    from . import relay
    keep = client_root(except_transport) if except_transport else None
    for directory in (runtime_env.home() / 'remote/clients').glob('*'):
        if directory.is_dir() and directory != keep:
            relay.stop(directory)
