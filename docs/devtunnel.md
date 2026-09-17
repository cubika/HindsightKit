# Connect Dev Boxes with Dev Tunnels

Use this when the coding machine cannot reach the memory server directly. Both machines connect out to Microsoft Dev Tunnels. HindsightKit connects to the local port created on the coding machine; it does not need a tunnel ID in its settings.

This guide uses the default API port, 9077. Only the memory API is forwarded. The database and dashboard stay on the server.

## 1. Prepare both machines

Install the [Microsoft Dev Tunnels CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started) on both machines. Sign in with the same account that will own the tunnel:

```powershell
devtunnel user login
devtunnel user show
```

Use the intended company account on both Dev Boxes. The default tunnel is private to its owner; no anonymous access setting is needed.

## 2. Start the memory server and tunnel

On the machine that stores memory, run from the HindsightKit checkout:

```powershell
.\setup.ps1 -ServerOnly
hindsightkit status
```

Setup starts the server and reports the location of its connection key. The default key file is `%USERPROFILE%\.hindsightkit\server\connection-key.txt`. Share this value privately with your coding machine; it is the HindsightKit key, separate from the Dev Tunnels login. Keep it out of Git and command-line arguments.

In a terminal on the server, run:

```powershell
devtunnel host -p 9077 --protocol http
```

Keep this process running and copy the tunnel ID from its output. If Hindsight uses a different API port, substitute that port here.

## 3. Connect the coding machine

On the other Dev Box, replace the quoted value with the ID from the server:

```powershell
$tunnelId = 'ID-FROM-SERVER-OUTPUT'
devtunnel connect $tunnelId
```

Keep this process running. Check its output for the local forwarded port. For port 9077, open another terminal in the HindsightKit checkout and run:

```powershell
.\setup.ps1 -Server http://127.0.0.1:9077
hindsightkit status
```

Enter the server's HindsightKit connection key at the hidden prompt. The machine name and memory routing are automatic. If the forwarded local port differs, use that port in the URL.

The `-Server` value is the local forwarded HTTP address. Do not use the tunnel ID, the server's private IP, or the browser forwarding URL ending in `devtunnels.ms` for this workflow. The Dev Tunnels CLI handles tunnel authentication before forwarding requests.

Reload VS Code and open a fresh Copilot CLI session after client setup. Clients install no dashboard or database.

## 4. Verify shared use

On the memory server:

```powershell
hindsightkit clients
```

The coding machine should appear with its registered integrations. After a successful memory query, its last-use time should update. This list reports recent use, not open windows or live tunnel connections.

On the client, `hindsightkit check` performs a retain/recall check using a temporary bank, then removes it. It uses a small amount of the server's Copilot allowance.

To check sharing between coding clients, start fresh sessions outside Git on both machines, save a unique test fact on one, and recall it on the other. For repository memory, use clones with the same Git origin. Remove the test document through the server dashboard afterward.

## Reconnect and troubleshoot

The Hindsight server and both `devtunnel` processes must remain running. After a server reboot, run `hindsightkit start`, host the tunnel again, then reconnect the coding machine. The temporary host command may produce a new tunnel ID; the saved HindsightKit URL remains usable if the forwarded local port stays the same.

For a reusable tunnel ID, create a persistent tunnel once on the server:

```powershell
devtunnel create
devtunnel port create -p 9077 --protocol http
```

Record the ID returned by `create`. On subsequent runs, use `devtunnel host YOUR-TUNNEL-ID` on the server and `devtunnel connect YOUR-TUNNEL-ID` on each coding machine. Tunnel expiry and account login still follow Dev Tunnels rules.

| Symptom | Check |
| --- | --- |
| Tunnel cannot connect | Both accounts match, the host process is running, and company policy permits the [required outbound domains](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security#domains). |
| Local port is occupied | Stop the conflicting local service or use the actual port reported by the forwarding CLI. Do not install a second Hindsight server on a client just to resolve this. |
| HindsightKit reports HTTP 401 | Enter the memory server's connection key, not a tunnel token. |
| Memory connection is refused | Check both tunnel processes and run `hindsightkit status` on the server. |
| Forwarded port changes | Rerun client setup with the new `-Server` URL, then restart coding sessions. |

## Validation scope

The commands were checked against [Microsoft's CLI documentation](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands). Automated HindsightKit tests cover authenticated HTTP, local TCP forwarding, and client configuration. Real cross-Dev-Box relay access, company sign-in policy, and reconnect behaviour remain to be tested.

Microsoft positions [Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview) for development and testing. See [server and client setup](shared-memory.md) for direct network access and the underlying installation behaviour.
