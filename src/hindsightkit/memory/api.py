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
class ReadSource:
    source: str
    bank: str
    types: tuple[str, ...] = ()
    budget: str = 'low'


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
    def __init__(self, client, scope: Scope, *, config=None, root=None):
        self.client, self.scope = client, scope
        self.config, self.root = config, root

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

    async def read(self, operation: str, query: str, max_tokens: int = 4096, *, timeout=None) -> dict:
        if operation not in {'recall', 'reflect'} or not query.strip():
            raise ValueError('Expected recall/reflect and a nonempty query.')
        if not 256 <= max_tokens <= 16384:
            raise ValueError('max_tokens must be between 256 and 16384.')
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout if timeout is not None else None
        sources = [ReadSource('repository' if self.scope.repository and bank == self.scope.bank else
                              'shared' if bank == self.scope.shared_bank else 'selected', bank)
                   for bank in self.scope.readable_banks]
        errors = []
        if self.config is not None:
            from hindsightkit.connectors.registry import readable_sources
            try:
                sources.extend(await asyncio.wait_for(readable_sources(self.config, self.root),
                    timeout=min(5, timeout / 3) if timeout is not None else 5))
            except Exception:
                errors.append({'source': 'connectors', 'status': 'error',
                    'error': 'Connector sources could not be discovered; retrieval is incomplete.'})
        # Keep the broader core read if a connector advertises the same bank.
        unique = {}
        for source in sources:
            unique.setdefault(source.bank, source)
        sources = list(unique.values())
        per_source, remainder = divmod(max_tokens, len(sources))

        async def read_bank(source, tokens):
            entry = {'bank': source.bank, 'source': source.source}
            if not tokens:
                return {**entry, 'status': 'error', 'result': {},
                        'error': 'The result budget is too small to search this source.'}
            options = {'budget': source.budget}
            if operation == 'reflect':
                options['include_facts'] = True
            if source.types:
                options['types' if operation == 'recall' else 'fact_types'] = list(source.types)
            try:
                request = getattr(self.client, 'a' + operation)(
                    bank_id=source.bank, query=query, max_tokens=tokens, **options)
                result = await asyncio.wait_for(request, timeout=max(0, deadline - loop.time())
                                                if deadline is not None else None)
                return {**entry, 'status': 'ok', 'result': result.model_dump(mode='json')}
            except Exception as exc:
                if getattr(exc, 'status', None) == 404:
                    return {**entry, 'status': 'empty', 'result': {}}
                # Upstream exception text may contain credentials or source content.
                return {**entry, 'status': 'error', 'result': {},
                        'error': 'Source retrieval failed; retry before treating missing results as evidence.'}

        memories = await asyncio.gather(*(read_bank(source, per_source + (index < remainder))
                                         for index, source in enumerate(sources)))
        return {'memories': memories, 'errors': errors,
                'complete': not errors and all(item['status'] != 'error' for item in memories)}
