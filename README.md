# ProvenLoop

Set up local [Hindsight](https://github.com/vectorize-io/hindsight) memory for GitHub Copilot Chat and Copilot CLI. Install once for your Windows user. Each session selects its repository memory automatically; sessions outside Git use shared memory. Hindsight owns storage, extraction, recall, and consolidation.

## Setup on Windows

From this checkout, run:

```powershell
.\setup.ps1
```

After installation, setup can be run again from any directory:

```powershell
provenloop setup
```

The command installs missing uv/Node prerequisites, a pinned Python environment, Hindsight, its local database, multilingual embeddings, the official UI, and both Copilot integrations. It checks Copilot authentication and starts Copilot's own login flow when needed. A Copilot entitlement and internet access are required. No Hindsight Cloud account or API key is needed.

Setup adds the native provenloop command to your user PATH. It works immediately in the PowerShell session that ran setup. Open a new terminal for other sessions; restart VS Code if its integrated terminal still inherits an older PATH.

Setup starts the services and checks a temporary memory by storing and recalling it through the real model provider. The test bank is removed afterward. This uses a small amount of Copilot allowance. Memory stays in the local Hindsight database; extraction and reflection use Copilot's hosted models.

Copilot Chat and CLI keep the model selected for the user's task. Hindsight makes separate calls through the official Copilot SDK using the signed-in account's allowance. New ProvenLoop profiles use `gpt-6-astra` with `xhigh` reasoning. `-Model` and `-ReasoningEffort` set `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_REASONING_EFFORT`. Changing the model in Copilot Chat does not change Hindsight's model. For an existing installation, edit these settings in `~/.hindsight/profiles/provenloop.env` and restart ProvenLoop. Rerunning setup preserves existing profile settings.

After setup, reload VS Code, use Copilot Chat in agent mode, and allow the Hindsight MCP server when VS Code asks. Start a fresh Copilot CLI session. VS Code controls its own workspace trust and MCP consent.

Optional settings:

```powershell
.\setup.ps1 -Model gpt-6-astra -ReasoningEffort xhigh -Port 9077 -NoOpen
# Reuse an already downloaded official multilingual-e5-small model:
.\setup.ps1 -ModelDir C:\models\e5
```

The model directory must contain the official E5 ONNX graph at `onnx/model.onnx` and its tokenizer files. Without this option, Hindsight downloads its default multilingual E5 model. First setup also downloads Python packages and PostgreSQL and can take several minutes. Download failures stop setup with a nonzero exit; rerun the same command after resolving network access. Standard uv/npm/Hugging Face proxy settings apply.

## Daily use

```powershell
provenloop status
provenloop start
provenloop ui
provenloop check
provenloop stop
provenloop copilot
```

Default API: http://127.0.0.1:9077. Default UI: http://localhost:19077. Run `provenloop ui` to start any stopped services and open the dashboard in your browser. Services run in the background without a separate server window and keep running after the terminal closes. Repeated calls reuse the running services. Use `provenloop stop` to stop them; no login task or system service is installed.

## Memory scope

| Session starts in | Writes to | Reads from |
| --- | --- | --- |
| Git repository A | A | A and shared |
| Git repository B | B | B and shared |
| Ordinary directory | Shared | Shared |

The Git common directory identifies a repository: subdirectories and worktrees share one bank, while different repositories with the same name remain separate. A session keeps its starting scope even if a shell command changes directory. Repository memory is never automatically promoted into shared memory.

The CLI prompt hook runs bounded, parallel recall requests for the allowed banks. Session writeback uses the unmodified official Copilot transcript hook. Both clients expose retain, recall, and reflect through a small MCP adapter that selects banks itself; the agent cannot supply a different bank ID. Reflect also reads only the permitted banks. Token budgets are split across the results.

VS Code uses user-level MCP configuration and global Copilot instructions. Its workspace roots determine the repository. Open one repository per VS Code window; a multi-root workspace spanning different repositories is rejected, and missing workspace information never silently writes to shared memory. A window with no folders uses shared memory when VS Code reports an empty root list. Existing default/named VS Code profiles and Insiders are configured; future independent profiles need to inherit MCP settings or rerun setup. Remote machines and containers need their own local setup.

No per-repository enable step is needed. Initial git-history import and the automatic codebase survey remain disabled. Upgrading removes only known ProvenLoop workspace registrations, preserving unrelated settings and all existing banks.

Use the official Hindsight UI to inspect memories, correct facts, or invalidate obsolete information. Retrieval and model behavior still need judgment: remembered information can be incomplete or wrong.

## WorkIQ email

Run `provenloop connectors` to open the local mail settings page. It uses the current WorkIQ account and lists the real mailbox folders. The suggested selection includes Inbox and the DSAPISOT subtree, excluding its Sev3 and PullRequests subtrees. Choose a historical lookback and a synchronization interval; zero minutes means manual runs. Preview the cleaned content before starting. Closing the browser leaves synchronization running.

The importer reads structured mail, removes mail envelopes and repeated boilerplate, and submits useful content to the official Hindsight engine. Imported email has its own bank and a read-only `recall_mail` MCP tool. Repository and shared agent memory keep their existing routing. The settings page links to the official Hindsight UI for inspecting memory and source evidence.

This release uses bounded time-window polling with overlap. It does not mirror mailbox deletions or guarantee changes outside the scanned window. WorkIQ must already be installed at the supported version and signed in; authentication renewal may require its login UI. `provenloop stop` stops the importer before Hindsight, and `provenloop start` resumes its saved settings. No Windows login task is installed.

Configuration and the delivery ledger live in `~/.provenloop/mail`. Credentials remain with WorkIQ. See [mail design and validation](docs/workiq-mail.md) for source handling and test results.

## Files and compatibility

| Location | Contents |
| --- | --- |
| This checkout's .venv | Pinned Python runtime packages |
| ~/.provenloop/bin | Native provenloop command registered on the user PATH |
| ~/.provenloop/runtime | Official npm components |
| ~/.hindsight/profiles/provenloop.env | Official Hindsight configuration |
| ~/.hindsight/profiles/provenloop.log | API log |
| ~/.hindsight/profiles/provenloop.ui.log | UI server log |
| ~/.pg0/instances/hindsight-embed-provenloop | Local database |
| ~/.hindsight/coding-agent.json | Local endpoint and session capture settings |
| ~/.provenloop/sessions | Small session-to-repository routing records; no transcripts |
| ~/.copilot/hooks/hindsight-coding-agents.json | Copilot hooks with absolute executable paths |
| %APPDATA%/Code/User/mcp.json | VS Code user-level MCP registration |
| ~/.copilot/copilot-instructions.md | Global memory instructions |

Existing unrelated MCP servers and VS Code JSONC comments are preserved. Changed files receive a `.provenloop-backup` copy once. Conflicting Hindsight endpoints or disabled-learning settings stop setup. The official coding-agent configuration itself must be strict JSON. This release uses the default Copilot profile; a custom COPILOT_HOME must be unset before setup. Keep this checkout and runtime directory in place while using the installed environment.

Pinned components: Hindsight 0.10.0, coding-agents 0.6.1, hindsight-copilot 0.1.0, pg0 0.15.2, and Copilot CLI 1.0.85. Python and npm dependency locks are committed. Local embeddings use ONNX multilingual E5 and ranking uses Hindsight's RRF, without Torch or a separate neural reranker.

## Development

```powershell
uv sync --frozen --python 3.12
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
# Explicit live access-matrix test; uses Copilot calls and cleans its synthetic data:
.\.venv\Scripts\python.exe tests/live_memory.py
```

Sources: [Hindsight installation](https://hindsight.vectorize.io/developer/installation), [Copilot provider](https://hindsight.vectorize.io/developer/models#github-copilot-setup), [VS Code integration](https://hindsight.vectorize.io/sdks/integrations/github-copilot), [coding-agents](https://hindsight.vectorize.io/sdks/integrations/coding-agents).

Official components retain their own licenses and notices. ProvenLoop does not modify their memory engine or copy LessonLoop's product code.
