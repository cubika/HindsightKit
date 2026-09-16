# ProvenLoop Implementation Checklist

**Status:** Active  
**Updated:** 2026-09-08

**Immediate target:** M0 observation foundation, followed by the M1 + M2
validated MVP.

This checklist turns the product design, architecture, roadmap, and validation
documents into an executable delivery order. Work is complete only when its
behavior is covered by the evaluation spine; code completion alone is not
completion. Existing checked items record earlier implementation/fixture
coverage, not a fresh validation of the `0.1.0-alpha.0.12` artifacts or field
acceptance. The Windows Design Partner Preview includes the M0-M2 repairs and
user controls below; new-version acceptance remains unchecked pending retained
results. `0.1.0-alpha.1` remains an unapproved quality-release target.

The 0.12 source includes bounded user/agent extraction and maintenance draining.
The historical batch checkboxes below are not a current feature inventory; see
the [general learning](general-learning-validation.md), [agent experience](agent-experience-validation.md)
and [0.12 release](releases/0.1.0-alpha.0.12.md) records for implementation and evidence boundaries.

## 1. Delivery rules

- [ ] Keep the MVP a TypeScript/Node.js modular monolith: a small Copilot
  capture Extension, stdio MCP, and leased worker sharing one packaged codebase,
  not a requirement for one OS process.
- [ ] Treat SQLite domain state as canonical; FTS, rendered context, and agent
  assets are rebuildable projections.
- [ ] Keep Extension callbacks bounded: copy allowed fields, enqueue to memory,
  and return without synchronous I/O.
- [ ] Fail closed for retrieval and learning; failure must never block normal
  Copilot use or fabricate successful state.
- [ ] Require stable IDs, provenance, scope, evidence state, and deletion state
  for every persisted or retrieved item.
- [ ] Add a Requirement Manifest, Replay Spec, deterministic verifier, and
  expected evidence for every product or safety promise.
- [ ] Record errors explicitly; do not silently accept malformed events,
  unknown versions, failed inference, or incomplete process claims.
- [ ] Implement and accept Windows 10/11 first. Keep platform-sensitive behavior
  behind explicit interfaces.
- [ ] Do not implement automatic Playbook generation or activation before M1
  and M2 pass their Go/No-Go gates.

## 2. Dependency order

```text
F0 integration spikes
  -> workspace and shared contracts
  -> evaluation spine
  -> redaction and durable queue
  -> canonical SQLite and worker
  -> Copilot adapter and control CLI
  -> basic Work Episode builder
  -> M1 Branch Context and retrieval
  -> M2 correction learning
  -> explicit rule -> later-session retrieval -> explicit feedback -> observation
  -> M0 field acceptance + controlled M1/M2 product evaluation
```

Independent work may proceed in parallel only after its shared contracts are
frozen.
M0 acceptance still gates quality release, but unresolved field measurements
need not serialize all safe M1/M2 development behind them.

## 3. F0: feasibility decisions

### 3.1 Copilot integration spike

- [x] Record the first supported Copilot CLI version range.
- [x] Verify available lifecycle hooks and their payload/version behavior.
- [x] Verify local MCP registration, startup, shutdown, and stdio behavior.
- [ ] Verify plugin install, upgrade, disable, uninstall, and idempotent
  reinstallation. Local marketplace lifecycle passes; remote upgrade remains
  blocked by F0-003.
- [x] Verify internal ProvenLoop work can be marked with
  `PROVENLOOP_INTERNAL=1`.
- [x] Verify supported background inference can reuse the existing Copilot
  sign-in without copying credentials, an additional API key, or per-call
  authorization.
- [x] Document degradation when Copilot is signed out, rate-limited, or
  incompatible.
- [x] Prove hook and MCP failure do not block foreground Copilot use.
- [x] Select the Extension event stream as the primary capture candidate and
  document its fallback, privacy, recovery, and Go/No-Go design.
- [x] Verify a plugin Extension can join the active Session and subscribe to
  required `session.on(...)` events.
- [x] Verify Extension callbacks are notification-only and do not wait for
  persistence or downstream processing.
- [x] Verify the Extension excludes registered internal Session IDs before
  copying content.
- [x] Verify Extension opt-in persists for ordinary `copilot` launches and a
  settings-based rollback stops Extension loading.
