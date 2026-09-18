# Installation and maintenance

Use the installation command on a published release page. It downloads the installer and application files without a source checkout. This guide describes the current Windows x64 installer source; see [release validation](release-validation.md) for published versions and completed checks. The `-ClientOnly` entry requires v0.1.2 or later. Linux, macOS, and Windows ARM are not supported.

## Before installing

- Use Windows PowerShell 5.1 or PowerShell 7 on Windows x64.
- Install Git for coding integrations, and have a Copilot account available for sign-in. A dedicated server installed with ServerOnly does not need Git for client routing.
- Allow downloads from GitHub and Node.js. The release supplies the application and pinned dependency archives separately. The Python interpreter and, when needed, Node.js still download. A new local server also downloads the embedding model and database distribution.
- For a private or internal release, install GitHub CLI and sign in with an account that can read the repository. The release page provides its authenticated command. A browser login does not authenticate PowerShell downloads.

The installer uses the default Copilot profile. A custom `COPILOT_HOME` must be unset before setup. WorkIQ is optional and is not installed by HindsightKit.

## What setup does

Default setup installs the local server and coding integrations. It prepares a managed Python 3.12 environment and Node.js, installs bundled Python and npm packages with hash checks, then downloads the precompiled database distribution and embedding model when needed. It checks Copilot authentication, starts Hindsight and its dashboard, verifies a temporary memory through retain/recall, and registers the client. The test bank is removed afterward. The check uses the server's Copilot allowance.

The release installer prints the current stage and log location. Runtime messages distinguish `Downloading`, `Installed`, and `Reusing`, with the version and path. A completed Node.js stage does not mean that the later Python or server setup stages have succeeded.

After a successful run, reload VS Code, use Copilot Chat in agent mode, and allow its Hindsight MCP server. Start a new Copilot CLI session. VS Code retains control of workspace trust and MCP consent.

`hindsightkit` is added to the user PATH. The optional `hk` alias is installed only if the name is available. Open a new terminal for other sessions; restart VS Code if its terminal still uses an older PATH. Shell profiles are not edited.

An existing remote client connection is preserved by default setup. Use the separate [connect command](devtunnel.md) to choose another server or return to local memory.

## Prepare a client for another server

Use the release page's `-ClientOnly` command. On a fresh client it downloads the application and client dependency archives, then prepares the command and Copilot components. It does not invent a default endpoint, contact a memory server, or install a local dashboard, database, or model.

After preparation, choose the server:

```powershell
hindsightkit connect
```

Paste the server's connection code at the hidden prompt. If the server address is already known, use `hindsightkit connect --server http://memory-host:9077`; the key is requested separately. The installer option `-Server http://memory-host:9077` is a shortcut that selects client-only installation and connects in the same run.

On a computer with a local HindsightKit server profile, the installer keeps the full package so server management commands remain available. Client-only setup preserves the server's settings and data without reinstalling, starting, or reconfiguring its dashboard, database, or model. It does not uninstall the server or stop a server that is already running. Existing managed client connections are preserved and their integrations refreshed.

If an earlier default installation already succeeded, run `connect` directly; its local dashboard can remain installed. If installation failed, rerun the appropriate release installer after checking the failure. Do not delete the database to switch client connections.

## Optional installer arguments

The downloaded `install.ps1` accepts these arguments. When using a release page's script-block command, append the argument to that invocation. Do not paste a connection key into a command line.

| Argument | Purpose |
| --- | --- |
| `-ServerOnly` | Install only the server. Default: false. |
| `-ClientOnly` | Prepare client components, then choose a server with `hindsightkit connect`. No local server or endpoint is created. |
| `-Server http://memory-host:9077` | Shortcut for client-only installation and connection to a known server. It requests the key separately. |
| `-NoOpen` | Do not open the dashboard after setup. |
| `-InstallDir C:\Apps\HindsightKit` | Change the release application, managed Python, and installation-log location. It does not relocate memory or user configuration. |
| `-Model` / `-ReasoningEffort` | Select model settings for a new server profile. |
| `-Port` | Set the API port for a new server profile: 1024–55534. Default: 9077. |
| `-ModelDir C:\models\e5` | Reuse the official multilingual E5 model. The directory must contain `onnx\model.onnx` and tokenizer files, including `tokenizer.json`. |
| `-ApiKeyEnv NAME` | Read a connection key from a named environment variable for automated setup. |

`-ClientOnly` and `-Server` cannot be combined with `-ServerOnly` or server model/port options. `-ApiKeyEnv` during client-only installation requires `-Server`. Client-only preparation without an endpoint keeps connection-key entry for the later `connect` command.

## Automatic startup

Use these commands to inspect, disable, or enable startup after Windows sign-in:

