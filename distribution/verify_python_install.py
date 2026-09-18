"""Install release wheels into new isolated environments with all index access disabled."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run(command, env):
    subprocess.run([str(value) for value in command], env=env, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def verify(bundle: Path, uv: str, destination: Path | None = None):
    bundle = bundle.resolve(strict=True)
    manifest = json.loads((bundle / 'python-bundle.json').read_text(encoding='utf-8'))
    for name, digest in manifest['files'].items():
        path = (bundle / name).resolve(strict=True)
        if not path.is_relative_to(bundle) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Python bundle integrity check failed: ' + name)
    parent = tempfile.TemporaryDirectory(prefix='hindsightkit offline validation ') if destination is None else None
    root = Path(parent.name) if parent else destination.resolve()
    root.mkdir(parents=True, exist_ok=True)
    # An unreachable proxy makes an accidental downloader fail rather than use
    # the CI runner's network. uv itself also receives offline/no-index switches.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(('UV_', 'PIP_', 'PYTHONPATH', 'VIRTUAL_ENV'))}
    env.update(UV_CACHE_DIR=str(root / 'empty-cache'), UV_OFFLINE='1',
               UV_NO_CONFIG='1', HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1',
               ALL_PROXY='http://127.0.0.1:1', NO_PROXY='', PYTHONUTF8='1')
    try:
        roles = ('client',) if manifest.get('profile') == 'client' else ('client', 'server')
        for role in roles:
            env['UV_CACHE_DIR'] = str(root / ('empty-cache-' + role))
            venv = root / role
            if venv.exists():
                raise RuntimeError('Validation requires an unused environment directory: ' + str(venv))
            run([uv, 'venv', venv, '--python', sys.executable, '--offline', '--no-python-downloads'], env)
            python = venv / 'Scripts/python.exe'
            requirements = bundle / ('requirements-' + role + '.txt')
            command = [uv, 'pip', 'sync', '--python', python, '--offline', '--no-index',
                       '--find-links', bundle / 'wheels', '--require-hashes', '--only-binary', ':all:', requirements]
            run(command, env)
            probe = '''import importlib, importlib.metadata as m, json, pathlib, sys
import hindsightkit.cli, hindsight_client, copilot
from hindsightkit.platform.runtime import PACKAGE
from hindsightkit.setup.node_bundle import package_directory
from hindsightkit.connectors.registry import CONNECTORS
assert m.version('hindsightkit') == sys.argv[1]
assert pathlib.Path(hindsightkit.cli.__file__).resolve().is_relative_to(pathlib.Path(sys.prefix).resolve())
for name in ('node/integrate.mjs', 'scripts/install_options.ps1', 'scripts/postgres_install.ps1', 'scripts/login_task.ps1',
             'web/catalog.html', 'web/connectors.html', 'web/catalog.js', 'web/connectors.js', 'web/connectors.css'):
    assert (PACKAGE / name).is_file(), name
for role in ('client', 'server'):
    for name in ('package.json', 'package-lock.json'):
        json.loads((package_directory(PACKAGE, role) / name).read_text(encoding='utf-8'))
for connector in CONNECTORS:
    assert hasattr(importlib.import_module(connector.module), 'Adapter')
if sys.argv[2] == 'server':
    import hindsight_api, hindsight_embed, onnxruntime, asyncpg
else:
    import importlib.util
    assert importlib.util.find_spec('hindsight_api') is None
    assert importlib.util.find_spec('hindsight_embed') is None
print(json.dumps({'role':sys.argv[2], 'installed':True, 'application_version':m.version('hindsightkit')}))
'''
            run([python, '-c', probe, manifest['project_version'], role], env)
            run([uv, 'pip', 'check', '--python', python, '--offline'], env)
            for module in ('hindsightkit.cli', 'hindsightkit.setup.installer',
                           'hindsightkit.sharing.relay', 'hindsightkit.connectors.host'):
                run([python, '-m', module, '--help'], env)
            # A repeat must resolve from the same local bundle without downloads.
            run(command, env)
        print(json.dumps({'offline_installation':'passed', 'roles':list(roles),
                          'empty_cache':True, 'index_access':False, 'repeat':'passed'}))
    finally:
        if parent:
            parent.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--uv', default='uv')
    parser.add_argument('--destination', type=Path, help='Optional unused parent directory; retained for inspection.')
    args = parser.parse_args()
    verify(args.bundle, args.uv, args.destination)


if __name__ == '__main__':
    main()
