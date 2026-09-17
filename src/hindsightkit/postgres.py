"""Provision a standalone PostgreSQL server using its official command-line tools."""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import uuid
from urllib.parse import quote, urlsplit

from filelock import FileLock

POSTGRES_VERSION = '18.6'
VECTOR_VERSION = '0.8.6'
DATABASE_KEY = 'HINDSIGHT_EMBED_API_DATABASE_URL'
EXTENSIONS = ('vector', 'pg_trgm', 'pg_stat_statements')


def execute(command, *, env=None, input=None, allowed=(0,), sensitive=()):
    # On Windows postgres children can inherit pg_ctl's output handles. Files avoid
    # waiting forever for pipe EOF after pg_ctl itself has already exited.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(
            [str(item) for item in command], input=input, env=env, stdout=output, stderr=output,
            text=True, encoding='utf-8', errors='replace', timeout=1800,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        output.seek(0)
        result.stdout = output.read().decode('utf-8', errors='replace')
        result.stderr = ''
    if result.returncode not in allowed:
        detail = (result.stderr or result.stdout)[-3000:]
        for value in sensitive:
            if value:
                detail = detail.replace(value, '[redacted]')
        raise RuntimeError(f'{Path(command[0]).name} failed ({result.returncode}): {detail}')
    return result


def private_directory(path: Path):
    reject_links(path)
    path.mkdir(parents=True, exist_ok=True)
    restrict_access(path, directory=True)


def restrict_access(path: Path, *, directory=False):
    if os.name == 'nt':
        account = execute(['whoami.exe', '/user', '/fo', 'csv', '/nh']).stdout
        sid = next(csv.reader(io.StringIO(account.strip())))[1]
        if not re.fullmatch(r'S-1-[0-9-]+', sid):
            raise RuntimeError('Cannot resolve the current Windows account SID.')
        permission = '(OI)(CI)F' if directory else 'F'
        execute(['icacls.exe', path, '/inheritance:r', '/grant:r',
                 f'*{sid}:{permission}', f'*S-1-5-18:{permission}'])
    else:
        path.chmod(0o700 if directory else 0o600)


def reject_links(path: Path):
    for item in (path, *path.parents):
        if item.exists() and (item.is_symlink() or item.is_junction()):
            raise RuntimeError(f'PostgreSQL paths must not traverse a junction or symbolic link: {item}')


