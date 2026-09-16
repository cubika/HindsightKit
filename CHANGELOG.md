# Changelog

All notable changes to ProvenLoop are documented here.

## [0.1.0-alpha.0.16] - 2026-09-11

- Classify experience by purpose, technical topics, entities, and applicability.
  Combine lexical and concept retrieval, preserve conditions and source controls,
  and rank by relevance before evidence and scope weights.
- Add `provenloop_search`, optional file/directory/URL references, reviewed
  metadata editing, and task-specific feedback for irrelevant results.
- Enrich existing lessons in bounded idle jobs with separate model review and
  the existing learning opt-out and daily budget. Schema 23 retains job state.
- Distill new lessons in English with original-language source quotations and
  reviewed search aliases. Preserve accepted replacement, renewal, and expiry rules.
- Reduce history grouping, canonical evidence, and index-update work; add
  growth regressions without claiming sustained production capacity.
- Keep session identity diagnostics explicit and retain useful findings from
  long investigations. Stabilize Windows observation-file replacement.

- Select source excerpts before learning inference, including instructions in the
  byte and character limits. Preserve raw evidence and recovery chains.
- Stop repeating deterministic input-size failures without charging model
  attempts. Give eligible 0.15 size failures one bounded recovery request with
  the new extractor. Schema 17 records preparation and recovery separately.

See the [0.16 release notes](docs/releases/0.1.0-alpha.0.16.md) for schema 23
upgrade requirements, background data use, and validation boundaries.

## [0.1.0-alpha.0.15] - 2026-09-11

- Add `records clear` and an Overview action to clear all records while preserving
  installation and configuration. Reset drains active work, survives interruption,
  and prevents old event replay. Schema 16 stores the reset cutoff.

- Filter temporary instructions and completed setup edits before learning; finish
  ordinary analysis without an indefinite evidence wait. Retain source quotations
  for separate convention and reference delivery, with scope and revision checks.
- Exclude empty and known internal work from episodes, separate activity from
  closure, and isolate temporary Branch Context by session and task goal.
- Add local knowledge adoption, editing, scope correction, archiving, and deletion
  forms, with stale-review and same-origin checks. Suggest same-scope duplicates.
- Show capture growth, distributions, storage size, and queue depth. Add an
  explicit retention plan and selected-session cleanup command.
- Advance canonical storage to schema 16 for provenance fields and the reset cutoff.

- Start background learning by default when installation, capture, worker, and
  correction learning are enabled. Preserve explicit disable and notification
  preferences without fabricating historical consent.
- Show effective learning eligibility and blockers in CLI status, Doctor, and
  the local viewer. Disclose excerpt transmission and Copilot usage in installer
  output, and apply an existing installation's opt-out before restarting it.
- Keep repository hook approval and persistent Knowledge feedback approval separate.

See the [0.15 release notes](docs/releases/0.1.0-alpha.0.15.md) for compatibility
and the remaining limits of experience extraction.

## [0.1.0-alpha.0.14] - 2026-09-09

Windows Design Partner Preview with a local read-only graphical viewer through
`provenloop ui`. Schema remains 14; capability preferences and learning consent
are unchanged. M0/MVP quality-release acceptance remains open.

### Added

- Browse knowledge, captured events, work episodes, learning jobs, and usage.
  Search and filter lists, then follow source evidence and verification receipts.
- Show captured content, redaction limits, conflicts, feedback, and recent use
  without changing stored records or treating observation counts as benefit.
- Bundle the local web viewer with the CLI, with no additional dependencies.
  Use short read-only database snapshots, maintenance coordination, loopback-only
  access, request isolation, escaped content, and display redaction.

See the [0.14 release notes](docs/releases/0.1.0-alpha.0.14.md) and
[viewer guide](docs/local-viewer.md).

## [0.1.0-alpha.0.13] - 2026-09-08

Windows Design Partner Preview focused on Windows upgrade recovery.
Retains 0.12's automatic-learning features with separate explicit inference
consent. M0/MVP remain No-Go; `0.1.0-alpha.1` remains an unapproved target.

### Fixed

- Register MCP shutdown participants, drain accepted requests and exit the
  protocol loop; report lifecycle failures explicitly. Upgrade drains active
  learning, worker, observation and projection/database leases, requests graceful
  shutdown, and waits for participants before cleaning up remaining legacy helpers.
- Match exact ProvenLoop MCP runtime slots, launchers and log-attested extension
  bootstrap identities, including numeric runtime-slot versions. Recheck owner,
  parent, path and creation identity; exclude foreground Copilot, current
  ancestors and unrelated processes. Unknown ownership never permits termination;
  no broad name-based or process-tree kill is used.
