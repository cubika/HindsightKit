"""Local settings and lifecycle host for optional connector adapters."""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from aiohttp import web

WEB = Path(__file__).parent / 'web'


def read_service(directory):
    try:
        value = json.loads((Path(directory) / 'service.json').read_text(encoding='utf-8'))
        port = int(value['port'])
        if not 1024 <= port <= 65535 or not isinstance(value['token'], str):
            return None
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def service_request(info, path='/health', *, post=False):
    request = Request(f"http://127.0.0.1:{info['port']}{path}",
                      data=b'{}' if post else None,
                      headers={'X-HindsightKit-Token': info['token'], 'Content-Type': 'application/json'})
    with urlopen(request, timeout=3) as response:
        result = json.load(response)
    if result.get('instance') != info['instance']:
        raise RuntimeError('Connector port is occupied by another service.')
    return result


def is_running(directory):
    info = read_service(directory)
    if not info:
        return False
    try:
        service_request(info)
        return True
    except (OSError, ValueError, URLError, RuntimeError):
        return False


def ensure_running(directory, api_url, hindsight_url, port):
    """Start a hidden process once; only return after the page is available."""
    from hindsight_embed.profile_manager import lock_file, unlock_file
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'start.lock').open('w') as lock:
        lock_file(lock)
        try:
            if is_running(directory):
                return f"http://127.0.0.1:{read_service(directory)['port']}"
            with socket.socket() as listener:
                try:
                    listener.bind(('127.0.0.1', port))
                except OSError as exc:
                    raise RuntimeError(f'Connector port {port} is already in use.') from exc
            flags = ({'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
                     if os.name == 'nt' else {'start_new_session': True})
            with (directory / 'service.log').open('ab') as log:
                process = subprocess.Popen(
                    [sys.executable, '-m', 'hindsightkit.connectors', '--directory', str(directory),
                     '--port', str(port), '--api-url', api_url, '--hindsight-url', hindsight_url],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, **flags,
                )
            deadline = time.monotonic() + 30
            while process.poll() is None and time.monotonic() < deadline:
                if is_running(directory):
                    return f'http://127.0.0.1:{port}'
                time.sleep(0.15)
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            raise RuntimeError(f'Connector page did not start. See {directory / "service.log"}.')
        finally:
            unlock_file(lock)


def stop(directory):
    info = read_service(directory)
    if info:
        if is_running(directory):
            service_request(info, '/api/shutdown', post=True)
        deadline = time.monotonic() + 60
        while read_service(directory) == info and time.monotonic() < deadline:
            time.sleep(0.1)
        if read_service(directory) == info:
            raise RuntimeError('Connector is still stopping; Hindsight was left running.')


def make_app(host, *, port, token, instance, hindsight_url, shutdown=None):
    origin = f'http://127.0.0.1:{port}'
    hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
    origins = {origin, f'http://localhost:{port}'}

    @web.middleware
    async def local_requests(request, handler):
        if request.host not in hosts or request.remote not in {'127.0.0.1', '::1'}:
            raise web.HTTPForbidden(text='Local requests only.')
        if request.headers.get('Origin') and request.headers['Origin'] not in origins:
            raise web.HTTPForbidden(text='Origin is not allowed.')
        if request.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise web.HTTPForbidden(text='Cross-site requests are not allowed.')
        if request.method != 'GET' and not hmac.compare_digest(
                request.headers.get('X-HindsightKit-Token', ''), token):
            raise web.HTTPForbidden(text='Refresh this page before changing settings.')
        try:
            response = await handler(request)
        except (ValueError, RuntimeError) as exc:
            response = web.json_response({'error': str(exc)}, status=400)
        except web.HTTPException:
            raise
        except Exception:
            # Remote exceptions can include mailbox content or opaque tokens.
            response = web.json_response({'error': 'The operation failed. Check the connection status and try again.'}, status=503)
        response.headers.update({
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        })
        return response

    app = web.Application(middlewares=[local_requests], client_max_size=32768)

    def snapshot(identity):
        value = host.status(identity)
        return {**value, 'hindsight_url': hindsight_url + '/en/banks/' + quote(value['bank'], safe='')}

    async def page(request):
        identity = request.match_info.get('connector')
        name = host.spec(identity).view if identity else 'catalog.html'
        content = (WEB / name).read_text(encoding='utf-8')
        content = content.replace('__TOKEN__', token).replace('__CONNECTOR_ID__', identity or '')
        return web.Response(text=content, content_type='text/html')

    async def asset(request):
        name = request.match_info['name']
        allowed = {'catalog.js', 'connectors.css'} | {asset for spec in host.registry.values() for asset in spec.assets}
        if name not in allowed:
            raise web.HTTPNotFound()
        content = (WEB / name).read_text(encoding='utf-8')
        mime = {'html': 'text/html', 'css': 'text/css', 'js': 'text/javascript'}[name.rsplit('.', 1)[1]]
        return web.Response(text=content, content_type=mime)

    async def status(request):
        return web.json_response(snapshot(request.match_info['connector']))

    async def catalog(request):
        return web.json_response({'connectors': host.catalog()})

    async def health(request):
        return web.json_response({'instance': instance, 'service': 'hindsightkit-connectors'})

    async def action(request):
        name = request.match_info['action']
        identity = request.match_info['connector']
        data = None
        if name == 'config':
            try:
                data = await request.json()
            except (ValueError, UnicodeError):
                raise ValueError('Settings must be valid JSON.')
        result = await host.action(identity, name, data)
        return web.json_response(result if name == 'preview' else snapshot(identity))

    async def stop_host(request):
        if shutdown:
            shutdown.set()
        return web.json_response({'instance': instance})

    app.router.add_get('/', page)
    app.router.add_get('/connectors/{connector}', page)
    app.router.add_get(r'/{name:[A-Za-z0-9_-]+\.(?:css|js)}', asset)
    app.router.add_get('/health', health)
    app.router.add_get('/api/connectors', catalog)
    app.router.add_get('/api/connectors/{connector}', status)
    app.router.add_post('/api/connectors/{connector}/{action}', action)
    app.router.add_post('/api/shutdown', stop_host)
    return app


async def serve(directory, api_url, hindsight_url, port):
    from .connector_registry import ConnectorHost
    from . import connection
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    token, instance = secrets.token_urlsafe(32), secrets.token_hex(16)
    config = connection.server_load()
    # Credentials are loaded inside the child, never written to service.json or argv.
    host = ConnectorHost(directory.parent, config)
    shutdown = asyncio.Event()
    runner = web.AppRunner(make_app(host, port=port, token=token, instance=instance,
                                   hindsight_url=hindsight_url, shutdown=shutdown), access_log=None)
    info = {'port': port, 'token': token, 'instance': instance, 'pid': os.getpid()}
    try:
        await runner.setup()
        await web.TCPSite(runner, '127.0.0.1', port).start()
        state = directory / 'service.json'
        temporary = state.with_suffix('.tmp')
        temporary.write_text(json.dumps(info), encoding='utf-8')
        temporary.replace(state)
        await host.boot()
        await shutdown.wait()
    finally:
        await runner.cleanup()
        await host.close()
        if read_service(directory) == info:
            (directory / 'service.json').unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--hindsight-url', required=True)
    args = parser.parse_args()
    asyncio.run(serve(args.directory, args.api_url, args.hindsight_url, args.port))


if __name__ == '__main__':
    main()
