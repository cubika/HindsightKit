# Installation and maintenance

Use the installation command on a published release page. It downloads the installer and application files without a source checkout. This guide describes the v0.1.1 Windows x64 candidate, whose release acceptance is still pending. Linux, macOS, and Windows ARM are not supported. See [release validation](release-validation.md) for completed checks.

## Before installing

- Use Windows PowerShell 5.1 or PowerShell 7 on Windows x64.
- Install Git for coding integrations, and have a Copilot account available for sign-in. A dedicated server installed with ServerOnly does not need Git for client routing.
- Allow downloads from GitHub, npm, Node.js, and the embedding model host. The v0.1.1 application archive contains the pinned Python packages, but the Python interpreter, Node.js, npm components, and embedding model still download during setup.
- For a private or internal release, install GitHub CLI and sign in with an account that can read the repository. The release page provides its authenticated command. A browser login does not authenticate PowerShell downloads.

The installer uses the default Copilot profile. A custom `COPILOT_HOME` must be unset before setup. WorkIQ is optional and is not installed by HindsightKit.

## What setup does

Default setup installs the local server and coding integrations. It prepares a managed Python 3.12 environment and Node.js, installs the bundled Python packages with hash checks and package-index access disabled, then downloads the remaining components and precompiled database distribution. It checks Copilot authentication, starts Hindsight and its dashboard, verifies a temporary memory through retain/recall, and registers the client. The test bank is removed afterward. The check uses the server's Copilot allowance.

The release installer prints the current stage and log location. Runtime messages distinguish `Downloading`, `Installed`, and `Reusing`, with the version and path. A completed Node.js stage does not mean that the later Python or server setup stages have succeeded.

After a successful run, reload VS Code, use Copilot Chat in agent mode, and allow its Hindsight MCP server. Start a new Copilot CLI session. VS Code retains control of workspace trust and MCP consent.

`hindsightkit` is added to the user PATH. The optional `hk` alias is installed only if the name is available. Open a new terminal for other sessions; restart VS Code if its terminal still uses an older PATH. Shell profiles are not edited.

An existing remote client connection is preserved by default setup. Use the separate [connect command](devtunnel.md) to choose another server or return to local memory.

## Optional installer arguments

The downloaded `install.ps1` accepts these arguments. When using a release page's script-block command, append the argument to that invocation. Do not paste a connection key into a command line.

| Argument | Purpose |
| --- | --- |
| `-ServerOnly` | Install only the server. Default: false. |
| `-Server http://memory-host:9077` | Advanced client-only installation against a known server. It requests the connection key separately and omits a new database, dashboard, and model. |
| `-NoOpen` | Do not open the dashboard after setup. |
| `-InstallDir C:\Apps\HindsightKit` | Change the release application, managed Python, and installation-log location. It does not relocate memory or user configuration. |
| `-Model` / `-ReasoningEffort` | Select model settings for a new server profile. |
| `-Port` | Set the API port for a new server profile. Default: 9077. |
| `-ModelDir C:\models\e5` | Reuse the official multilingual E5 model. The directory must contain `onnx\model.onnx` and tokenizer files, including `tokenizer.json`. |
| `-ApiKeyEnv NAME` | Read a connection key from a named environment variable for automated setup. |

Server model/port options cannot be combined with `-Server`. On a machine that already has a local server, client installation retains the Python server dependencies so its management commands remain available.

## Model configuration

Hindsight makes separate model requests through the official Copilot SDK. Changing the model in Copilot Chat or CLI does not change Hindsight's model. New profiles default to `gpt-6-astra` and `xhigh` reasoning; the server account must have access to the chosen model.

Existing profiles retain their settings when setup is rerun. To change them, stop HindsightKit, edit `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_REASONING_EFFORT` in `%USERPROFILE%\.hindsight\profiles\hindsightkit.env`, then start it again. The setup flags do not override an existing model or port silently.

Local embeddings use ONNX multilingual E5. Ranking uses Hindsight's RRF; no Torch-based reranker is installed by this profile.

## Start, stop, and inspect

```powershell
hindsightkit status
hindsightkit start
hindsightkit ui
hindsightkit check
hindsightkit stop
```

The default local API address is `http://127.0.0.1:9077` and the dashboard is `http://localhost:19077`. The authenticated API listens on IPv4 interfaces; the database listens only on loopback. PostgreSQL prefers port 15432 and selects an available port during its first setup. No firewall rules are created.

The processes continue after the terminal closes. Start them again after reboot. On a client-only machine, `start` restores a saved managed relay; it does not create a local server. `ui` requires a local server. See [remote connections](devtunnel.md) for relay lifecycle details.

`check` performs a temporary retain/recall operation. If the machine has both a local server and a remote client, `check` and `clients` target the local server. `status` also checks the selected client endpoint.

## File locations

These are default Windows locations. `%USERPROFILE%` means the user's home directory; `%LOCALAPPDATA%` is its local application-data directory. In PowerShell commands, expand these through `$env:USERPROFILE` and `$env:LOCALAPPDATA`.

Application versions are separated from persistent settings and memory so upgrading the program can reuse the existing database. The current layout also keeps npm components in the persistent HindsightKit directory.

