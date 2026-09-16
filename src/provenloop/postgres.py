"""Provision a standalone PostgreSQL server using its official command-line tools."""
from __future__ import annotations

from contextlib import contextmanager
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
    if os.name == 'nt':
        account = execute(['whoami.exe', '/user', '/fo', 'csv', '/nh']).stdout
        sid = next(csv.reader(io.StringIO(account.strip())))[1]
        if not re.fullmatch(r'S-1-[0-9-]+', sid):
            raise RuntimeError('Cannot resolve the current Windows account SID.')
        execute(['icacls.exe', path, '/inheritance:r', '/grant:r',
                 f'*{sid}:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'])
    else:
        path.chmod(0o700)


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


class Postgres:
    def __init__(self, root: Path):
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
        private_directory(self.root)
        shell = shutil.which('powershell.exe') or shutil.which('pwsh')
        if not shell:
            raise RuntimeError('PowerShell is required to install PostgreSQL on Windows.')
        print('Installing standalone PostgreSQL and pgvector...', flush=True)
        # The installer checks hashes, compiler prerequisites and installed versions.
        result = subprocess.run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                 str(Path(__file__).with_name('postgres_install.ps1')),
                                 '-Destination', str(self.distribution),
                                 '-CacheDirectory', str(self.root / 'downloads')],
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if result.returncode:
            raise RuntimeError('PostgreSQL distribution installation failed. Resolve the reported error and rerun setup.')

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
                    "\n# ProvenLoop standalone PostgreSQL\nlisten_addresses = '127.0.0.1'\n"
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
            raise RuntimeError('Standalone PostgreSQL is not configured. Run provenloop setup.')
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

    def command(self, name, args=(), *, connection=None, input=None):
        conn = connection or self.connection()
        env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
        env.update(PGPASSWORD=conn['password'], PGCONNECT_TIMEOUT='10', PGCLIENTENCODING='UTF8',
                   PGOPTIONS='-c timezone=UTC -c datestyle=ISO,YMD -c extra_float_digits=3')
        return execute([self.binary(name), '-h', conn['host'], '-p', conn['port'],
                        '-U', conn['user'], '-w', *args], env=env, input=input,
                       sensitive=(conn['password'], self.state['admin_password'], self.state['password']))

    def sql(self, query, *, database=None, app=False, connection=None):
        conn = connection or self.connection(database=database, app=app)
        return self.command('psql', ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                            '-d', conn['database']], connection=conn, input=query + ';\n').stdout.strip()

    def prepare_database(self, database=None):
        state = self.state
        # Passwords are random URL-safe tokens, sent through stdin rather than argv.
        if self.sql("SELECT 1 FROM pg_roles WHERE rolname='hindsight'", database='postgres') != '1':
            self.sql(f"CREATE ROLE hindsight LOGIN PASSWORD '{state['password']}'", database='postgres')
        self.sql('ALTER ROLE hindsight NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', database='postgres')
        db = database or state['database']
        if self.sql(f"SELECT 1 FROM pg_database WHERE datname='{db}'", database='postgres') != '1':
            self.sql(f"CREATE DATABASE {ident(db)} OWNER hindsight TEMPLATE template0 ENCODING 'UTF8'", database='postgres')
        for extension in EXTENSIONS:
            self.sql(f'CREATE EXTENSION IF NOT EXISTS {ident(extension)} WITH SCHEMA public', database=db)
        self.sql(f"ALTER EXTENSION vector UPDATE TO '{VECTOR_VERSION}'", database=db)
        self.validate(database=db)

    def validate(self, database=None):
        info = json.loads(self.sql("SELECT json_build_object('version', current_setting('server_version_num')::int, "
            "'superuser', (SELECT rolsuper FROM pg_roles WHERE rolname=current_user), "
            "'extensions', (SELECT json_object_agg(extname, extversion) FROM pg_extension))", app=True, database=database))
        if info['version'] != 180006:
            raise RuntimeError('The running PostgreSQL version does not match the pinned 18.6 distribution.')
        if info['superuser']:
            raise RuntimeError('Hindsight must not run as a PostgreSQL superuser.')
        if info['extensions'].get('vector') != VECTOR_VERSION or not all(name in info['extensions'] for name in EXTENSIONS):
            raise RuntimeError('Required PostgreSQL extensions are missing or have an unexpected version.')
        # Exercise all installed extensions using the application's own privileges.
        self.sql("SELECT '[1,0]'::vector <=> '[1,0]'::vector; SELECT similarity('memory','memory'); "
                 "SELECT count(*) FROM pg_stat_statements; SELECT to_tsvector('simple','memory') @@ to_tsquery('simple','memory')", app=True, database=database)
        return info

    def snapshot(self, connection):
        tables = json.loads(self.sql("SELECT coalesce(json_agg(json_build_array(n.nspname,c.relname)), '[]') "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') "
            "AND n.nspname NOT LIKE 'pg_toast%' AND NOT EXISTS "
            "(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')",
            connection=connection))
        # Order-independent content fingerprints catch UPDATEs as well as inserted/deleted rows.
        return {schema + '.' + table: json.loads(self.sql(
                "SELECT json_build_array(count(*), coalesce(sum(('x'||substr(md5(row_to_json(t)::text),1,16))::bit(64)::bigint::numeric),0)::text, "
                "coalesce(sum(('x'||substr(md5(row_to_json(t)::text),17,16))::bit(64)::bigint::numeric),0)::text) "
                f'FROM {ident(schema)}.{ident(table)} t', connection=connection)) for schema, table in tables}

    def backup(self):
        directory = self.root / 'backups'
        directory.mkdir(exist_ok=True)
        target = directory / (self.state['database'] + '-' + uuid.uuid4().hex + '.dump')
        self.command('pg_dump', ['-Fc', '-f', target, '-d', self.state['database']])
        return target

    def restore_legacy(self, source):
        """Restore into a fresh database; never replace the source or a populated target."""
        directory = self.root / 'backups'
        directory.mkdir(exist_ok=True)
        tag = uuid.uuid4().hex
        archive = directory / ('pg0-' + tag + '.dump')
        database = 'hindsight_' + tag[:12]
        role = 'provenloop_restore_' + tag[:12]
        before = self.snapshot(source)
        version = int(self.sql('SHOW server_version_num', connection=source))
        if version // 10000 > 18:
            raise RuntimeError('The source database is newer than PostgreSQL 18; refusing a downgrade.')
        self.command('pg_dump', ['-Fc', '-f', archive, '-d', source['database']], connection=source)
        if self.snapshot(source) != before:
            raise RuntimeError('The source database changed during backup. Stop its writers before retrying.')
        self.sql(f'CREATE DATABASE {ident(database)} OWNER hindsight TEMPLATE template0', database='postgres')
        self.sql(f'CREATE ROLE {ident(role)} NOLOGIN SUPERUSER', database='postgres')
        try:
            conn = self.connection(database=database)
            self.command('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl',
                         '--role', role, '-d', database, archive], connection=conn)
            self.sql(f'REASSIGN OWNED BY {ident(role)} TO hindsight', database=database)
            after = self.snapshot(conn)
            if before != after:
                raise RuntimeError('Restored table counts do not match the source. The old database is unchanged.')
        finally:
            # If interrupted, a NOLOGIN role cannot expose elevated application access.
            # Reassign any committed objects before removing that temporary role.
            self.sql(f'REASSIGN OWNED BY {ident(role)} TO hindsight', database=database)
            self.sql(f'DROP ROLE {ident(role)}', database='postgres')
        self.prepare_database(database=database)
        state = self.state
        state.update(database=database, migration={'source': 'pg0', 'backup': str(archive), 'verified_tables': len(before)})
        atomic_json(self.state_path, state)
        return archive