```powershell
hindsightkit startup status
hindsightkit startup off
hindsightkit startup on
```

Setup registers or updates a task named `HindsightKit-Login-<user SID>-<installation ID>`. Upgrades preserve a disabled setting. The task uses the installed command's absolute path, so it does not depend on the terminal PATH. Client-only installations resume a saved client connection; they do not start a local server, even if one was previously installed.

An explicit `hindsightkit stop` remains effective across Windows restarts. Run `hindsightkit start` to resume services; enabling startup alone does not clear that pause. Disconnected clients stay disconnected. Startup retries a failure up to three times at one-minute intervals. Expired relay credentials still require an interactive `share --relay` or `connect` command.

`startup status` reports the Windows task's enabled state and last result. Output is saved in `%USERPROFILE%\.hindsightkit\startup.log` and `startup-error.log` (or under `HINDSIGHTKIT_HOME`). Use `hindsightkit status` to check the resulting services and client connection. A successful task result can also mean startup was skipped because memory was paused or no client was connected.

There is no uninstall command. Before manually removing an installation, run `hindsightkit startup off` to remove its scheduled task, then `hindsightkit stop`. These commands preserve memory and configuration.

## Model configuration

Hindsight makes separate model requests through the official Copilot SDK. Changing the model in Copilot Chat or CLI does not change Hindsight's model. New profiles default to `gpt-6-astra` and `xhigh` reasoning; the server account must have access to the chosen model.

Existing profiles retain their settings when setup is rerun. To change them, stop HindsightKit, edit `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_REASONING_EFFORT` in `%USERPROFILE%\.hindsight\profiles\hindsightkit.env`, then start it again. The setup flags do not override an existing model or port silently.

Local embeddings use ONNX multilingual E5. Ranking uses Hindsight's RRF; no Torch-based reranker is installed by this profile.

## Start, stop, and inspect

```powershell
hindsightkit status
hindsightkit start
hindsightkit ui
hindsightkit status --test-memory
hindsightkit stop
```

The default local API address is `http://127.0.0.1:9077` and the dashboard is `http://localhost:19077`. The authenticated API listens on IPv4 interfaces; the database listens only on loopback. PostgreSQL prefers port 15432 and selects an available port during its first setup. No firewall rules are created.

The processes continue after the terminal closes. Setup enables automatic startup 30 seconds after the installing user signs in to Windows. It runs in the background under that user, without administrator privileges or a stored password. It does not start before sign-in. `stop` stops local services and pauses memory in this computer's MCP and hooks, including direct clients. They stay paused until `start`. On a client-only machine, `start` resumes the saved connection and relay without creating a local server. `ui` requires a local server; its dashboard starts alongside the API. See [remote connections](devtunnel.md) for disconnecting and sharing.

`status` reports local services, relays, and the selected client connection without making model calls. Add `--test-memory` to also run a temporary retain/recall test on the local server using Copilot allowance. A client-only machine reports that the memory test is skipped; it never writes a remote test bank. `clients` targets the local server when installed.

## File locations

These are default Windows locations. `%USERPROFILE%` means the user's home directory; `%LOCALAPPDATA%` is its local application-data directory. In PowerShell commands, expand these through `$env:USERPROFILE` and `$env:LOCALAPPDATA`.

Application versions are separated from persistent settings and memory so upgrading the program can reuse the existing database. The current layout also keeps npm components in the persistent HindsightKit directory.

| Location | Contents |
| --- | --- |
| `%LOCALAPPDATA%\HindsightKit\versions\<version>-<hash>` | Application, assembled Python wheels and requirements in `python`, npm archives in `node`, its `.venv`, and release metadata |
| `%LOCALAPPDATA%\HindsightKit\downloads` | Release archives cached by SHA256 and checked again before reuse |
| `%LOCALAPPDATA%\HindsightKit\cache` | Shared uv package cache and portable setup tools |
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

Run the newer release's installer to upgrade. It preserves the last successful installation mode: client-only stays client-only even without repeating `-ClientOnly`. It verifies package hashes, keeps version directories separate, and restarts managed server processes when server setup runs. Reload coding clients afterward. Database downgrades are not supported.

After successful setup and its runtime checks, the installer keeps the current release and the previous successful release. It removes older managed versions, including their Python environments, after checking file ownership, running processes, launchers, and configuration references. Referenced versions, modified files, unknown directories, and directories containing links are kept. If process or configuration inspection fails, version cleanup is deferred. Close older HindsightKit sessions and rerun the installer to retry. Cleanup failure does not fail installation.

The installer announces when configuration has completed and reports cleanup phases and item counts. Optional cleanup has a 30-second time budget, checked between operations. When the budget is reached, installation finishes successfully and leaves remaining old files for a later attempt. A single filesystem or process-inspection call can take longer; large releases may remain if their safety checks cannot finish within the budget.