- [ ] Verify plugin disable and uninstall preserve prior user experimental
  settings while stopping the Extension.
- [x] Measure at least 500 Extension events on Windows 11 and verify required
  event coverage, event IDs, delivery freshness, callback work duration,
  failure isolation, and metadata-only persistence.
- [x] Accept the Extension event stream as feasible and unblock Batch 1
  workspace and shared-contract implementation.
- [ ] Complete F0-001 with Windows 10, paired foreground A/B latency,
  cancel/resume/subagent coverage, concurrent load and queue-failure tests,
  Session file reconciliation, and installed-plugin lifecycle validation
  before M0 acceptance.

### 3.2 Local runtime spike

- [x] Select and verify the SQLite driver on Node.js 22 for Windows packaging,
  WAL, transactions, migrations, and FTS5.
- [x] Verify atomic queue writes and replacement behavior on Windows.
- [x] Verify the process lease or named-mutex approach releases correctly after
  crashes.
- [x] Define the Windows data-root, log, artifact, queue, and evaluation paths.
- [x] Measure cold start, idle memory, queue throughput, and baseline capture
  overhead.

### 3.3 Exit criteria

- [x] Capture the decisions in architecture decision records or the relevant
  architecture sections.
- [x] Convert every unresolved feasibility risk into a blocking issue with an
  owner and a testable exit condition.
- [x] Do not begin broad implementation while authentication reuse, capture
  non-blocking behavior, or SQLite packaging remains unproven.

## 4. Batch 1: repository and contract foundation

### 4.1 Workspace

- [x] Initialize Git and add ignore rules for dependencies, builds, local
  ProvenLoop data, logs, and evaluation output.
- [x] Create a Node.js 22 TypeScript workspace with strict type checking.
- [x] Establish packages or modules for:
  - `contracts`
  - `domain`
  - `platform-windows`
  - `storage-sqlite`
  - `retrieval`
  - `evaluation`
  - `copilot-adapter`
  - `host`
  - `cli`
  - `testkit`
- [x] Add standard scripts: `build`, `typecheck`, `lint`, `test`, and
  `test:integration`.
- [x] Add CI that runs clean install, type checking, tests, and build.
- [x] Establish versioning for schemas, migrations, fixtures, and reports.

### 4.2 Shared schemas

- [x] Implement runtime-validated schemas for `RawEvent`.
- [x] Implement schemas for `WorkEpisode`, `BranchContext`, `CorrectionKey`,
  `OutcomeEvidenceLink`, `KnowledgeCandidate`, and `FeedbackEvent`.
- [x] Implement schemas for `ProcessClaim`, `ContextUseRecord`, and
  `CorrectionOpportunity`.
- [x] Implement `RequirementManifest`, `ReplaySpec`, `EvidenceLedgerEntry`, and
  `GateResult`.
- [x] Freeze evaluation exit codes:
  - `0`: required gates passed
  - `1`: product or safety gate failed
  - `2`: invalid manifest, spec, or input
  - `3`: infrastructure error
- [x] Add schema compatibility tests and invalid-input fixtures.

### 4.3 Definition of done

- [x] Public package boundaries contain no Windows-specific types except the
  platform package.
- [x] Every persisted schema has an explicit version and migration strategy.
- [x] Unknown enum values and source versions follow an explicit compatibility
  or error path.
- [x] The entire empty workspace builds and tests successfully from a clean
  checkout.

## 5. Batch 2: evaluation spine first

### 5.1 Runner

- [x] Implement `provenloop eval run --suite <suite> --out <directory>`.
- [x] Implement `provenloop eval report --run <run-id>`.
- [x] Load and validate Requirement Manifests and Replay Specs.
- [x] Write an append-only Evidence Ledger for each evaluation run.
- [x] Produce stable `report.json` and `report.md`.
- [x] Return the documented exit code without converting gate failures into
  infrastructure failures.

### 5.2 Initial deterministic verifiers

- [x] Event schema and source-version verifier.
- [x] Event idempotency verifier.
- [x] Process-claim execution consistency verifier.
- [x] Participant and resolved-model identity verifier.
- [x] Command completion and exit-code verifier.
- [x] Secret persistence verifier.
- [x] Repository-scope isolation verifier.
- [x] Deletion propagation verifier contract, even if its full implementation
  lands with deletion support.