def configured_url(config):
    return config.get(DATABASE_KEY) or os.environ.get(DATABASE_KEY) or ''


def require_postgresql(config):
    value = configured_url(config)
    if urlsplit(value).scheme not in ('postgresql', 'postgres'):
        raise RuntimeError('This profile still uses pg0. Run provenloop setup to migrate to standalone PostgreSQL.')
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
    backup = path.with_name(path.name + '.before-postgresql')
    if not backup.exists():
        shutil.copy2(path, backup)
    lines = [line for line in original.splitlines()
             if not re.match(r'^\s*(?:export\s+)?(?:HINDSIGHT_EMBED_API_DATABASE_URL|HINDSIGHT_API_DATABASE_URL)\s*=', line)]
    lines.append(DATABASE_KEY + '=' + url)
    temporary = path.with_suffix('.postgresql.tmp')
    temporary.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def legacy_connection(root: Path, tools: Postgres):
    """Use the existing pg0 installation only to read its persistent database."""
    instance = root / 'instances/hindsight-embed-provenloop'
    reject_links(instance / 'data')
    metadata = instance / 'instance.json'
    if not metadata.is_file():
        if instance.exists() and any(instance.iterdir()):
            raise RuntimeError('Legacy PostgreSQL files exist without instance.json; migration requires recovery first.')
        yield None
        return
    info = json.loads(metadata.read_text(encoding='utf-8'))
    data = Path(info['data_dir']).resolve(strict=True)
    installation = Path(info['installation_dir']).resolve(strict=True)
    reject_links(Path(info['installation_dir']))
    if data != (instance / 'data').resolve() or not installation.is_relative_to((root / 'installation').resolve()):
        raise RuntimeError('Legacy PostgreSQL metadata points outside the expected pg0 directories.')
    if not (installation / 'bin/postgres.exe').is_file():
        version = str(info.get('version', ''))
        if not re.fullmatch(r'[0-9]+[.][0-9]+[.][0-9]+', version):
            raise RuntimeError('Legacy PostgreSQL metadata has an invalid version.')
        installation = installation / version
        reject_links(installation)
    ctl = installation / 'bin/pg_ctl.exe'
    version = execute([installation / 'bin/postgres.exe', '--version']).stdout
    major = (data / 'PG_VERSION').read_text().strip()
    if not re.search(r'PostgreSQL\) ' + re.escape(major) + r'\.', version):
        raise RuntimeError('Legacy PostgreSQL binaries do not match its data directory.')
    was_running = execute([ctl, '-D', data, 'status'], allowed=(0, 3)).returncode == 0
    port = str(info['port'])
    if was_running:
        # postmaster.pid contains the actual live port, unlike stale instance metadata.
        port = (data / 'postmaster.pid').read_text().splitlines()[3]
    try:
        if not was_running:
            port = str(available_port(0))
            execute([ctl, '-D', data, '-l', tools.root / 'migration-source.log', '-w', '-t', '60',
                     '-o', f'-h 127.0.0.1 -p {port}', 'start'])
        conn = {'host': '127.0.0.1', 'port': port, 'user': info['username'],
                'password': info['password'], 'database': info['database']}
        if Path(tools.sql('SHOW data_directory', connection=conn)).resolve() != data:
            raise RuntimeError('The legacy database connection points to an unexpected cluster.')
        yield conn
    finally:
        if not was_running and execute([ctl, '-D', data, 'status'], allowed=(0, 3)).returncode == 0:
            execute([ctl, '-D', data, '-m', 'fast', '-w', '-t', '60', 'stop'])


