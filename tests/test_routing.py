import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient

from provenloop import cli
from provenloop.memory import scope_for, Scope, SHARED_BANK
from provenloop.routing import repository_identity, seed_aliases, resolve
from provenloop.server import ClientsExtension


class RoutingTests(unittest.TestCase):
    def test_nondefault_origin_ports_remain_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli.run(['git', 'init', root], capture=True)
            identities = []
            for origin in ['https://git.example:3000/team/repo', 'https://git.example:4000/team/repo',
                           'https://git.example:443/team/repo', 'git@git.example:team/repo.git',
                           'https://dev.azure.com/org/project/_git/repo', 'git@ssh.dev.azure.com:v3/org/project/repo']:
                cli.run(['git', '-C', root, 'config', 'remote.origin.url', origin], capture=True)
                identities.append(repository_identity(scope_for(root)))
            self.assertNotEqual(identities[0], identities[1])
            self.assertEqual(identities[2], identities[3])
            self.assertEqual(identities[4], identities[5])

    def test_new_session_records_do_not_hide_legacy_alias_and_unpublished_bank_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli.run(['git', 'init', root], capture=True)
            selected = scope_for(root)
            sessions = root / 'sessions'
            sessions.mkdir()
            for name, bank in [('old', selected.bank), ('new', 'provenloop-repo-new-identity')]:
                (sessions / (name + '.json')).write_text(json.dumps({'_repository': str(root), 'bankId': bank}))
            aliases = root / 'repositories.json'
            seed_aliases(aliases, sessions, {}, 'device-one')
            self.assertEqual(list(json.loads(aliases.read_text()).values()), [selected.bank])

    def test_same_origin_across_paths_and_protocols_reuses_existing_server_bank(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            a, b = root / 'original', root / 'another-machine'
            for path, origin in [(a, 'https://git.example/team/repo.git'), (b, 'git@git.example:team/repo.git')]:
                path.mkdir()
                cli.run(['git', 'init', path], capture=True)
                cli.run(['git', '-C', path, 'remote', 'add', 'origin', origin], capture=True)
            first, second = scope_for(a), scope_for(b)
            self.assertNotEqual(first.bank, second.bank)
            self.assertEqual(repository_identity(first), repository_identity(second))
            sessions = root / 'sessions'
            sessions.mkdir()
            (sessions / 'session.json').write_text(json.dumps({'_repository': str(a), 'bankId': first.bank}))
            aliases = root / 'repositories.json'
            seed_aliases(aliases, sessions, {})
            ext = ClientsExtension({'clients_file': str(root / 'clients.json'), 'aliases_file': str(aliases)})
            app = FastAPI()
            app.include_router(ext.get_router(None), prefix='/ext')
            with patch.dict(os.environ, {'HINDSIGHT_API_TENANT_API_KEY': 'test-key'}), TestClient(app) as client:
                self.assertEqual(client.get('/ext/provenloop/connection').status_code, 401)
                headers = {'Authorization': 'Bearer test-key'}
                discovery = client.get('/ext/provenloop/connection', headers=headers).json()
                self.assertEqual(discovery['routing'], 'repository')
                for selected in [first, second]:
                    result = client.post('/ext/provenloop/scope', headers=headers, json={'repository': repository_identity(selected)})
                    self.assertEqual(result.json(), {'bank': first.bank, 'sharedBank': SHARED_BANK})
                self.assertEqual(client.post('/ext/provenloop/scope', headers=headers, json={}).json()['bank'], SHARED_BANK)
                self.assertEqual(client.post('/ext/provenloop/scope', headers=headers, json={'repository': '../../other'}).status_code, 422)
            self.assertEqual(json.loads(aliases.read_text())[repository_identity(first)], first.bank)

    def test_no_origin_repositories_stay_device_scoped_and_nonrepo_uses_shared(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli.run(['git', 'init', root], capture=True)
            requests = []
            async def request(config, method, path, body):
                requests.append(body)
                return {'bank': 'repo-test' if body['repository'] else SHARED_BANK, 'sharedBank': SHARED_BANK}
            with patch('provenloop.connection.request', request):
                for device in ['one', 'two']:
                    asyncio.run(resolve({'provenloop': {'routing': 'repository', 'deviceId': device}}, scope_for(root)))
                shared = asyncio.run(resolve({'provenloop': {'routing': 'repository'}}, Scope(SHARED_BANK)))
            self.assertNotEqual(requests[0]['repository'], requests[1]['repository'])
            self.assertIsNone(requests[2]['repository'])
            self.assertEqual(shared.readable_banks, (SHARED_BANK,))

    def test_alias_seeding_never_replaces_an_existing_mapping(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli.run(['git', 'init', root], capture=True)
            cli.run(['git', '-C', root, 'remote', 'add', 'origin', 'https://git.example/repo'], capture=True)
            selected = scope_for(root)
            path = root / 'repositories.json'
            path.write_text(json.dumps({repository_identity(selected): 'existing-bank'}))
            with self.assertRaisesRegex(RuntimeError, 'Multiple existing memory banks'):
                seed_aliases(path, root / 'sessions', { 'mapPathToBank': {str(root): selected.bank} })
            self.assertEqual(json.loads(path.read_text())[repository_identity(selected)], 'existing-bank')