- Recover from Windows plugin-directory uninstall errors 5 and 32 by refreshing
  only the strict known plugin layout from verified bundled assets. Preserve
  backups and unrelated configuration, guard against concurrent edits, and
  report rollback failures. Do not rename/delete the held directory or invent
  Copilot `source_sha` metadata.
- After verified plugin registration and SQLite `quick_check`, clear only the
  recognized generic stale schema-recovery error without enabling disabled
  capabilities or granting learning consent. Retain unrelated errors,
  canonical-data-changed review warnings and recovery snapshots, including through outer failure handling;
  future capabilities remain unavailable.
- Probe the target runtime even when inherited PATH is stale. Verify an
  already-version-matched installation instead of uninstalling it, while
  respecting `-NoAutoCollect`. Same-version verification enters maintenance recovery
  only when the exact recognized stale schema-recovery diagnostics remain.

### Local validation

Windows / Node.js 22.18.0 validation passed lint, typecheck, all 918 unit tests
across 82 files with `PROVENLOOP_PROCESS_FIXTURE=1` and no skipped tests, all 269
integration tests across 25 files, `package:verify`, and Windows PowerShell 5.1
`install.ps1 -DryRun`.

The installed bundled-CLI smoke drives an `os error 32` uninstall failure through
recovery, verifies every refreshed asset against exact embedded/source release
bytes, and checks unrelated configuration and `source_sha` semantics. Native
owned-MCP and legacy-extension preservation fixtures and a native directory handle
denying delete sharing are included. These are controlled local checks, not a
real user's 0.13 upgrade.

### Upgrade and release boundaries

Schema remains 14, as in 0.12; published 0.11 used schema 10. Existing foreground
Copilot work need not all close for upgrade, but old ProvenLoop tools may
disconnect and require a new session or host-supported reload. Hot reconnection
is not guaranteed. Runtime switching alone is not a database rollback.

The retained manual 0.12 recovery is historical evidence, not an observed 0.13
upgrade. Remote CI and GitHub Release tarball/checksum publication require their
own retained results; this preview has no public npm publication.
See the [0.13 release notes](docs/releases/0.1.0-alpha.0.13.md) and
[plugin process recovery](docs/plugin-process-recovery.md).

## [0.1.0-alpha.0.12] - 2026-09-08

Windows Design Partner Preview with opt-in automatic learning and coordinated
upgrade maintenance. M0/MVP remain No-Go; controlled benefit is unproved.

### Added

- Extract repository-scoped candidates from ordinary user corrections and
  captured agent research or self-directed recovery. Preserve exact source
  quotations and source roles without treating agent text as user approval.
- Qualify narrow MCP invocation and repository test-command recovery from
  native causal evidence. Broad semantic proposals and research findings remain
  candidates outside ordinary Context.
- Add explicit learning consent, status, disable and notice controls, with
  repository hook approval verified for Copilot CLI `1.0.84-1`.
- Retain general correction and agent experience validation records, including
  incomplete provider experiments and remaining catalog gaps.

### Fixed

- Process learning changes through an incremental durable queue. Preserve
  attempt/expiry budgets, resume interrupted jobs, and revisit enriched native
  evidence without requiring another model request.
- Strengthen proof binding, conflict isolation and deletion/revocation controls.
  Keep source roles and unresolved evidence intact across lifecycle changes.
- Pause new MCP and background database work before upgrade, wait up to
  15 seconds for active work, and remove the pause on a drain timeout. Hold
  inference and database leases through cleanup, migration and rollback.

### Migration

SQLite schema 14 replaced published 0.11's schema 10. The 0.12 migration guidance
required closing Sessions using older previews and restarting afterward. That
historical procedure is superseded for upgrades using 0.13 by targeted helper
recovery. The pause/drain protocol still requires participating runtime code; it
does not hot-reload old MCP processes. Retain the verified snapshot and prior runtime.
See the [0.12 release notes](docs/releases/0.1.0-alpha.0.12.md).

## [0.1.0-alpha.0.11] - 2026-09-07

Windows Design Partner Preview compatibility update. Carries forward the 0.10
capability scope without changing schema 10 or the M0/MVP acceptance boundary.

### Fixed

- Remove artificial Node.js and npm upper bounds from the installer, package
  engines, and Doctor. Keep Node.js `>=22.16.0`, npm `>=11`, and the SQLite API
  checks; include Node.js 24 in CI alongside the pinned development baseline.
