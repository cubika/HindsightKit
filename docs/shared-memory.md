# Memory routing and server roles

HindsightKit stores memory on a Hindsight server and connects coding sessions to it. Follow [installation](installation.md) to install the required roles, then use the [connection guide](devtunnel.md) to connect another computer.

## Where a session reads and writes

The managed coding integrations select memory from the session's Git repository:

| Session location | Reads | Writes |
| --- | --- | --- |
| Inside a Git repository | That repository's bank and the server's shared bank | The repository's bank |
| Outside Git | The server's shared bank | The shared bank |

Repository sessions can use shared context without writing repository details into shared memory. Other repositories are outside that session's selected scope. Retain, recall, and reflect use the official Hindsight API.

Clones with the same normalized `origin` host and repository path use the same bank on the same server, even when their local directories differ. Standard HTTPS and SSH origins are normalized, including the standard Azure DevOps forms. Different SSH host aliases, path spellings, or nondefault ports can produce different identities; use a common origin URL when two clones should share memory. Repositories without a recognized origin use an identity based on the device and local repository. Git worktrees share their repository's memory.

The selected scope stays fixed for a coding session. Use one repository per VS Code window. If its workspace roots change, restart the Hindsight MCP server before using memory. Start a fresh Copilot CLI session when switching repository context.

## Pause memory for a repository

Run these commands inside the repository or one of its worktrees:

```powershell
hindsightkit memory off
hindsightkit memory status
hindsightkit memory on
```

`hk` accepts the same commands when that alias is installed. Memory is on by default. The setting is stored in local Git configuration, shared by the clone's worktrees and subdirectories. It is not committed or copied to other clones or computers. Running these commands outside Git reports an error.

`off` stops subsequent automatic recall and session saving in Copilot CLI. It also blocks the repository's MCP calls to `retain`, `recall`, `reflect`, and optional `recall_mail`. Tools can remain visible; a call reports that repository memory is disabled. The check happens before relay startup, bank discovery, or memory requests. In-flight requests can finish. Existing saved memory and context already loaded into a chat remain available. Server connector jobs continue independently.

`on` restores MCP access and automatic recall on the next call. Start a new Copilot CLI session to resume automatic session saving: a session that spans a pause will not save its transcript afterward, so enabling memory cannot upload the conversation from the paused period. New sessions started while memory is off also skip automatic saving for the rest of that session.

The switch follows the repository selected when the session began. Changing the CLI working directory does not change that selection. VS Code must supply workspace roots, including for a connection using a fixed bank. Switching VS Code workspace roots requires restarting its MCP server.

After upgrading an older installation, restart the MCP server and start a new CLI session once to load this support. Later `off`/`on` changes do not require restarting the MCP server.

## Server and client roles

The server owns the database, embedding model, dashboard, and optional connector jobs. Its Copilot account supplies the model calls. Coding clients run the editor and CLI integrations and send memory requests to the selected server. A client-only installation has no local database or model, and an unreachable server does not cause it to create a replacement.

One computer can run both roles while its coding client uses a different server. Changing the client connection leaves the local dashboard, database, and connector jobs on their own server profile. A later default setup preserves an existing remote client selection. `ServerOnly` leaves client settings alone.

The roles also keep separate configuration: the default server profile is `%USERPROFILE%\.hindsight\profiles\hindsightkit.env`, and the coding client's selected API and key are in `%USERPROFILE%\.hindsight\coding-agent.json`. `HINDSIGHT_CONFIG` can select a different client file. See [file locations](installation.md#file-locations) for the full layout and the limits of directory overrides.

## Permissions

The server requires a connection key for its memory API. Default server setup listens on all IPv4 interfaces, using port 9077 unless configured otherwise. Firewall rules and the network determine which computers can reach it. Direct HTTP does not encrypt the key or memory traffic; transport choices are covered in the [connection guide](devtunnel.md).

Repository routing controls the scope exposed by the managed coding integrations. It is not per-repository authorization for people who hold the server key. The key grants access to the server, and the current setup has no per-device permissions or individual key revocation. Use this arrangement only among computers trusted with that server's memory.

The optional private relay adds Dev Tunnels account authentication. It does not narrow the memory permissions of the server key. On the server, `unshare` revokes existing connection codes and disables direct and relay access while preserving local memory. On a client, it disconnects that client. `stop` pauses this computer's memory integrations and stops its services until `start`.

## Client activity

```powershell
hindsightkit clients
```

The inventory lists registered machines and integrations, including the last reported use. `Recent` means use within five minutes; it does not count open windows, sessions, or currently online devices. Reconnecting refreshes the hostname and reuses the device identity. The inventory contains no memory content and grants no permissions.

`clients` queries the local server when one is installed. On a client-only computer it queries the configured remote server. `status` checks the coding client's selected destination as well as any installed local server. Its optional `--test-memory` test always targets the local server and is skipped on a client-only computer.

## Existing repository mappings

During setup, saved repository mappings and surviving local session records can associate an existing bank with its current repository identity. Conflicting mappings stop setup without moving memory. If no mapping or session record survives, the old bank remains on the server, but setup cannot reconstruct its repository association. Inspect those banks in the server dashboard before changing their mappings.
