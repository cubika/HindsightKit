# ProvenLoop implementation blockers

**Updated:** 2026-09-11

This list tracks missing **acceptance evidence**, not a claim that the associated
code is absent. `0.1.0-alpha.0.12` is a Windows Design Partner Preview evidence
candidate. Its capture/storage/feedback repairs require their own retained
version-bound validation and native-host observations; historical probe results
do not approve the new path. `0.1.0-alpha.1` remains an unapproved quality-release
target.

## SCALE-001: Sustained history and retrieval capacity

State: initial repairs in the working tree with remaining findings; sustained-capacity claims are
blocked. See the [scalability review](scalability-review.md) for SC-01 through
SC-14, retained diagnostic evidence, work-package dependencies and acceptance
criteria. This entry covers processing cost, query availability, relevance,
duplicate/conflicting guidance, feedback, retention and evaluation.

Exit conditions:

- remove full-history reconstruction and exhaustive session pairing from
  ordinary processing, including long-session event growth;
- preserve evidence, delivery-accounting and deletion guarantees through
  incremental publication and concurrent retrieval;
- pass growing-corpus quality and mixed-load resource checks on a declared
  capacity profile, including representative event sizes and arrival rates;
- retain installed-host and sustained-run evidence before making a capacity
  claim; the current diagnostic medians and functional tests do not close it.

## F0-001: Copilot event capture latency

**Owner:** Copilot adapter work package
**State:** Feasibility passed; M0 acceptance gate

Copilot CLI `1.0.82-0` delivered tested command and HTTP Hooks hundreds of
milliseconds after their event timestamps. A plugin Extension using Session
event notifications passed the initial Windows 11 feasibility spike described
in [copilot-event-capture-design.md](copilot-event-capture-design.md).

The minimal Extension probe passed the feasibility decision needed to start
Batch 1. Remaining work below blocks M0 acceptance, not workspace and contract
implementation.

Historical minimal-probe evidence collected on Windows 11 with Copilot CLI
`1.0.82-0` (see the linked capture design and ADR; not the complete current
producer/mapper/proof bridge):

- more than 1,200 events across directly reported baseline, delayed-callback,
  and throwing-callback runs;
- all-event delivery P95 varied from 1 ms to 1528 ms because some prompt-mode
  startup events are buffered until the Extension joins;
- delivery latency is tracked as capture freshness, not user-visible latency;
- the first corrected per-type report measured required capture events at
  1 ms P95; delayed startup events were outside the required capture set;
- corrected full callback work-duration P95 between 0.042 and 0.114 ms in the
  latest non-internal runs;
- required prompt, tool start, tool completion, assistant message, and turn end
  events observed;
- callback delay, callback exception, and Extension process exit did not stop
  foreground Copilot;
- internal Session registry skipped 87 events and persisted no normal content
  records;
- persistent opt-in and settings-based rollback worked in isolated
  `COPILOT_HOME`.

The M0 gate remains open for Windows 10, paired foreground A/B added latency,
cancel/resume/subagent coverage, load and queue-failure tests, reconciliation,
and installed-plugin lifecycle behavior.

Exit conditions:

- select a supported capture path that cannot block foreground Copilot;
- measure at least 500 representative events on Windows 10 and 11;
- use paired Extension-off and Extension-on foreground measurements;
- achieve foreground added latency P95 of 10 ms or less;
- report delivery latency separately and prove it does not create an unbounded
  backlog or unrecoverable loss;
- retain bounded, redacted fields sufficient to verify event identity, tool
  completion, Session identity, command targets, and explicit errors; retain
  omission/truncation provenance rather than claiming full payload retention.
- prove callback backlog, Extension crash, and queue failure do not slow or
  stop foreground Copilot.
- prove the experimental opt-in persists for ordinary `copilot` launches and
  is reversed by disable or uninstall.
- recover a Session when the Extension is terminated before it can persist a
  `capture_gap`.

## F0-002: Provider degradation matrix

**Owner:** Copilot adapter work package
**State:** Blocking before M0 acceptance

The historical signed-in path works, and Hook or MCP failure did not stop
foreground Copilot. Automated provider classification coverage and the explicit
online Doctor are implemented. A retained, version-bound real degradation
matrix in isolated profiles is still required; unit fixtures do not establish
signed-out, rate-limited, unavailable, or incompatible runtime behavior.

Exit conditions:

- test signed-out behavior with an isolated account or supported credential
  fixture;
- test rate limiting and provider unavailability;
- test an unsupported Copilot CLI version;
- verify explicit paused or incompatible state, durable backlog, bounded
  retry, and unaffected foreground Copilot use.

## F0-003: Remote marketplace upgrade

**Owner:** Plugin packaging work package
**State:** Blocking M0 release acceptance; installer is implemented

Published installation uses the release-pinned remote marketplace. The local
marketplace remains useful for development but is loaded live, so its update
command cannot prove a cached remote plugin can move between versions. Existing
packaging and installer code do not close the real two-version upgrade matrix.

Exit conditions:

- publish two versions to a test Git marketplace;
- install the first version, refresh the marketplace, and update to the second;
- verify disable, enable, uninstall, and repeated installation;
- verify configuration and user data survive upgrade and uninstall as
  specified.
- verify the runtime-switch and database-recovery boundaries separately;
  an older package is not automatically compatible with a newer schema.

## M2-AUTO: Automatic natural-language rule production

**Owner:** M2 learner, Copilot adapter and installed-runtime work packages
**State:** Installed-host acceptance open. Bounded user/agent extraction and supported
recovery qualification are implemented in 0.12; see the [general](general-learning-validation.md)
and [agent](agent-experience-validation.md) validation records.

- Replace fixed-field/manual-rule production as the normal path with automatic
  bounded semantic extraction using the existing authorized Copilot sign-in.
- Preserve original user/tool provenance; a model cannot approve itself or turn
  a generic MCP success into external verification.
- Qualify at least the supported native-command and MCP invocation-contract
  scenarios without another user confirmation; keep unsupported cases as candidates.
- Observe actual later-task retrieval and use without a manual tool reminder.
- Implement durable job state, budgets, diagnostics, counterevidence and deletion
  propagation before enabling the consumer for existing installations.
- Meet `M2-AUTO-001` through `M2-AUTO-008`, including coverage, noise control
  and bounded user-visible feedback; manual `remember` demonstrations and
  synthetic construction of downstream events do not close this blocker.

## 0.1.0-alpha.0.12 acceptance boundary

- Retain final lint, typecheck, targeted/full test, build, and packed-artifact
  results for the evaluated source; this documentation does not assert they ran.
- Observe the repaired native producer-to-MCP path across real Sessions:
  bounded capture, strict correction/operation/verification binding, live
  repository identity, explicit user approval, and later retrieval.
- Retain native-host evidence for automatic current-session reconciliation.
  The installed caller is implemented, but absent SDK workspace metadata skips
  backfill with a diagnostic; fixtures do not prove lossless or historical capture.
- Verify recovery does not rewrite source provenance or resurrect deleted data.
- Keep ordinary local observations separate from controlled-effect evidence.
  The current MVP `field-effect-evidence` check remains blocked; synthetic
  recurrence/timing figures and maintainer attestations cannot clear it.

These gaps do not prohibit an explicitly bounded, safe observation candidate.
They do prohibit describing it as a quality-approved release or demonstrated
productivity improvement.
