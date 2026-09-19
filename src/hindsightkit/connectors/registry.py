"""Explicit optional adapters; source-specific code stays outside the host."""
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from hindsightkit.memory.api import ReadSource


@dataclass(frozen=True)
class Connector:
    id: str
    title: str
    description: str
    module: str
    directory: str
    view: str
    assets: tuple[str, ...] = ()
    memory: ReadSource | None = None
    memory_state: str = ''


CONNECTORS = (Connector('workiq', 'WorkIQ email', 'Save useful email findings with links to their sources.',
                        'hindsightkit.connectors.workiq.adapter', 'mail', 'connectors.html', ('connectors.js', 'connectors.css'),
                        ReadSource('workiq', 'hindsightkit-mail', ('world',), 'mid'), 'sync.sqlite3'),)


class ConnectorHost:
    def __init__(self, root, config, *, registry=CONNECTORS):
        self.root, self.config = Path(root), config
        self.registry = {item.id: item for item in registry}
        if len(self.registry) != len(registry):
            raise ValueError('Connector IDs must be unique.')
        self.adapters = {}

    def spec(self, identity):
        if identity not in self.registry:
            raise ValueError('Unknown connector.')
        return self.registry[identity]

    def adapter(self, identity):
        spec = self.spec(identity)
        if identity not in self.adapters:
            self.adapters[identity] = import_module(spec.module).Adapter(self.root / spec.directory, self.config)
        return self.adapters[identity]

    def status(self, identity):
        return self.adapter(identity).status()

    def catalog(self):
        result = []
        for identity, spec in self.registry.items():
            try:
                state = self.status(identity)
            except Exception:
                state = {'config': {'enabled': False},
                         'availability': {'ready': False, 'message': 'Unable to read connector settings. Check the local configuration.'}}
            result.append({'id': identity, 'title': spec.title, 'description': spec.description,
                           'url': '/connectors/' + identity, 'enabled': state['config']['enabled'],
                           'availability': state['availability']})
        return result

    async def action(self, identity, action, data=None):
        return await self.adapter(identity).action(action, data)

    async def boot(self):
        for identity, spec in self.registry.items():
            if not (self.root / spec.directory).exists():
                continue
            try:
                adapter = self.adapter(identity)
                await adapter.boot()
            except Exception:
                # One optional integration must not take down the settings host.
                if identity in self.adapters:
                    self.adapters[identity].error = 'The connector could not resume. Open its settings to check the connection.'

    async def close(self):
        import asyncio
        results = await asyncio.gather(*(adapter.close() for adapter in self.adapters.values()), return_exceptions=True)
        if any(isinstance(result, Exception) for result in results):
            raise RuntimeError('A connector did not release its resources.')


def enabled_connectors(root, registry=CONNECTORS):
    result = []
    for spec in registry:
        directory = Path(root) / spec.directory
        if directory.exists():
            try:
                if import_module(spec.module).saved_status(directory)['config']['enabled']:
                    result.append(spec.id)
            except (OSError, ValueError, ImportError, KeyError, TypeError):
                continue
    return result


def readable_connectors(root, registry=CONNECTORS):
    """Saved imports remain readable while acquisition is paused or unavailable."""
    return [spec.id for spec in registry if spec.memory and spec.memory_state
            and (Path(root) / spec.directory / spec.memory_state).is_file()]


async def readable_sources(config, root=None, registry=CONNECTORS):
    from hindsightkit import connection
    from hindsightkit.platform.runtime import home
    if connection.fixed_bank(config):
        return ()
    if connection.client_mode(config):
        # Discovery belongs to the selected server, never the local importer.
        advertised = (await connection.discover(config)).get('connectors', [])
    else:
        advertised = readable_connectors(root if root is not None else home(), registry)
    supported = {spec.id: spec.memory for spec in registry if spec.memory}
    if not isinstance(advertised, list) or any(not isinstance(identity, str) or identity not in supported
                                              for identity in advertised):
        raise ValueError('The server advertised an unsupported connector. Update HindsightKit.')
    return tuple(supported[identity] for identity in dict.fromkeys(advertised))
