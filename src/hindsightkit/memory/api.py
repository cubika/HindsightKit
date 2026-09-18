"""Select native Hindsight banks; retrieval and learning remain upstream."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import subprocess
import uuid

SHARED_BANK = 'hindsightkit-shared'


@dataclass(frozen=True)
class Scope:
    bank: str
    repository: str | None = None
    shared_bank: str = SHARED_BANK

    @property
    def readable_banks(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((self.bank, self.shared_bank))) if self.repository else (self.bank,)


def scope_for(directory: str | Path) -> Scope:
    directory = Path(directory).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError('The session directory must be a directory.')
    # Host Git environment must not redirect discovery to another repository.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    result = subprocess.run(
        ['git', '-C', str(directory), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', env=env,
        timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    )
    if result.returncode:
        if 'not a git repository' in result.stderr.lower():
            return Scope(SHARED_BANK)
        raise RuntimeError('Cannot determine the repository; memory access was skipped: ' + result.stderr.strip())
    common = Path(result.stdout.strip()).resolve()
    root = common.parent if common.name == '.git' else common
    digest = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()[:12]
    return Scope('hindsightkit-' + digest, str(root))


class Memory:
    def __init__(self, client, scope: Scope):
        self.client, self.scope = client, scope

    async def retain(self, content: str, context: str = '') -> dict:
        if not content.strip():
            raise ValueError('Memory content cannot be empty.')
        source = self.scope.repository or 'shared, outside a Git repository'
        document_id = 'agent-' + uuid.uuid4().hex
        result = await self.client.aretain(
            bank_id=self.scope.bank, content=content, context=f'{source}\n{context}'.strip(),
            metadata={'repository': self.scope.repository or '', 'source': 'agent'},
            document_id=document_id,
        )
        return {'bank': self.scope.bank, 'document_id': document_id, 'result': result.model_dump(mode='json')}

    async def read(self, operation: str, query: str, max_tokens: int = 4096) -> dict:
        if operation not in {'recall', 'reflect'} or not query.strip():
            raise ValueError('Expected recall/reflect and a nonempty query.')
        if not 256 <= max_tokens <= 16384:
            raise ValueError('max_tokens must be between 256 and 16384.')
        banks = self.scope.readable_banks

        async def read_bank(bank):
            try:
                result = await getattr(self.client, 'a' + operation)(
                    bank_id=bank, query=query, max_tokens=max_tokens // len(banks), budget='low',
                )
                return {'bank': bank, 'result': result.model_dump(mode='json')}
            except Exception as exc:
                if getattr(exc, 'status', None) == 404:
                    return {'bank': bank, 'result': {}}
                raise

        return {'memories': await asyncio.gather(*(read_bank(bank) for bank in banks))}
