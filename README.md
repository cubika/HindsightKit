# ProvenLoop

Set up local [Hindsight](https://github.com/vectorize-io/hindsight) memory for GitHub Copilot Chat and Copilot CLI. Both use the same memory bank for a project. Hindsight owns storage, extraction, recall, and consolidation; ProvenLoop installs and configures the official components.

## Setup on Windows

From this checkout, run:

```powershell
.\setup.ps1
```

To connect another project:

```powershell
.\setup.ps1 -Project C:\source\my-project
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

Default API: http://127.0.0.1:9077. Default UI: http://localhost:19077. Services keep running when setup exits. Run `start` after restarting Windows; no login task or system service is installed.

The official CLI hooks write sessions back and inject relevant memory. The VS Code integration adds the official recall/retain instructions and an HTTP MCP server. Only projects passed to setup participate in CLI memory. Initial git-history import and the automatic codebase survey are disabled; normal session learning stays enabled.

Use the official Hindsight UI to inspect memories, correct facts, or invalidate obsolete information. Retrieval and model behavior still need judgment: remembered information can be incomplete or wrong.

## Files and compatibility

| Location | Contents |
| --- | --- |
| This checkout's .venv | Pinned Python runtime packages |
| ~/.provenloop/bin | Native provenloop command registered on the user PATH |
| ~/.provenloop/runtime | Official npm components |
| ~/.hindsight/profiles/provenloop.env | Official Hindsight configuration |
| ~/.hindsight/profiles/provenloop.log | API log |
| ~/.pg0/instances/hindsight-embed-provenloop | Local database |
| ~/.hindsight/coding-agent.json | Official CLI integration settings and project mapping |
| ~/.copilot/hooks/hindsight-coding-agents.json | Official hooks, with absolute executable paths |
| Project .vscode/mcp.json | VS Code memory endpoint |
| Project .github/copilot-instructions.md | Official recall/retain rule |

Existing unrelated MCP servers and VS Code JSONC comments are preserved. Changed files receive a `.provenloop-backup` copy once. Conflicting Hindsight endpoints or disabled-learning settings stop setup. The official coding-agent configuration itself must be strict JSON. This release uses the default Copilot profile; a custom COPILOT_HOME must be unset before setup. Keep this checkout and runtime directory in place while using the installed environment.

Pinned components: Hindsight 0.10.0, coding-agents 0.6.1, hindsight-copilot 0.1.0, pg0 0.15.2, and Copilot CLI 1.0.85. Python and npm dependency locks are committed. Local embeddings use ONNX multilingual E5 and ranking uses Hindsight's RRF, without Torch or a separate neural reranker.

## Development

```powershell
uv sync --frozen --python 3.12
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
# Explicit live integration test; uses Copilot calls and restarts this Hindsight profile:
.\.venv\Scripts\python.exe tests/live_memory.py
```

Sources: [Hindsight installation](https://hindsight.vectorize.io/developer/installation), [Copilot provider](https://hindsight.vectorize.io/developer/models#github-copilot-setup), [VS Code integration](https://hindsight.vectorize.io/sdks/integrations/github-copilot), [coding-agents](https://hindsight.vectorize.io/sdks/integrations/coding-agents).

Official components retain their own licenses and notices. ProvenLoop does not modify their memory engine or copy LessonLoop's product code.
