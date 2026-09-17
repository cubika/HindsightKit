# HindsightKit

HindsightKit installs a [Hindsight](https://github.com/vectorize-io/hindsight) memory server and connects GitHub Copilot Chat and CLI to it. Coding sessions select their repository memory automatically and can recall shared memory.

## Install from a release

The v0.1.1 preview supports **Windows x64** with Windows PowerShell 5.1 or PowerShell 7. Install Git and have a Copilot account available for sign-in.

1. Open **Releases** in this repository and select a published version.
2. Copy its installation command into PowerShell. A restricted repository requires GitHub CLI sign-in as shown on that release page.
3. Finish any Copilot login prompt. After setup succeeds, reload VS Code, allow the Hindsight MCP server, and start a new Copilot CLI session.

The default command installs the local server and coding integrations together. Version 0.1.1 bundles pinned Python packages in the application archive and installs them locally with hash verification. The Python interpreter, Node.js, npm components, embedding model, and precompiled PostgreSQL/pgvector distribution still require downloads. No source checkout or C++ compiler is needed. Setup checks a temporary memory through the real model provider and removes the test bank afterward; this uses Copilot allowance.

Version 0.1.1 removes the PyPI wheel download step that failed on affected v0.1.0 installations. It distinguishes downloaded and reused Node.js runtimes and records installation stages in a log. The tests and installation checks are recorded in [release validation](docs/release-validation.md).

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

Stored memory remains in Hindsight's database; model requests use the server's Copilot account. Remembered information may be incomplete or wrong, so inspect source evidence when it matters.

## Connect another computer

Remote access is an optional step after installation. On the memory server, run `hindsightkit share`. On the coding computer, run `hindsightkit connect` and paste the connection code at the hidden prompt.

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