### 5.3 Initial replay fixtures

- [x] Valid supported event.
- [x] Malformed event that must remain visible and fail validation.
- [x] Duplicate event that must create one canonical fact.
- [x] Declared test completion with no invocation evidence.
- [x] Detected participant that was never invoked.
- [x] Requested model different from the resolved model.
- [x] Seeded credential and high-entropy secret payloads.
- [x] Unknown adapter version.
- [x] Queue interruption and recovery.

### 5.4 Definition of done

- [x] Fixtures can intentionally pass, fail, or become inconclusive.
- [x] A false completion or false consensus claim exits with code `1`.
- [x] Invalid fixture/schema input exits with code `2`.
- [x] Reports identify requirement IDs, evidence IDs, fixture versions, and
  failure messages.

## 6. Batch 3: safe event capture

### 6.1 Event envelope and identity

- [x] Generate stable event IDs and deduplication keys.
- [x] Record adapter name/version, timestamp, trust label, session, repository,
  branch, worktree, commit, tool, operation, actor, and participant identities
  when available.
- [x] Keep requested provider/model separate from resolved provider/model.
- [ ] Keep process declaration separate from verified completion evidence.
- [ ] Never inject raw events directly into model context.

### 6.2 Redaction

- [x] Redact known credential formats before queue persistence.
- [x] Add entropy-based detection for unknown token formats.
- [x] Minimize stored tool arguments and result bodies.
- [x] Preserve a safe error and digest when content is removed.
- [ ] Revalidate writer/worker redaction of new structured evidence and
  capture-quality paths, plus existing retrieval-time filtering.
- [x] Test false positives as well as seeded-secret recall.

### 6.3 Persistent queue

- [x] Implement atomic append or atomic file replacement.
- [x] Implement `pending`, `claimed`, `acknowledged`, `retry`, and `dead-letter`
  states.
- [x] Add bounded retry with explicit last error and next-attempt time.
- [x] Recover claimed items after process failure.
- [x] Retain successful items only for the configured diagnostic period.
  This is acknowledged-queue pruning, not canonical raw-event retention.
- [x] Prevent recursive events marked `PROVENLOOP_INTERNAL=1`.

### 6.4 Extension capture

- [x] Join the active Copilot Session and subscribe to required events.
- [x] Copy allowed fields into a bounded in-memory buffer.
- [x] Redact and enqueue through an asynchronous writer.
- [x] Emit explicit `capture_gap` records on overflow or interrupted delivery.
- [x] Return control without waiting for worker availability or persistence.
- [x] Surface capture degradation through status and logs without failing
  Copilot.
- [x] Implement supported Session-file reconciliation.
- [x] Wire bounded current-Session reconciliation into the existing
  background observation loop using actual SDK identity/path and join observation
  time; validate the scheduler/helper source regressions and built entry with
  SDK/command-runner fixtures and real queue/worker/store.
- [x] Verify automatic missing-argument enrichment preserves the original
  envelope, excludes pre-observation records, and joins the SDK Session once
  in built integration coverage.
- [ ] Validate recovery on a real installed SDK host and retain explicit
  acceptance-window evidence; regression fixtures do not establish field acceptance.
- [ ] Benchmark capture-added latency.
- [ ] Retain producer-path regressions for native tool/turn/shell completion,
  missing exit status, truncated targets, unknown repository state, and
  independent operation proof.

### 6.5 Definition of done

- [ ] Supported-event recognition precision is at least 95%.
- [ ] Capture-added latency P95 is at most 10 ms.
- [x] Seeded secrets persisted by capture are zero.
- [ ] Duplicate events create no duplicate canonical facts.
- [x] Unknown and malformed events are observable and never silently accepted.

## 7. Batch 4: canonical storage and shared worker

### 7.1 Database

- [x] Create versioned, transactional migrations.
- [x] Enable and test WAL and busy-timeout behavior.
- [x] Create canonical tables for raw events, parser errors, identities, queue
  state, episodes, evidence links, process claims, feedback, deletions, metrics,
  and evaluation runs.
