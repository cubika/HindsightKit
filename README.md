# HindsightKit

HindsightKit installs a [Hindsight](https://github.com/vectorize-io/hindsight) memory server and connects GitHub Copilot Chat and CLI to it. Coding sessions select their repository memory automatically and can recall shared memory.

## Install from a release

The v0.1.4 preview supports Windows x64 with Windows PowerShell 5.1 or PowerShell 7. Install Git and have a Copilot account available for sign-in. Use the commands from the published version you select; `-ClientOnly` requires v0.1.2 or later.

1. Open **Releases** in this repository and select a published version.
2. Use its default command to host memory on this computer, or its `-ClientOnly` command to prepare a coding client for an existing server. A restricted repository requires GitHub CLI sign-in as shown on that release page.
3. Finish any Copilot login prompt. Connect a new client to its server as described below. After connection succeeds, reload VS Code, allow the Hindsight MCP server, and start a new Copilot CLI session.

The default command installs the local server and coding integrations together. `-ClientOnly` prepares the client command and Copilot components without creating a server connection, local dashboard, database, or model. A fresh client uses the smaller client archive. An existing local server keeps its management dependencies and data; client setup does not reconfigure or start it.

Python packages are bundled with hashes. Python, Node.js, and npm components still need downloads; a new local server also needs the embedding model and precompiled PostgreSQL/pgvector distribution. No source checkout or C++ compiler is needed. Server setup checks a temporary memory through Copilot and removes it afterward. npm installation prints output and elapsed-time heartbeats; see [troubleshooting](docs/installation.md#npm-installation-takes-time). Test results and publication status are recorded in [release validation](docs/release-validation.md).

See [installation, upgrades, and file locations](docs/installation.md) for details. Building or installing from a checkout is covered separately in [development](docs/development.md).

## Use memory

```powershell
hindsightkit status
hindsightkit ui
```

`status` checks the configured client connection and any local server. `ui` starts the local services if needed and opens the dashboard. The short command `hk` works too, unless that name was already taken on the machine.

Services stay running when the terminal closes. After restarting Windows, run `hindsightkit start`. Use `hindsightkit stop` to stop the local services and managed relay processes. Setup does not create a login task or Windows service.

| Session location | Writes | Reads |
| --- | --- | --- |
| A Git repository | That repository's memory | Repository and shared memory |
| Outside Git | Shared memory | Shared memory |

Open one repository per VS Code window. No per-repository enable step is needed. The [memory scope guide](docs/shared-memory.md) explains repository identity, cross-computer use, and access limits.

Run `hindsightkit memory off` inside a repository to pause its hooks and MCP memory tools. Use `hindsightkit memory on` to re-enable them and `hindsightkit memory status` to inspect the setting. The switch stays local to that clone and applies to its worktrees. See [pausing repository memory](docs/shared-memory.md#pause-memory-for-a-repository) for session behavior.

Stored memory remains in Hindsight's database; model requests use the server's Copilot account. Remembered information may be incomplete or wrong, so inspect source evidence when it matters.

## Connect another computer

On the memory server, run `hindsightkit share`. Prepare the coding computer with the release's `-ClientOnly` installation command, then run `hindsightkit connect` and paste the connection code at the hidden prompt. For a known address, use `hindsightkit connect --server http://memory-host:9077`; the key is requested separately.

If HindsightKit is already installed successfully, run `connect` directly. An existing local dashboard does not need to be removed.

When direct access is unavailable, use `hindsightkit share --relay` to prepare a private relay. The [remote connection guide](docs/devtunnel.md) covers sign-in, background recovery, and returning to local memory. Connection codes contain the server key and must be shared privately.

## Optional email memory

`hindsightkit connectors` opens the connector settings. The WorkIQ connector requires a supported, already installed and signed-in WorkIQ client. It keeps one current outcome per accepted email thread and provides a separate read-only `recall_mail` tool. It is optional and does not change repository memory routing.

See [connectors](docs/connectors.md) for prerequisites, configuration, and current limitations.

## Documentation

- [Installation and troubleshooting](docs/installation.md)
- [Memory scope and access](docs/shared-memory.md)
- [Remote connections](docs/devtunnel.md)
- [Connectors](docs/connectors.md)
- [Development](docs/development.md) and [release maintenance](docs/releases.md)
- [Release validation](docs/release-validation.md) and [connector validation](docs/connector-validation.md)

HindsightKit uses pinned official Hindsight components. Their licenses and notices remain with those components.
