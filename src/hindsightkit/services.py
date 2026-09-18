"""Start, stop, and inspect managed services."""
import asyncio
import os
import re
import socket
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from . import connection, lifecycle
from . import runtime as runtime_env


def profile_config():
    from hindsight_embed.profile_manager import ProfileManager
    manager = ProfileManager()
    config = manager.load_profile_config(runtime_env.PROFILE)
    if not config:
        raise RuntimeError('HindsightKit is not configured. Run the release installer first.')
    return config, manager.resolve_profile_paths(runtime_env.PROFILE)


def start_local(*, message='Starting Hindsight (first start downloads the embedding model)...'):
    require_local()
    from .postgres import Postgres, require_postgresql, check_external
    config, paths = profile_config()
    database_url = require_postgresql(config)
    database = Postgres(runtime_env.home() / 'postgresql')
    if database.state_path.is_file() and database_url == database.url:
        database.start()
        database.validate()
    else:
        asyncio.run(check_external(database_url))
    print(message, flush=True)
    runtime_env.run([runtime_env.executable('hindsight-embed'), '--profile', runtime_env.PROFILE, 'daemon', 'start'])
    ui_url = start_ui(paths)
    from .connector_registry import enabled_connectors
    if enabled_connectors(runtime_env.home()):
        from .connectors import ensure_running
        try:
            ensure_running(runtime_env.home() / 'connectors', f'http://127.0.0.1:{paths.port}', ui_url, paths.ui_port + 1)
        except RuntimeError as exc:
            print(f'Optional connectors: {exc}', file=sys.stderr)
    return f'http://127.0.0.1:{paths.port}', ui_url


@contextmanager
def startup():
    """Keep an explicitly stopped installation stopped if startup fails."""
    previous = lifecycle.state()
    stopped = previous.get('stopped', False)
    try:
        yield
    except Exception as exc:
        if stopped:
            try:
                stop()
                lifecycle.update(**previous)
            except Exception as cleanup:
                raise RuntimeError(f'{exc}; startup cleanup failed: {cleanup}') from exc
        raise


def start():
    from .remote import resume
    has_server = connection.has_server()
    if not has_server:
        if not connection.config_path().is_file() or lifecycle.state().get('disconnected'):
            raise RuntimeError('This client is not connected. Run hindsightkit connect first.')
    with startup():
        result = start_local() if has_server else None
        lifecycle.start()
        resume()
    return result


def start_ui(paths):
    from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
    from hindsight_embed.profile_manager import lock_file, unlock_file

    ui_url = f'http://localhost:{paths.ui_port}'
    paths.ui_log.parent.mkdir(parents=True, exist_ok=True)
    with paths.ui_log.with_suffix('.start.lock').open('w') as lock:
        lock_file(lock)
        try:
            if DaemonEmbedManager().is_ui_running(runtime_env.PROFILE, paths.ui_port):
                asyncio.run(check_ui(ui_url))
            else:
                launch_ui(paths, ui_url)
            # Keep the official stop command aware of the bound port.
            paths.ui_log.with_suffix('.port').write_text(str(paths.ui_port), encoding='utf-8')
        finally:
            unlock_file(lock)
    return ui_url


