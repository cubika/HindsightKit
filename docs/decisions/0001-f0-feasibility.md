# ADR 0001: F0 Windows and Copilot feasibility

**Status:** Accepted with blocking follow-up
**Date:** 2026-08-28

## Context

ProvenLoop cannot start broad implementation until the Copilot integration,
authentication path, non-blocking failure behavior, and local SQLite runtime
have been tested on Windows.

## Decisions

### Compatibility baseline

The initial Copilot CLI allowlist contains `1.0.82-0` only. Unknown versions
must report an incompatible or unverified capability state instead of assuming
their event payloads are compatible.

The initial runtime is Node `22.18.0` on Windows 10 or 11. Runtime upgrades must
rerun the F0 probes.

### Plugin distribution

Production installation will use a Copilot plugin marketplace. Direct path
installation is deprecated by Copilot CLI and cannot be disabled through the
normal plugin lifecycle commands.

The local marketplace probe verified registration, repeated installation,
disable, enable, update command handling, uninstall behavior, and marketplace
removal in an isolated `COPILOT_HOME`.

### MCP integration

The plugin contributes a local stdio MCP server. Copilot started the server,
completed initialization, listed its tools, called the probe tool, and stopped
the child process when the session ended.

### Authentication and recursion

A non-interactive Copilot prompt completed with no custom provider, API key,
bearer token, or GitHub token override configured. This validates reuse of the
existing Copilot sign-in on the tested machine.

Internal work sets `PROVENLOOP_INTERNAL=1`. The HTTP Hook configuration copies
only that variable into `X-ProvenLoop-Internal`, and the probe server observed
the value. The probe discarded the internal payloads before queue persistence
and retained only event type and timing metadata.

### Hook transport

Neither tested Hook transport meets the latency requirement.

The command Hook probe had median measurements between about 570 and 620 ms,
with P95 measurements between about 700 and 800 ms. Direct localhost HTTP
requests had a P95 near 2 ms, but Copilot CLI `1.0.82-0` delivered HTTP Hook
requests about 450 to 1200 ms after the event timestamps in the payloads.

HTTP Hook failures were fail-open in the probe. Foreground Copilot completed
normally with the Hook server stopped. This satisfies failure isolation, but
the dispatch delay blocks adoption of this transport.

The replacement candidate is a plugin-contributed Copilot CLI Extension using
Session event notifications. It remains a proposal until the F0 latency,
coverage, backpressure, and crash experiments pass. See
[Copilot event capture design](../copilot-event-capture-design.md).

### Local persistence

The selected F0 SQLite driver is the Node `node:sqlite` module bundled with
Node `22.18.0`. The probe verified SQLite `3.50.2`, WAL, transactions,
`PRAGMA user_version`, and FTS5. Node still reports the module as experimental,
so the storage package must hide it behind an interface and pin the tested Node
range.

The queue prototype writes one item to a temporary file, flushes the write
handle, and renames it atomically. A 1000-item run persisted about 435 items per
second in the initial run and about 460 per second in a later run. Both runs
left no temporary files.

The worker lease uses a Windows named pipe. A second holder received
`EADDRINUSE`, and a new holder acquired the same pipe after the first process
was terminated. The idle holder used about 42 MB of resident memory.

### Windows paths

Runtime data will use these locations:

```text
%LOCALAPPDATA%\ProvenLoop\
  data\provenloop.db
  queue\
  logs\
  artifacts\
  evaluation\
```

Copilot owns installed plugin files under `COPILOT_HOME`. ProvenLoop does not
store domain data inside the plugin directory.

## Consequences

The contracts, storage boundary, queue format, plugin marketplace packaging,
and stdio MCP work may proceed once the event capture latency blocker is resolved.
Broad workspace implementation remains paused under the dependency rule.

Open feasibility work is tracked in
[implementation-blockers.md](../implementation-blockers.md).
