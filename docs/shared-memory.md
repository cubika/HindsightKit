# Shared memory setup

Local installation remains the default. Shared setup adds an authenticated API and a client activity list.

ProvenLoop connects clients to an HTTP(S) API address. IP addresses, DNS names, and local ports forwarded by Dev Tunnels or SSH use the same configuration. Tunnel accounts, IDs, and processes stay outside ProvenLoop. Memory remains in one official Hindsight server.

## Installation

The default `./setup.ps1` installs the local server, dashboard, and Copilot integrations. A shared server additionally enables API authentication and selects its listening address. Existing memory and unrelated configuration are preserved. Changing an existing managed connection is explicit.

Client installation accepts a server URL and an explicit bank ID. A new client installs the Python client runtime, Node, and Copilot integrations, without Hindsight server packages, a database, embedding models, or a dashboard. Switching an existing server installation to a client preserves its installed server components and data. Credentials come from a hidden prompt or an environment variable, never a command-line token argument. The local official configuration stores the credential and must stay out of Git.

Clients use the same bank ID even when their checkout paths differ. An explicit bank applies to both MCP tools and automatic session capture. Ordinary local installation retains repository/shared routing. Selecting a different bank does not copy or merge existing memories.

## Network and lifecycle

On the server, choose the existing bank to share, or create one with this setup. The API key prompt is hidden. Use the same key when installing clients. For private IPv4 access:

```powershell
.\setup.ps1 -Share -Listen 0.0.0.0 -Bank provenloop-shared -NoOpen
```

An existing managed installation changing its bank needs `-ReplaceConnection`. For tunnels, use `-Listen 127.0.0.1` and forward API port 9077 using your chosen network tool. Direct access also requires a network/firewall rule allowing the selected API port; setup does not change firewall rules.

On another machine, copy or clone this checkout, then run:

```powershell
.\setup.ps1 -ApiUrl http://10.0.0.20:9077 -Bank provenloop-shared -DeviceName DevBox-West
# For an already established local port forward:
.\setup.ps1 -ApiUrl http://127.0.0.1:9077 -Bank provenloop-shared -DeviceName DevBox-West
```

These are alternative addresses, not sequential setup steps. Use the actual forwarding port and keep it free of any local Hindsight server. After installation, reload VS Code and open a fresh Copilot CLI session. A bare `provenloop setup` keeps the saved mode, address, bank, and device identity. To change a managed address or bank, rerun setup with `--replace-connection`; to return to the full local installation, run `./setup.ps1 -Local -ReplaceConnection` from this checkout. Existing services are not stopped by client setup.

For scripted setup, `-ApiKeyEnv NAME` reads an existing environment variable named `NAME`; the value is not passed as an argument. Model calls use the server's Copilot account. Clients keep their own Copilot login for coding work.

The shared API supports both direct access and an authenticated tunnel. Direct HTTP is suitable only on a trusted private network; use HTTPS through an existing reverse proxy on other networks. HTTPS clients verify certificates. Configure the final API origin, without a login redirect or URL rewrite: the official SDK and transcript hook retain their upstream redirect behaviour. Connection checks and inventory requests reject redirects. The server dashboard remains local.

Client `status` checks its configured API and bank. `check` exercises retain and recall in a disposable bank and removes it. Client `start`, `stop`, and `ui` explain that service management belongs on the server; they never start a replacement local database. Network failures do not change the configured destination.

## Client activity

The optional shared-server extension stores a small, bounded inventory outside the memory database. Each installation generates a device ID and a display name. VS Code and Copilot CLI are separate registered clients on that device. Repeated setup updates the same records.

`provenloop clients` groups registered clients by device and shows their last reported successful MCP call or CLI prompt recall. Transcript writeback alone does not update this timestamp because the upstream hook can return success after logging a failed submission. Activity in the last five minutes is labelled recent; this is not a count of open windows, live sockets, or online sessions. Timestamps update at most once per client per 30 seconds. There are no heartbeats or background client service. Display names and activity are self-reported under the shared API credential; this inventory does not provide per-device permissions or revocation.

The extension uses the official Hindsight HTTP extension interface and shared API authentication. It does not change memory extraction, retrieval, or storage. A reporting failure must not discard a successful memory operation.

## Validation

Automated checks cover local defaults, a client-only installation path, authenticated SDK calls, fixed-bank routing, duplicate registration, bounded activity records, configuration conflicts, unavailable servers, and direct HTTP plus local TCP forwarding. Tests use isolated configuration and synthetic data.

On 2026-09-16, 49 tests passed using the existing Python environment, including real stdio MCP sessions and Windows background-process checks. The dependency lock passed offline consistency validation and the client dependency export excludes Hindsight API, embed, PostgreSQL, and model packages. A fresh client environment and wheel build could not finish because downloads from files.pythonhosted.org failed with TLS HandshakeFailure. These download/install paths still need verification on a clean machine. No production memory was used for these checks.

Actual Dev Box networking, company login policy, and Microsoft relay reconnect behaviour require the two-machine check. On the first machine, retain a unique test fact; on the second, recall it from the same bank. Check both VS Code and CLI, inspect the client list, interrupt and restore the network, and remove the test document afterward.

Sources: [Hindsight configuration](https://hindsight.vectorize.io/developer/configuration), [Dev Tunnels connections](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands), [Dev Tunnels network requirements](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security).
