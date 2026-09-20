# Connect another computer

Install the memory server normally. Prepare a new coding computer with the release page's `-ClientOnly` command, then choose its server using the commands below. Client preparation does not install a local dashboard, database, or model, and does not select an endpoint. The installer flag requires v0.1.2 or later.

If installation already succeeded, run `connect` directly. An existing local server and dashboard can remain installed; changing the client connection does not require deleting them or their database. See [installation](installation.md#prepare-a-client-for-another-server) for retries and existing-server behavior. Local use needs no sharing step.

## Connect directly

On the computer that stores memory, run:

```powershell
hindsightkit share
```

`share` and `share --relay` copy the connection code to the Windows clipboard and also display it in the terminal. If copying fails, copy the displayed code manually.

On the coding computer, run:

```powershell
hindsightkit connect
```

Paste the connection code at the hidden prompt. HindsightKit checks the server and its key before selecting it for the client. If discovery or registration fails, it restores the previous connection selection; editor registration may still need a retry. After a successful connection, reload VS Code, enable its Hindsight MCP server, and open a fresh Copilot CLI session.

The code contains the server address and connection key. It grants access to the memory server and has no pairing expiry or per-device restriction. Share it privately, keep it out of Git, and paste it only at the hidden prompt. See [permissions](shared-memory.md#permissions) for what the key allows.

By default, `share` uses the server's hostname and configured API port. If that hostname is not reachable from the coding computer, specify a reachable address:

```powershell
hindsightkit share --address http://memory-host:9077
```

You can also connect to a known address without a code:

```powershell
hindsightkit connect --server http://memory-host:9077
```

The key is requested separately. Direct HTTP sends the key and memory traffic without encryption, so use it only on a trusted private network. An existing HTTPS reverse proxy can provide the API origin instead. Use an origin without a path, query, fragment, or redirect. HindsightKit does not change firewall rules.

## Use a private relay

If the computers cannot reach each other directly, run this on the memory server:

```powershell
hindsightkit share --relay
```

Run `hindsightkit connect` on the coding computer and paste the new code. The client tries the direct address first and uses the relay after a network connection failure. An incorrect key, incompatible server, or TLS certificate error stops the connection attempt. Those failures do not trigger relay fallback.

The first relay use downloads Microsoft's signed Dev Tunnels CLI if it is missing and requests login if needed. Choose Microsoft (personal, work, or school) or GitHub at the terminal prompt; Enter selects Microsoft. HindsightKit opens the account provider's device sign-in page in your default browser, and the terminal displays a device code. Enter that code in the browser and sign in with the same account type and account used on the memory server. If the browser does not open, open the URL displayed in the terminal manually. Keep the terminal open until login finishes; the request times out after 10 minutes. This login is separate from Copilot authentication. The tunnel is private to that account; HindsightKit does not enable anonymous access. The network must allow the [Dev Tunnels outbound domains](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#domains).

You can also select the account type in the command. For GitHub, run these on the server and client respectively:

```powershell
hk share --relay --relay-provider github
hk connect --relay-provider github
```

Use `--relay-provider microsoft` for a Microsoft account. A saved login is reused when its type matches, or when you omit the option. If you select a different type, HindsightKit starts that login flow and checks the result before restarting the selected relay. Direct connections do not require this login.

Changing accounts does not transfer an existing server tunnel. If the newly signed-in account cannot access it, use the original account. If the tunnel expired, or you want to share from another account, run `hk unshare` on the server, then `hk share --relay --relay-provider github` (or `microsoft`) and distribute the new code. `unshare` revokes previous connection codes.

If sign-in stalls before the terminal displays a device code, press Ctrl+C and run the [Dev Tunnels device-code login](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands#manage-user-credentials) directly. Open the URL it displays and enter the code:

```powershell
devtunnel user login --use-device-code-auth
```

If `devtunnel` is not on PATH, use HindsightKit's downloaded copy:

```powershell
& "$env:USERPROFILE\.hindsightkit\tools\devtunnel.exe" user login --use-device-code-auth
```

For a custom `HINDSIGHTKIT_HOME`, use its `tools\devtunnel.exe`. If the server uses GitHub login, add `--github` and use the same GitHub account. After login succeeds, rerun `hindsightkit connect` on the client or `hindsightkit share --relay` on the server.

HindsightKit manages the tunnel and its background processes. The coding client keeps a stable loopback address even when the CLI selects a different forwarding port. The relay forwards the memory API; PostgreSQL and the dashboard are not forwarded.

## Start, inspect, and stop

| Command | Effect |
| --- | --- |
| `hindsightkit status` | Reports relay state, requests authenticated discovery from the configured client destination, and reports local server health when installed. |
| `hindsightkit start` | Starts the local server when installed and resumes memory and saved relay connections. |
| `hindsightkit stop` | Stops local services and relays and pauses this computer's memory integrations, including direct clients, until `start`. |
| `hindsightkit unshare` | Disconnects this computer's remote client. On a server, also disables direct and relay sharing and revokes old connection codes, preserving local memory. |

The relay continues after the terminal closes. Its supervisor restarts an exited tunnel process with a delay between attempts. A process that never becomes ready is restarted after 60 seconds.

On clients, the supervisor also checks HTTP reachability through the tunnel every 10 seconds, without sending a key or reading memory. A failed check clears the ready state; three consecutive failures restart the tunnel process while keeping the same local client address. Any HTTP response counts as reachable, including authentication and server errors. An interrupted request can still fail; recovery does not replay it.

Setup enables automatic startup 30 seconds after Windows sign-in. On the memory server, it starts local services and resumes saved sharing; client-only installations resume their saved client relay. Client MCP and hooks can also recover a saved relay during normal use. An explicit `stop` or `unshare` stays effective across restarts. Use `hindsightkit startup on`, `off`, or `status` to control login startup, and `hindsightkit start` to resume an explicit stop. Background recovery does not open a login flow. If sign-in has expired, rerun `share --relay` on the server or `connect` on the client interactively.

On a server, `unshare` rotates the server key and restricts the API to loopback. Previously issued codes no longer authenticate, including after a later `share`. The local client keeps access with the new key. A remote client on the same computer is disconnected too. The cloud tunnel remains in its owner's account but its local forwarding is disabled.

On a client, `unshare` forgets the connection key and disables relay recovery. `start` does not reconnect it; use `connect` to choose a server again. After changing servers, restart the Hindsight MCP server. Reconnecting to the same destination preserves its running MCP sessions. Sessions spanning a stop, disconnect, or server change are not saved retroactively; start a new Copilot CLI session for automatic capture.

To switch a coding computer back to its own installed memory server:

```powershell
hindsightkit connect --local
```

This also stops that computer's managed client relays. It requires an existing local server installation.

## Verify the connection

Relay diagnostics are written to `%USERPROFILE%\.hindsightkit\remote\host\supervisor.log` on the server and `remote\clients\<connection-id>\supervisor.log` under the same root on the client. `HINDSIGHTKIT_HOME` overrides that root. A relay connection attempt prints its log path, including when the attempt fails before saving a connection.

Each line is a JSON event with a UTC timestamp. Logs record CLI verification, account reuse or sign-in, worker startup, tunnel readiness, process exits and retries, and API discovery and registration failures. They contain exception types and numeric error codes; raw Dev Tunnels output, connection codes, tokens, and memory contents are excluded. Each log keeps up to 1 MiB plus one rotated `.1` file. These logs are available starting with v0.1.6; v0.1.5 can leave an empty log.

Run `hindsightkit status` on the coding computer to check its selected destination. A relay marked `ready` is not, by itself, a successful memory request; also check the `Client` result. `status` does not start a stopped relay. Use `start` first when needed.

`hindsightkit status` reports local services, relays, and the selected client connection without making model calls. Add `--test-memory` to also run a temporary retain/recall test on an installed local server using Copilot allowance. It deletes its test bank afterward. A client-only installation skips the memory test and checks authenticated discovery without writing remote memory. Use an actual client memory query to verify routing from an editor session.

A recorded test passed synthetic HTTP traffic through the real private relay service on one computer, including port conflicts, process reuse, and restart at the same client address. Test workers and tunnels were removed. This does not establish access from a second computer or through its account and network policies. See [release validation](release-validation.md) for the recorded checks. Microsoft provides Dev Tunnels for development and testing; see its [documentation](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/).
