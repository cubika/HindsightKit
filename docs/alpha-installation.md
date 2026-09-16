# ProvenLoop 0.1 Alpha installation

**Updated:** 2026-09-11

## Supported environment

| Component | Supported version |
|---|---|
| Operating system | Windows 10 or Windows 11, x64 |
| Node.js | `>=22.16.0`, with the required `node:sqlite` APIs |
| npm | `>=11` |
| GitHub Copilot CLI | `>=1.0.71` |
| Automatic retrieval hooks | Copilot CLI `1.0.84-1`, with repository approval |
| ProvenLoop | `0.1.0-alpha.0.16` evidence candidate |

The relaxed Node.js/npm ranges apply starting with `0.1.0-alpha.0.11`. Older
tagged installers and tarballs retain their original requirements; use the new
versioned installer below. Newer major versions are not rejected solely by
version number; the installer still checks SQLite backup and busy-timeout support.
The Node.js 22 Winget default and pinned development tools are reproducibility
choices, not upper bounds.

The runtime also suppresses only SQLite's experimental-feature notice
during SQLite module loading, including the background search reader. Other
warnings and SQLite errors remain visible.

The URLs below target the `0.1.0-alpha.0.16` Windows Design Partner Preview.
The preview adds experience classification, concept-assisted retrieval, deeper
search, and reviewed enrichment of saved lessons. It uses
schema 23 and enables background learning when prerequisites are met, preserving
explicit opt-outs. See the [release notes](releases/0.1.0-alpha.0.16.md).
M0/MVP remain No-Go for quality release; `0.1.0-alpha.1` is still an unapproved
target.

Local 0.13 validation passed on Windows with Node.js 22.18.0: lint, typecheck,
918/918 unit tests across 82 files with `PROVENLOOP_PROCESS_FIXTURE=1` and no
skipped tests, 269/269 integration tests across 25 files, `package:verify`, and
Windows PowerShell 5.1 `install.ps1 -DryRun`. Native process-preservation and
directory-lock fixtures and installed bundled-CLI error-32 recovery are included.
These are retained 0.13 results. The [0.14 release notes](releases/0.1.0-alpha.0.14.md)
record that release's viewer validation separately. They do not establish 0.15
acceptance. Actual model quality remains unvalidated in this round because a
working model host was unavailable.

The earlier `0.1.0-alpha.0.8` and `0.1.0-alpha.0.9` tags remain immutable.
Package smoke stopped 0.8 publication; a real-runtime source context assertion
stopped 0.9 publication. Neither created a GitHub Release or assets, so neither
is an available Release-tarball installation target.

The installer probes the Plugin Marketplace, plugin installation, and plugin
enable/disable commands before changing Copilot configuration. Copilot CLI
`1.0.82-0` and `1.0.83-4` are ProvenLoop-verified. Newer compatible versions
are allowed without an artificial upper bound, but Doctor marks them as
unverified until ProvenLoop evidence is collected. Automatic retrieval hook
approval is verified separately and currently requires `1.0.84-1`. The Alpha
does not bundle Node.js.

## Open the local viewer

After installation, run:

```powershell
provenloop ui
```

The command opens the default browser. Keep its terminal running while browsing;
Ctrl+C stops the server. Each launch prints a new access URL. If an old tab reports
that the site cannot be reached, run the command again and use its new URL.
See [Local learning viewer](local-viewer.md) for filters and runtime options.

## Install

For the Microsoft-internal Design Partner preview, the canonical installation
source is the exact tarball attached to the versioned GitHub Release.

