"""Configure optional remote access after the ordinary local installation."""
import argparse
import asyncio
import base64
import getpass
import hashlib
import json
from pathlib import Path
import re
import socket
import os
from urllib.parse import urlsplit

import aiohttp

from . import connection


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
    from .cli import home
    identity = hashlib.sha256(json.dumps(transport, sort_keys=True).encode()).hexdigest()[:16]
    return home() / 'remote/clients' / identity


def prepare_client(config, *, interactive=False):
    transport = config.get('hindsightkit', {}).get('transport')
    if transport:
        from . import relay
        if (transport.get('mode') != 'connect' or
                config.get('apiUrl') != f'http://127.0.0.1:{transport.get("local_port")}'):
            raise ValueError('Saved remote transport does not match the configured connection.')
        relay.ensure_running(client_root(transport), transport, interactive=interactive)


def resume():
    from .cli import home
    from . import relay
    host = home() / 'remote/host'
    spec = relay.load_spec(host)
    if spec:
        relay.ensure_running(host, spec)
    path = connection.config_path()
    if path.is_file():
        prepare_client(json.loads(path.read_text(encoding='utf-8')))


def stop():
    from .cli import home
    from . import relay
    root = home() / 'remote'
    relay.stop(root / 'host')
    for directory in (root / 'clients').glob('*'):
        if directory.is_dir():
            relay.stop(directory)


def status():
    from .cli import home
    from . import relay
    host_root = home() / 'remote/host'
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
    from .cli import home
    from . import relay
    root = home() / 'remote/host'
    relay.stop(root)
    # Keep the cloud tunnel private and leave deletion under its owner's control.
    (root / 'spec.json').unlink(missing_ok=True)
    print('Background relay sharing is disabled. Existing direct connections and server keys are unchanged.')


def share(args):
    from . import cli, relay
    cli.require_local()
    cli.start(remote_connections=False)
    config = connection.server_load()
    port = urlsplit(config['apiUrl']).port
    url = connection.validate_url(args.address or f'http://{socket.gethostname()}:{port}')
    invitation = {'version': 1, 'url': url, 'key': config['apiToken']}
    if args.relay:
        root = cli.home() / 'remote/host'
        spec = relay.create_host(root, port)
        relay.ensure_running(root, spec, interactive=True)
        invitation['relay'] = {name: spec[name] for name in ('tunnel_id', 'remote_port')}
    print('On the other computer, run hindsightkit connect and paste this code at its hidden prompt.')
    print('This code grants access to this memory server. Share it privately with your own computer.')
    print(encode_invitation(invitation))
    if args.relay:
        print('Remote relay is running in the background. Sign in with the same account on both computers.')
    else:
        print('Direct connection is ready. If the other computer cannot reach it, run hindsightkit share --relay here.')


async def discover(candidate):
    result = await connection.request(candidate, 'GET', '/ext/hindsightkit/connection', timeout=5)
    if result.get('protocol') != 1 or result.get('routing') != 'repository':
        raise RuntimeError('This server is not compatible. Update its HindsightKit installation.')
    return result


def connect(args):
    from . import cli, relay
    if args.api_key_env and not args.server:
        raise ValueError('--api-key-env requires --server.')
    if args.local:
        cli.require_local()
        cli.start(remote_connections=False)
        configure_client(connection.server_load())
        stop_clients()
        return
    if args.server:
        invitation = {'url': connection.validate_url(args.server),
                      'key': cli.api_key(options(api_key_env=args.api_key_env))}
    else:
        invitation = decode_invitation(getpass.getpass('Connection code (hidden): ').strip())
    candidate = {'apiUrl': invitation['url'], 'apiToken': invitation['key']}
    transport = None
    try:
        asyncio.run(discover(candidate))
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
            relay.ensure_running(root, transport, interactive=True)
            candidate['apiUrl'] = f'http://127.0.0.1:{transport["local_port"]}'
            asyncio.run(discover(candidate))
        except Exception:
            if transport != saved:
                relay.stop(root)
            raise
    # setup_client validates discovery and editor conflicts before saving the new destination.
    try:
        configure_client(candidate, transport=transport)
    except Exception:
        if transport and transport != saved:
            relay.stop(client_root(transport))
        raise
    stop_clients(except_transport=transport)


def configure_client(candidate, *, transport=None):
    """Restore the selected connection if registration fails after writing it."""
    from . import cli
    from .postgres import restrict_access
    path = connection.config_path()
    previous = path.read_bytes() if path.is_file() else None
    try:
        cli.setup_client(options(), local_server=candidate, transport=transport)
        restrict_access(path)
    except Exception:
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            temporary = path.with_name(path.name + '.restore')
            temporary.write_bytes(previous)
            restrict_access(temporary)
            os.replace(temporary, path)
        raise


def stop_clients(*, except_transport=None):
    from .cli import home
    from . import relay
    keep = client_root(except_transport) if except_transport else None
    for directory in (home() / 'remote/clients').glob('*'):
        if directory.is_dir() and directory != keep:
            relay.stop(directory)
