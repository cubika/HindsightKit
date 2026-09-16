"""Native memory operations with host-selected, session-fixed bank access."""
import asyncio
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

from fastmcp import Context, FastMCP
from . import connection
from .memory import Memory, Scope, SHARED_BANK, scope_for


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
    instructions = ('Use retain, recall and reflect with this installation\'s selected shared bank.'
                    if connection.fixed_bank(config) else
                    'Use retain, recall and reflect. Repository memory stays in this repository; shared memory is read-only inside repositories.')
    server = FastMCP('ProvenLoop', instructions=instructions)
    # A CLI process inherits the agent's launch cwd. VS Code supplies MCP roots.
    scope = Scope(connection.fixed_bank(config)) if connection.fixed_bank(config) else None
    if context == 'cli' and scope is None:
        session_id = os.environ.get('COPILOT_AGENT_SESSION_ID')
        if session_id:
            from .hooks import session_config
            path = Path(os.environ.get('HINDSIGHT_CONFIG', Path.home() / '.hindsight/coding-agent.json'))
            config = json.loads(path.read_text(encoding='utf-8'))
            _, pinned = session_config({'sessionId': session_id, 'cwd': directory or os.getcwd()}, config)
            scope = Scope(pinned['bankId'], pinned['_repository'])
        else:
            scope = scope_for(directory or os.getcwd())
    lock = asyncio.Lock()
    root_uris = None

    async def memory(ctx: Context):
        nonlocal scope, root_uris
        async with lock:
            if context == 'vscode' and not connection.fixed_bank(config):
                capabilities = ctx.session.client_capabilities
                if not capabilities or not capabilities.roots:
                    raise ValueError('VS Code did not supply workspace roots; repository memory access is unavailable.')
                roots = await asyncio.wait_for(ctx.session.list_roots(), timeout=5)
                current = tuple(sorted(str(root.uri) for root in roots.roots))
                if root_uris is not None and current != root_uris:
                    raise ValueError('The workspace changed. Restart the Hindsight MCP server before using memory.')
                if scope is None:
                    scope = await asyncio.to_thread(scope_from_roots, roots.roots)
                    root_uris = current
        return scope

    async def call(ctx, operation, **arguments):
        selected = await memory(ctx)
        client = connection.sdk(config, timeout=330)
        try:
            service = Memory(client, selected)
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