When upgrading from installers without success receipts, the newest legacy copy is kept until another successful version is available. Other legacy copies can be removed after the same checks. Failed setups recorded by the current installer are kept for diagnosis and retries. Keeping a previous program version does not provide database rollback.

Cleanup also removes unreferenced release downloads older than seven days and installation logs older than 30 days. It preserves archives needed by retained versions and recent interrupted downloads. The installer reports the number of versions and cache/log files removed and their total file size; hard-linked files may share disk space. Persistent memory, database files, models, settings, the shared uv cache, managed Python, and portable runtime tools are outside this cleanup. Running the same release installer again reuses its version directory.

To change roles, explicitly use `-ClientOnly`, `-ServerOnly`, or `-ClientOnly:$false` for full installation in the PowerShell script-block invocation. Installation and configuration are handled by the installer; the public command has no `setup` or `copilot` subcommand. Use the independent `copilot` command to launch Copilot.

The application downloads separately from Python and Node dependencies. Dependencies are split into client and server components. If their content hashes match the cached archives, an upgrade downloads only the application. A dependency change downloads only the affected component archives. Python environments remain separate for each application version and reuse the shared uv cache; existing npm installations are checked before reuse.

All required archives are downloaded and assembled before setup runs. A download or extraction failure leaves the previous version in place and keeps verified downloads for the next attempt. Existing releases that used a single combined archive have no component cache; their first upgrade to this format downloads the required components. Clearing the download cache also requires those downloads again.

Setup preserves existing model settings, memory banks, and unrelated editor configuration. Changed integration files receive a `.hindsightkit-backup` copy once. Conflicting endpoints or disabled-learning settings stop registration. The official coding-agent configuration must be strict JSON; VS Code JSONC comments are preserved.

A full upgrade also refreshes this computer's client components when they use a remote server. The selected address and connection key remain unchanged.

Upgrading files does not update already running sessions. A source installation still depends on its checkout until a release installation has completed and the relevant services and clients have restarted. Do not delete a directory that still supplies a running installation.

An existing external PostgreSQL URL is retained and checked. Its administrator must provide PostgreSQL 14+, pgvector 0.8+, and `pg_trgm` in the database. HindsightKit does not manage that external server's processes or roles. An unknown local data directory or a PostgreSQL major-version mismatch stops setup; changing a connection string does not migrate memory.

## Troubleshooting

### Find the failed stage

The release installer prints the failed stage, the first matching dependency error, and a log path under `<InstallDir>\logs`. With the default directory, logs are in `%LOCALAPPDATA%\HindsightKit\logs`. The installer restricts this directory to the current user and SYSTEM.

The log contains stage messages and dependency-command output, not a complete terminal transcript. Source installations also log npm output. Copilot login and connection-key prompts remain excluded. Keep the relevant console error if the failure occurs during an interactive stage.

### Dependency installation and retries

If this computer only connects to another server, use the release's `-ClientOnly` command, or pass `-Server` with the server address. A fresh client downloads the smaller package and skips the local dashboard, database, and embedding model. An existing local server keeps its management dependencies.

Release installation uses pinned Python wheels and Hindsight npm components from separate release archives. Copilot CLI is separate: setup checks and reuses an existing installation; if missing, it installs the official CLI globally through npm. That step requires network access and uses the user's npm registry, proxy, and CA settings. Existing Copilot installations are not upgraded or overwritten.

Setup checks Copilot entries in PATH order. If a Windows application alias cannot start, it reports that path and error, then tries the next entry. A working first entry is reused. Version-check diagnostics are redacted and saved in the installation log; login output stays private. If all detected entries fail, setup preserves them and stops instead of installing over them.

Setup reuses x64 Node.js 22+ with npm from PATH. Otherwise it reuses the current installation's portable Node.js or downloads the pinned official runtime. It skips runtimes inside another HindsightKit checkout or release directory.

Rerun the same installer after an interrupted dependency installation. No uninstall or cache cleanup is needed. Keep memory, connection settings, and Copilot configuration. Installation checks existing npm files and repairs damaged dependencies from the bundle.

### Retry reports changed application files

The release installer verifies installed application files on retry. It stops if they are edited, missing, or damaged. Use a new `-InstallDir` for a clean copy; existing settings and database paths remain unchanged. Dependency installation can otherwise be retried in the same version directory.

### Command or editor still uses an older installation

Open a new terminal and restart VS Code. `hindsightkit --help` shows which commands the installed launcher exposes. Updating a source checkout or publishing a release does not update an installed copy automatically. Rerun the release installer to upgrade it.
