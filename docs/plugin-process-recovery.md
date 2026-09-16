# Plugin process recovery

**Updated:** 2026-09-08

**Candidate:** `0.1.0-alpha.0.13` Windows Design Partner Preview

This document describes the 0.13 recovery contract and separately records the
historical manual 0.12 repair and the published 0.13 upgrade below. Process survival
and successful installation do not establish hot reconnection or controlled benefit.
For the versioned bootstrap and data-recovery precautions, see
[installation and operations](alpha-installation.md#upgrade).

## Scope

Upgrade may stop old ProvenLoop child processes, but must not terminate foreground
Copilot sessions or unrelated MCP servers. Exact executable paths, parsed arguments,
Windows owner SID, parent identity and process creation time establish ownership.
A native process handle pins identity during termination. Foreground Copilot and
the upgrader's current ancestors are excluded. No broad name-based termination or
process-tree kill is used.

Legacy MCP servers and launchers must match their exact ProvenLoop signature and a
verified runtime slot/data root; numeric version components must match correctly.
Legacy extension bootstraps share a generic command, so they additionally require
an exact host startup record for the plugin path, PID and creation time. The reader examines at most the
first 8 MiB of four parent log files. It reads no process environment or memory.
Ownership and parent identity are rechecked before termination. Unknown, stale or
ambiguous identities remain untouched; discovery is not permission to kill an
unverified process.

Native failures report bounded phase/reason, PID/depth and Windows error codes.
Raw command lines, process inventories and unrecognized native error text are
not copied into those diagnostics.

## Shutdown ordering

Upgrade pauses new participating MCP and background database work and drains
learning, worker, observation, projection and MCP leases. The current drain budget
is 15 seconds; a drain timeout removes the barrier before migration or participant
shutdown. It then requests graceful shutdown and waits for registered participants
before targeted cleanup of remaining legacy helpers.

Participating MCP servers register their shutdown lifecycle, finish accepted
requests and exit their protocol loop. Lifecycle failures are explicit, rather than
reporting a successful shutdown while the server remains live. Plugin extension
launchers exit when their owned runtime has finished stopping. Older
nonparticipating helpers require the ownership checks above.

This coordination does not close every foreground Copilot session. Capture pauses
when the ProvenLoop Extension stops, and old MCP tools may disconnect. Start a new
session or use a host-supported reload to load the updated integration when needed.
The upgrade does not guarantee hot reconnection inside existing sessions.

## Directory-handle fallback

Windows may deny directory replacement after all helper processes exit, even when
the individual plugin files can be opened. If plugin-directory uninstall still
reports `os error 5` (access denied) or `os error 32` (sharing violation), the fallback
is eligible only for the strict known five-file plugin layout. Within that layout,
upgrade can copy the package's embedded assets into the existing files without
renaming or removing the directory. It first backs up all affected files, config
and settings, validates the exact installed ProvenLoop registration, and checks for
concurrent changes before each write. Unrelated configuration entries are preserved.

The replacement manifest and registration use the verified package version. The
marketplace is pinned to its immutable tag. Copilot's undocumented `source_sha`
field is removed from the target entry; a local SHA-256 manifest records file
integrity separately. Failed writes roll back only bytes still owned by that
operation; conflicting external edits are retained for review.

Unexpected layout, ambiguous registration ownership, invalid backups or unsafe file
identity fail explicitly. Partial writes and unsuccessful rollback are reported,
not hidden behind a successful recovery result. Do not delete/rename the held
directory, kill Copilot by name or remove user data as a recovery shortcut.

## Verification and retained state

The bootstrap probes the target runtime's state even if the shell inherited an
older PATH. A matching installed plugin version takes the verification path instead
of unnecessary uninstall/reinstall, and still respects `-NoAutoCollect`. This
same-version path enters maintenance recovery only when the exact recognized stale
schema-recovery diagnostics remain.

Only after verified plugin registration and SQLite `quick_check` may recovery clear
the exact recognized generic stale schema-recovery `lastError`. It retains enabled
and disabled capability settings and the existing automatic-learning consent. Clearing
an error is not permission to enable collection, retrieval, learning or unsupported
future capabilities. Background inference still requires a separate explicit opt-in.

Schema 14 is unchanged from 0.12; published 0.11 used schema 10. Failed schema
replacement may restore its retained snapshot only when no intervening canonical
writes occurred. Otherwise the canonical-data-changed review warning and safety
pause remain. Outer failure handling preserves that specific warning instead of
overwriting it with a generic recovery error. Unrelated errors, snapshots, deletion
safeguards and review evidence are not discarded by successful plugin repair.
Switching to an old runtime alone does not restore compatible data; follow the separate
[rollback procedure](alpha-installation.md#rollback) before any destructive restore.

### Regression coverage and evidence limits

The local suites cover MCP request drain and lifecycle errors; exact
process/parent identity and bounded legacy-log evidence; refresh backups, partial
writes, external edits and explicit rollback errors; and adapter ordering,
Windows errors 5/32, verification failure and state-preserving retry. Bootstrap
checks additionally cover stale inherited PATH, matching-version verification,
diagnostic-gated maintenance recovery and `-NoAutoCollect`.

Local Windows / Node.js 22.18.0 validation passed lint, typecheck, 918/918 unit
tests across 82 files with `PROVENLOOP_PROCESS_FIXTURE=1` and no skipped tests,
269/269 integration tests across 25 files, `package:verify`, and Windows PowerShell
5.1 `install.ps1 -DryRun`. Native owned-MCP and legacy-extension preservation
fixtures ran, as did a native Windows directory handle fixture denying delete sharing.

Package smoke drives an injected `os error 32` uninstall failure through the
installed bundled CLI, verifies every refreshed asset byte-for-byte against exact
embedded/source release assets, and checks unrelated configuration and
`source_sha` semantics. This covers the packaged recovery path, not just mocked
source-level refresh calls. These controlled fixtures do not constitute a real
user's 0.13 upgrade or tool reconnection. The
[0.13 release notes](releases/0.1.0-alpha.0.13.md#verification-scope-and-remaining-evidence)
record the complete local validation summary. Remote CI, publication and a bounded
live-host upgrade observation are recorded below; broader field acceptance remains open.

Retain version-bound test and packed-artifact results separately from live-host
observations. Neither those regressions nor the historical recovery below prove
controlled benefit or clear M0/MVP No-Go; `0.1.0-alpha.1` remains an unapproved target.

## Historical manual 0.12 recovery on 2026-09-08

The failing installation had old 0.10 MCP launchers and extension bootstraps.
Targeted cleanup stopped the verified remaining plugin children; all three
foreground Copilot processes remained alive. Copilot still returned Windows error
5 when uninstalling the directory, while every plugin file admitted an exclusive
read and Restart Manager reported no file holders.

Refreshing the exact published 0.12 assets in place allowed Copilot to report the
correct plugin version. The maintenance upgrade then completed, the runtime locator
was restored to the installed 0.12 slot and the normal data root, and SQLite
`quick_check` passed at schema 14. Collection, retrieval and correction-learning
capabilities were restored after the failed upgrade's safety pause. Background
inference consent was not enabled. Existing dead-letter records were retained.
The corrected bootstrap then completed successfully against the published 0.12
package without reinstalling its already version-matched plugin. The three original
foreground Copilot processes remained running throughout recovery.

This recovery does not prove hot reconnection of tools inside old Copilot sessions.
It establishes that the plugin can be repaired without terminating those sessions.
The capability restoration described here was part of that manual repair, not a
promise that 0.13 recovery re-enables disabled settings. The three preserved host
PIDs are historical 0.12 evidence, not a newly observed 0.13 release result.

## Published 0.13 upgrade on 2026-09-08

Both Windows Node.js 22.18.0 and Node.js 24 jobs passed in
[CI run 34220593611](https://github.com/cubika/ProvenLoop/actions/runs/34220593611).
[Release run 34221132424](https://github.com/cubika/ProvenLoop/actions/runs/34221132424)
published `v0.1.0-alpha.0.13` from commit
`2c8d20b25123b996d9c824dbc3871843509dc508`. The downloaded tarball matched its
checksum file and GitHub's asset digest:

```text
bb57c24eaa524a4db963e19be046c59c0f5a32fe57244ec9a490fc906ce304e3
```

The published bootstrap upgraded an existing 0.12 installation to 0.13 without
closing its six foreground Copilot processes. Each retained the same PID and
creation identity. The plugin was installed and enabled at 0.13, the runtime
locator retained the data root, and every capability preference and the existing
automatic-learning consent were unchanged. No generic stale schema-recovery
diagnostics remained. SQLite reported `quick_check=ok` at schema 14.

This was a same-schema installed-host upgrade, not a new schema-migration or
hot-reconnection test. Doctor still reported retained dead letters, an idle worker
and incomplete host/provider verification. Those records and warnings were not
deleted or changed merely to report a healthy status. Existing sessions can stay
open; use a new session or a supported host reload when updated tools are needed.