- [x] Store source IDs and content digests on all derived records.
- [x] Keep projection schemas outside domain lifecycle authority.
- [x] Test migration upgrade, failed migration recovery, and database restore.
- [ ] Revalidate current-schema preflight, pre-upgrade snapshots, restore
  identity/manifest checks, recovery journals, and deletion non-resurrection.
- [ ] Prove late enrichment preserves the immutable original envelope,
  capture-quality history, and source provenance.

### 7.2 Worker

- [x] Acquire a Windows process lease or named mutex.
- [x] Claim queue items in bounded batches.
- [x] Parse adapter events into canonical events.
- [x] Commit one processing unit transactionally.
- [x] Acknowledge only after the canonical transaction succeeds.
- [x] Yield to interactive MCP requests and open a circuit breaker under CPU,
  memory, disk, provider-error, or queue-pressure conditions.
- [x] Preserve durable backlog while a consumer or model provider is disabled.

### 7.3 Parser

- [x] Normalize every supported Copilot event type.
- [x] Record unsupported events through an explicit compatibility path.
- [x] Preserve the safe raw envelope and parser error on failure.
- [x] Distinguish a declared capability from an observed successful event.
- [x] Add fixture-based parser tests for every supported source version.

### 7.4 Definition of done

- [x] A fixture travels end to end from Extension envelope to redacted queue item,
  worker processing, canonical SQLite row, Ledger evidence, and gate result.
- [x] Worker crashes do not lose acknowledged or pending work.
- [x] Failed transactions do not create success-shaped domain state.
- [x] Disabling a consumer stops its side effects without corrupting the queue.

## 8. Batch 5: Copilot adapter and operational CLI

### 8.1 Adapter

- [x] Implement the `AgentAdapter` contract.
- [x] Register the supported Extension and local MCP configuration.
- [x] Resolve session, repository, branch, worktree, and commit identity.
- [x] Publish an actual capability matrix for the installed Copilot version.
- [x] Detect internal ProvenLoop sessions and suppress recursive capture.
- [x] Tolerate unsupported Copilot versions without breaking the CLI.

### 8.2 CLI

- [x] `provenloop install`
- [x] `provenloop status`
- [x] `provenloop doctor`
- [x] `provenloop enable <capability>`
- [x] `provenloop disable <capability>`
- [x] `provenloop uninstall`
- [x] Preserve data on uninstall unless purge is explicitly requested.
- [x] Make install, enable, disable, and uninstall idempotent.

### 8.3 Doctor checks

- [x] Node and Windows compatibility.
- [x] Data-root permissions and free disk.
- [x] SQLite health and migration version.
- [x] Queue health, backlog, retry, and dead-letter count.
- [x] Worker lease and recent heartbeat.
- [ ] Copilot version, sign-in availability, Extension registration, and MCP
  registration. Version and registration checks are implemented; Copilot CLI
  does not expose a non-interactive credential-status command, so sign-in
  availability remains explicit but unverified.
- [x] Capability state and last explicit error for each consumer.
- [x] Redaction and end-to-end synthetic-event self-test.

### 8.4 Definition of done

- [x] ProvenLoop can be stopped or broken while Copilot remains usable.
- [x] Installation requires no wrapper command for ordinary Copilot use.
- [x] Daily operation requires no additional model API key.
- [ ] Validate capability isolation in the installed 0.10 preview path.
  Capture, worker, and retrieval are wired to persisted capability state;
  automated coverage is not the full real installed-host matrix.

## 9. Batch 6: basic Work Episode builder

### 9.1 Deterministic grouping

- [x] Group by repository before applying weaker signals.
- [x] Use branch, commit ancestry, PR/issue references, changed-file overlap,
  tests/errors, task semantics, temporal proximity, and explicit links.
- [x] Store association evidence and confidence.
- [x] Prefer conservative splits over harmful merges.
- [x] Keep low-confidence associations as candidates.
- [x] Support user correction of merge and split decisions in the domain model.

### 9.2 Episode state

- [x] Record sessions, branches, commits, PRs, issues, timing, corrections, and
  outcome evidence references.
- [x] Keep `outcome` separate from `outcomeQualification`.
- [x] Do not treat an open or censored success as a final training example.
- [x] Rebuild episode projections deterministically from canonical evidence.

### 9.3 Evaluation