- Suppress only SQLite's experimental-feature notice during module loading,
  including the search Worker and installer probe, without hiding other warnings
  or database errors. Avoid the Windows PowerShell 5.1 native-warning exception
  that could otherwise interrupt installation.

## [0.1.0-alpha.0.10] - 2026-09-06

Windows Design Partner Preview evidence candidate. Carries forward the full
attempted 0.8 capability scope and 0.9 deterministic worker smoke changes.
M0/MVP remain No-Go; controlled benefit is unproved and `0.1.0-alpha.1` remains
an unapproved quality-release target.

### Fixed

- Schedule real-runtime source fixtures in an isolated phase after CPU-heavy
  suites. Allow bounded retries only for documented deadline degradation,
  without skipping tests or relaxing the runtime's 150 ms limit; successful
  context retrieval remains mandatory.
- Strengthen the cross-repository assertion and identify feedback through its
  request ID rather than incidental record order.
- Make daily-acceptance fixtures deterministic with injected real-worker
  admission and a five-second test-only drain budget. Require `incomplete` in
  the CPU-blocked negative case; production deadlines and resource thresholds
  remain unchanged.

### Validation boundary

The 0.9 release failed a functional context assertion (`ok` expected,
`degraded` received) on a loaded runner. No exact cause is established here.
Local passes and any separate main-CI outcome do not make that release
successful. The immutable 0.9 tag has no GitHub Release or assets; 0.10 requires
its own retained validation and publication record.

## [0.1.0-alpha.0.9] - 2026-09-06

**Failed publication attempt — no GitHub Release or assets; superseded by
`0.1.0-alpha.0.10`.** The tag at `c5a48fc` remains immutable. Release run
`34002088945` failed the `production-learning-loop` context assertion on a
loaded runner; this is distinct from the earlier 0.8 package-smoke failure.

Windows Design Partner Preview evidence candidate. Includes the full capability
scope recorded under the attempted 0.8 release below, plus deterministic worker
validation. M0/MVP remain No-Go; controlled benefit is unproved and
`0.1.0-alpha.1` remains an unapproved quality-release target.

### Fixed

- Distinguish explicit resource-pressure or circuit pauses from errors in
  package smoke, retain both stdout and stderr diagnostics, and require the
  installed runtime worker to complete under controlled test admission.
- Control resource admission in the current-session reconciliation fixture so
  ambient runner load does not prevent its expected worker rows. Product
  admission thresholds and runtime budgets remain unchanged.
- Supersede the failed 0.8 publication attempt without changing its immutable
  tag. The earlier smoke treated a potentially legitimate resource pause as a
  failure; surfaced diagnostics did not establish the exact worker reason.

### Validation boundary

The 0.8 release lint, typecheck, unit, and integration jobs passed, but package
smoke stopped publication before any GitHub Release or assets were created.
Those results did not certify 0.9. Its release subsequently failed the functional
context assertion, despite local runs passing 472 unit and 244 integration
tests. No release or assets were created.

## [0.1.0-alpha.0.8] - 2026-09-06

**Failed publication attempt — no GitHub Release or assets; superseded by
`0.1.0-alpha.0.9`.** The tag at `b40d03e` remains immutable. The following is
the attempted capability scope, not a successfully published package.

Windows Design Partner Preview evidence candidate, not an M0/MVP-approved
quality release. Controlled field benefit remains unestablished, and
`0.1.0-alpha.1` remains an unapproved target.

### Added

- Explicit Knowledge review, confirmation, replacement, and revocation, with
  reviewed digests and separately acknowledged counterevidence.
- Local observation summaries and privacy-bounded exports that distinguish
  provided context, user-reported adoption, and unknown outcomes.
- Task-start context instructions and live SDK workspace identity shared by
  capture, MCP, and workflow-scoped Knowledge controls.
- Native SDK causal verification bridge and `assistant.turn_start` mapping.
- Bounded current-session reconciliation in the installed Extension background
  loop, using matched SDK identity/workspace, a join-time lower bound, and
  state/path/lease checks. Worker/admission runs first, then reconciliation and
  observations every 30 seconds, with two-second catch-up on progress or budget
  exhaustion; runtime shutdown stops the loop.

### Fixed

- Bind correction verification to the actual tool operation and source
  workspace; prevent older confirmations from erasing newer counterevidence.
- Require trusted live SDK context, cross-process reader-probe guards, and
  explicit real-user confirmation for persistent MCP feedback. Workflow
  Knowledge controls require matching live `SESSION_ID`, workflow, and cwd.
- Preserve bounded capture metadata and reconcile incomplete session events
  with two-pass redaction and append-only enrichment, without overwriting
  original evidence or resurrecting deleted sources.
