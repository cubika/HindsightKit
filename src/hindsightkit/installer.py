"""Internal entry point used by the PowerShell installers."""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from . import cli


def record_mode(args):
    """Commit the selected role only after installation has succeeded."""
    mode = ('client-only' if args.server or getattr(args, 'client_only', False) else
            'server-only' if getattr(args, 'server_only', False) else 'full')
    path = cli.home() / 'installation.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.installation-', suffix='.json', delete=False) as handle:
            temporary = Path(handle.name)
            json.dump({'schema': 1, 'mode': mode}, handle)
            handle.write('\n')
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Configure HindsightKit after installing its dependencies.')
    parser.add_argument('--port', type=int)
    parser.add_argument('--model')
    parser.add_argument('--reasoning-effort', choices=['low', 'medium', 'high', 'xhigh', 'max'])
    parser.add_argument('--model-dir')
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--server')
    parser.add_argument('--client-only', action='store_true')
    parser.add_argument('--server-only', action='store_true')
    parser.add_argument('--api-key-env')
    args = parser.parse_args(argv)
    try:
        cli.prepare_env()
        launcher = cli.setup(args)
        print('Checking installed command...', flush=True)
        cli.run([launcher, '--help'], capture=True)
        record_mode(args)
        return 0
    except Exception as exc:
        print(f'HindsightKit installation: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