- [x] Prepare the 24-pair synthetic Episode association dataset.
- [ ] Retain 20-50 real, appropriately minimized Episodes for field validation.
- [x] Label same-episode and different-episode pairs.
- [x] Report precision, recall, wrong merge, and wrong split separately.
- [x] Record ambiguous cases rather than forcing a confident label.

### 9.4 Definition of done

- [x] Synthetic association precision meets the 95% regression threshold.
- [x] Synthetic association recall meets the 90% regression threshold.
- [ ] Establish both thresholds on retained independent real Episodes.
- [x] Wrong merges are visible as a distinct release metric.
- [x] Every episode relation can be explained using concrete source evidence.

## 10. M0 release checklist

- [ ] All Batch 1-6 definitions of done pass.
- [x] M0 Requirement Manifests and Replay Specs are versioned and frozen.
- [x] Event/process integrity, secret, scope, idempotency, and recovery suites
  pass.
- [ ] Unsupported Completion Claim count is zero.
- [ ] Seeded secret persistence and cross-repository leakage are zero.
- [ ] Capture-added latency P95 is at most 10 ms.
- [x] Parser and episode-builder synthetic quality thresholds pass.
- [ ] Revalidate the repaired native producer and real Episode quality.
- [ ] `provenloop doctor` reports actionable failures.
- [x] `report.json`, `report.md`, Evidence Ledger, dataset versions, and code
  version are retained for the release decision.
- [x] Known failures and limitations are included in the report.
- [x] M0 remains observation-only: no automatic long-term Knowledge activation.

## 11. M1: trusted continuity memory

### 11.1 Branch Context

- [x] Build Branch Context only after material continuation state changes.
- [x] Store goal, accepted decisions, constraints, implementation state,
  unfinished work, and recent verification evidence.
- [x] Verify repository, branch, and HEAD before retrieval.
- [x] Stop automatic recall on repository/branch/HEAD mismatch or context expiry.
- [ ] Add automatic branch merge/deletion discovery if required; expiry is not
  physical cleanup.
- [x] Keep Branch Context a rebuildable short-lived projection.

### 11.2 Knowledge backend

- [x] Implement `KnowledgeBackend` without leaking backend-specific schema into
  domain code.
- [x] Implement the SQLite FTS5/BM25 backend.
- [x] Implement index, search, get, remove, rebuild, and health.
- [x] Recheck canonical scope, state, evidence tier, and deletion state after
  projection search.
- [x] Test complete projection rebuild from canonical SQLite.

### 11.3 MCP retrieval

- [x] Implement `provenloop_context`.
- [x] Implement `provenloop_explain`.
- [x] Implement deterministic `provenloop_feedback` actions.
- [x] Enforce repository, workflow, personal, and branch scope.
- [x] Rank by scope, relevance, trigger, evidence, freshness, utility, and
  contradiction/stale penalties.
- [x] Enforce the token ceiling after rendering.
- [x] Return zero to three items and allow an empty result.
- [x] Deduplicate repeated injection within a session.
- [x] Fail closed with no context on timeout or backend degradation.
- [ ] Validate 0.10 MCP instructions/plugin skill and per-call trusted
  live Session snapshot with stale, ambiguous, outside-repo, and moved-workspace cases.
- [ ] Verify exact real-user feedback approval; helpful/provided must not
  imply adoption or a successful outcome.
- [ ] Verify Branch Context feedback never changes Knowledge lifecycle.

### 11.4 User control and deletion

- [x] Implement explicit remember, correct, forget, and mute-for-session.
- [x] Implement `forget <knowledge-or-playbook>`.
- [x] Implement delete by source/session/episode.
- [x] Implement purge of database, artifacts, projections, queue, cache,
  evaluations, logs, and tombstones.
- [x] Block dependent work while deletion is active.
- [x] Recompute or deactivate dependent Knowledge.
- [x] Run the deletion propagation gate before reporting success.
- [ ] Revalidate 0.10 Knowledge list/show/confirm/replace/revoke with
  stale digests, explicit confirmation, and named counterevidence resolution.
- [ ] Verify old confirmation cannot clear later failures or corrections.

### 11.5 M1 gate

- [x] Implement the 32-pair synthetic Branch Continuation gate, including
  token/TTV fixture comparisons, precision, wrong injection, and latency checks.
