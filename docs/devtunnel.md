# Connect another computer

Install the memory server normally. Prepare a new coding computer with the v0.1.2 release page's `-ClientOnly` command, then choose its server using the commands below. Client preparation does not install a local dashboard, database, or model, and does not select an endpoint. The v0.1.2 candidate is awaiting validation and publication; its new installer flag is unavailable in older releases.

If installation already succeeded, run `connect` directly. An existing local server and dashboard can remain installed; changing the client connection does not require deleting them or their database. See [installation](installation.md#prepare-a-client-for-another-server) for retries and existing-server behavior. Local use needs no sharing step.

## Connect directly

On the computer that stores memory, run:

```powershell
hindsightkit share
```

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

The first relay use downloads Microsoft's signed Dev Tunnels CLI if it is missing and requests login if needed. Sign in with the same Dev Tunnels account on both computers. This login is separate from Copilot authentication. The tunnel is private to that account; HindsightKit does not enable anonymous access. The network must allow the [Dev Tunnels outbound domains](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#domains).

HindsightKit manages the tunnel and its background processes. The coding client keeps a stable loopback address even when the CLI selects a different forwarding port. The relay forwards the memory API; PostgreSQL and the dashboard are not forwarded.

## Start, inspect, and stop

| Command | Effect |
| --- | --- |
| `hindsightkit status` | Reports relay state, requests authenticated discovery from the configured client destination, and reports local server health when installed. |
| `hindsightkit start` | Starts the local server when installed and restores saved relay connections. A client-only installation restores its relay without creating a local server. |
| `hindsightkit stop` | Stops this computer's managed relay processes and local server components. Saved connections remain available for a later start. |
| `hindsightkit unshare` | Stops the server's relay and removes its saved sharing configuration. |

The relay continues after the terminal closes. Its supervisor restarts an exited tunnel process with a delay between attempts. An interrupted request can still fail; recovery does not replay it.

After reboot, run `hindsightkit start` on the memory server. Client MCP and hooks can also restore their saved relay when they start or run, including after `stop`. No Windows service or login task is installed. Background recovery does not open a login flow. If sign-in has expired, rerun `share --relay` on the server or `connect` on the client interactively.

`unshare` leaves the cloud tunnel, server key, and existing direct access in place. It disables this installation's automatic relay sharing; it does not revoke a connection code. Microsoft expires an unused tunnel after its inactivity period. If that happens, run `share --relay` again and use the new code on the client.

To switch a coding computer back to its own installed memory server:

```powershell
hindsightkit connect --local
```

This also stops that computer's managed client relays. It requires an existing local server installation.

## Verify the connection

Run `hindsightkit status` on the coding computer to check its selected destination. A relay marked `ready` is not, by itself, a successful memory request; also check the `Client` result. `status` does not start a stopped relay. Use `start` first when needed.

`hindsightkit check` performs a temporary retain/recall test and uses Copilot allowance. It attempts to delete its test bank afterward. On a computer with a local server installed, `check` targets that server even when the coding client points elsewhere. On a client-only installation, it targets the configured remote server. Use an actual client memory query to verify routing from an editor session.

A recorded test passed synthetic HTTP traffic through the real private relay service on one computer, including port conflicts, process reuse, and restart at the same client address. Test workers and tunnels were removed. This does not establish access from a second computer or through its account and network policies. See [release validation](release-validation.md) for the recorded checks. Microsoft provides Dev Tunnels for development and testing; see its [documentation](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/).
