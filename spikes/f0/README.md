# F0 feasibility probes

These probes test the first Windows and GitHub Copilot CLI integration
assumptions before the product workspace is created.

## Commands

Run the local runtime checks:

```powershell
pwsh -NoProfile -File .\spikes\f0\runtime\run-local-runtime.ps1
```

Run the isolated plugin lifecycle checks:

```powershell
pwsh -NoProfile -File .\spikes\f0\run-plugin-lifecycle.ps1
```

Run the live Copilot integration checks:

```powershell
pwsh -NoProfile -File .\spikes\f0\run-copilot-integration.ps1
```

Run the Extension event probe:

```powershell
pwsh -NoProfile -File .\spikes\f0\run-extension-probe.ps1 -Mode baseline
pwsh -NoProfile -File .\spikes\f0\run-extension-probe.ps1 -Mode delay
pwsh -NoProfile -File .\spikes\f0\run-extension-probe.ps1 -Mode throw
pwsh -NoProfile -File .\spikes\f0\run-extension-probe.ps1 -Mode exit
pwsh -NoProfile -File .\spikes\f0\run-extension-probe.ps1 -Mode baseline -Internal
```

Run the persistent experimental setting probe:

```powershell
pwsh -NoProfile -File .\spikes\f0\run-extension-opt-in-probe.ps1
```

The live integration script uses the signed-in Copilot CLI account and makes
three small prompt requests. It does not change the user's plugin or MCP
configuration.

## What the probes cover

The runtime probe checks:

- Node's built-in SQLite driver, WAL, transactions, migration version storage,
  and FTS5;
- atomic file replacement and one-file-per-item queue persistence;
- a Windows named pipe used as an OS-owned worker lease;
- release of that lease after the holder process is terminated;
- cold start, queue throughput, and idle resident memory.

The plugin lifecycle probe uses a temporary `COPILOT_HOME`. It registers the
local marketplace, installs the plugin twice, disables and enables it,
executes the update command, uninstalls it, and removes the marketplace.

The live integration probe checks:

- the installed Copilot CLI version;
- use of the existing Copilot sign-in without provider or token overrides;
- plugin Hook payloads;
- required field and type validation for observed Hook payloads;
- propagation of `PROVENLOOP_INTERNAL=1` through a restricted HTTP header;
- startup and shutdown of the plugin's stdio MCP server;
- a real MCP tool call;
- foreground Copilot behavior when the Hook endpoint is offline;
- foreground Copilot behavior when plugin Hooks fail and the plugin MCP command
  cannot start.

The Extension probes check:

- Session event discovery and required event coverage;
- event ID, timestamp, delivery latency, and callback CPU time;
- metadata-only logging without Prompt or tool content;
- delayed callback, callback exception, and process-exit isolation;
- internal Session exclusion before content copying;
- persistent experimental opt-in and settings-based rollback.

## Current result

The probes passed on Windows with Copilot CLI `1.0.82-0` and Node `22.18.0`.
The current Hook transport is not accepted for implementation. Raw localhost
HTTP round trips had a P95 near 2 ms, but Copilot's measured dispatch from
event timestamp to the Hook server reached about 1.2 seconds. Command Hook
P95 measurements ranged from about 700 to 800 ms.

The probe plugins are test fixtures. They are not production plugin assets.
