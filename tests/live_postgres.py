"""Disposable real PostgreSQL acceptance; pass an installed official distribution."""
import argparse
import asyncio
import json
from pathlib import Path
import tempfile
import os
import subprocess
import sys
import time
from unittest.mock import patch

from provenloop.postgres import Postgres, write_profile_database, require_postgresql, available_port


def check_hindsight(server, root):
    """Run the unmodified official API against the disposable non-superuser DB."""
    import aiohttp
    from provenloop import cli
    from hindsight_embed.profile_manager import ProfileManager
    config = ProfileManager().load_profile_config('provenloop')
    port = available_port(0)
    env = os.environ.copy()
    env.update(config)
    env.update(HINDSIGHT_API_DATABASE_URL=server.url, HINDSIGHT_API_DATABASE_SCHEMA='public',
               HINDSIGHT_API_HOST='127.0.0.1', HINDSIGHT_API_PORT=str(port),
               HINDSIGHT_API_WORKER_ID='provenloop-postgres-validation', PYTHONUTF8='1')
    log_path = root / 'hindsight-api.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen([sys.executable, '-m', 'hindsight_api.main'], env=env,
            stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    async def check():
        url = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 600
        async with aiohttp.ClientSession() as session:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('Hindsight API exited; see ' + str(log_path))
                try:
                    async with session.get(url + '/health', timeout=aiohttp.ClientTimeout(total=3)) as response:
                        if response.status == 200:
                            break
                except (aiohttp.ClientError, TimeoutError):
                    pass
                await asyncio.sleep(1)
            else:
                raise RuntimeError('Hindsight API startup timed out; see ' + str(log_path))
        await cli.check_memory(url)
    try:
        asyncio.run(check())
    except BaseException:
        text = log_path.read_text(encoding='utf-8', errors='replace')[-10000:]
        text = text.replace(server.state['password'], '[redacted]').replace(server.state['admin_password'], '[redacted]')
        print(text, file=sys.stderr)
        raise
    finally:
        process.terminate()
        process.wait(timeout=30)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--hindsight', action='store_true', help='Also make a real Copilot retain/recall call.')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='provenloop postgres ') as directory:
        root = Path(directory)
        source, target = Postgres(root / 'source'), Postgres(root / 'target')
        source.distribution = target.distribution = args.distribution.resolve()
        try:
            for server in (source, target):
                server.initialize()
                server.start()
                server.prepare_database()
                server.start()
                assert server.validate()['extensions']['vector'] == '0.8.6'
            if args.hindsight:
                check_hindsight(source, root)
            source.sql("CREATE TABLE migration_fixture (id bigserial PRIMARY KEY, content text, embedding vector(3)); "
                       "INSERT INTO migration_fixture(content,embedding) VALUES ('中文 memory', '[1,2,3]'); "
                       "CREATE INDEX ON migration_fixture USING hnsw (embedding vector_cosine_ops)", app=True)
            fingerprint = source.snapshot(source.connection())
            source.sql("UPDATE migration_fixture SET content='updated 中文 memory'", app=True)
            assert source.snapshot(source.connection()) != fingerprint
            backup = target.restore_legacy(source.connection())
            assert backup.is_file()
            assert target.sql('SELECT content FROM migration_fixture', app=True) == 'updated 中文 memory'
            assert target.sql("INSERT INTO migration_fixture(content) VALUES ('next') RETURNING id", app=True) == '2'
            assert source.sql('SELECT count(*) FROM migration_fixture', app=True) == '1'
            assert target.sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'provenloop_restore_%'") == '0'
            assert target.backup().stat().st_size > 0
            state = target.state_path.read_bytes()
            original_command = target.command
            def fail_restore(name, *args, **kwargs):
                if name == 'pg_restore':
                    raise RuntimeError('injected restore failure')
                return original_command(name, *args, **kwargs)
            with patch.object(target, 'command', side_effect=fail_restore):
                try:
                    target.restore_legacy(source.connection())
                except RuntimeError as error:
                    assert 'injected' in str(error)
                else:
                    raise AssertionError('Restore failure was ignored')
            assert target.state_path.read_bytes() == state
            profile = root / 'profile.env'
            profile.write_text('# custom comment\nHINDSIGHT_API_LLM_MODEL=custom\n', encoding='utf-8')
            write_profile_database(profile, target.url)
            assert '# custom comment' in profile.read_text()
            assert require_postgresql({'HINDSIGHT_EMBED_API_DATABASE_URL': target.url}) == target.url
            target.stop()
            assert not target.running()
            target.start()
            assert target.sql('SELECT count(*) FROM migration_fixture', app=True) == '2'
            if args.hindsight:
                check_hindsight(target, root)
            print(json.dumps({'postgres': '18.6', 'extensions': list(target.validate()['extensions']),
                              'restore': 'passed', 'permissions': 'passed', 'restart': 'passed',
                              'failed_restore_preserves_state': True, 'source_unchanged': True}))
        finally:
            target.stop()
            source.stop()


if __name__ == '__main__':
    main()
