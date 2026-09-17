# Server and client setup

Install the server and local coding integrations together:

```powershell
.\setup.ps1
```

Setup installs and starts Hindsight, PostgreSQL, and the local dashboard, then connects VS Code and Copilot CLI to the local API. The authenticated API listens on IPv4 port 9077. It generates a connection key on first installation and reuses it for the local client. Use `.\setup.ps1 -ServerOnly` on a dedicated memory server to skip coding integrations. The server needs a Copilot login for its model calls. For a release installation without a checkout, use the command in that repository's release notes; it accepts the same role options.

Install a client on each machine used for coding:

```powershell
.\setup.ps1 -Server http://memory-host:9077
```

Enter the server's connection key at the hidden prompt. A client connecting to the server on the same Windows account reuses its local key automatically. The machine name comes from the local hostname. No bank, device name, listening address, or tunnel ID is required. Client setup installs coding integrations without a database, models, dashboard, or server processes.

Bank selection is internal. Repository sessions keep their own memory and read shared memory; sessions outside Git use shared memory. Clones with the same Git origin share repository memory across machines, even when their local paths differ. Repositories without an origin stay device-local. HTTPS and SSH origins with the same canonical host/path are normalized, including Azure DevOps standard URLs. Custom SSH host aliases need a common origin URL on both machines. Setup does not combine unrelated repository memories.

## Local use and network transport

For two Dev Boxes connected through Microsoft Dev Tunnels, follow the [step-by-step tunnel guide](devtunnel.md). It includes commands for both machines, the address to pass to client setup, and reconnect checks.

Default setup already includes the local client. To add one to an installation previously made with ServerOnly:

```powershell
.\setup.ps1 -Server http://127.0.0.1:9077
```

The two roles keep separate settings. Installing a client on the server does not redirect the server dashboard, database, or import jobs. Plain setup prepares the server and configures a local client when no remote client connection exists. It preserves an existing remote connection and prints a notice. ServerOnly leaves client settings alone. Running setup with a server address changes only the managed client connection after validation.

IP addresses, DNS names, and local ports forwarded by Dev Tunnels or SSH use the same command. For an established tunnel, use its local forwarded address as the server URL. HindsightKit does not manage tunnel IDs, accounts, or processes. Direct HTTP is for trusted private networks; use HTTPS through an existing reverse proxy elsewhere. Use the final API origin without redirects. Setup does not change firewall rules.

The server starts listening during setup. After reboot, run hindsightkit start; stop and ui manage only the local server. No login task or Windows service is installed. The status command reports installed roles. Client-only installations never launch a replacement local server when their connection is unavailable.

## Client activity

The clients command lists registered machines and coding integrations, with last use and activity within five minutes. It counts configured integrations, not open windows or sessions. Registration is idempotent; the hostname is refreshed during setup. The list contains no memory content and does not implement per-device permissions.

## Upgrade and validation

Existing databases, memory banks, model configuration, and unrelated editor settings are preserved. Setup recognizes old repository mappings from local CLI session records and reuses their banks. Conflicting mappings stop setup rather than choosing one silently. Old banks with no surviving session or mapping record remain in Hindsight; their association cannot be reconstructed automatically. They can still be inspected in the server dashboard. Rerun client setup after upgrading the server. Server setup does not remove an already installed client. When both roles share this checkout, the Python environment retains server dependencies. A fresh client installation excludes them.

Advanced server model and port settings remain available through setup help. Automated deployment can supply an API key through -ApiKeyEnv NAME; secret values are never command-line arguments. A new server normally generates its own key.

Tests use temporary profiles, synthetic keys, HTTP fixtures, local TCP forwarding, and real stdio MCP sessions. Actual Dev Box networking, company login policy, and tunnel reconnect behaviour require a two-machine check. A fresh dependency download was previously blocked by files.pythonhosted.org TLS HandshakeFailure; this is separate from local runtime tests.

Validated on 2026-09-17: 131 tests passed, including installation role separation, automatic repository routing, authenticated discovery, local TCP forwarding, and Windows process checks. After merging the latest interface changes, the 23 connector tests also passed. Actual two-machine networking and a fresh dependency download remain unverified.
