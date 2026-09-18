"""Bounded relay diagnostics containing events, never credentials or CLI output."""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time

from filelock import FileLock

from .postgres import private_directory, reject_links

MAX_BYTES = 1024 * 1024
_current = ContextVar('relay_log_root', default=None)
_warned = set()


def path(root):
    return Path(root) / 'supervisor.log'


def current_root():
    return _current.get()


def event(root, name, *, error=None, **fields):
    if root is None:
        return
    log = path(root)
    record = {'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds'),
              'pid': os.getpid(), 'event': name, **fields}
    if error is not None:
        # Exception messages, subprocess output, and request objects can contain keys.
        record['error'] = type(error).__name__
        for key in ('errno', 'winerror', 'returncode', 'status'):
            value = getattr(error, key, None)
            if type(value) is int:
                record[key] = value
    try:
        if not log.parent.exists():
            private_directory(log.parent)
        backup, lock = log.with_name(log.name + '.1'), log.with_name(log.name + '.lock')
        for item in (log, backup, lock):
            reject_links(item)
        payload = (json.dumps(record, ensure_ascii=True) + '\n').encode('utf-8')
        with FileLock(str(lock), timeout=2):
            if log.exists() and log.stat().st_size + len(payload) > MAX_BYTES:
                os.replace(log, backup)
            with log.open('ab') as output:
                output.write(payload)
    except (OSError, RuntimeError, TimeoutError) as exc:
        # Diagnostics must not break forwarding or hide the original failure.
        if log not in _warned:
            _warned.add(log)
            print(f'Cannot write relay log {log}: {type(exc).__name__}', file=sys.stderr, flush=True)


@contextmanager
def operation(root, name, **fields):
    token = _current.set(root)
    started = time.monotonic()
    event(root, name + '.started', **fields)
    try:
        yield
    except BaseException as exc:
        event(root, name + '.failed', error=exc, elapsed_seconds=round(time.monotonic() - started, 3))
        raise
    else:
        event(root, name + '.completed', elapsed_seconds=round(time.monotonic() - started, 3))
    finally:
        _current.reset(token)