Upgrading does not require closing every foreground Copilot session, including
hosts that loaded 0.11 or earlier. The upgrade coordinates participating
runtimes and retires only ownership-verified legacy ProvenLoop helpers. Old tools
may disconnect; load the updated integration in a new session or through a
host-supported reload. See [Upgrade](#upgrade) before migrating an older data root.

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1 | iex
```

The installer:

1. checks Windows, Node.js, npm, and Copilot CLI;
2. optionally installs Node.js 22 through Winget when Node is missing;
3. downloads the exact Release tarball and SHA-256 file;
4. verifies the checksum;
5. installs the local tarball into a versioned user-local runtime slot without
   contacting an npm registry;
6. upgrades the version-pinned Copilot marketplace and plugin only after the
   new runtime is verified;
7. enables capture, worker, retrieval and correction-learning capabilities on
   a fresh bootstrap install, or preserves existing settings on upgrade;
8. runs passive Doctor.

Background model requests are eligible when learning prerequisites are met,
unless the user has explicitly disabled learning. This default also applies
to older installations with no recorded preference.
The bootstrap probes the exact target runtime's existing state even when the
current process inherited a stale PATH. An already-version-matched plugin goes
through verification rather than unnecessary uninstall/reinstall. Same-version
verification enters maintenance recovery only if the exact recognized stale
schema-recovery diagnostics remain.

Install without automatic event collection:

```powershell
& ([ScriptBlock]::Create(
  (Invoke-RestMethod `
    https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1)
)) -NoAutoCollect
```

Repeated installation and version-match verification respect `-NoAutoCollect`;
they do not override that choice by re-enabling collection.

Install without retrieval or correction learning:

```powershell
& ([ScriptBlock]::Create(
  (Invoke-RestMethod `
    https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1)
)) -NoLearning
```

For a manual tarball installation (without the bootstrap's orchestration):

```powershell
$version = "0.1.0-alpha.0.16"
$release = "https://github.com/cubika/ProvenLoop/releases/download/v$version"
$downloadRoot = New-Item -ItemType Directory -Force .\.provenloop\downloads
$package = Join-Path $downloadRoot.FullName "provenloop-cli-$version.tgz"
$checksum = "$package.sha256"

Invoke-WebRequest "$release/provenloop-cli-$version.tgz" `
  -OutFile $package `
  -UseBasicParsing
Invoke-WebRequest "$release/provenloop-cli-$version.tgz.sha256" `
  -OutFile $checksum `
  -UseBasicParsing

$expected = (Get-Content $checksum -Raw).Trim().Split()[0]
$actual = (Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  throw "ProvenLoop package checksum mismatch."
}

$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot $package --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop install
if ($LASTEXITCODE -ne 0) { throw "Copilot integration failed; do not switch PATH." }
& $provenloop enable retrieval
if ($LASTEXITCODE -ne 0) { throw "Retrieval activation failed." }
& $provenloop enable correction_learning
if ($LASTEXITCODE -ne 0) { throw "Correction learning activation failed." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; inspect the prior runtime before switching PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

The tarball contains the complete ProvenLoop runtime and has no runtime npm
dependencies. npm is used only to place the files in a versioned user-local
runtime slot and create the `provenloop` command. The installer switches PATH
only after the new runtime validates and the Copilot integration succeeds, so
the prior runtime remains available when an upgrade fails. npm does not resolve
ProvenLoop through npmjs, `packagefeedproxy.microsoft.io`, or Azure Artifacts.

The bootstrap enables retrieval and correction-learning capabilities on fresh
installs unless `-NoLearning` is supplied; upgrades preserve existing settings.
Direct `provenloop install` enables capture and the worker unless
`--no-auto-collect` is supplied. The manual example enables learning
capabilities explicitly; see the automatic-learning version boundary below.
Manual steps are not a transactional replacement for bootstrap rollback.
Keep the previous runtime slot and stop
on any failed command before editing PATH.

The installer registers the release-pinned
`cubika/ProvenLoop#v0.1.0-alpha.0.16` marketplace, installs
`provenloop@provenloop-marketplace`, and preserves existing JSONC settings.
The MCP server runs through the globally installed `provenloop` command. The
Extension is bundled in the plugin and does not reference a source checkout.
Fresh installation enables capture and the background worker unless collection
is opted out; upgrades preserve existing capability settings. To install without
collecting any events:

```powershell
provenloop install --no-auto-collect
```

## Upgrade

To upgrade from a published candidate, retain the previous runtime slot and
recovery snapshots, then run the versioned 0.15 bootstrap. Foreground Copilot
work can remain open; only verified ProvenLoop helpers are eligible for targeted
cleanup. Load the updated tools in a new session or through a host-supported
reload after success. The bootstrap stages the new runtime in a separate slot,
performs the integration upgrade, and switches the user PATH only after success:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1 | iex
```

For a manually downloaded and verified release tarball, use the same
versioned-slot path and invoke that exact new command. Do not use npm's default
global prefix or an unqualified `provenloop` command, because either can select
an older runtime:

```powershell
$version = "0.1.0-alpha.0.16"
$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot `
  <downloaded-provenloop-tarball> --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop upgrade
if ($LASTEXITCODE -ne 0) { throw "Upgrade failed; do not switch PATH." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; do not switch PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

Upgrade retains the previous runtime slot until the new marketplace, plugin,
runtime locator, and capability state all succeed. If marketplace or plugin
replacement fails, ProvenLoop restores the prior registration and leaves the
previous active runtime on PATH when using the bootstrap. Integration rollback
alone does **not** undo a database migration. Upgrade preserves local data, but an
older runtime may reject the new canonical schema. Before a cross-schema
upgrade, retain a compatible database backup and recovery plan; see Rollback.

The default data root is `%LOCALAPPDATA%\ProvenLoop`: canonical data lives in
`data\provenloop.db`, the rebuildable search index in `backends\knowledge.db`,
and queue, artifacts, evaluation, integration, and logs in separate child
directories. `%LOCALAPPDATA%\ProvenLoopRuntime\versions\<version>` contains
installed code, not canonical user data.

### Maintenance migrations

The upgrade retires verified old ProvenLoop helper processes before plugin
replacement. It matches exact MCP runtime slots, launchers and attested extension
bootstrap PIDs using Windows owner, parent, path and creation identity. Foreground
Copilot, current ancestors and unrelated processes are excluded. Legacy extension
ownership additionally requires bounded parent startup-log evidence. Unknown
ownership never permits termination; no broad name-based or process-tree kill is
used. If ownership cannot support safe recovery, the operation fails explicitly.

If directory uninstall still returns Windows access/sharing errors
(`os error 5` or `os error 32`) after helpers exit, the strict known five-file
layout can be refreshed in place from verified bundled assets. Recovery backs up
the files and the two affected host configuration documents, checks registration
ownership and concurrent edits, preserves unrelated settings, and verifies the
updated registration. It neither deletes nor renames the held directory and does
not invent Copilot `source_sha` metadata. Rollback errors remain explicit.
See [plugin process recovery](plugin-process-recovery.md) for the recovery contract
and the separately labeled historical 0.12 manual repair.

This release uses schema 23. Version 0.15 uses schema 16; versions 0.12 through 0.14 use schema 14, and
published 0.11 uses schema 10. Existing older databases require explicit
`provenloop upgrade`; ordinary runtime opens do not silently migrate them.
Older readers reject schema 23. Keep the pre-upgrade snapshot and runtime
identity if rollback may be needed.

The following coordination applies to sessions running a participating runtime.
Upgrade first pauses new ProvenLoop MCP requests and background work. It waits up
to 15 seconds for current learning, worker, observation, projection and MCP work
to release its database leases. A drain timeout removes the maintenance barrier
before any migration or participant shutdown, so existing sessions can continue.
While paused, Context returns a temporary maintenance result; Explain and Feedback
report a retryable maintenance error. Degraded observation paths do not write data.

After draining, upgrade requests graceful shutdown and awaits registered
participants before targeted cleanup of remaining legacy helpers. Participating
MCP servers finish accepted requests, exit their protocol loop and report shutdown
failures explicitly. Upgrade holds the database leases through snapshot, migration,
plugin replacement and any rollback. Unknown inference
scratch ownership stops the upgrade before migration. Upgrade retains
`data\backups\pre-upgrade-<id>.db` with its deletion key, manifest, and available
runtime locator before changing schema. Failed integration replacement can
restore that snapshot only when no intervening canonical writes occurred.
Otherwise it preserves data/snapshots and pauses capabilities for review.
Do not delete the recovery journal or force the old runtime to open new data.

After successful verified plugin registration and SQLite `quick_check`, recovery
clears only the recognized generic stale schema-recovery `lastError`. It preserves
each capability's enabled/disabled state and automatic-learning consent; clearing an
error does not resume a disabled capability or make future features available.
Unrelated errors and the canonical-data-changed review warning remain for review;
outer failure handling must not replace that specific warning with a generic error.
Recovery snapshots are retained.

Foreground Copilot sessions can remain open, but ProvenLoop capture pauses when
its Extension stops. Old MCP connections may disconnect and are not hot-reloaded.
Start a new session or use a host-supported reload when you need the updated
plugin/runtime; automatic hot reconnection is not guaranteed. Legacy runtimes
lack the new admission gate and are handled by narrowly verified helper cleanup,
not by requiring every foreground session to close.

## Automatic capture and recovery

The installed Extension runs worker/admission first, then bounded current-session
reconciliation and observation collection on a 30-second schedule. Actual
queued/enriched progress or an exhausted reconciliation budget schedules a
two-second catch-up; runtime shutdown stops the loop. It validates capability
state, paths, and leases and excludes records before the join-time observation
boundary.

Automatic reconciliation requires the joined SDK Session's `sessionId` and
`workspacePath` to match the trusted Session locator and state directory.
Missing or mismatched metadata produces a diagnostic and skips automatic
backfill; the runtime does not guess paths or enumerate historical Sessions.
Capture is best effort, not lossless archival. Bounded enrichment preserves
original source evidence and does not make unsupported or missing events complete.

### MCP identity diagnostics

When Context cannot confirm the session or workspace, `statusDetail` includes a
reason code. The MCP server writes a matching entry to
`%LOCALAPPDATA%\ProvenLoop\logs\mcp.jsonl`, or `logs\mcp.jsonl` under the
configured data root. Match the response's `requestId` to the log entry.

| Reason | What to check |
| --- | --- |
| `session_id_missing` | Whether the host supplied `SESSION_ID` to the MCP process. |
| `session_producer_inactive` | Extension startup and whether the Extension and MCP server use the same data root. See `logs\extension.jsonl`. |
| `record_missing`, `record_producer_inactive` | Publisher startup or restart; the record may not have been written by the active publisher yet. |
| `record_expired`, `repository_expired` | Publisher heartbeat or workspace refresh. Compare `recordAgeMs` and `repositoryAgeMs` with `maxAgeMs`. |
| `record_from_future`, `repository_from_future` | Clock differences greater than `futureToleranceMs`. |
| `workspace_refreshing` | A workspace refresh is in progress. A later request should use the refreshed identity. |
| `repository_unknown` | The publisher has not confirmed the repository state. |
| `reader_probe_busy` | Another reader held the identity probe guard during the request. |
| `record_invalid`, `record_too_large`, `record_session_mismatch` | An invalid, oversized, or mismatched session record. |
| `record_read_failed`, `context_read_failed` | File or identity-probe access; inspect `errorCode` when present. |
| `resolver_unavailable`, `resolver_failed` | A custom identity resolver returned no context or threw an error. |

Entries include the runtime version, PID, session hash, and observation timing.
The hash uses the same raw Session ID digest as the session record filename.
`trusted_identity_recovered` links to the earlier failure through
`previousIdentityCheckId`. Concurrent requests can finish out of order; use
`observationSequence` within one server instance and `observedAt` to reconstruct
identity checks. Recovery means identity became available; retrieval can still
fail for another reason.

These entries contain no prompts, approval text, raw workspace paths, or raw
exception messages. Logging is best effort, with a 25 ms wait budget for each
write. A slow write can finish later, and a failed write can leave no entry.
Diagnostics do not change identity checks or add output to the JSON-RPC stream.

## Capability controls

```powershell
provenloop disable retrieval
provenloop enable retrieval

provenloop disable capture
provenloop enable capture

provenloop disable worker
provenloop enable worker

provenloop disable correction_learning
provenloop enable correction_learning
```

Disabled capabilities report their state explicitly. Unsupported future
capabilities remain unavailable, including after upgrade recovery. Neither returns
success-shaped placeholder results.

Disabling the worker while leaving capture enabled preserves pending work but
can grow disk usage: the durable queue has no total storage quota. Its
seven-day acknowledged-item pruning is not pending/dead-letter or canonical
raw-event retention. Use Doctor to inspect backlog and disk health.

Use the collection shortcut to control both capture and the worker:

```powershell
provenloop collection disable
provenloop collection enable
```

## Doctor

Passive Doctor does not inspect credentials or consume a model request:

```powershell
provenloop doctor
```

The online probe is explicit, bounded, has no available tools, and does not
persist provider output:

```powershell
provenloop doctor --online
```

It classifies the provider as `available`, `signed_out`, `rate_limited`,
`incompatible`, or `unavailable`.

## Automatic learning

Learning starts when installation, capture, worker, and correction learning are
enabled. Missing legacy preferences
use this default. Explicitly disabled learning remains disabled across upgrades
and capability changes. No acknowledgement timestamp is invented for a default.

Background learning covers user corrections and captured agent investigation
and recovery. It sends bounded, redacted conversation and tool excerpts to
GitHub Copilot with the existing sign-in and service quota. Background requests
have no tools or plugins; Copilot usage and retention policies apply.

```powershell
provenloop enable retrieval
provenloop enable correction_learning
provenloop learning status
provenloop learning approve-hooks --cwd C:\path\to\repository --confirm
provenloop learning status
```

`approve-hooks` grants the ProvenLoop Extension access to session hooks for
that exact repository root. It currently supports Copilot CLI `1.0.84-1`;
restart the Session after approval. Automatic learning does not grant host
permissions or repair an unavailable Session identity. Repeat repository approval
for each repository used with automatic retrieval.

Ordinary corrections can produce source-backed candidates about code, documents,
data meaning or plans. Agent findings require an exact captured summary and
supporting tool-result quotations. Qualified lasting conventions and source
references can be returned while retaining the `inferred` label. References
return captured excerpts only in the matching worktree and revision; they do
not establish a broader reusable lesson. Task-local constraints stay within
their originating session. Unsupported or legacy findings remain review-only.
Automatic activation covers
supported MCP invocation recovery and repository test-command substitutions
with native causal evidence. Inspect provenance and scope using Knowledge
review commands; agent text never counts as user confirmation.

The learner keeps at most 32 events per window, processes a durable incremental
queue, and applies bounded attempts, expiry and daily usage. `learning status`
shows effective `enabled`, `mode`, missing prerequisites in `blockedBy`, job
progress, pause reasons, and retry times. Automatic eligibility does not prove
that a provider request ran or that a job completed. The controls are:

```powershell
provenloop learning disable
provenloop learning enable
provenloop learning mute
provenloop learning unmute
```

Mute changes only notifications. Disabling any prerequisite pauses extraction;
restoring it resumes automatic eligibility unless learning was explicitly disabled.
The installer displays the data/usage disclosure and effective learning
state, and applies `-NoLearning` before restarting an existing integration.

Disabling learning prevents subsequent result submission; it does not establish
that every active process has already finished cleanup. Upgrade maintenance
waits for the learner's full database lifetime and cleanup before migration.
See the historical [0.12 release notes](releases/0.1.0-alpha.0.12.md) for the
inherited learning features' provider experiments and their limits. Those results
are not new 0.15 installed-host acceptance or evidence of controlled benefit.

## First useful use

Once learning is eligible and the approved Session has restarted, work normally.
A captured correction or supported self-directed recovery can produce a scoped
rule; research alone produces a candidate. Use a later relevant task to inspect
whether guidance was delivered, then check its source with Explain.

For a deterministic installation check, create a narrowly scoped rule manually:

```powershell
provenloop enable retrieval
provenloop remember `
  --content "Inspect package scripts and run the targeted repository test." `
  --when "running repository tests" --scope repository
```

Open a new Copilot Session in the same repository. Ask it to call
`provenloop_context`, inspect the returned rule using `provenloop_explain`,
and give explicit feedback after trying it. Retrieval proves only that context
was offered. A user-confirmed rule is not externally verified learning.
The [README workflow](../README.md#first-useful-workflow) includes
Knowledge list/show/confirm/replace/revoke commands and feedback approval.
Each Knowledge mutation requires the latest reviewed digest and `--confirm`.
Workflow scope additionally requires a matching live SDK `SESSION_ID`, workflow,
and `--cwd`; flags alone cannot authorize it.

### Local observations

Ordinary preview use collects bounded local observations without daily
acceptance start/stop commands:

```powershell
provenloop observations show
provenloop observations show --date 2026-09-06 --session <session-id>
provenloop observations export --date 2026-09-06 |
  Set-Content -Encoding utf8 .\provenloop-observations.json
```

The default date is today in UTC. Export prints a current-code-version
observational manifest, not raw records, to stdout. Files live below
`%LOCALAPPDATA%\ProvenLoop\evaluation\observations`.
Counts distinguish provided context, explicit adoption reports, and feedback;
unknown outcomes, absent coverage, and unmeasured safety remain unknown.
An empty export does not prove there were no errors, and these observations
cannot establish controlled benefit or release approval. Inspect the selected
export before sharing it; do not share the whole observations directory.

## Explicit M0 acceptance — maintainer experiment

The installed CLI supports bounded acceptance windows:

```powershell
provenloop acceptance start
# Use Copilot normally, then close the Sessions in the experiment.
provenloop acceptance complete
```

An acceptance window is an evidence boundary, not the capture on/off switch.
Use `provenloop collection enable` or `disable` to control collection.
Reports are written below
`%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily`. They contain aggregate
metrics and stable identifiers, never raw prompts, code, tool arguments, or
tool results. Reconciliation reports coverage of supported, accessible Session
files; it cannot count events that neither capture nor those files retained.

### Source-checkout controlled probes

These scripts are maintainer tools, not required daily steps for package users:

```powershell
.\spikes\f0\run-paired-latency-probe.ps1 `
  -BaselineSamples .provenloop\foreground-baseline-ms.json `
  -ProvenLoopSamples .provenloop\foreground-provenloop-ms.json
.\spikes\f0\run-provider-doctor-probe.ps1 -ExpectedStatus signed_out
.\spikes\f0\run-capability-isolation-probe.ps1 `
  -AutomatedTestReport .provenloop\capability-tests.json
.\spikes\f0\run-fault-isolation-probe.ps1
```

The paired-latency script analyzes supplied measurements; it does not run a
benchmark. Supply two equal-length JSON arrays of at least 100 finite,
non-negative millisecond observations, paired by caller-controlled order.
The capability probe exercises installed switches and validates an external
automated-test report; it does not execute those tests. Retain the reports
and their digests separately from maintainer attestations. Neither probe
substitutes for the full native-event or Windows acceptance matrix.

Provider degradation must use an isolated `COPILOT_HOME` or test account.
After collecting the section reports, assemble the strict M0 evidence file:

```powershell
.\spikes\f0\build-m0-evidence.ps1 `
  -BaselineM0Report <m0-report.json> `
  -CaptureReport <capture-summary.json> `
  -ProviderDegradationReport <provider-summary.json> `
  -MarketplaceUpgradeReport <marketplace-upgrade-report.json> `
  -CapabilityIsolationReport <capability-isolation-report.json> `
  -ObservedGuardrailsReport <guardrails-summary.json> `
  -OutputPath .provenloop\m0-evidence.json
```

## Uninstall and purge

Normal uninstall removes the Copilot integration and preserves local data:

```powershell
provenloop uninstall
```

Purge removes only an ownership-verified ProvenLoop data root:

```powershell
provenloop uninstall --purge
```

Purge refuses an unowned or ambiguous data root. It also requests active
Extensions to stop and waits for their confirmed shutdown; if any Extension
does not stop before the deadline, it preserves all data and instructs the user
to close Copilot before retrying.

## Rollback

Git rollback, runtime switching, and data recovery are different operations.
A Git commit existing is not proof that its runtime can read a newer database.
Do not point an old runtime at a migrated data root just because the previous
runtime slot is still present.

1. Close Copilot Sessions and stop collection/worker activity.
2. Retain a consistent recovery backup, schema/runtime identity, and release
   evidence. Do not copy a live WAL database as if it were a complete backup.
3. Establish that the previous runtime supports the current schema, or arrange
   maintainer-assisted recovery of a compatible snapshot with deletion
   tombstones preserved. There is no documented user-facing restore CLI.
4. Run `provenloop uninstall` without purge.
5. Download and verify the previous tarball, then install it in its own slot
   **only after** the data-compatibility check or recovery has succeeded:

```powershell
$version = "<previous-version>"
$runtimeSlot = Join-Path `
  $env:LOCALAPPDATA `
  "ProvenLoopRuntime\versions\$version"
npm install --global --prefix $runtimeSlot `
  <downloaded-provenloop-tarball> --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Runtime installation failed." }
$provenloop = Join-Path $runtimeSlot "provenloop.cmd"
& $provenloop version
& $provenloop install
if ($LASTEXITCODE -ne 0) { throw "Integration failed; do not switch PATH." }
& $provenloop doctor
if ($LASTEXITCODE -ne 0) { throw "Doctor failed; do not switch PATH." }

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable(
  "Path",
  "$runtimeSlot;$userPath",
  "User"
)
$env:Path = "$runtimeSlot;$env:Path"
```

Do not delete `%LOCALAPPDATA%\ProvenLoop` as a rollback shortcut. Backup restore
must not resurrect deleted sources or Knowledge. Independently copied backups
and exported files remain the owner's responsibility; do not share them as
diagnostics. Consult the [storage boundaries](architecture.md#5-storage-architecture)
for the migration and restore contract.

## Distribution decision

The Design Partner preview deliberately uses GitHub Release tarballs instead
of an internal npm Feed:

- it is immediately available without the public npm/CFS quarantine period;
- it avoids onboarding ProvenLoop as a publisher to a shared O365 Feed;
- the package, checksum, Git tag, source commit, and release notes remain
  together;
- the existing tested npm package layout and global command shims are reused.

An internal Azure Artifacts path may be added when the internal audience grows.
For O365, the expected governed model is publication through an approved
pipeline to the designated producer Feed, normally Common, with consumption
through Enzyme. Direct publication to Enzyme is not assumed without approval
from its owners.

This 0.15 preview is not being published to the public npm registry. Any separate
public/developer npm channel is not an installation dependency for this preview.

This decision is recorded in
[ADR 0003](decisions/0003-design-partner-distribution.md).
