"""Optional device inventory, mounted through Hindsight's official HTTP extension."""
import hmac
import json
import os
import time
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from filelock import FileLock
from pydantic import BaseModel, Field
from hindsight_api.extensions.http import HttpExtension

MAX_DEVICES = 128
RECENT_SECONDS = 300


class Activity(BaseModel):
    deviceId: UUID
    name: str = Field(min_length=1, max_length=80, pattern=r'^[^\x00-\x1f\x7f]+$')
    clients: list[Literal['vscode', 'copilot-cli']] = Field(min_length=1, max_length=2)
    used: bool = False


class RepositoryScope(BaseModel):
    repository: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')


class Inventory:
    def __init__(self, path):
        self.path = Path(path)

    def read(self):
        if not self.path.exists():
            return {}
        if self.path.stat().st_size > 256 * 1024:
            raise RuntimeError('Client inventory exceeds its size limit.')
        return json.loads(self.path.read_text(encoding='utf-8'))

    def update(self, activity, now=None):
        now = time.time() if now is None else now
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.path) + '.lock', timeout=5):
            devices = self.read()
            identity = str(activity.deviceId)
            new = identity not in devices
            if new and len(devices) >= MAX_DEVICES:
                raise HTTPException(409, 'Client inventory is full (128 devices).')
            device = devices.setdefault(identity, {'name': activity.name, 'clients': {}})
            before = json.dumps(device, sort_keys=True)
            device['name'] = activity.name
            for kind in activity.clients:
                entry = device['clients'].setdefault(kind, {'registeredAt': now, 'lastUsed': None})
                if activity.used and (entry['lastUsed'] is None or now - entry['lastUsed'] >= 30):
                    entry['lastUsed'] = now
            if new or before != json.dumps(device, sort_keys=True):
                temporary = self.path.with_suffix('.tmp')
                temporary.write_text(json.dumps(devices), encoding='utf-8')
                os.replace(temporary, self.path)

    def snapshot(self, now=None):
        now = time.time() if now is None else now
        devices = []
        for identity, value in self.read().items():
            clients = [{'kind': kind, **entry,
                        'recent': entry['lastUsed'] is not None and 0 <= now - entry['lastUsed'] <= RECENT_SECONDS}
                       for kind, entry in sorted(value['clients'].items())]
            devices.append({'deviceId': identity, 'name': value['name'], 'clients': clients})
        return {'devices': sorted(devices, key=lambda item: (item['name'], item['deviceId'])),
                'recentSeconds': RECENT_SECONDS}


class ClientsExtension(HttpExtension):
    def get_router(self, memory):
        inventory = Inventory(self.config['clients_file'])
        router = APIRouter()

        def authorize(authorization):
            key = os.environ.get('HINDSIGHT_API_TENANT_API_KEY', '')
            if not key or not hmac.compare_digest((authorization or '').encode(), ('Bearer ' + key).encode()):
                raise HTTPException(401, 'Invalid API key')

        @router.get('/hindsightkit/connection')
        def connection(authorization: str | None = Header(default=None)):
            authorize(authorization)
            from hindsightkit.connection import validate_bank
            from hindsightkit.memory.api import SHARED_BANK
            from hindsightkit.connectors.registry import enabled_connectors
            return {'protocol': 1, 'routing': 'repository',
                    'sharedBank': validate_bank(self.config.get('memory_bank', SHARED_BANK)),
                    'connectors': enabled_connectors(inventory.path.parent)}

        @router.post('/hindsightkit/scope')
        def scope(body: RepositoryScope, authorization: str | None = Header(default=None)):
            authorize(authorization)
            from hindsightkit.connection import validate_bank
            from hindsightkit.memory.api import SHARED_BANK
            shared = validate_bank(self.config.get('memory_bank', SHARED_BANK))
            aliases = Inventory(self.config.get('aliases_file', str(inventory.path.with_name('repositories.json')))).read()
            bank = aliases.get(body.repository, 'hindsightkit-repo-' + body.repository) if body.repository else shared
            return {'bank': validate_bank(bank), 'sharedBank': shared}

        @router.get('/hindsightkit/clients')
        def clients(authorization: str | None = Header(default=None)):
            authorize(authorization)
            return inventory.snapshot()

        @router.post('/hindsightkit/clients')
        def activity(body: Activity, authorization: str | None = Header(default=None)):
            authorize(authorization)
            inventory.update(body)
            return {'ok': True}

        return router