- Isolate corrupt queue items and prune acknowledged items without deleting
  pending work. Guard deletion/projection transactions and restore tombstones.
- Require explicit schema-10 maintenance migration with verified pre-upgrade
  snapshots and guarded recovery rather than silently downgrading data.
- Retrieve ordinary English and Chinese queries without allowing short
  queries to spuriously match more specific exclusion conditions.
- Bound test-runner process contention without relaxing runtime deadlines.

### Known limitations

- Missing or mismatched SDK workspace metadata produces a diagnostic and skips
  automatic backfill. Capture is best effort, not lossless or full-history ingestion.
- M0 platform, latency, provider-degradation, and remote-upgrade evidence remains
  open. MVP remains No-Go; synthetic fixtures and local observations cannot clear
  the blocked controlled-field-effect gate.
- Distribution uses GitHub Release tarball/checksum assets, with npm only as the
  local installer; this candidate is not being published to the public npm registry.
- Prior source validation is not validation of the new versioned artifacts.

## [0.1.0-alpha.0.7] - 2026-09-05

### Fixed

- Make Windows-hosted integration tests independent of current machine resource
  pressure and give bounded asynchronous evaluation work its full test budget.

## [0.1.0-alpha.0.6] - 2026-09-05

### Fixed

- Stage each installer release in a versioned runtime slot, verify that exact
  command, and switch PATH only after the Copilot integration upgrade succeeds.
- Restore the prior plugin registration if marketplace or plugin replacement
  fails, and preserve the previous runtime locator.
- Refuse purge until active Extensions confirm shutdown, and validate managed
  Copilot settings before destructive uninstall work begins.
- Bound Copilot commands and local operation leases so blocked commands return
  actionable errors instead of waiting indefinitely.

## [0.1.0-alpha.0.5] - 2026-09-05

### Fixed

- Raised unit-test and hook timeouts to 30 seconds so the release workflow
  remains reliable on loaded Windows hosted runners.

## [0.1.0-alpha.0.4] - 2026-09-05

### Changed

- Replaced the exact Copilot CLI `1.0.82-0` allowlist with `>=1.0.71`
  and no artificial upper bound.
- The installer now probes the required Plugin Marketplace, installation, and
  plugin enable/disable commands before modifying Copilot configuration.
- Doctor distinguishes verified CLI versions (`1.0.82-0`, `1.0.83-4`) from
  compatible versions that still require ProvenLoop evidence.

## [0.1.0-alpha.0.3] - 2026-09-04

### Added

- Immutable, checksum-verifying PowerShell installer for the Microsoft Design
  Partner preview.
- Stable per-user runtime prefix and PATH command registration.

### Changed

- Lowered the Node.js runtime minimum from 22.18 to 22.16 after running the
  unit and integration suites with Node.js 22.16.
- Installation now probes the required `node:sqlite` APIs directly.

## [0.1.0-alpha.0.2] - 2026-09-03

### Fixed

- Use Windows PowerShell 5.1-compatible absolute path validation for MCP
  launchers on non-C: drives and hosted runners.

## [0.1.0-alpha.0.1] - 2026-09-03

### Fixed

- Read the pinned marketplace ref from Copilot settings instead of relying on
  the abbreviated marketplace list output.
- Increased hosted-runner integration test timeouts without weakening product
  time budgets.
- Superseded by `0.1.0-alpha.0.2` because the MCP launcher rejected some
  valid absolute paths on non-C: drives.

## [0.1.0-alpha.0] - 2026-09-02

### Added

- Self-contained Windows package for `@provenloop/cli`.
- Official GitHub Copilot CLI marketplace and bundled Extension runtime.
- Install, upgrade, status, Doctor, capability control, worker, uninstall, and
  purge lifecycle commands.
- M0, M1, M2, and aggregate MVP release gates.
- Version-bound M0 acceptance evidence and daily acceptance reporting.
- Passive Doctor and opt-in bounded online provider classification.
- Capture, retrieval, worker, and correction-learning isolation controls.

### Known limitations

- The Alpha supports Windows and GitHub Copilot CLI `1.0.82-0` only.
- Node.js `22.18` or later in the Node.js 22 line must already be installed.
- Windows 10/11 capture, remote marketplace upgrade, and provider-degradation
  evidence must be collected before publication.
- The release does not include M3-M6 delayed outcome, retrospective, or
  playbook automation.
- This evidence-collection candidate is not the final M0-approved Alpha.
- Superseded by `0.1.0-alpha.0.1` because marketplace ref detection could
  incorrectly disable capture after installation.
