"""Protect local state directories and replace JSON files atomically."""
import csv
import io
import json
import os
from pathlib import Path
import re

from hindsightkit.platform.process import execute


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
            raise RuntimeError(f'Managed paths must not traverse a junction or symbolic link: {item}')


def atomic_json(path: Path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)
