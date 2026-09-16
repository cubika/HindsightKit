# ProvenLoop 0.1.0 Alpha Release Plan

**Status:** 0.16 preview release; quality-release acceptance remains open
**Target:** `0.1.0-alpha.1` (planned, not published by this work)
**Repository:** `https://github.com/cubika/ProvenLoop`  
**Updated:** 2026-09-11

**Evidence candidate:** `0.1.0-alpha.0.16` is the Windows Design Partner Preview
for collecting the real Windows, provider-degradation, and remote-upgrade
evidence required by the target `0.1.0-alpha.1`. It is a prerelease, not M0/MVP
approval or evidence of controlled benefit. See the
[0.16 release notes](releases/0.1.0-alpha.0.16.md).

The 0.16 scope adds classification, concept-assisted retrieval, deeper search,
and reviewed enrichment of saved experience. It also includes the intervening
distillation, lifecycle, and scalability fixes. Schema 23 requires the maintenance
upgrade path from 0.15/schema 16. Explicit learning opt-out is preserved.

Knowledge review, automatic local observations, trusted Session approval,
strict native proof binding, bounded current-session reconciliation, and
storage/capture repairs are included alongside opt-in user/agent learning inherited
from 0.12. The 0.13 scope adds graceful MCP shutdown, narrowly verified legacy-helper
cleanup, guarded Windows locked-directory refresh and state-preserving recovery.
Checked engineering items below refer to recorded work, including the local 0.13
regression and packaged-runtime results in section 14. The
[published upgrade record](plugin-process-recovery.md#published-013-upgrade-on-2026-09-08)
separately records remote CI, tag/source/asset verification and a same-schema live upgrade.

## 1. Goal

The evidence candidate is a Windows and GitHub Copilot CLI Design Partner Preview.
It should let a user install ProvenLoop without cloning the source repository,
use it during ordinary coding work, collect bounded M0 acceptance evidence, and
remove it without losing or corrupting unrelated Copilot configuration.

This release does not add M3-M6 product capabilities. Its job is to turn the
implemented M0-M2 code into an installable, observable, and reversible product.

The planned quality release is complete only when:

- ordinary natural-language corrections trigger automatic extraction and
  qualified later-task reuse without manual remember/retrieve instructions;
- installation uses a published package rather than a source checkout;
- the Copilot Extension and MCP run from installed assets;
- M0 blockers are evaluated from retained evidence instead of hard-coded
  `blocked` checks;
- normal daily work can produce privacy-minimized observations without daily
  start/stop rituals;
- installation, upgrade, disable, uninstall, and rollback are reproducible;
- the MVP aggregate gate reaches at least `Conditional Go`.

An explicitly bounded observation candidate may be distributed with a disclosed
No-Go to collect missing evidence; it is not an approved quality release.
The 0.10 MVP gate keeps `field-effect-evidence` blocked, so
neither synthetic regression, ordinary observations, nor maintainer attestation
can currently yield Go/Conditional Go. Controlled-effect evaluation is an
additional requirement, not a box that packaging work can close.

## 2. Release scope

### Included

The list describes the release target. Bounded extraction was implemented in 0.12
and is retained in 0.13; installed-host acceptance and controlled benefit remain open.

- GitHub Copilot CLI adapter;
- non-blocking Extension event capture;
- durable local queue and worker;
- canonical SQLite storage;
- Work Episode projection;
- M1 Branch Context and scoped retrieval;
- MCP Context, Explain, and Feedback;
- explicit Remember, Correct, Mute, Forget, Delete, and Purge;
- Knowledge list/show/confirm/replace/revoke with reviewed digests and explicit
  confirmation; workflow controls require a matching live SDK Session and cwd;
- M2 verified correction learning;
- automatic source-backed proposal extraction through the existing authorized
  Copilot sign-in, including narrow verified MCP invocation recovery;
- Knowledge lifecycle and counterevidence handling;
- M0, M1, M2, and MVP evaluation gates;
- automatic local observations and safe export;
- a local read-only knowledge and evidence viewer through `provenloop ui`;
- bounded current-session reconciliation in the installed background loop;
- explicit bounded M0 acceptance and maintainer-controlled probes;
- package installation, upgrade, disable, uninstall, and rollback.

### Excluded

- M3 automated delayed Outcome Linker;
- M4 Deep Retrospective;
- M5 Playbook generation or activation;
- additional coding-agent adapters;
- cross-machine or team synchronization;
- remote or team dashboards and browser-based editing;
- cloud storage;
- model fine-tuning.

Disabled or deferred capabilities must remain visibly unavailable rather than
returning success-shaped placeholders.

## 3. Intended installation experience

The candidate's versioned installation command is:

```powershell
irm https://raw.githubusercontent.com/cubika/ProvenLoop/v0.1.0-alpha.0.16/install.ps1 | iex
```

For the Microsoft-internal Design Partner preview, the versioned GitHub
Release tarball is the canonical runtime source. npm is used only as the local
installer and must not resolve ProvenLoop through a registry. The tarball and
its SHA-256 file must be downloaded from the same immutable Git tag and
verified before installation.

The bootstrap installer must check prerequisites, verify the Release SHA-256,
install the local tarball without registry resolution, register the Copilot
integration, enable in-scope capabilities on a fresh install unless opted out,
preserve existing settings on upgrade, run Doctor, and clean all temporary package
files. Background inference requires separate explicit learning consent.
Version-match verification and a stale inherited PATH must not override
`-NoAutoCollect` or re-enable disabled capabilities. Same-version verification
enters maintenance recovery only for the exact recognized stale schema-recovery
diagnostics.

The 0.13 preview is not being published to the public npm registry. A separate
public npm channel or a future governed Azure Artifacts path is not part of
this publication. If O365 internal distribution later uses Azure Artifacts, the
expected model is an approved producer pipeline and Feed, normally Common,
with consumption through Enzyme; direct Enzyme publishing requires explicit
owner approval.

`provenloop install` should:

1. initialize `%LOCALAPPDATA%\ProvenLoop`;
2. register the official Copilot marketplace;
3. install and enable the ProvenLoop plugin;
4. register the Extension and local MCP server;
5. verify the installed runtime and supported Copilot version;
6. preserve the user's existing Copilot settings;
7. report a clear incompatible state instead of partially installing.

No installed manifest may reference the source checkout or a developer-specific
absolute path.

A later Windows release may use Winget or MSI and bundle Node.js. The first
Alpha requires an external Node.js runtime meeting the declared minimum and
SQLite API requirements, not a single pinned major version.

## 4. Delivery order

```text
release package
  -> remote marketplace
  -> M0 evidence contract
  -> narrow first-use workflow + automatic observations
  -> explicit maintainer acceptance experiments
  -> capture and degradation evidence
  -> capability isolation
  -> M0 Gate
  -> MVP Gate
  -> quality-release decision
```

Evidence candidates precede that final decision and retain their limitations.
Recommended branches:

```text
feat/r0-release-package
feat/r0-remote-marketplace
feat/m0-acceptance-evidence
feat/f0-daily-acceptance
feat/f0-provider-doctor
feat/m0-capability-isolation
release/0.1.0-alpha.1
```

Each branch starts from `master`, passes its targeted acceptance tests, and is
merged before the dependent branch starts.

## 5. Workstream A: publishable runtime package

- [ ] Set the final root and publishable package version to `0.1.0-alpha.1`
  after the `0.1.0-alpha.0.x` evidence period.
- [x] Keep internal-only packages private or bundle them into the public CLI.
- [x] Produce one publishable `@provenloop/cli` package.
- [x] Bundle the CLI, MCP server, worker, and Extension runtime.
- [x] Include required schemas, migrations, and built-in evaluation fixtures.
- [x] Remove runtime references to `packages\*\dist` in the source checkout.
- [x] Resolve installed assets from the package installation directory.
- [x] Verify `npm pack` contains every runtime file and no test/private data.
- [x] Install the packed tarball into a clean temporary user environment.
- [x] Publish the exact tarball and SHA-256 through GitHub Releases.
- [x] Document registry-independent installation from the GitHub Release
  tarball.
- [x] Run `install`, `status`, `doctor`, `worker run`, and `uninstall` from the
  packed artifact.
- [x] Verify uninstall preserves `%LOCALAPPDATA%\ProvenLoop` unless `--purge`
  is supplied.
- [x] Verify purge refuses an unowned or ambiguous data root.

Package smoke testing must use the tarball, not workspace module resolution.

## 6. Workstream B: official remote Copilot marketplace

Create the release layout:

```text
.github\
  plugin\
    marketplace.json
plugins\
  provenloop\
    plugin.json
    .mcp.json
    extensions\
      event-capture\
        extension.mjs
```

- [x] Add the official marketplace metadata to this repository.
- [x] Give the marketplace and plugin stable, non-local names.
- [x] Make `.mcp.json` launch the installed ProvenLoop CLI/runtime.
- [x] Make the Extension import only bundled or plugin-local assets.
- [x] Replace the generated `provenloop-local` production path.
- [x] Retain the local marketplace only for isolated development tests.
- [ ] Publish two test versions.
- [ ] Install the first version from the Git repository.
- [ ] Refresh the marketplace and upgrade to the second version.
- [ ] Verify disable, enable, uninstall, and repeated installation.
- [ ] Verify local Knowledge and queue data survive upgrade and normal
  uninstall.
- [ ] Verify user-owned Copilot experimental settings are restored exactly.

This work closes F0-003 only after a real two-version remote upgrade succeeds.

### 0.13 upgrade-recovery boundary

Upgrade must drain learning, worker, observation, projection and MCP database
leases, request graceful shutdown and await registered participants before targeted
cleanup of remaining legacy helpers. Legacy ownership requires exact runtime-slot
or launcher identity, or bounded parent startup-log attestation for extension
bootstraps. Foreground Copilot, current ancestors and unrelated processes are
excluded; unknown ownership never authorizes termination.

If Windows uninstall still returns access/sharing errors 5 or 32, recovery may
refresh only the strict known plugin layout from verified bundled assets. Backups,
configuration ownership and concurrent-edit guards are required; no held-directory
deletion/rename, invented Copilot `source_sha`, or silent rollback failure is allowed.
After verified registration and SQLite `quick_check`, only the recognized generic
stale schema-recovery error may clear. Preserve capability states, learning consent,
unrelated errors, canonical-data-changed review warnings and snapshots. Outer failure
handling must not overwrite that specific review warning. Future capabilities remain
unavailable.

Schema remains 14, as in 0.12; published 0.11 used schema 10. Foreground Copilot
work need not all close for upgrade, but old tools may disconnect and require a
new session or host-supported reload. Hot reconnection is not guaranteed.
The [recovery record](plugin-process-recovery.md) describes a prior manual 0.12
repair; it is not a 0.13 live-host test or closure of the remote-upgrade gate.

## 7. Workstream C: M0 acceptance evidence contract

Add a versioned evidence schema, for example:

```text
packages\evaluation\src\m0-acceptance-evidence.ts
packages\evaluation\fixtures\m0-acceptance-evidence-template-v1.json
```

Extend the command:

```powershell
provenloop eval m0 `
  --out .provenloop\evaluation `
  --evidence .provenloop\m0-evidence.json
```

The evidence must bind:

- Git code version;
- executable runtime digest;
- operating-system version;
- Copilot CLI version;
- plugin version;
- fixture and probe versions;
- capture run IDs;
- retained report digests.

Required sections:

```json
{
  "capture": {},
  "providerDegradation": {},
  "marketplaceUpgrade": {},
  "doctor": {},
  "capabilityIsolation": {},
  "observedGuardrails": {}
}
```

- [x] Add strict schema validation and safe identifier rules.
- [x] Reject secret-bearing evidence and unsafe paths.
- [x] Require evidence files and output below an ignored directory or outside
  the repository.
- [x] Reject evidence from another code, runtime, plugin, or probe version.
- [x] Replace `knownBlockedChecks()` with evidence-driven checks.
- [x] Preserve `blocked` for missing evidence, `fail` for failed thresholds,
  `2` for invalid evidence, and `3` for infrastructure failure.
- [x] Publish the complete run through an atomic staging directory.
- [x] Add tests for stale, forged, incomplete, and mismatched evidence.
- [ ] Revalidate repaired artifact loading, digest matching, input schemas,
  and runtime/code binding for the final source.

Read and validate actual referenced reports rather than trusting supplied
“passed” booleans or matching file names. External runner reports,
caller-supplied measurements, and maintainer attestations remain separately
labeled evidence. A digest binds an artifact; it does not prove that the
experiment or human judgment behind it was valid.

## 8. Workstream D: observations and explicit acceptance

Ordinary preview users should start with one explicit rule, later-session
retrieval, Explain, and approved feedback. See the
[first-use workflow](../README.md#first-useful-workflow).
Local observations should not require daily acceptance windows:

```powershell
provenloop observations show
provenloop observations export --date 2026-09-06 |
  Set-Content -Encoding utf8 .\provenloop-observations.json
```

These commands use UTC dates, retain unknown outcomes, and export
only current-code-version observational records. They do not measure controlled
benefit or grant release approval.

For an explicit maintainer experiment, the installed CLI provides:

```powershell
provenloop acceptance start

# Use Copilot normally; close the experiment's Sessions before completion.

provenloop acceptance complete
```

The window bounds evidence, not whether collection is enabled. Source-checkout
scripts wrap these commands. Optional source-checkout controlled probes:

```powershell
.\spikes\f0\run-paired-latency-probe.ps1 `
  -BaselineSamples .provenloop\foreground-baseline-ms.json `
  -ProvenLoopSamples .provenloop\foreground-provenloop-ms.json
.\spikes\f0\run-fault-isolation-probe.ps1
.\spikes\f0\run-capability-isolation-probe.ps1 `
  -AutomatedTestReport .provenloop\capability-tests.json
```

The latency probe requires at least 100 equal-length paired finite,
non-negative numeric samples; it analyzes supplied measurements, not actual
benchmark execution. The capability probe checks installed switches and
references a separately executed automated-test report.

### Start script

- [x] Record the run ID, UTC start time, OS version, Copilot version, plugin
  version, code version, and runtime digest.
- [x] Capture initial queue, worker, database, and capability health.
- [x] Record canonical high-water marks without copying Prompt or code text.
- [x] Refuse to start when another acceptance run is active.
- [x] Store state below `%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily`.

### Completion script

- [x] Record the end time and final health snapshot.
- [x] Drain the worker with a bounded timeout.
- [x] Run Session-file reconciliation.
- [x] Compare queue and canonical high-water marks.
- [x] Calculate event counts by supported event type.
- [x] Calculate callback work duration and delivery-latency distributions.
- [x] Report recorded capture gaps, supported-file reconciliation differences,
  duplicate facts, retry items, and dead letters.
  Missing source-file coverage cannot be converted into a known zero-loss count.
- [x] Run seeded-secret and internal-Session persistence checks.
- [x] Write stable JSON and Markdown reports.
- [x] Never include raw Prompt, code, tool arguments, or tool results in the
  acceptance report.

Acceptance output layout:

```text
%LOCALAPPDATA%\ProvenLoop\evaluation\m0-daily\<run-id>\
  run.json
  environment.json
  capture-metrics.json
  reconciliation.json
  guardrails.json
  report.json
  report.md
```

## 9. Workstream E: F0-001 capture acceptance

Use daily work for natural event coverage and controlled probes for paired or
fault scenarios.

Required scenarios:

- [ ] Prompt submission.
- [ ] Tool success.
- [ ] Tool failure.
- [ ] Cancellation.
- [ ] Resume.
- [ ] Shutdown.
- [ ] Subagent start, completion, and failure.
- [ ] Extension callback delay.
- [ ] Extension callback exception.
- [ ] Extension process termination.
- [ ] Worker stopped.
- [ ] Queue backlog.
- [ ] Queue write failure.
- [ ] Reconciliation after a capture gap.
- [ ] Reconciliation when the Extension dies before writing `capture_gap`.

Required environments:

- [ ] Windows 11, at least 500 representative events.
- [ ] Windows 10, at least 500 representative events; alternatively revise the
  Alpha support statement and M0 requirement explicitly before release.

Hard thresholds:

```text
foreground added latency P95 <= 10 ms
callback work duration P95 <= 1 ms
missing required events after reconciliation = 0
duplicate canonical facts = 0
seeded secret persistence = 0
internal Session content persistence = 0
foreground Copilot blocking failures = 0
```

Delivery latency is reported separately from user-visible added latency.

## 10. Workstream F: F0-002 provider degradation and Doctor

Default Doctor must remain passive and must not consume a model request or
inspect credentials.

Add an explicit online mode:

```powershell
provenloop doctor --online
```

- [x] Add an opt-in, bounded Copilot availability probe.
- [x] Give the probe no tool permissions and require a fixed response.
- [x] Apply a strict timeout and classify errors without persisting provider
  output.
- [x] Report `available`, `signed_out`, `rate_limited`, `incompatible`, or
  `unavailable`.
- [x] Keep passive Doctor status as `unverified` when no supported credential
  status API exists.
- [x] Use an isolated `COPILOT_HOME` or test account.
- [x] Test signed-out behavior.
- [x] Test rate limiting.
- [x] Test provider unavailability.
- [x] Test an unsupported Copilot version.
- [ ] Retain actual isolated-profile observations for each provider state,
  separately from automated classification tests.
- [ ] Verify backlog remains durable and retry remains bounded.
- [ ] Verify foreground Copilot remains usable.

This work closes F0-002 only when the real degradation matrix is retained as
version-bound evidence.

## 11. Workstream G: capability isolation

Required capability checks:

### Retrieval disabled

- [x] Context returns no Knowledge.
- [x] Feedback fails explicitly.
- [x] Capture remains operational.
- [x] Worker continues canonical ingestion.

### Capture disabled

- [x] New Extension events stop.
- [x] Existing Knowledge remains retrievable.
- [x] Worker and deletion remain usable.
- [x] Copilot remains usable.

### Worker disabled

- [x] Durable queue backlog is preserved.
- [x] No consumer side effects occur.
- [x] Existing projected Knowledge remains retrievable.
- [x] Re-enabling the worker drains backlog without duplicates.

### Correction learning disabled

- [x] Correction events may remain observable.
- [x] Correction Knowledge lifecycle side effects stop.
- [x] Existing manually remembered Knowledge remains independent.

- [x] Add one end-to-end isolation matrix test.
- [x] Add a real installed-plugin probe.
- [x] Bind the result into M0 evidence.
- [x] Remove the hard-coded M0 capability-isolation blocker only after both
  tests pass.

These engineering checks do not prove the current installed-host matrix passed.
Retain version-bound native results; an external automated-test report is not
itself evidence that the capability probe ran those tests.

## 12. Daily-use evidence period

The initial collection period should last several working days.

### Day 0

- install the packaged Alpha candidate;
- run `provenloop doctor`;
- verify capture, worker, and retrieval status;
- record the exact Copilot and Windows versions.
- remember one narrowly scoped rule and inspect its source and applicability;
- inspect the local observations entry point.

### Days 1-3

- use Copilot normally;
- include multiple repositories and branches;
- start new Sessions and resume existing work;
- perform real tests and builds;
- include at least one explicit correction;
- include at least one failed command followed by recovery;
- retrieve the rule in a later Session, inspect Explain, and approve explicit
  feedback after use;
- inspect observations without interpreting offered context as adoption or benefit.

Maintainers may additionally choose a bounded `acceptance start/complete`
window. It is not a daily prerequisite for ordinary users.

### Controlled fault window

Run separately from important work:

- stop the worker and create queue backlog;
- disable and re-enable retrieval;
- disable and re-enable capture;
- terminate the Extension during a test Session;
- run reconciliation;
- confirm Copilot foreground work remains usable.

Do not deliberately sign out, rate-limit, or corrupt the real user profile.
Provider degradation tests require an isolated profile or test account.

## 13. What to return after several days

After reviewing the selected files, share only what the investigation needs:

- the privacy-minimized observation export;
- selected acceptance `report.json` / `report.md` or validated M0 evidence;
- redacted diagnostic codes and a minimal reproduction, not arbitrary raw errors;
- Windows and Copilot versions;
- a description of user-visible slowdown or incorrect behavior.

Do not share:

- `provenloop.db`;
- `knowledge.db`;
- raw queue files;
- raw Session files;
- Prompt or tool-result logs;
- credentials or Copilot configuration containing secrets.
- backups, recovery snapshots, local observation keys, or whole evaluation directories.

Stable digests and counts can still reveal usage patterns; export minimization
is not an assurance of complete anonymity. Never attach raw databases or backups
as a shortcut.

The follow-up review should classify each failure as:

```text
capture correctness
foreground performance
reconciliation
provider degradation
capability isolation
installation lifecycle
reporting or evidence integrity
```

## 14. Release engineering

- [x] Add `LICENSE`.
- [x] Add `CHANGELOG.md`.
- [x] Add `SECURITY.md`.
- [x] Document supported Windows, Node.js, and Copilot versions.
- [x] Add installation, upgrade, disable, uninstall, and purge documentation.
- [x] Add a tag-triggered release workflow.
- [ ] Run clean checkout validation.
- [x] Run packed-artifact validation.
- [x] Generate checksums for published artifacts.
- [ ] Publish GitHub Release notes with known limitations.
- [ ] Retain the M0 and MVP reports used for the decision.
- [ ] Verify the Git tag resolves to the evaluated code version.

Software signing and Winget packaging may follow the first private Alpha, but a
public Windows release should not distribute unsigned mutable binaries without
an explicit warning and checksum.

### Candidate-specific verification to retain

Local validation completed on Windows with Node.js 22.18.0: lint, typecheck,
918/918 unit tests across 82 files with `PROVENLOOP_PROCESS_FIXTURE=1` and no
skipped tests, 269/269 integration tests across 25 files, `package:verify`, and
Windows PowerShell 5.1 `install.ps1 -DryRun` passed. The
[release notes](releases/0.1.0-alpha.0.13.md#verification-scope-and-remaining-evidence)
record the coverage. The final three items link to separate remote and installed-host
observations; none of these engineering results constitutes M0/MVP acceptance:

- [x] MCP shutdown finishes accepted work, exits the protocol loop and reports
  lifecycle inspection failures explicitly.
- [x] Process cleanup selects exact owned helpers, rejects stale/ambiguous
  identity and ancestry, and preserves host and unrelated processes in controlled
  local fixtures.
- [x] Run native owned-MCP and legacy-extension preservation fixtures in the
  standard local unit suite with `PROVENLOOP_PROCESS_FIXTURE=1`.
- [x] Legacy extension evidence is bounded and matched to the live parent.
- [x] Locked-file refresh handles partial writes and rollback failures, protects
  file/config ownership and external edits, and rejects unexpected layouts.
- [x] Exercise a native Windows directory handle that denies delete sharing.
- [x] Adapter regression covers graceful-before-legacy ordering, both Windows
  uninstall errors, failed verification rollback and state-preserving retries.
- [x] Bootstrap verification covers the target runtime with stale inherited PATH,
  an already-version-matched plugin, diagnostic-gated maintenance recovery and
  `-NoAutoCollect`.
- [x] Run `install.ps1 -DryRun` under Windows PowerShell 5.1.
- [x] Complete local lint, typecheck, unit, integration and packed-artifact
  validation for the 0.13 source and tarball.
- [x] Drive an `os error 32` uninstall failure through the installed bundled CLI
  in package smoke, verify every refreshed asset against exact embedded/source
  release bytes, and preserve unrelated configuration and `source_sha` semantics.
- [x] Retain remote CI/release results, including the native process fixture in
  the standard unit suite.
- [x] Retain a version-bound installed-host upgrade/recovery observation separately
  from mocked, synthetic and prior manual recovery records.
- [x] Verify the GitHub Release tarball, checksum and tag/source binding after
  publication without creating a public npm dependency.

## 15. Release decision

Before approving the planned quality release (not merely an observation candidate):

```powershell
provenloop eval m0 `
  --out .provenloop\evaluation `
  --evidence .provenloop\m0-evidence.json

provenloop eval mvp `
  --out .provenloop\evaluation `
  --evidence .provenloop\release-evidence.json `
  --stable
```

Required result:

```text
M0: PASS
MVP: GO or explicitly bounded CONDITIONAL GO
```

`No-Go`, missing/stale evidence, an unverified recovery target, or non-zero or
unknown safety counts block quality-release approval. The 0.10
`field-effect-evidence` is blocked and cannot be cleared by synthetic or
observational inputs. Keep any bounded evidence-candidate distribution
explicitly separate; never relabel it M0/MVP-approved.

## 16. Definition of done

- [ ] `M2-AUTO-001` through `M2-AUTO-008` are implemented in the existing release
  evaluator and pass with version-bound native-host evidence, including the
  coverage/noise thresholds and user-visible feedback in product validation.
- [ ] A normal correction in an open Session becomes a qualified reusable rule
  without fixed fields, manual `remember`, or a user-invoked extraction tool.
- [ ] A subsequent relevant task retrieves and follows that rule without the
  user restating it or requesting a ProvenLoop tool call.
- [ ] The model provider has one-time disclosed consent, no tool permissions,
  bounded usage/retries, recursion isolation and visible pause/failure states.
- [ ] A user can install from a published package without cloning the repo.
- [ ] Installed Plugin and MCP paths survive moving or deleting the source
  checkout.
- [ ] A clean profile can install, upgrade, disable, uninstall, and reinstall.
- [ ] Normal uninstall preserves user data.
- [ ] Purge removes only the owned ProvenLoop data root.
- [ ] Daily work produces bounded local observations; explicit maintainer
  experiments produce the required M0 evidence.
- [ ] The installed 0.10 two-Session rule/Explain/approval workflow is observed.
- [ ] Controlled field-effect evidence is independently established and supported
  by the release evaluator, not inferred from synthetic or observational inputs.
- [ ] F0-001, F0-002, and F0-003 are closed with retained evidence.
- [ ] Capability isolation passes in tests and an installed environment.
- [ ] M0 exits with code `0`.
- [ ] MVP produces Go or bounded Conditional Go.
- [ ] `0.1.0-alpha.1` is tagged from the evaluated commit.
- [ ] Published artifacts match the retained runtime digest.

Only after this release is operating safely should work begin on M3 automated
delayed Outcome linking.
