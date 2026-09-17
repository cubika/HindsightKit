# Connect another computer after installation

Install HindsightKit normally first. Local use needs no network setup. These commands are a separate, optional step when another computer should use this memory server.

## Direct connection

On the computer that stores memory:

```powershell
hindsightkit share
```

On the other computer:

```powershell
hindsightkit connect
```

Paste the server's connection code at the hidden prompt. The client verifies the server before updating its connection. Reload VS Code and open a fresh Copilot CLI session afterward. A failed connection preserves the previous settings.

The code contains the server address and its connection key. Share it privately with your own computer, keep it out of Git, and do not put it in command-line arguments. It grants access to the memory server; it is not a per-device permission or an expiring pairing token.

If the hostname is not reachable, supply an address that the other computer can use:

```powershell
hindsightkit share --address http://memory-host:9077
```

A known direct address also works without a code:

```powershell
hindsightkit connect --server http://memory-host:9077
```

The connection key is requested separately. Direct HTTP is intended for a trusted private network. An existing HTTPS reverse proxy can be used by passing its API origin. Setup does not change firewall rules.

## When the computers cannot connect directly

On the memory server:

```powershell
hindsightkit share --relay
```

On the other computer, run `hindsightkit connect` and paste the new code. Direct access is tested first. If the network cannot reach the server, HindsightKit starts its private relay in the background. An incorrect key, incompatible server, or invalid TLS certificate is reported without switching networks.

The first relay use installs Microsoft's signed Dev Tunnels CLI if needed and opens its normal login flow. Use the same account on both computers. HindsightKit creates a private tunnel owned by that account; it does not enable anonymous access or grant access to other people. Copilot login remains separate. Company policy must allow the [Dev Tunnels outbound domains](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#domains).

No tunnel ID, forwarding port, or extra terminal needs to be managed by the user. The client retains a stable loopback address even if the tunnel CLI chooses a different local forwarding port. Only the memory API is forwarded; PostgreSQL and the dashboard remain on the server.

## Daily use

```powershell
hindsightkit status
hindsightkit start
hindsightkit stop
```

The managed relay continues after the terminal closes and retries interrupted connections. After reboot, run `hindsightkit start` on the server to restore the saved relay. Client MCP/hooks also restore the saved connection when they start. Background recovery never opens a login flow: if authentication has expired, rerun `share --relay` or `connect` interactively. No Windows login task is installed.

To return the coding computer to its own installed memory server:

```powershell
hindsightkit connect --local
```

To stop and disable automatic relay sharing on the server:

```powershell
hindsightkit unshare
```

This disables the managed relay; it does not revoke the server key or disable existing direct access. Cloud tunnel expiry follows Microsoft policy. If an inactive tunnel expires, run `share --relay` again and distribute the new code.

## Verification

Use `hindsightkit check` for a temporary retain/recall test. It uses Copilot allowance and removes its test bank afterward. On a machine with both a local server and a remote client, the command checks the local server; check client connectivity with `hindsightkit status` or an actual client query.

Microsoft documents Dev Tunnels for development and testing. Cross-machine relay access, company login policy, and reconnect behavior require a two-machine check. Local fixtures alone do not establish that those external conditions have passed.
