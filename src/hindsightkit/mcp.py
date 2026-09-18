"""Native memory operations with host-selected, session-fixed bank access."""
import asyncio
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import Middleware
from . import connection, lifecycle, memory_control
from .memory import Memory, Scope, SHARED_BANK, scope_for
from .routing import resolve


def scope_from_roots(roots) -> Scope:
    scopes = set()
    for root in roots:
        uri = urlparse(str(root.uri))
        if uri.scheme != 'file' or uri.netloc not in {'', 'localhost'}:
            raise ValueError('Memory routing requires a local file workspace.')
        scopes.add(scope_for(Path(url2pathname(uri.path))))
    if len(scopes) > 1:
        raise ValueError('Open one repository per VS Code window to keep memory isolated.')
    return next(iter(scopes), Scope(SHARED_BANK))


def serve(context: str, directory: str | None = None):
    config = connection.load()
    connection_epoch = lifecycle.state().get('connection_epoch', '')
    from .remote import prepare_client
    instructions = ('Use retain, recall and reflect with this installation\'s selected shared bank.'
                    if connection.fixed_bank(config) else
                    'Use retain, recall and reflect. Repository memory stays in this repository; shared memory is read-only inside repositories.')
    server = FastMCP('HindsightKit', instructions=instructions)
    # A CLI process inherits the agent's launch cwd. VS Code supplies MCP roots.
    scope = Scope(connection.fixed_bank(config)) if connection.fixed_bank(config) else None
    local_scope = None
    repository = None
    session_event = None
    if context == 'cli':
        session_id = os.environ.get('COPILOT_AGENT_SESSION_ID')
        if session_id:
            from .hooks import session_config
            session_event = {'sessionId': session_id, 'cwd': directory or os.getcwd()}
            _, pinned = session_config(session_event, config, resolve_scope=False)
            repository = pinned['_memory_repository']
            if not pinned['_scope_pending']:
                scope = Scope(pinned['bankId'], pinned['_repository'], pinned.get('_shared_bank', SHARED_BANK))
        else:
            local_scope = scope_for(directory or os.getcwd())
            repository = local_scope.repository
    lock = asyncio.Lock()
    root_uris = None

    async def memory(ctx: Context):
        nonlocal scope, root_uris, local_scope, repository
        async with lock:
            lifecycle.require_memory(connection_epoch=connection_epoch)
            # A local server can rotate its sharing key without changing scope.
            if connection.config_path().is_file():
                current = connection.load()
                if current.get('apiUrl') == config.get('apiUrl'):
                    config['apiToken'] = current.get('apiToken')
            if context == 'vscode':
                capabilities = ctx.session.client_capabilities if ctx is not None else None
                if capabilities and capabilities.roots:
                    roots = await asyncio.wait_for(ctx.session.list_roots(), timeout=5)
                    current = tuple(sorted(str(root.uri) for root in roots.roots))
                    if root_uris is not None and current != root_uris:
                        raise ValueError('The workspace changed. Restart the Hindsight MCP server before using memory.')
                    if local_scope is None:
                        local_scope = await asyncio.to_thread(scope_from_roots, roots.roots)
                        repository = local_scope.repository
                        root_uris = current
                else:
                    raise ValueError('VS Code did not supply workspace roots; repository memory access is unavailable.')
            if not (await asyncio.to_thread(memory_control.state, repository)).enabled:
                raise ToolError('Memory is disabled for this repository. Run hindsightkit memory on to enable it.')
            await asyncio.to_thread(prepare_client, config)
            if scope is None:
                if session_event is not None:
                    _, pinned = await asyncio.to_thread(session_config, session_event, config)
                    if pinned['_scope_pending']:
                        raise ToolError('Memory is disabled for this repository. Run hindsightkit memory on to enable it.')
                    scope = Scope(pinned['bankId'], pinned['_repository'], pinned.get('_shared_bank', SHARED_BANK))
                else:
                    scope = await resolve(config, local_scope)
        return scope

    class RepositoryMemoryGuard(Middleware):
        async def on_call_tool(self, request, call_next):
            # Covers optional connector tools as well as core memory operations.
            try:
                await memory(request.fastmcp_context)
            except (ValueError, RuntimeError, OSError) as exc:
                raise ToolError(str(exc)) from exc
            return await call_next(request)

    server.add_middleware(RepositoryMemoryGuard())

    async def call(ctx, operation, **arguments):
        # The middleware has already checked the switch and resolved the scope.
        if scope is None:
            raise RuntimeError('Memory scope was not initialized.')
        client = connection.sdk(config, timeout=330)
        try:
            service = Memory(client, scope)
            result = await service.retain(**arguments) if operation == 'retain' else await service.read(operation, **arguments)
            await connection.report(config, 'copilot-cli' if context == 'cli' else 'vscode')
            return result
        finally:
            await client.aclose()

    @server.tool
    async def retain(content: str, ctx: Context, context: str = '') -> dict:
        """Remember a fact in this repository, or in shared memory outside Git."""
        return await call(ctx, 'retain', content=content, context=context)

    @server.tool
    async def recall(query: str, ctx: Context, max_tokens: int = 4096) -> dict:
        """Find relevant memory from this repository and shared memory."""
        return await call(ctx, 'recall', query=query, max_tokens=max_tokens)

    @server.tool
    async def reflect(query: str, ctx: Context, max_tokens: int = 4096) -> dict:
        """Ask Hindsight to reason over each accessible bank; results identify their source."""
        return await call(ctx, 'reflect', query=query, max_tokens=max_tokens)

    from .connector_registry import register_tools
    from .cli import home
    register_tools(server, config, home())

    server.run(transport='stdio', show_banner=False)