def setup_database(root: Path, config, profile_path: Path, *, stop_api, legacy_root=None):
    server = Postgres(root)
    private_directory(server.root)
    with FileLock(str(server.root / 'setup.lock'), timeout=600):
        current = configured_url(config)
        if current and not current.startswith('pg0'):
            require_postgresql(config)
            if not server.state_path.is_file() or current != server.url:
                asyncio.run(check_external(current))
                stop_api()
                return None
        if current.startswith('pg0') and current not in ('pg0', 'pg0://hindsight-embed-provenloop'):
            raise RuntimeError('A custom pg0 database is configured. Migrate it explicitly before switching this profile.')
        server.install()
        server.initialize()
        server.start()
        server.prepare_database()
        if current == server.url:
            return server
        # Quiesce Hindsight before taking a consistent full-database backup.
        stop_api()
        try:
            # A failed profile write may leave a verified candidate. Always re-read the source
            # until the profile has switched; it could have received newer memories meanwhile.
            with legacy_connection(legacy_root or Path.home() / '.pg0', server) as source:
                if source:
                    print('Migrating existing Hindsight data to PostgreSQL; keeping the old database and backup.', flush=True)
                    before = server.snapshot(source)
                    server.restore_legacy(source)
                    stop_api()
                    if server.snapshot(source) != before:
                        raise RuntimeError('The old database changed during migration. Close its clients and rerun setup.')
                write_profile_database(profile_path, server.url)
        except BaseException:
            # Profile switching is last. A failed backup/restore never points Hindsight at an empty DB.
            raise
        return server