- [ ] Re-run that gate for the final current source and retain its artifacts.
- [ ] Evaluate at least 30 independent real Branch Continuation pairs.
- [ ] Demonstrate repeated Context Token median reduction of at least 30%.
- [ ] Demonstrate TTV median reduction of at least 15%.
- [ ] Establish real Retrieval Precision@3 of at least 90%.
- [ ] Establish Wrong Injection at most 2% for research and 1% for stable.
- [ ] Establish Outcome Success decline of no more than two percentage points.
- [ ] Establish installed-path retrieval latency P95 of at most 150 ms.

Synthetic fixture timing/outcome values do not measure real-user improvement.

## 12. M2: evidence-backed correction learning

### 12.0 Required first-product automatic learning

All items below are pending; existing checked structured-correction work does
not satisfy them. See architecture sections 3.6.1-3.6.5 and `M2-AUTO-001` through
`M2-AUTO-008` in product validation.

- [ ] Add source-backed window/job/proposal/typed-receipt contracts and canonical migrations.
- [ ] Automatically schedule bounded ordinary-language correction windows in an
  open Session without fixed labels or user-invoked learner tools.
- [ ] Implement the authenticated no-tools Copilot inference provider, one-time
  disclosure/consent, internal-session exclusion, budgets and explicit failure states.
- [ ] Keep inference outside capture callbacks and canonical/projection/maintenance
  leases; revalidate source, capability and deletion state before result commit.
- [ ] Persist proposals without rewriting original events or minting user confirmation.
- [ ] Classify reusable constraints separately from temporary requests, quotations
  and generic advice; keep unsupported candidates out of ordinary Context.
- [ ] Merge equivalent proposals only within matching scope and conditions;
  preserve conflicts and count independent sources rather than retries.
- [ ] Persist configurable candidate expiry and logical archival; model reruns
  cannot refresh it, and reevaluation must recheck deletion and revocation.
- [ ] Add MCP call provenance and narrow input-contract/postcondition verifiers;
  retain candidate status when only generic success is available.
- [ ] Wire existing correction admission, lifecycle, FTS and Explain to qualified proposals.
- [ ] Observe automatic later-task retrieval and use on the real supported host;
  instructions or a registered tool alone do not pass this requirement.
- [ ] Check task scope and applicability before ranking; suppress known duplicate
  guidance while allowing fresh retrieval after a material task/workspace change.
- [ ] Cover crash/retry deduplication, counterevidence, revocation, source/session
  deletion and in-flight-result invalidation.
- [ ] Expose why a window was not scheduled, produced no rule, awaits evidence,
  activated, paused or failed, plus model usage and source-to-rule latency.
- [ ] Show bounded activation/delivery notices on the actual user surface, with
  source/control access, a separate mute preference and deletion invalidation.
- [ ] Meet frozen discovery, activation and delivery coverage thresholds and both
  wrong-delivery denominators; preserve misses, unknowns and infrastructure failures.
- [ ] Pass frozen natural-language evaluation and actual installed/model/host
  acceptance before describing the first complete product as delivered.

### 12.1 Correction capture

- [x] Normalize explicit user corrections into frozen Correction Keys.
- [x] Record scope, expected behavior, trigger, task family, subsystem, source
  corrections, and verification evidence.
- [x] Require a verified result before correction-based Knowledge can activate.
- [ ] Revalidate full `VerificationBinding`: correction and captured operation,
  ordered parent chain, Session/repository/worktree identity, command target,
  trusted completion, and independent support.
- [x] Record Correction Opportunities before observing their outcomes.

### 12.2 Knowledge lifecycle

- [x] Aggregate by stable topic key instead of creating permanent duplicates.
- [x] Implement `candidate`, `active`, `disputed`, `superseded`, and `archived`.
- [x] Implement explainable Evidence Tiers.
- [x] Keep model relevance scores separate from lifecycle authority.
- [x] Prevent candidate, inferred, disputed, stale, deleted, and
  scope-incompatible items from silent injection.
- [x] Immediately dispute applicable Knowledge when valid counterevidence
  appears.
- [x] Rebuild current state from append-only feedback and evidence events.

### 12.3 Admission policy

