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
from unittest.mock import Mock, patch

from hindsightkit.setup.postgres import Postgres, require_postgresql, available_port, setup_database, DATABASE_KEY


def check_hindsight(server, root):
    """Run the unmodified official API against the disposable non-superuser DB."""
    import aiohttp
    from hindsightkit import cli
    from hindsightkit.setup import installer
    from hindsightkit import services
    from hindsightkit.platform import runtime as runtime_env
    from hindsight_embed.profile_manager import ProfileManager
    config = ProfileManager().load_profile_config('hindsightkit')
    port = available_port(0)
    env = os.environ.copy()
    env.update(config)
    env.update(HINDSIGHT_API_DATABASE_URL=server.url, HINDSIGHT_API_DATABASE_SCHEMA='public',
               HINDSIGHT_API_HOST='127.0.0.1', HINDSIGHT_API_PORT=str(port),
               HINDSIGHT_API_WORKER_ID='hindsightkit-postgres-validation', PYTHONUTF8='1')
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
        await services.check_memory(url)
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
    with tempfile.TemporaryDirectory(prefix='hindsightkit postgres ') as directory:
        root = Path(directory)
        profile = root / 'profile.env'
        profile.write_text('# custom comment\nHINDSIGHT_API_LLM_MODEL=custom\n', encoding='utf-8')
        stop_api = Mock()
        def installed_distribution(server):
            server.distribution = args.distribution.resolve()
        server = Postgres(root / 'postgresql')
        server.distribution = args.distribution.resolve()
        try:
            with patch.object(Postgres, 'install', installed_distribution):
                server = setup_database(root / 'postgresql', {}, profile, stop_api=stop_api)
                stop_api.assert_called_once_with()
                server.sql("CREATE TABLE persistence_fixture (id bigserial PRIMARY KEY, content text, embedding vector(3)); "
                           "INSERT INTO persistence_fixture(content,embedding) VALUES ('中文 memory', '[1,2,3]'); "
                           "CREATE INDEX ON persistence_fixture USING hnsw (embedding vector_cosine_ops)", app=True)
                saved = profile.read_bytes()
                server = setup_database(root / 'postgresql', {DATABASE_KEY: server.url}, profile, stop_api=stop_api)
                stop_api.assert_called_once_with()
                assert profile.read_bytes() == saved
            assert '# custom comment' in profile.read_text()
            assert require_postgresql({DATABASE_KEY: server.url}) == server.url
            server.stop()
            assert not server.running()
            server.start()
            assert server.sql('SELECT content FROM persistence_fixture', app=True) == '中文 memory'
            assert server.sql("INSERT INTO persistence_fixture(content) VALUES ('next') RETURNING id", app=True) == '2'
            assert not (server.root / 'backups').exists()
            if args.hindsight:
                check_hindsight(server, root)
            print(json.dumps({'postgres': '18.6', 'extensions': list(server.validate()['extensions']),
                              'setup': 'passed', 'permissions': 'passed', 'restart': 'passed',
                              'repeated_setup_preserves_data': True}))
        finally:
            server.stop()


if __name__ == '__main__':
    main()