def launch_ui(paths, ui_url):
    server = runtime_env.home() / 'runtime/node_modules/@vectorize-io/hindsight-control-plane/standalone/server.js'
    if not server.is_file():
        raise RuntimeError('Hindsight UI is not installed. Rerun the release installer.')
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', paths.ui_port))
        except OSError as exc:
            raise RuntimeError(f'UI port {paths.ui_port} is already in use.') from exc
    ui_env = os.environ.copy()
    ui_env.update(PORT=str(paths.ui_port), HOSTNAME='localhost',
                  HINDSIGHT_CP_DATAPLANE_API_URL=f'http://127.0.0.1:{paths.port}')
    key = connection.server_load().get('apiToken')
    if key:
        ui_env['HINDSIGHT_CP_DATAPLANE_API_KEY'] = key
    # Upstream #4379: Next.js locale rewriting loops with a literal 127.0.0.1 hostname.
    ui_env['NODE_OPTIONS'] = (ui_env.get('NODE_OPTIONS', '') + ' --dns-result-order=ipv4first').strip()
    # Run the pinned official server directly; npx/CLI child shells can create Windows consoles.
    options = ({'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
               if sys.platform == 'win32' else {'start_new_session': True})
    with paths.ui_log.open('ab') as log:
        process = subprocess.Popen(
            [runtime_env.node(), str(server)], cwd=server.parent, env=ui_env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, **options,
        )
    try:
        asyncio.run(wait_ui(ui_url, process))
    except BaseException as exc:
        if process.poll() is None:
            process.kill()
        process.wait()
        if not isinstance(exc, Exception):
            raise
        raise RuntimeError(f'Hindsight UI failed to start. See {paths.ui_log}: {exc}') from exc


async def wait_ui(url, process, timeout=30):
    import aiohttp
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        if process.poll() is not None:
            raise RuntimeError(f'Server exited with code {process.returncode}.')
        try:
            await asyncio.wait_for(check_ui(url), timeout=max(0, deadline - loop.time()))
            if process.poll() is not None:
                raise RuntimeError(f'Server exited with code {process.returncode}.')
            return
        except (aiohttp.ClientError, TimeoutError, RuntimeError):
            if loop.time() >= deadline:
                raise
            await asyncio.sleep(min(0.25, deadline - loop.time()))


async def check_ui(url):
    import aiohttp
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        async with session.get(url + '/dashboard') as response:
            content = await response.text()
            if response.status != 200 or 'Hindsight' not in content:
                raise RuntimeError('Hindsight UI health passed but its dashboard did not load.')


async def check_memory(api_url: str, api_key=None):
    bank = 'hindsightkit-check-' + uuid.uuid4().hex
    marker = 'PL-' + uuid.uuid4().hex[:10]
    client = connection.sdk({'apiUrl': api_url, 'apiToken': api_key}, timeout=180)
    error = None
    try:
        await client.aretain(
            bank_id=bank, content=f'The verification label for project Peregrine is {marker}.',
            document_id='setup-check',
        )
        recall = await client.arecall(bank_id=bank, query='What is the verification label for project Peregrine?')
        if marker not in recall.model_dump_json():
            raise RuntimeError('Retain completed but recall did not return the verification memory.')
        print('Memory check passed: Copilot inference, retain and recall.', flush=True)
    except Exception as exc:
        error = exc
        raise
    finally:
        try:
            await client.adelete_bank(bank_id=bank)
        except Exception:
            if error is None:
                raise
        finally:
            await client.aclose()


async def ensure_bank(api_url: str, bank: str, api_key=None):
    client = connection.sdk({'apiUrl': api_url, 'apiToken': api_key})
    try:
        # An empty official upsert creates the bank without changing existing settings.
        await client.acreate_bank(bank_id=bank)
    finally:
        await client.aclose()


def client_status():
    current = lifecycle.state()
    if current.get('stopped'):
        print('Client: stopped. Run hindsightkit start to resume memory.')
        return False
    if current.get('disconnected'):
        print('Client: disconnected. Run hindsightkit connect.')
        return True
    path = connection.config_path()
    if not path.is_file():
        print('Client: not connected. Run hindsightkit connect.')
        return True
    config = {}
    try:
        config = connection.load()
        asyncio.run(connection.discover(config))
        print(f'Client: connected to {config["apiUrl"]}')
        return True
    except Exception as exc:
        print(f'Client: unavailable at {config.get("apiUrl", path)}: {exc}')
        return False


def status():
    from .remote import status as remote_status
    remote_status()
    healthy = client_status()
    path = connection.config_path()
    if not connection.has_server():
        if not path.is_file():
            directory = runtime_env.home() / 'client-runtime'
            if ((directory / '.installed-lock').is_file() and
                    (directory / 'node_modules/@vectorize-io/hindsight-coding-agents/dist/installer.js').is_file()):
                print('Client: installed; not connected. Run hindsightkit connect.')
                return healthy
            raise RuntimeError('Run the release installer with -ClientOnly, then hindsightkit connect.')
        return healthy
    return server_status() and healthy


def server_status():
    from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
    from .postgres import Postgres, configured_url
    config, paths = profile_config()
    database = Postgres(runtime_env.home() / 'postgresql')
    url = configured_url(config)
    managed = database.state_path.is_file() and url == database.url
    print('Database: ' + ('standalone PostgreSQL ' + ('running' if database.running() else 'stopped')
          if managed else 'external PostgreSQL' if url.startswith(('postgresql://', 'postgres://')) else 'PostgreSQL not configured; rerun the release installer'))
    manager = DaemonEmbedManager()
    healthy = manager.is_running(runtime_env.PROFILE)
    ui = manager.is_ui_running(runtime_env.PROFILE)
    print(f'Hindsight: {"running" if healthy else "stopped"} at http://127.0.0.1:{paths.port}')
    print(f'UI: {"running" if ui else "stopped"} at http://localhost:{paths.ui_port}')
    print(f'Profile: {paths.config}\nLog: {paths.log}\nUI log: {paths.ui_log}')
    return healthy and ui and (database.running() if managed else bool(url.startswith(('postgresql://', 'postgres://'))))


def require_local():
    if not connection.has_server():
        raise RuntimeError('This is a client installation. Manage services and the dashboard on the server.')


def configure_sharing(key, bank, *, enabled=True):
    """Configure the official authentication and HTTP extension without replacing the engine."""
    config, paths = profile_config()
    updates = {
        'HINDSIGHT_API_HOST': ('0.0.0.0' if enabled else '127.0.0.1') if enabled is not None else config.get('HINDSIGHT_API_HOST', '0.0.0.0'),
        'HINDSIGHT_API_TENANT_EXTENSION': 'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',
        'HINDSIGHT_API_TENANT_API_KEY': key,
        'HINDSIGHT_API_HTTP_EXTENSION': 'hindsightkit.server:ClientsExtension',
        'HINDSIGHT_API_HTTP_CLIENTS_FILE': str(runtime_env.home() / 'clients.json'),
        'HINDSIGHT_API_HTTP_MEMORY_BANK': connection.validate_bank(bank),
        'HINDSIGHT_API_HTTP_ALIASES_FILE': str(runtime_env.home() / 'repositories.json'),
    }
    for name in ('HINDSIGHT_API_TENANT_EXTENSION', 'HINDSIGHT_API_HTTP_EXTENSION'):
        if config.get(name) and config[name] != updates[name]:
            raise RuntimeError(f'Existing {name} conflicts with shared setup.')
    if config.get('HINDSIGHT_API_MCP_AUTH_TOKEN') or config.get('HINDSIGHT_API_TENANT_MCP_AUTH_DISABLED', '').lower() in {'true', '1', 'yes'}:
        raise RuntimeError('Remove conflicting MCP authentication overrides before shared setup.')
    if any(config.get(name) != value for name, value in updates.items()):
        # Explicit shared setup may restart only this profile to apply listening/auth changes.
        if enabled is False:
            stop_profile_services(remote_connections=False)
        else:
            stop_profile_services()
        runtime_env.backup(paths.config)
        text = paths.config.read_text(encoding='utf-8')
        for name, value in updates.items():
            line = name + '=' + str(value)
            pattern = r'(?m)^' + re.escape(name) + r'=.*$'
            text = re.sub(pattern, lambda _: line, text) if re.search(pattern, text) else text.rstrip() + '\n' + line + '\n'
        paths.config.write_text(text, encoding='utf-8')


def stop_profile_services(*, remote_connections=True, database=False):
    """Stop only this installation's official services before replacing their runtime."""
    from .connectors import stop
    from hindsight_embed.daemon_embed_manager import DaemonEmbedManager
    from .remote import stop as stop_remote
    errors = []
    def attempt(operation):
        try:
            operation()
        except Exception as exc:
            errors.append(str(exc))
    if remote_connections:
        attempt(stop_remote)
    attempt(lambda: stop(runtime_env.home() / 'connectors'))
    manager = DaemonEmbedManager()
    if manager.is_ui_running(runtime_env.PROFILE):
        attempt(lambda: runtime_env.run([runtime_env.executable('hindsight-embed'), '--profile', runtime_env.PROFILE, 'ui', 'stop']))
    # A busy daemon can fail /health while it still accepts authenticated work.
    # The official stop implementation checks port ownership, not health.
    def stop_api():
        if not manager.stop(runtime_env.PROFILE):
            raise RuntimeError('The local API could not be stopped safely.')
    attempt(stop_api)
    if database:
        from .postgres import Postgres, configured_url
        def stop_database():
            config, _ = profile_config()
            local = Postgres(runtime_env.home() / 'postgresql')
            if local.state_path.is_file() and configured_url(config) == local.url:
                local.stop()
        attempt(stop_database)
    if errors:
        raise RuntimeError('; '.join(errors))


def stop():
    lifecycle.stop()
    if connection.has_server():
        stop_profile_services(database=True)
    else:
        from .remote import stop as stop_remote
        stop_remote()


def check():
    healthy = client_status()
    if connection.has_server():
        if lifecycle.state().get('stopped'):
            raise RuntimeError('HindsightKit is stopped. Run hindsightkit start before checking local memory.')
        config = connection.server_load()
        print(f'Checking local memory at {config["apiUrl"]}...')
        from .postgres import Postgres, require_postgresql, check_external
        profile, _ = profile_config()
        url = require_postgresql(profile)
        database = Postgres(runtime_env.home() / 'postgresql')
        if database.state_path.is_file() and url == database.url:
            database.validate()
        else:
            asyncio.run(check_external(url))
        asyncio.run(check_memory(config['apiUrl'], config.get('apiToken')))
    else:
        print('Local server: not installed. Only the client connection was checked.')
        if not connection.config_path().is_file() or lifecycle.state().get('disconnected'):
            healthy = False
    return healthy


def ui():
    import webbrowser
    require_local()
    _, url = start()
    webbrowser.open(url)


def connectors():
    import webbrowser
    from .connectors import ensure_running
    require_local()
    _, paths = profile_config()
    api_url, ui_url = f'http://127.0.0.1:{paths.port}', f'http://localhost:{paths.ui_port}'
    try:
        asyncio.run(connection.request(connection.server_load(), 'GET', '/health'))
    except Exception:
        api_url, ui_url = start()
    webbrowser.open(ensure_running(runtime_env.home() / 'connectors', api_url, ui_url, paths.ui_port + 1))


def clients():
    result = asyncio.run(connection.request(connection.management(), 'GET', '/ext/hindsightkit/clients'))
    print(f'{len(result["devices"])} registered machines; recent means used within 5 minutes (not online sessions).')
    for device in result['devices']:
        print(f'{device["name"]} ({device["deviceId"]}): {len(device["clients"])} clients')
        for client in device['clients']:
            used = datetime.fromtimestamp(client['lastUsed'], timezone.utc).isoformat() if client['lastUsed'] else 'never'
            print(f'  {client["kind"]}: {"recent" if client["recent"] else "inactive"}; last used {used}')