def atomic_json(path: Path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def available_port(preferred=15432):
    with socket.socket() as listener:
        try:
            listener.bind(('127.0.0.1', preferred))
        except OSError:
            listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def release_distribution():
    manifest_path = os.environ.get('HINDSIGHTKIT_RELEASE_MANIFEST')
    if manifest_path is None:
        # Release setup uses uv's editable app/src/hindsightkit package. Keep
        # later CLI setup calls on that app's release without searching ancestors.
        adjacent = Path(__file__).resolve().parents[2] / 'release.json'
        if not adjacent.exists():
            return None
        manifest_path = str(adjacent)
    try:
        if not manifest_path:
            raise ValueError('manifest path is empty')
        manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
        if not isinstance(manifest, dict) or type(manifest.get('schema')) is not int or manifest['schema'] != 1:
            raise ValueError('unsupported schema')
        if not all(isinstance(manifest.get(name), str) and manifest[name].strip()
                   for name in ('version', 'repository', 'release_url')):
            raise ValueError('release metadata is missing')
        requires_auth = manifest.get('requires_auth', False)
        if type(requires_auth) is not bool:
            raise ValueError('requires_auth must be a boolean')
        distribution = manifest.get('postgres')
        if not isinstance(distribution, dict):
            raise ValueError('PostgreSQL distribution is missing')
        if (distribution.get('postgres_version') != POSTGRES_VERSION
                or distribution.get('vector_version') != VECTOR_VERSION):
            raise ValueError('PostgreSQL or pgvector version differs from this runtime')
        url = distribution.get('url')
        if not isinstance(url, str) or any(char.isspace() for char in url):
            raise ValueError('PostgreSQL URL is invalid')
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError('PostgreSQL URL must use HTTPS without credentials or a fragment')
        digest = distribution.get('sha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', digest):
            raise ValueError('PostgreSQL SHA256 is invalid')
        if requires_auth:
            repository, tag = manifest['repository'], manifest['version']
            if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository)
                    or not re.fullmatch(r'v\d+\.\d+\.\d+(?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', tag)):
                raise ValueError('Authenticated release repository or tag is invalid')
            base = f'https://{parsed.netloc}/{repository}/releases/download/{tag}'
            asset = parsed.path.rsplit('/', 1)[-1]
            if (parsed.query or manifest['release_url'] != base or url != base + '/' + asset
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*\.zip', asset)):
                raise ValueError('PostgreSQL URL does not match the authenticated repository, tag and asset')
            return url, digest.upper(), repository, tag
        return url, digest.upper(), None, None
    except (OSError, ValueError, TypeError) as exc:
        raise RuntimeError(f'Invalid HindsightKit release manifest {manifest_path!r}: {exc}') from exc


class Postgres:
    def __init__(self, root: Path):
        reject_links(root)
        self.root = root.resolve()
        self.distribution = self.root / ('server-' + POSTGRES_VERSION)
        self.data = self.root / 'data'
        self.state_path = self.root / 'cluster.json'
        self.log = self.root / 'postgresql.log'

    @property
    def state(self):
        return json.loads(self.state_path.read_text(encoding='utf-8'))

    def binary(self, name):
        return self.distribution / 'bin' / (name + ('.exe' if os.name == 'nt' else ''))

    def install(self):
        distribution = release_distribution()
        private_directory(self.root)
        shell = shutil.which('powershell.exe') or shutil.which('pwsh')
        if not shell:
            raise RuntimeError('PowerShell is required to install PostgreSQL on Windows.')
        print('Installing standalone PostgreSQL and pgvector...', flush=True)
        # PowerShell 7's inherited module path can hide Windows PowerShell's built-ins.
        env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
        command = [shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                   str(Path(__file__).with_name('postgres_install.ps1')),
                   '-Destination', str(self.distribution),
                   '-CacheDirectory', str(self.root / 'downloads')]
        if distribution:
            command += ['-DistributionUrl', distribution[0], '-DistributionSha256', distribution[1]]
            if distribution[2]:
                command += ['-ReleaseRepository', distribution[2], '-ReleaseTag', distribution[3]]
        # Stream every stage immediately, retaining a bounded tail for failures.
        detail = ''
        with subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, encoding='utf-8', errors='replace', bufsize=1,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
            for line in process.stdout:
                print(line, end='', flush=True)
                detail = (detail + line)[-3000:]
            code = process.wait()
        if code:
            raise RuntimeError(f'PostgreSQL distribution installation failed (exit {code}): {detail}')

    def initialize(self):
        private_directory(self.root)
        reject_links(self.data)
        if self.data.exists() and not self.state_path.is_file():
            raise RuntimeError('PostgreSQL data exists without its cluster configuration; refusing to initialize over it.')
        if not self.state_path.is_file():
            atomic_json(self.state_path, {'version': POSTGRES_VERSION, 'port': available_port(),
                        'admin_password': secrets.token_urlsafe(32),
                        'password': secrets.token_urlsafe(32), 'database': 'hindsight'})
        state = self.state
        if state['version'] != POSTGRES_VERSION:
            raise RuntimeError('The PostgreSQL cluster needs an explicit version upgrade; its data was preserved.')
        if self.data.exists():
            if (self.data / 'PG_VERSION').read_text().strip() != POSTGRES_VERSION.split('.')[0]:
                raise RuntimeError('PostgreSQL major version differs from the existing data directory.')
            return
        # Failed/interrupted initdb leaves only this attempt's staging directory.
        stage = self.root / ('init-' + uuid.uuid4().hex)
        password_file = self.root / ('password-' + uuid.uuid4().hex)
        try:
            password_file.write_text(state['admin_password'], encoding='utf-8')
            execute([self.binary('initdb'), '-D', stage, '-U', 'postgres',
                     '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256',
                     '--data-checksums', '--pwfile', password_file], sensitive=(state['admin_password'],))
            with (stage / 'postgresql.conf').open('a', encoding='utf-8') as config:
                config.write(
                    "\n# HindsightKit standalone PostgreSQL\nlisten_addresses = '127.0.0.1'\n"
                    f"port = {int(state['port'])}\npassword_encryption = 'scram-sha-256'\n"
                    "shared_preload_libraries = 'pg_stat_statements'\ncompute_query_id = auto\n"
                )
            os.replace(stage, self.data)
        finally:
            password_file.unlink(missing_ok=True)
            if stage.is_dir():
                shutil.rmtree(stage)

    def running(self):
        if not self.state_path.is_file() or not self.binary('pg_ctl').is_file() or not self.data.is_dir():
            return False
        return execute([self.binary('pg_ctl'), '-D', self.data, 'status'], allowed=(0, 3)).returncode == 0

    def start(self):
        reject_links(self.data)
        if not self.state_path.is_file() or not self.data.is_dir():
            raise RuntimeError('Standalone PostgreSQL is not configured. Run hindsightkit setup.')
        if not self.running():
            with socket.socket() as listener:
                try:
                    listener.bind(('127.0.0.1', int(self.state['port'])))
                except OSError as exc:
                    raise RuntimeError('The configured PostgreSQL port is occupied; the other process was preserved.') from exc
            execute([self.binary('pg_ctl'), '-D', self.data, '-l', self.log, '-w', '-t', '60', 'start'])
        actual = self.sql('SHOW data_directory', database='postgres')
        if Path(actual).resolve() != self.data:
            raise RuntimeError('PostgreSQL answered from an unexpected data directory.')

    def stop(self):
        reject_links(self.data)
        if self.running():
            execute([self.binary('pg_ctl'), '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop'])

    def connection(self, *, database=None, app=False):
        state = self.state
        return {'host': '127.0.0.1', 'port': str(state['port']),
                'user': 'hindsight' if app else 'postgres',
                'password': state['password'] if app else state['admin_password'],
                'database': database or state['database']}

    @property
    def url(self):
        conn = self.connection(app=True)
        return f"postgresql://hindsight:{quote(conn['password'], safe='')}@127.0.0.1:{conn['port']}/{conn['database']}"

    def sql(self, query, *, database=None, app=False):
        conn = self.connection(database=database, app=app)
        env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
        env.update(PGPASSWORD=conn['password'], PGCONNECT_TIMEOUT='10', PGCLIENTENCODING='UTF8')
        return execute([self.binary('psql'), '-h', conn['host'], '-p', conn['port'],
                        '-U', conn['user'], '-w', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                        '-d', conn['database']], env=env, input=query + ';\n',
                       sensitive=(conn['password'], self.state['admin_password'], self.state['password'])).stdout.strip()

    def prepare_database(self):
        state = self.state
        # Passwords are random URL-safe tokens, sent through stdin rather than argv.
        if self.sql("SELECT 1 FROM pg_roles WHERE rolname='hindsight'", database='postgres') != '1':
            self.sql(f"CREATE ROLE hindsight LOGIN PASSWORD '{state['password']}'", database='postgres')
        self.sql('ALTER ROLE hindsight NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', database='postgres')
        db = state['database']
        if self.sql(f"SELECT 1 FROM pg_database WHERE datname='{db}'", database='postgres') != '1':
            self.sql(f"CREATE DATABASE {ident(db)} OWNER hindsight TEMPLATE template0 ENCODING 'UTF8'", database='postgres')
        for extension in EXTENSIONS:
            self.sql(f'CREATE EXTENSION IF NOT EXISTS {ident(extension)} WITH SCHEMA public', database=db)
        self.sql(f"ALTER EXTENSION vector UPDATE TO '{VECTOR_VERSION}'", database=db)
        self.validate()

    def validate(self):
        info = json.loads(self.sql("SELECT json_build_object('version', current_setting('server_version_num')::int, "
            "'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname=current_user), "
            "'extensions', (SELECT json_object_agg(extname, extversion) FROM pg_extension))", app=True))
        if info['version'] != 180006:
            raise RuntimeError('The running PostgreSQL version does not match the pinned 18.6 distribution.')
        if info['superuser']:
            raise RuntimeError('Hindsight must not run as a PostgreSQL superuser.')
        if info['extensions'].get('vector') != VECTOR_VERSION or not all(name in info['extensions'] for name in EXTENSIONS):
            raise RuntimeError('Required PostgreSQL extensions are missing or have an unexpected version.')
        # Exercise all installed extensions using the application's own privileges.
        self.sql("SELECT '[1,0]'::vector <=> '[1,0]'::vector; SELECT similarity('memory','memory'); "
                 "SELECT count(*) FROM pg_stat_statements; SELECT to_tsvector('simple','memory') @@ to_tsquery('simple','memory')", app=True)
        return info


def configured_url(config):
    return config.get(DATABASE_KEY) or os.environ.get(DATABASE_KEY) or ''


def require_postgresql(config):
    value = configured_url(config)
    if urlsplit(value).scheme not in ('postgresql', 'postgres'):
        raise RuntimeError('A PostgreSQL connection is required. Run hindsightkit setup to configure it.')
    return value


async def check_external(url):
    """Check an explicitly configured server without altering its roles or services."""
    import asyncpg
    try:
        connection = await asyncpg.connect(url, timeout=10)
        try:
            version = int(await connection.fetchval('SHOW server_version_num'))
            extensions = dict(await connection.fetch('SELECT extname, extversion FROM pg_extension'))
            if version < 140000 or not {'vector', 'pg_trgm'} <= extensions.keys():
                raise RuntimeError('External PostgreSQL requires version 14+ with vector and pg_trgm enabled in this database.')
            if tuple(map(int, extensions['vector'].split('.'))) < (0, 8, 0):
                raise RuntimeError('External PostgreSQL requires pgvector 0.8 or newer.')
            await connection.fetchval("SELECT '[1,0]'::vector <=> '[1,0]'::vector")
            await connection.fetchval("SELECT similarity('memory','memory')")
        finally:
            await connection.close()
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError('Cannot validate the external PostgreSQL connection. Check its credentials, network and extensions.') from None


def write_profile_database(path: Path, url):
    original = path.read_text(encoding='utf-8')
    lines = [line for line in original.splitlines()
             if not re.match(r'^\s*(?:export\s+)?(?:HINDSIGHT_EMBED_API_DATABASE_URL|HINDSIGHT_API_DATABASE_URL)\s*=', line)]
    lines.append(DATABASE_KEY + '=' + url)
    temporary = path.with_suffix('.postgresql.tmp')
    temporary.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    restrict_access(temporary)
    os.replace(temporary, path)


def setup_database(root: Path, config, profile_path: Path, *, stop_api):
    server = Postgres(root)
    private_directory(server.root)
    with FileLock(str(server.root / 'setup.lock'), timeout=600):
        current = configured_url(config)
        if current:
            require_postgresql(config)
            if not server.state_path.is_file() or current != server.url:
                asyncio.run(check_external(current))
                stop_api()
                return None
        server.install()
        server.initialize()
        server.start()
        server.prepare_database()
        if current != server.url:
            stop_api()
            write_profile_database(profile_path, server.url)
        return server
