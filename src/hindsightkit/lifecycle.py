"""Persistent controls shared by CLI commands and running memory integrations."""
import json
import os
import uuid

from filelock import FileLock


def path():
    from .cli import home
    return home() / 'service-state.json'


def state():
    file = path()
    return json.loads(file.read_text(encoding='utf-8')) if file.is_file() else {}


def update(**changes):
    file = path()
    file.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(str(file) + '.lock', timeout=5):
        current = state()
        current.update(changes)
        temporary = file.with_suffix('.tmp')
        temporary.write_text(json.dumps(current), encoding='utf-8')
        os.replace(temporary, file)
    return current


def stop():
    update(stopped=True, capture_epoch=uuid.uuid4().hex)


def start():
    update(stopped=False)


def disconnect():
    update(disconnected=True, capture_epoch=uuid.uuid4().hex, connection_epoch=uuid.uuid4().hex)


def connected():
    update(stopped=False, disconnected=False, connection_epoch=uuid.uuid4().hex, capture_epoch=uuid.uuid4().hex)


def available(current=None):
    current = state() if current is None else current
    return not current.get('stopped') and not current.get('disconnected')


def require_memory(*, connection_epoch=None):
    current = state()
    if current.get('stopped'):
        raise RuntimeError('HindsightKit is stopped. Run hindsightkit start to resume memory.')
    if current.get('disconnected'):
        raise RuntimeError('This client is disconnected. Run hindsightkit connect.')
    if connection_epoch is not None and connection_epoch != current.get('connection_epoch', ''):
        raise RuntimeError('The memory connection changed. Restart the Hindsight MCP server.')
    return current