| Location | Contents |
| --- | --- |
| `%LOCALAPPDATA%\HindsightKit\versions\<version>-<hash>` | Application, bundled Python wheels and requirements in `python`, its `.venv`, managed Node.js, download cache, and release metadata |
| `%LOCALAPPDATA%\HindsightKit\python` | Managed Python runtime |
| `%LOCALAPPDATA%\HindsightKit\logs\install-<timestamp>-<id>.log` | Installation stages and dependency-command output; interactive setup output is excluded |
| `%USERPROFILE%\.hindsightkit\bin` | Installed `hindsightkit` and optional `hk` commands |
| `%USERPROFILE%\.hindsightkit\runtime` and `%USERPROFILE%\.hindsightkit\client-runtime` | Official npm components |
| `%USERPROFILE%\.hindsightkit\postgresql` | PostgreSQL program files, persistent `data` directory, `cluster.json` credentials, and database log |
| `%USERPROFILE%\.hindsightkit\server\connection-key.txt` | Private server connection key |
| `%USERPROFILE%\.hindsightkit` | Device inventory and routing in `clients.json`, `repositories.json`, and `sessions`; optional state in `connectors`, `mail`, and `remote` |
| `%USERPROFILE%\.hindsight\profiles\hindsightkit.env` | Official Hindsight server profile |
| `%USERPROFILE%\.hindsight\profiles` | API and dashboard logs: `hindsightkit.log` and `hindsightkit.ui.log` |
| `%USERPROFILE%\.hindsight\coding-agent.json` | Client connection and session-capture settings |
| `%USERPROFILE%\.copilot` | Copilot instructions, MCP configuration, and hooks |
| `%APPDATA%\Code\User\mcp.json` | VS Code MCP registration; installed named profiles and Insiders have their own entries |

`-InstallDir` changes the release application and managed Python root, with installation logs under its `logs` directory. It does not move persistent settings or memory. The advanced `HINDSIGHTKIT_HOME` environment variable overrides the default `.hindsightkit` directory, but does not move the official `.hindsight` profile or editor configuration. Changing paths does not migrate existing data.

## Upgrades and existing configuration

Run the newer release's installer to upgrade. It verifies package hashes, keeps version directories separate, and restarts managed server processes when server setup runs. Reload coding clients afterward. Old version directories are retained; automatic pruning and database downgrades are not implemented.

Setup preserves existing model settings, memory banks, and unrelated editor configuration. Changed integration files receive a `.hindsightkit-backup` copy once. Conflicting endpoints or disabled-learning settings stop registration. The official coding-agent configuration must be strict JSON; VS Code JSONC comments are preserved.

Upgrading files does not update already running sessions. A source installation still depends on its checkout until a release installation has completed and the relevant services and clients have restarted. Do not delete a directory that still supplies a running installation.

An existing external PostgreSQL URL is retained and checked. Its administrator must provide PostgreSQL 14+, pgvector 0.8+, and `pg_trgm` in the database. HindsightKit does not manage that external server's processes or roles. An unknown local data directory or a PostgreSQL major-version mismatch stops setup; changing a connection string does not migrate memory.

## Troubleshooting

### Find the failed stage

The v0.1.1 release installer prints the failed stage, the first matching dependency error, and a log path under `<InstallDir>\logs`. With the default directory, logs are in `%LOCALAPPDATA%\HindsightKit\logs`. The installer restricts this directory to the current user and SYSTEM.

The log contains stage messages and dependency-command output, not a complete terminal transcript. Interactive configuration output, including Copilot login and connection-key prompts, is excluded. Keep the relevant console error if the failure occurs during that stage.

### Python packages fail to install

The v0.1.1 release installs its wheels using `--offline`, `--no-index`, and `--require-hashes`. It stops on a missing bundle or checksum failure instead of falling back to PyPI. Use the complete application archive from that release. The Python interpreter is a separate download; check the stage name to distinguish it from package installation.

In v0.1.0, the locked `hindsight-api-slim 0.10.0` wheel failed with TLS `HandshakeFailure` on `files.pythonhosted.org` while the index remained reachable. The error was reproduced locally and also appeared in the second machine's supplied log. Switching to the system certificate store did not resolve the locally reproduced failure. The network component responsible was not identified.

An older source installation may keep working because its packages and cache already exist. Each release has a separate environment and cache, so an existing working checkout does not validate a new download. Source setup still uses the lockfile and package hosts; the bundled-package change applies to release installation. Keep TLS verification enabled.

### Node.js output is unclear

The v0.1.1 output distinguishes three states: `Downloading Node.js` starts the transfer, `Installed Node.js` follows extraction and version verification, and `Reusing Node.js` confirms an existing suitable runtime. Release installs use the pinned managed copy so they do not depend on a source checkout. Source setup can reuse a suitable Node.js from PATH.

The v0.1.0 message `Installing Node.js...` only marked entry into the download/install path; reuse was silent. A later uv error means the installation stopped after that stage.

### Retry reports changed application files

The release installer verifies installed application files on retry. It stops if they are edited, missing, or damaged. Use a new `-InstallDir` for a clean copy; existing settings and database paths remain unchanged. Dependency downloads can otherwise be retried in the same version directory.

### Command or editor still uses an older installation

Open a new terminal and restart VS Code. `hindsightkit --help` shows which commands the installed launcher exposes. Updating a source checkout or publishing a release does not update an installed copy automatically. Rerun the release installer to upgrade it.
