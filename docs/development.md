# Development

For normal use, follow [release installation](installation.md). A source checkout is for development and keeps its Python environment in that checkout.

## Prepare a checkout

Use Windows x64, Git, uv, and Node.js 22 or newer with npm. Install the locked Python dependencies:

```powershell
uv sync --frozen --python 3.12 --extra server
```

Install the locked Node integration packages before running the suite so those checks are available:

```powershell
.venv/Scripts/python.exe -c "from hindsightkit.cli import install_node_packages; install_node_packages(); install_node_packages(client=True)"
.venv/Scripts/python.exe -m unittest discover -s tests -v
```

Running `.\setup.ps1` performs real setup against the current user's Hindsight profile and editor configuration. It starts services, may request Copilot login, and makes a real retain/recall check. Keep this checkout in place while an installation uses it. The release installer is the supported route for users who do not want a checkout dependency.

Source server setup compiles official pgvector sources using Microsoft's C++ toolchain and the pinned PostgreSQL headers. If the toolchain is missing, setup can install signed Build Tools and Windows may request administrator approval. Release packages include precompiled database components.

## Boundaries

HindsightKit wraps pinned official Hindsight components. Hindsight owns the memory database and retrieval engine. Client routing and optional [connector adapters](connectors.md) remain small and explicit; do not fork the engine or create a second memory store.

Follow the checkout's `AGENTS.md` for worktrees, validation, and merge conventions. Keep runtime data, accounts, credentials, local publishing destinations, and test payloads out of tracked files. Design documents describe stable behavior; actual connector measurements belong in [connector validation](connector-validation.md).

## Live checks

The unit suite uses temporary profiles and fixtures. The following checks make real calls and must be run deliberately:

```powershell
.venv/Scripts/python.exe tests/live_memory.py
.venv/Scripts/python.exe tests/live_postgres.py --distribution C:\path\to\server-18.6
```

The memory check uses Copilot allowance and disposable banks. The PostgreSQL check uses a disposable cluster; adding `--hindsight` also calls the real model provider. Email live tests access mailbox data and require their own selected scope. Preserve unrelated memory and services, and record actual cleanup results.

## Pinned components

The current dependency set includes Hindsight 0.10.0, coding-agents 0.6.1, hindsight-copilot 0.1.0, PostgreSQL 18.6, and pgvector 0.8.6. Setup installs Copilot CLI 1.0.85 when it needs to provide a CLI; an existing CLI can be reused. Python and npm locks are checked in. See the manifests and locks for the complete package set.

Upstream references: [installation](https://hindsight.vectorize.io/developer/installation), [Copilot provider](https://hindsight.vectorize.io/developer/models#github-copilot-setup), [coding-agent integration](https://hindsight.vectorize.io/sdks/integrations/coding-agents).
