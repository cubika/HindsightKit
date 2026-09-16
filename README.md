# ProvenLoop

Run a [Hindsight](https://github.com/vectorize-io/hindsight) memory server and connect GitHub Copilot clients to it. Each session selects its repository memory automatically; sessions outside Git use shared memory. Hindsight owns storage, extraction, recall, and consolidation.

## Setup on Windows

Install and start the server:

```powershell
.\setup.ps1
```

Install a client on a coding machine:

```powershell
.\setup.ps1 -Server http://memory-host:9077
```

For entirely local use, run both commands on the same machine, using http://127.0.0.1:9077 for the client. Server setup starts the API listening automatically. Client setup asks for the server connection key once; the hostname and memory routing are automatic. See [server and client setup](docs/shared-memory.md) for keys, tunnels, upgrades, and client activity.

Server setup installs Hindsight, standalone PostgreSQL, embeddings, and the dashboard. It does not register coding integrations. Client setup installs the coding integrations without a database, models, or dashboard. Each role keeps its own settings, including when both run on one machine. The server uses its Copilot account for model calls; coding clients use their own Copilot login.
Setup adds the native provenloop command to your user PATH. It works immediately in the PowerShell session that ran setup. Open a new terminal for other sessions; restart VS Code if its integrated terminal still inherits an older PATH.

Server setup starts the services and checks a temporary memory by storing and recalling it through the real model provider. The test bank is removed afterward. This uses a small amount of Copilot allowance. Memory stays in the local Hindsight database; extraction and reflection use Copilot's hosted models.

Copilot Chat and CLI keep the model selected for the user's task. Hindsight makes separate calls through the official Copilot SDK using the signed-in account's allowance. New ProvenLoop profiles use `gpt-6-astra` with `xhigh` reasoning. `-Model` and `-ReasoningEffort` set `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_REASONING_EFFORT`. Changing the model in Copilot Chat does not change Hindsight's model. For an existing installation, edit these settings in `~/.hindsight/profiles/provenloop.env` and restart ProvenLoop. Rerunning setup preserves existing profile settings.

After client setup, reload VS Code, use Copilot Chat in agent mode, and allow the Hindsight MCP server when VS Code asks. Start a fresh Copilot CLI session. VS Code controls its own workspace trust and MCP consent.

Optional settings:

```powershell
.\setup.ps1 -Model gpt-6-astra -ReasoningEffort xhigh -Port 9077 -NoOpen
# Reuse an already downloaded official multilingual-e5-small model:
.\setup.ps1 -ModelDir C:\models\e5
```

The model directory must contain the official E5 ONNX graph at `onnx/model.onnx` and its tokenizer files. Without this option, Hindsight downloads its default multilingual E5 model. First setup downloads Python packages, the official EDB PostgreSQL 18.6 Windows x64 binaries, and pgvector 0.8.6 source. Both database archives have pinned SHA256 checksums. pgvector is compiled with its official Windows Makefile. If MSVC C++ tools are missing, setup installs Microsoft's signed Build Tools; Windows may ask for administrator approval. Existing PostgreSQL installations are left alone. Download failures stop setup with a nonzero exit; rerun after resolving network access. Standard uv/npm/Hugging Face proxy settings apply.

PostgreSQL runs as a separate local server with its own data directory. Setup enables `vector` for similarity search, `pg_trgm` for entity matching, and `pg_stat_statements` for query diagnostics. Native full-text search needs no extra extension. PostgreSQL's other bundled contrib extensions remain available for explicit use. The server listens only on 127.0.0.1, uses SCRAM passwords and data checksums, and gives Hindsight a database-owner account without superuser privileges. Credentials and database files are restricted to the installing Windows user and SYSTEM.

An existing external PostgreSQL URL in `HINDSIGHT_EMBED_API_DATABASE_URL` is preserved and validated; its administrator must provide PostgreSQL 14+, pgvector 0.8+ and `pg_trgm`. Setup does not manage that server's processes or roles. Changing a connection string does not migrate existing data.

## Daily use

```powershell
provenloop status
provenloop start
provenloop ui
provenloop check
provenloop stop
provenloop copilot
```

Default API: http://127.0.0.1:9077. Default UI: http://localhost:19077. PostgreSQL prefers port 15432 and chooses an available port during first setup if needed. Run `provenloop ui` to start stopped services and open the dashboard. The API, UI and standalone PostgreSQL run in the background and keep running after the terminal closes. Use `provenloop stop` to stop them. No login task or Windows service is installed; run `provenloop start` after reboot.

Database server upgrades are explicit: setup will not initialize over an unknown data directory or automatically change its PostgreSQL major version.

## Memory scope

| Session starts in | Writes to | Reads from |
| --- | --- | --- |
| Git repository A | A | A and shared |
| Git repository B | B | B and shared |
| Ordinary directory | Shared | Shared |

The Git common directory identifies a repository: subdirectories and worktrees share one bank, while different repositories with the same name remain separate. A session keeps its starting scope even if a shell command changes directory. Repository memory is never automatically promoted into shared memory.

The CLI prompt hook runs bounded, parallel recall requests for the allowed banks. Session writeback uses the unmodified official Copilot transcript hook. Both clients expose retain, recall, and reflect through a small MCP adapter that selects banks itself; the agent cannot supply a different bank ID. Reflect also reads only the permitted banks. Token budgets are split across the results.

VS Code uses user-level MCP configuration and global Copilot instructions. Its workspace roots determine the repository. Open one repository per VS Code window; a multi-root workspace spanning different repositories is rejected, and missing workspace information never silently writes to shared memory. A window with no folders uses shared memory when VS Code reports an empty root list. Existing default/named VS Code profiles and Insiders are configured; future independent profiles need to inherit MCP settings or rerun setup. Remote machines and containers need their own client installation or local setup. Clients sharing the same Git origin use the same repository memory across machines. Bank selection is internal; see [server and client setup](docs/shared-memory.md).

No per-repository enable step is needed. Initial git-history import and the automatic codebase survey remain disabled. Upgrading removes only known ProvenLoop workspace registrations, preserving unrelated settings and all existing banks.

Use the official Hindsight UI to inspect memories, correct facts, or invalidate obsolete information. Retrieval and model behavior still need judgment: remembered information can be incomplete or wrong.

## WorkIQ email

Run `provenloop connectors` to open the optional connector catalog. WorkIQ must already be installed at the supported version before its connector can run. ProvenLoop does not install it or open its login flow during setup. Core memory works without any connector; paused connectors are not automatically started. Each adapter has its own settings, prerequisites and lifecycle, as described in the [connector contract](docs/connectors.md).

The WorkIQ settings page uses the current account and lists real mailbox folders. The suggested selection includes Inbox and the DSAPISOT subtree, excluding its Sev3 and PullRequests subtrees. Choose a historical lookback and a synchronization interval; zero minutes means manual runs. Preview the cleaned content before starting. Closing the browser leaves enabled synchronization running. Pausing releases WorkIQ while preserving imported memory.

The importer reads structured mail, removes mail envelopes and repeated boilerplate, and submits useful content to the official Hindsight engine. Imported email has its own bank and a read-only `recall_mail` MCP tool. Repository and shared agent memory keep their existing routing. The settings page links to the official Hindsight UI for inspecting memory and source evidence.

This release uses bounded time-window polling with overlap. It does not mirror mailbox deletions or guarantee changes outside the scanned window. WorkIQ must already be installed at the supported version and signed in; authentication renewal may require its login UI. `provenloop stop` stops the importer before Hindsight, and `provenloop start` resumes its saved settings. No Windows login task is installed.

The settings host stores its process record in `~/.provenloop/connectors`. Mail configuration and the delivery ledger remain in `~/.provenloop/mail`; opening the catalog does not create a mail ledger or model client. Credentials remain with WorkIQ. See [mail design and validation](docs/workiq-mail.md) for source handling and test results.

## Files and compatibility

| Location | Contents |
| --- | --- |
| This checkout's .venv | Pinned Python runtime packages |
| ~/.provenloop/bin | Native provenloop command registered on the user PATH |
| ~/.provenloop/runtime | Official npm components |
| ~/.provenloop/client-runtime | Official npm integration for client installations |
| ~/.provenloop/server/connection-key.txt | Private server connection key |
| ~/.provenloop/repositories.json | Legacy repository aliases; no memory content |
| ~/.provenloop/clients.json | Shared server device inventory; no memory content |
| ~/.hindsight/profiles/provenloop.env | Official Hindsight configuration |
| ~/.hindsight/profiles/provenloop.log | API log |
| ~/.hindsight/profiles/provenloop.ui.log | UI server log |
| ~/.provenloop/postgresql/server-18.6 | Official PostgreSQL tools and extensions |
| ~/.provenloop/postgresql/data | Standalone PostgreSQL cluster |
| ~/.provenloop/postgresql/cluster.json | Private local connection configuration |
| ~/.provenloop/postgresql/postgresql.log | PostgreSQL log |
| ~/.hindsight/coding-agent.json | Local endpoint and session capture settings |
| ~/.provenloop/sessions | Small session-to-repository routing records; no transcripts |
| ~/.copilot/hooks/hindsight-coding-agents.json | Copilot hooks with absolute executable paths |
| %APPDATA%/Code/User/mcp.json | VS Code user-level MCP registration |
| ~/.copilot/copilot-instructions.md | Global memory instructions |

Existing unrelated MCP servers and VS Code JSONC comments are preserved. Changed files receive a `.provenloop-backup` copy once. Conflicting Hindsight endpoints or disabled-learning settings stop setup. The official coding-agent configuration itself must be strict JSON. This release uses the default Copilot profile; a custom COPILOT_HOME must be unset before setup. Keep this checkout and runtime directory in place while using the installed environment.

Pinned components: Hindsight 0.10.0, coding-agents 0.6.1, hindsight-copilot 0.1.0, PostgreSQL 18.6, pgvector 0.8.6, and Copilot CLI 1.0.85. Python and npm dependency locks are committed. Local embeddings use ONNX multilingual E5 and ranking uses Hindsight's RRF, without Torch or a separate neural reranker.

## Development

```powershell
uv sync --frozen --python 3.12 --extra server
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
# Explicit live access-matrix test; uses Copilot calls and cleans its synthetic data:
.\.venv\Scripts\python.exe tests/live_memory.py
```

Sources: [Hindsight installation](https://hindsight.vectorize.io/developer/installation), [Copilot provider](https://hindsight.vectorize.io/developer/models#github-copilot-setup), [VS Code integration](https://hindsight.vectorize.io/sdks/integrations/github-copilot), [coding-agents](https://hindsight.vectorize.io/sdks/integrations/coding-agents).

Official components retain their own licenses and notices. ProvenLoop does not modify their memory engine or copy LessonLoop's product code.