- [x] Activate only when deterministic evidence and scope rules pass.
- [x] Never activate from model self-assessment alone.
- [x] Never broaden repository Knowledge to personal scope automatically.
- [x] Never use recalled Knowledge as fresh supporting evidence.
- [x] Preserve applies-when, non-applicability, proof chain, conflicts, and
  supersession.

### 12.4 M2 gate

- [x] Implement the 24-pair synthetic Correction Recurrence gate with provenance,
  evidence tier, counterevidence, recurrence, and wrong-injection checks.
- [ ] Re-run the strict-proof regression fixtures for the final source.
- [ ] Observe at least 20 independent real Correction Opportunities before
  claiming a measured percentage improvement; preserve unknown/censored cases.
- [ ] Demonstrate RCR improvement of at least 20% against a real baseline.
- [ ] Establish real Knowledge provenance completeness of 100%.
- [ ] Establish Evidence Tier label accuracy of at least 95%.
- [ ] Confirm direct counterevidence stops injection on the native installed path.
- [ ] Establish real Wrong Injection at most 2% for research and 1% for stable.

### 12.5 First-use observations — 0.10 acceptance

- [ ] Verify explicit scoped rule -> later-session Context -> Explain ->
  approved feedback -> local observation using the actual installed MCP path.
- [ ] Validate `observations show/export`, UTC date/session filtering, version
  filtering, bounded coverage, and privacy-minimized output.
- [ ] Keep provided context, explicit adoption, feedback, verification, and
  unknown outcomes separate; do not infer task time or causal benefit.
- [ ] Validate observation invalidation and collector/deletion lease ordering.

## 13. M1 + M2 MVP Go/No-Go

The aggregate `provenloop eval mvp` command is implemented and retains M0, M1,
M2, manual review, Shadow, observation-window, and rollback checks in one
atomic report. The checklist remains open because the current real decision is
No-Go. In addition to M0 and retained release evidence, current
`field-effect-evidence` remains blocked: synthetic fixtures, observation
manifests, and maintainer attestations cannot establish controlled benefit.

- [ ] Run event/process integrity, Branch Continuation, Correction Recurrence,
  Negative Trigger, and Safety/Recovery suites.
- [ ] Manually inspect the worst cases, not only aggregate scores.
- [ ] Confirm Severe Harm, secret leakage, cross-repository leakage, deletion
  propagation failure, and Unsupported Completion Claims are all zero.
- [ ] Confirm Outcome Success does not regress beyond the allowed threshold.
- [ ] Run Shadow before any limited Canary.
- [ ] Wait for the configured outcome observation window.
- [ ] Publish a Go, Conditional Go, or No-Go report with limitations and a
  rollback target.
- [ ] Do not begin automatic Skill/Playbook work unless cross-session episode
  reconstruction, retrieval precision, repeated-correction reduction,
  isolation, latency, provenance, and deletion are all credible.

## 14. Deferred until after M1 + M2

- [ ] M3 automatic delayed Outcome Linker.
- [ ] M4 Deep Retrospective and Insight Candidates.
- [ ] M5 Playbook generation, sandbox evaluation, approval, Canary, and
  rollback.
- [ ] M6 additional agent adapters and cross-agent deduplication.
- [ ] Memorix backend integration.
- [ ] Web dashboard and generic annotation UI.
- [ ] Team-scoped synchronization.
- [ ] Online fine-tuning or parameter training.

These items must not expand the first implementation batch.

## 15. First executable slice

The original fixture slice established the following path. It remains the
smallest regression path to revalidate when its capture/storage contracts change:

```text
fixture Extension event
  -> envelope validation
  -> write-time redaction
  -> atomic durable queue
  -> worker claim
  -> canonical parser
  -> SQLite transaction
  -> Evidence Ledger
  -> deterministic Gate
  -> JSON/Markdown report and stable exit code
```

0.10 rerun checklist (not a claim that the original implementation
is still missing):

- [ ] a valid event passes;
- [ ] a malformed event remains visible and fails;
- [ ] a duplicate event is idempotent;
- [ ] a seeded secret is absent from persisted content;
- [ ] a worker crash can recover the item;
- [ ] a completion claim without invocation evidence fails with exit code `1`;
- [ ] the same results are reproducible from a clean checkout.
