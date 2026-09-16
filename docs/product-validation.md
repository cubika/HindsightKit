# ProvenLoop Product Acceptance and Quality Evaluation Plan

**Historical baseline (2026-09-07):** `0.1.0-alpha.0.11` is a Windows Design Partner Preview
evidence candidate with observation export, strict native proof chains, bounded current-Session
reconciliation, and revised field-effectiveness gates. Synthetic regression, field observation,
controlled benefit comparisons, and release approval are four distinct forms of evidence;
none substitutes for another. New-version artifacts require separate validation. The M0/MVP
quality release remains No-Go, and `0.1.0-alpha.1` has not been approved.

**First-product requirement introduced on 2026-09-07:** Ordinary natural-language
corrections must trigger background extraction and produce source-backed rule candidates.
Rules that meet the evidence requirements must be reused in later relevant tasks without
manual reminders. A `remember` demonstration, fixed-format correction, or manually
constructed verification event cannot replace this acceptance test. 0.11 has not passed it.

**Status:** Proposed validation plan
**Version:** 1.2
**Updated:** 2026-09-11

The [Design Partner plan in section 9.6](#96-validating-the-product-promise-with-design-partners)
adds validation for the product positioning: less repeated investigation and rework.
It is a proposed study, not a completed trial or a new release approval. The
[README](../README.md#initial-integration) and dated release notes describe current
preview capabilities; older version-specific records below retain their original scope.
The [distillation checks in section 9.7](#97-distillation-quality-noise-and-missed-learning)
address FB-008's reported noise, missed learning, and instruction-quality output.

---

## 0. Questions this document addresses

The product document explains what to build, and the architecture document explains how
it is intended to work. After development, three harder questions remain:

1. Are these features implemented correctly and ready to deliver?
2. Does ProvenLoop improve Coding Agent outcomes, beyond storing more data?
3. What should change next, and what evidence supports that choice?

A single demo, a few successful cases, or a user's favorable impression cannot answer
these questions. ProvenLoop is a learning system. Its greatest risk is presenting incorrect
lessons as correct and repeatedly using them in later tasks, which matters more than an
individual broken button. Acceptance must therefore examine functionality, learning
results, product benefit, and harm.

This plan does not redefine the goals and metrics in `product-design.md`. It specifies
how to prepare evidence, run acceptance checks, make release decisions, and turn failures
from production use into verifiable improvements.

### 0.1 Executability review findings

The plan's direction is feasible, but its original form was an acceptance policy rather
than an acceptance system.

The missing foundation is a shared, machine-executable path, beyond additional metrics:

```text
Requirement Manifest
  -> Replay Spec
  -> Evidence Ledger
  -> Deterministic Gate
  -> JSON / Markdown Report
  -> Exit Code
```

Build this path in M0. Later versions add Replay Cases and Gates to the same evaluation
tools. The first iteration implements only what M0-M2 need. The full Sandbox, Dashboard,
complete labeling platform, and M3-M6-specific evaluation must come later. Establish the
protocols and execution entry points together without implementing every evaluation
capability at once.

---

## 1. Definition of product quality

ProvenLoop quality consists of six independent judgments, without a combined score:

| Dimension | Question | Typical evidence |
|---|---|---|
| Functional correctness | Do features follow product rules? | Automated tests, end-to-end scenarios, requirements traceability |
| Learning correctness | Is learned content supported by evidence, correctly scoped, and revised by counterevidence? | Episode replay, blind review, temporally split evaluation |
| Product benefit | Do users repeat less Context, make fewer corrections, and reach valid verification sooner? | RCR, TTV, repeated Context Tokens, failed retries |
| Safety and trust | Are Secrets leaked, contents injected across Repositories, or unauthorized actions executed? | Adversarial tests, permission checks, deletion verification, audit records |
| Reliability and cost | Is integration stable, with acceptable latency, resource use, and failure behavior? | P95 latency, queue backlog, recovery drills, CPU/disk usage |
| Understandability and control | Can users see what was learned, then correct, disable, delete, and roll it back? | Explain, Feedback, Forget, Rollback acceptance |

A critical failure in any dimension cannot be offset by strong results elsewhere. A 30%
reduction in TTV does not offset a cross-Repository leak. Producing many Insights does
not offset a lack of evidence for most of them.

Formal evaluation reports the status, metrics, and evidence for each dimension. It does
not produce an overall quality score.

---

## 2. Four levels of acceptance

Acceptance work should happen throughout development. Each level answers different questions.

### 2.1 Change acceptance

This applies to an individual code change, user story, or defect fix.

Every completed change must have:

- A corresponding product rule or defect case;
- Tests for the normal path, boundaries, and failure paths;
- An assessment of effects on data, permissions, Scope, deletion semantics, and compatibility;
- The necessary observable events and error messages;
- A repeatable acceptance command or scenario;
- No bypass of existing safety rules.

A feature that runs is not necessarily complete. It is also incomplete if failures cannot
be observed, or if diagnosing them requires inspecting the raw database.

### 2.2 Subsystem acceptance

This applies to complete capabilities such as Event Ingestion, Episode Builder, Outcome
Linker, Retriever, Retrospective Analyzer, and Playbook Evaluator.

Subsystem acceptance examines:

- Interface and data invariants;
- Behavior when integrated with upstream and downstream components;
- Invalid inputs, unknown versions, and partial data;
- Crashes, repeated execution, and recovery;
- Performance boundaries;
- Whether the subsystem emits events usable for product evaluation.

For example, Episode Builder tests must measure association Precision, Recall, wrong
merges, and wrong splits separately, as well as checking that it can produce an Episode.

### 2.3 Milestone acceptance

This applies to M0-M6 in `product-design.md` and `roadmap.md`.

Milestone acceptance answers research questions. For M2, the question is whether a
verified correction reduces repeated corrections in later similar tasks; the existence
of a Knowledge Card page does not answer it.

A Milestone passes only when all of these conditions hold:

1. The features in scope are complete;
2. The corresponding offline evaluation meets research thresholds;
3. Real use or controlled trials show results in the same direction;
4. Guardrails remain within their limits;
5. Failures can be explained, and data and reports can be reviewed.

### 2.4 Release acceptance

This applies to a version intended for delivery to more users.

Release acceptance is stricter than Milestone acceptance. Research thresholds indicate
that work is worth continuing, not that a stable release is ready. Before release, also complete:

- Full regression and data migration validation;
- Final Held-out evaluation;
- Dedicated safety and privacy checks;
- Shadow or Canary;
- Upgrade, downgrade, disabling, and uninstall validation;
- A version rollback drill;
- Documentation of known issues and applicability boundaries.

---

## 3. Acceptance basis: from requirements to evidence

Every requirement should have an executable acceptance record. The following structure is recommended:

```yaml
requirement_id: M2-KNOWLEDGE-004
milestone: M2
statement: Relevant Knowledge immediately stops automatic injection when counterevidence appears
scope: repository
preconditions:
  - An Active Knowledge item already exists
  - A new Episode produces direct revert evidence
action:
  - Run Outcome Linker
  - Issue a Context Request that matches the original Trigger
expected:
  - Knowledge state becomes disputed or superseded
  - Context Response does not contain that Knowledge
  - Explain shows the counterevidence and state change
verifier:
  - id: knowledge-disputed-stops-injection
    type: deterministic
guardrails:
  - Unrelated Knowledge remains unaffected
required_evidence:
  - test report
  - event IDs
  - evaluation run ID
expected_status: pass
```

Acceptance records prevent omissions during development and allow later releases to
verify that they have not broken earlier commitments.

Requirements and evidence must have at least the following relationship:

```text
Product rule
  -> Acceptance case
  -> Automated test or manual steps
  -> Run result
  -> Versioned report
```

A statement that behavior meets expectations is not reviewable evidence. Reports must
identify the tests, dataset version, code version, and failure cases.

### 3.1 Minimum execution core

M0 must deliver the following five elements. Without any one of them, acceptance still
depends on human interpretation and cannot be considered executable.

#### Requirement Manifest

Record product commitments and their Gates:

```yaml
requirement_id: PROCESS-CLAIM-001
milestone: M0
statement: A protocol may be claimed complete only when actual execution evidence is complete
scope: workflow
replay_specs:
  - false-consensus-missing-external-representative
verifier_ids:
  - claim-execution-consistency
required_evidence:
  - process claim
  - participant resolution
  - invocation completion
release_gate: hard
```

#### Replay Spec

Freeze the inputs and expectations for a repeatable acceptance run:

```json
{
  "specId": "false-consensus-missing-external-representative",
  "requirementId": "PROCESS-CLAIM-001",
  "inputEvents": ["fixture://false-consensus/events.jsonl"],
  "frozenEnvironment": "local-fixture-v1",
  "expectedGate": "fail",
  "expectedEvidence": [
    "claim.declared",
    "delegate.available",
    "delegate.not_invoked"
  ]
}
```

#### Evidence Ledger

The Evidence Ledger is an append-only index of execution evidence during normal operation.
User-initiated Source Delete and Purge still follow product deletion semantics. It records at least:

```text
run_id
event_id
episode_id
claim_id
actor_id
participant_id
requested_provider
requested_model
resolved_provider
resolved_model
invocation_id
status
input_digest
output_digest
timestamp
```

Detecting that a tool is available and observing its successful participation must be
distinct states. Model statements cannot fill gaps in evidence.

#### Deterministic Gate

A deterministic Gate reads only the Spec, Ledger, and verifiable artifacts and returns:

```text
pass
fail
inconclusive
infrastructure_error
```

The model generating a conclusion must not judge its own factual claims about process
execution, command success, participant and model identities, Scope, Secrets, or deletion
propagation. Models may propose Episode associations or Insight candidates, but cannot
issue their own proof of passing.

#### Runner and exit codes

The first iteration uses these shared entry points:

```powershell
provenloop eval run --suite valid-supported-event --out .provenloop\eval
provenloop eval m0 --out .provenloop\eval
provenloop eval m1 --out .provenloop\eval
provenloop eval m2 --out .provenloop\eval
provenloop eval report --run <run-id>
```

`m0-m2` is not a built-in suite name. Aggregate release decisions use `provenloop eval mvp`.
Passing one fixture must not be interpreted as passing an entire Milestone.

Fixed exit codes:

| Exit Code | Meaning |
|---:|---|
| 0 | All required Gates passed |
| 1 | At least one product or safety Gate failed |
| 2 | Invalid Spec, Manifest, or data |
| 3 | Infrastructure error; results cannot support a release decision |

Each run produces both `report.json` and `report.md`. Markdown supports reading; JSON
and exit codes determine automated gates.

### 3.2 One tool with Gates enabled by version

| Stage | Gates first enabled |
|---|---|
| M0 | Capture completeness, Secrets, identity, idempotency, Process Claim, failure recovery |
| M1 | Branch Continuation, Scope, Context Budget, Retrieval Negative, Wrong Injection |
| M2 | Correction Recurrence, Evidence Tier, disabling on counterevidence, repeated corrections |
| M3 | Outcome Link, observation windows, retroactive revision from Revert/Fix |
| M4 | Insight Evidence, counterexamples, Unsupported Causality |
| M5 | Playbook Trigger, Non-trigger, permissions, Sandbox, Canary, Rollback |
| M6 | Cross-Agent deduplication, capability degradation, cross-Agent Scope |

The Runner, Manifest, Ledger, reports, and exit codes remain unchanged. Later iterations
add Verifiers and Replay Suites only.

---

## 4. Test and evaluation assets

### 4.1 Test layers

ProvenLoop needs four types of tests; none replaces another.

| Type | Main purpose | Examples |
|---|---|---|
| Unit and property tests | Verify deterministic rules and invariants | Scope checks, state transitions, Token Budget, idempotency |
| Integration and fault tests | Verify component interaction and failure behavior | Queue recovery, SQLite locks, unknown event versions, Backend timeouts |
| Scenario and end-to-end tests | Verify user-visible outcomes | Cross-Session continuation, correction learning, Revert counterevidence, Forget |
| Replay and product evaluation | Regression verification, or benefit evaluation under real controlled conditions | Baseline comparisons, Held-out Episodes, Negative Triggers |

Unit tests and synthetic Replays verify deterministic behavior and regressions. Using a
production builder does not turn synthetic inputs into a real-user experiment. Field
observations describe what happened, but cannot establish attribution without a control.
Only controlled, independent, predeclared comparisons of real tasks support benefit
judgments. Release also requires platform, safety, human review, and recovery evidence.
The current fixtures contain 24 Episode association cases, 32 Branch Continuation cases,
and 24 Correction Recurrence cases. They must be explicitly labeled `synthetic_regression`
and excluded from real sample counts.

### 4.2 Six core datasets

Use the temporal split from the product design:

```text
Source -> Development -> Final Held-out
```

Maintain the following recommended datasets:

1. Branch Continuation: Test whether cross-Session Context is useful.
2. Correction Recurrence: Test whether similar corrections recur.
3. Outcome Replay: Test whether Review, CI, Fix, and Revert can revise earlier judgments.
4. Hidden Pattern Retrospective: Test whether unstated patterns can be discovered.
5. Negative Trigger: Test whether injection is withheld in similar but inapplicable situations.
6. Safety and Recovery: Test Secrets, malicious content, cross-Repo boundaries, deletion, and failure recovery.

These six datasets define the eventual structure, not the scope of a single M0 delivery.
The first iteration builds only:

- Event/Process Integrity;
- Branch Continuation;
- Correction Recurrence;
- Negative Trigger;
- Deterministic cases in Safety and Recovery covering Secrets, Scope, deletion, and failure recovery.

Outcome Replay, Hidden Pattern Retrospective, and complete Sandbox Replay are enabled
in their respective Milestones, using the same Manifest, Spec, Ledger, and report formats.

Each dataset needs a Manifest:

```yaml
dataset_id: correction-recurrence-2026-08
version: 3
created_from: anonymized-real-episodes
split: final-held-out
episode_count: 42
repository_count: 4
label_policy_version: episode-labeling-v1
excluded_cases:
  - incomplete_outcome_window
  - ambiguous_user_intent
known_biases:
  - frontend tasks underrepresented
content_hash: sha256:...
```

### 4.3 Preventing evaluation leakage

A learning system can inadvertently see the answers. Fix the following rules:

- Source Episodes cannot also be Held-out samples for the same Knowledge or Playbook;
- Final Held-out data must not influence Prompt, threshold, Trigger, or ranking adjustments;
- Reviews, Bugs, Fixes, and Reverts after time T are hidden outcomes only;
- Multiple Sessions from the same task must belong to the same data partition;
- Highly similar Forks, copied projects, and repeated tasks cannot span training and test partitions;
- Every evaluation records model, Prompt, rule, data, permission, and Repository Snapshot versions.

Leakage invalidates the run. Adding a note to the report does not permit continued use of its results.

### 4.4 Labeling and blind review

Items requiring human judgment, such as whether records belong to the same Episode or
whether an Insight is valid, use two-person blind review. When resources are limited,
the same person may review again at a different time with system outputs hidden.

When labels disagree:

1. Preserve both original judgments;
2. Record the reason for disagreement;
3. Determine the final label through adjudication rules or a third review;
4. Report the disagreement rate.

High disagreement usually indicates problems with task definitions or labeling rules
and should not simply be blamed on reviewers.

### 4.5 Separate generation from verification

Evaluation must distinguish two kinds of work:

```text
Generation:
  Discover candidate Episodes, similar tasks, Insights, and Triggers

Verification:
  Determine whether evidence exists, steps ran, Scope matches,
  Verifiers passed, and evidence supports the claims
```

Generation may use models. Verification should prefer deterministic rules, tool exit
codes, and external Outcomes. When semantic labels are uncertain, use frozen rules,
blind review, or a review process isolated from the generator. The same call that
generates a conclusion cannot also define the sample denominator, judge itself correct,
and approve release.

---

## 5. Subsystem acceptance

### 5.1 Event Ingestion

Must verify:

- Precision for recognizing supported events is at least 95%.
- Duplicate events do not produce duplicate facts.
- Unknown versions explicitly enter an error or compatibility path.
- Extension failures do not block Copilot.
- Capture added latency P95 is no more than 10 ms.
- Persisted Seeded Secrets: 0.
- The queue can recover after interruption, and failed events can be located.

Failure categories:

```text
missed_event
wrong_event_type
duplicate_event
wrong_identity
redaction_failure
silent_parse_failure
```

### 5.2 Work Episode Builder

Report separately:

- Association Precision.
- Association Recall.
- Incorrect merge rate.
- Incorrect split rate.
- Human correction cost for low-confidence associations.

The M0 research thresholds remain:

- Precision of at least 95%.
- Recall of at least 90%.

Do not report only overall accuracy. Merging two unrelated tasks is usually more dangerous than splitting one task into two because it contaminates subsequent learning.

### 5.3 Context Retrieval

Offline comparison:

```text
A: No Context
B: Branch Context
C: Branch Context + Active Knowledge
D: Full History Oracle
```

Core metrics:

- Retrieval Precision@3.
- Wrong Injection.
- Miss rate for useful Context.
- Negative Abstention.
- Rendered Token count.
- Retrieval latency.
- User ignore, correction, and revocation rates.

M1 research thresholds:

- At least 30 paired Branch Continuation tasks.
- At least a 30% reduction in median repeated Context Tokens.
- At least a 15% reduction in median TTV.
- Precision@3 of at least 90%.
- Outcome Success no more than 2 percentage points below Baseline.
- Wrong Injection no more than 2%.

For a stable release, Wrong Injection must tighten to no more than 1%.

### 5.4 Correction Learning

The [general correction-learning test catalog](general-learning-test-catalog.md) expands scenario coverage beyond tool-parameter recovery. It separates candidate discovery, qualification, applicability and observed behavior, and defines paired counterexamples without changing the release thresholds below.

#### Initial automatic extraction acceptance

The following Requirement IDs must enter the existing Evaluation/MVP Gate. These are new requirements, not existing runtime checks. Implementation cannot consist only of adding documentation checkboxes.

| Requirement | Required observation |
|---|---|
| `M2-AUTO-001` Automatic triggering | The installed plugin automatically schedules processing when an open Session receives an ordinary Chinese or English correction, without `remember`, fixed fields, an explicit extraction tool, or Session closure |
| `M2-AUTO-002` Extraction provenance | The model actually reads bounded, redacted excerpts; the rule and applicability conditions trace back to original user statements and operations, without fabricated user confirmation or native events |
| `M2-AUTO-003` Operation verification | Both native test/build scenarios and real MCP parameter corrections have positive examples of automatic activation; unrelated success, ordinary MCP success, and model self-assessment cannot serve as proof |
| `M2-AUTO-004` Later reuse | A new related task obtains the rule without a user reminder to call a memory tool; record whether behavior actually follows it, without equating delivery with adoption |
| `M2-AUTO-005` Isolation and degradation | No tool permissions; internal calls are excluded from learning; disabled learning, insufficient quota, expired sign-in, rate limits, and timeouts have explicit states and do not block foreground work |
| `M2-AUTO-006` Lifecycle | Retries do not add duplicate support, and old results cannot override new counterevidence; after source-data deletion, disablement, or revocation, in-flight results and rebuilds cannot restore the rule |
| `M2-AUTO-007` Coverage and noise | Candidate discovery, activation, and later delivery each meet the thresholds below; one-time requests are not retained as rules, synonymous entries are merged, and conflicts and candidate expiration follow policy |
| `M2-AUTO-008` User visibility | The normal work interface automatically shows brief feedback about actual activation and delivery, with provenance and disable/delete controls; candidates, repeated evidence, and unchanged states do not repeatedly interrupt users, and disabling notifications does not disable learning |

Freeze at least 40 ordinary-language windows, including at least 20 positive examples and 20 closely related negative examples. Cover Chinese and English, multi-step corrections, MCP parameter/tool selection, varied wording, ordinary questions, quoted text, excerpts containing secrets, and injection attempts. Include closely related comparisons between persistent project constraints and one-time requests, synonymous repetition, retries in the same operation chain, similar conditions with conflicting conclusions, expired candidates, content already covered by project instructions, and unrelated tasks.

Evaluate candidate discovery separately from activation eligibility. A model cannot be the final judge of its own output. Label completeness, provenance completeness, and blocking of scenarios prohibited from automatic activation must all be 100%. Independent human annotators must label usable rule content and applicability conditions, with Precision of at least 95%. Leakage, misuse across repositories, and fabricated confirmation must be zero. This Precision applies to usable rule content and applicability conditions. Report candidate correctness, misses, and rejection reasons separately; increasing candidate count is not a goal. Recognizing persistent intent does not authorize the model to confirm a rule.

The initial controlled acceptance thresholds for `M2-AUTO-007` follow. These are product targets that remain to be implemented, not measured results. Labels and supported scenarios must be frozen before execution; system output must not be used to reduce denominators.

| Metric | Denominator and success condition | Initial threshold |
|---|---|---:|
| Candidate discovery Recall | Among independently labeled reusable correction opportunities, the proportion producing a candidate with correct semantics and provenance; an opportunity with no candidate counts as a miss | ≥90% |
| Automatic activation rate for qualified rules | Among rules across all labeled opportunities that have supported verification, clear scope, and no counterevidence, the proportion automatically persisted as Active; includes rules missed during extraction | ≥90% |
| Unprompted delivery rate in later tasks | Among later tasks labeled in advance as requiring the rule and matching its scope/conditions, the proportion actually provided the rule before the relevant operation without a user reminder; failure to activate because of an upstream miss still counts as failure | ≥95% |
| Wrong delivery rate | Items with the wrong Scope, wrong Trigger, expiration, or counterevidence / all provided items; also calculate tasks receiving at least one incorrect item / all tasks receiving content | Both measures ≤2% during research and ≤1% for formal release |
| Negative Abstention | Among all later tasks labeled in advance as inapplicable, the proportion not provided the rule; includes independent host observation when no call occurs | ≥98% |

The discovery and activation denominators must each contain at least 20 independent positive examples. Also prepare at least 20 applicable later tasks and 20 inapplicable tasks. Report "insufficient evidence" when scenarios are insufficient; a missing denominator cannot count as a pass. Label actual compliance in related tasks separately. Both complete host scenarios, test commands and MCP parameters, must show compliance. Report compliant, noncompliant, and unknown counts across all tasks. Receiving a rule does not count as adoption.

Controlled runs use authorization, provider, and resource conditions frozen in advance, and retain all attempts. Sign-in, budget, or host failures are reported separately and make that controlled acceptance run incomplete. Do not discard failures and declare a pass. Field observations separately report all opportunities and the subset that can be adjudicated. Unlabeled opportunities must not be recorded as successes or zero errors. Passing on a small sample does not prove the same rates in production.

Repeated sources, retries in the same operation chain, and window revisions must not add synonymous Active entries or duplicate support. Incompatible conditions must not be merged to broaden scope. Candidates are archived when they expire; replay or model-prompt changes do not reset the deadline. Only new independent evidence or an explicit human action may request reassessment, and a human action does not directly grant activation eligibility. One-time requests must not become persistent rules. Quotations and generic advice must not enter ordinary Context. All these targeted negative cases must pass.

`M2-AUTO-008` requires observed activation notifications and later-delivery explanations in the installed host without diagnostic commands. By default, each task has at most one learning-change summary and one delivery explanation. No-rule results, candidates awaiting verification, and repeated evidence do not produce individual notifications. The same learning change is not announced again across tasks, though delivery may be explained again when a new related task actually receives the rule. Check provenance and control entry points, notification disablement, and cancellation of in-flight notifications after disablement/deletion. Background logs alone, tool results the Agent does not display, or its own claim that it has "remembered" do not pass. Candidate content must not be hidden in status messages delivered to the executing Agent.

In controlled scenarios with authorization, an available provider, and no budget/resource pause, the target p95 from the final required native evidence to rule persistence is within 120 seconds. Report timeout, paused, and queued samples separately; do not discard them and present the remainder as overall performance. Existing foreground latency, safety, and Wrong Injection thresholds still apply and are not relaxed for the added model.

A provider substitute with fixed responses proves only scheduling and the state machine. Retain version-bound evidence of the actual sign-in state, real model calls, installed artifact, and native host, and observe reuse in another normal task. Passing controlled replay still does not prove improved user productivity.

#### Correction recurrence and benefit

The evaluation unit is a Correction Opportunity, not the number of Knowledge Cards.

An opportunity is defined by frozen rules before the outcome appears:

- A verified Correction Key already exists.
- The new task matches its Scope, Task Family, Subsystem, Intent, and Trigger.
- The system has an opportunity to use the Knowledge before the user corrects it.
- Applicability is not redefined because of later success, failure, or missing outcomes.

`outcomeKnown` is a later analysis state, not a prerequisite for creating an opportunity. Report all predeclared opportunities, the analysis sample with adjudicable outcomes, and censored/unknown samples separately. State inclusion criteria and the denominator when calculating RCR. Do not select successful tasks first and describe the remainder as all correction opportunities.

Core metric:

```text
RCR =
Number of Correction Keys that recur in later similar tasks
/
Number of opportunities with an existing reusable correction
```

M2 research thresholds:

- RCR at least 20% lower than Baseline.
- Knowledge provenance completeness of 100%.
- Evidence Tier labeling accuracy of at least 95%.
- Automatic injection stops immediately when counterevidence appears.
- Wrong Injection no more than 2%.

Do not publish an attractive percentage from an insufficient sample. With fewer than 20 independent opportunities, report every case and directional findings without claiming proven product benefit. Even more than 20 synthetic fixture groups cannot satisfy the real-opportunity requirement. Counts of "later corrections" in ordinary observations are not RCR improvements established through controlled comparison.

### 5.5 Outcome Linker

Evaluate link reliability and whether incorrect links can change Knowledge, not just how many links were created.

Must verify:

- Precision for `direct` associations is at least 95%.
- Precision for `plausible` and stronger associations is at least 90%, with Recall of at least 80%.
- `uncertain` associations cannot independently activate, weaken, or rewrite Knowledge.
- A Later Revert can weaken the original conclusion retroactively.
- Episodes with open observation windows remain `censored`.
- Users can split, merge, or reject associations.

Report harm from incorrect associations separately:

```text
Incorrect display only
Incorrect ranking change
Incorrectly stopping valid Knowledge
Incorrect Knowledge activation
Incorrect propagation across Scope
```

### 5.6 Deep Retrospective

Use blinded evaluation: provide only Episodes before time T and hide Reviews, Bugs, Fixes, or expert labels after T.

Evaluate:

- Whether the Pattern exists.
- Whether evidence supports the hypotheses.
- Whether observation, correlation, hypothesis, and causality are distinguished.
- Whether counterexamples are actively checked.
- Whether Applicability and Non-applicability are clear.
- Whether later hidden outcomes support the Insight.
- Whether using the Insight improves real task outcomes.

Formal metrics:

- Evidence Coverage of 100%.
- Insight Precision of at least 80%.
- Unsupported Causality no more than 2%.
- Every Insight includes a counterexample check or explains why it could not be performed.

"No reliable pattern found" is an acceptable output. Lowering thresholds to increase the number of Insights is product regression.

### 5.7 Playbook

Comparison:

```text
A: No Knowledge / No Playbook
B: Active Knowledge
C: Current Approved Playbook
D: Candidate Playbook
```

A Candidate may enter Canary only if it improves on the currently available approach on an independent Held-out set.

Release thresholds:

- At least 50 paired Held-out replays.
- Trigger Precision of at least 95%.
- Negative Abstention of at least 98%.
- Provenance, permissions, Trigger, Non-trigger, and Verifier completeness of 100%.
- Severe Harm of 0.
- The lower bound of the benefit confidence interval is greater than 0.
- One-click rollback to the previous version is available.

---

## 6. System-level Guardrails

These metrics are release thresholds, not optimization targets:

| Metric | Stable-release threshold |
|---|---:|
| Wrong Injection | No more than 1% |
| Harm Rate | No more than 0.5% |
| Severe Harm | 0 |
| Secret persistence or output | 0 |
| Leakage across Repositories | 0 |
| Retrieval Latency P95 | No more than 150 ms |
| Capture Added Latency P95 | No more than 10 ms |
| Evidence Coverage | 100% |
| Deletion propagation failures | 0 |
| Unsupported Completion Claim | 0 |

Severe Harm includes Secret leakage, content leakage across Repositories, and unauthorized destructive actions. A single occurrence makes the release No-Go. After a fix, rerun the full safety suite, not just the failed case.

An Unsupported Completion Claim is a statement such as "tested," "reviewed," "cross-model consensus reached," or "the specified process completed" that affects acceptance, learning, or user decisions but lacks corresponding execution evidence. Ordinary wording is not penalized by this metric; consequential process claims must have Ledger records.

---

## 7. Complete release acceptance process

### 7.1 Freeze the evaluation target

Record:

- Code Commit.
- Schema and migration versions.
- Adapter version.
- Model and Prompt versions.
- Declared protocols and versions.
- Required and actual participating Agents, Providers, Models, and external tools.
- Retrieval, Trigger, Evidence Tier, and threshold configuration.
- Dataset version.
- Permission and network policies.
- Test environment.

A change to any of these during evaluation requires a new Evaluation Run.

### 7.2 Run automated regression

Suggested order:

1. Unit and property tests.
2. Schema, migration, and compatibility tests.
3. Integration and failure recovery.
4. End-to-end product scenarios.
5. Safety and Recovery.
6. Replay and Held-out comparisons.
7. Performance and resource tests.

Run inexpensive tests with clear failure localization before time-consuming Replay.

### 7.3 Human review of failure cases

At every Milestone or Release, review at least:

- All Severe Harm and Harm.
- All Wrong Injection.
- The 10 Episodes with the worst metrics.
- Cases the system rated highly confident but human reviewers judged incorrect.
- Cases where the system declined injection but the Oracle judged it necessary.
- Cases involving user correction, ignoring, deletion, or rollback.

Average metrics can hide real problems. The ten worst cases usually reveal more than ten additional successes.

### 7.4 Shadow

New policies first compute results without injecting them into Agent Context. During Shadow, compare the new and old versions:

- Newly retrieved items.
- Items no longer retrieved.
- Differences in state transitions.
- Scope, Secret, or permission risks triggered.
- Expected effects on Tokens and latency.

Shadow tests whether a seemingly reasonable rule holds under the actual traffic distribution.

### 7.5 Canary

After Shadow passes, enable the policy only for a small number of Episodes or low-risk Scopes. During Canary:

- Retain the old version as a control.
- Record a version for every use of Knowledge or a Playbook.
- Check Harm, Wrong Injection, and latency in real time.
- Roll back immediately when a stopping condition is met.
- Do not continue tuning parameters during Canary while retaining the original evaluation report.

### 7.6 Observation window

Passing local tests is not final success. Wait for Review, CI, Fix, Revert, or the next release cycle.

M3 plans an Outcome-qualified Success observation window of 14 days or one release cycle. Episodes whose window remains open are marked `censored` and cannot be counted early as successes. Current ordinary observations do not provide complete delayed-outcome tracking. The passage of observation dates alone cannot turn unknown task outcomes into successes.

### 7.7 Release decision

A release record includes at least:

```text
Decision: Go / Conditional Go / No-Go
Version:
Evaluation Run:
Passed gates:
Failed gates:
Open risks:
Canary scope:
Rollback target:
Owner:
Decision date:
```

Conditional Go should be limited to issues that do not concern safety or data correctness, with explicit usage restrictions and expiration. Without new evidence at expiration, it automatically becomes No-Go instead of being extended indefinitely. This is release policy, not a capability claim for the current synthetic gates. Version 0.10 retains `field-effect-evidence: blocked`, so additional ordinary observations or human endorsement cannot produce Go/Conditional Go.

---

## 8. Go / No-Go rules

### 8.1 Immediate No-Go

Do not proceed to the next stage if any of the following applies:

- The first complete product still requires users to write rules manually, follow a correction
  format, or prompt tool calls to pass the required automatic correction learning scenarios.
- Severe Harm is greater than 0.
- Secret or cross-Repository leakage is greater than 0.
- Derived data remains retrievable after deletion.
- Evaluation data has leaked.
- Critical metrics are missing or cannot be reproduced.
- Outcome Success declines substantially.
- System failures block Copilot.
- Unsupported inferences can automatically activate Knowledge or Playbooks.
- Critical completion claims lack actual execution evidence.
- The version cannot be rolled back.
- Final Held-out data was used for tuning.

### 8.2 Research may continue, but stable release is not allowed

- Core value metrics are moving in the right direction, but the sample is too small.
- Wrong Injection is between 1%-2%.
- Some noncritical Adapters require explicit degradation.
- Performance on low-end devices is close to the threshold.
- Users can complete control operations, but the steps remain cumbersome.

These versions may continue in internal use or Design Partner trials. Research thresholds
must not be described as stable quality. Safe, explicitly authorized observation candidates
with a narrow scope may also collect missing evidence, but must disclose No-Go and stop
conditions. Unproven benefit does not establish absence of harm. Unknown safety counts must
not be filled in as zero.

---

## 9. Finding product improvements

Improvements should primarily come from gaps between expected behavior and actual outcomes,
rather than feature wish lists.

### 9.1 Four types of gaps

| Gap | Symptoms | Typical improvements |
|---|---|---|
| Correctness gap | Incorrect learning, linking, retrieval, or state | Fix rules, models, evidence, and data |
| Value gap | The system works, but RCR and TTV do not improve | Improve Triggers, Context format, and task coverage |
| Trust gap | Users hesitate to enable features, frequently use Explain, or disable the system | Improve explanations, permissions, previews, and controls |
| Cost gap | Benefits exist, but latency, Token use, disk use, or maintenance cost is too high | Improve compression, caching, batching, and retention policies |

A user not clicking a feature does not establish that the feature is useless. The entry point
may be hard to find, or the user may not trust it. Identify the gap before deciding whether
to change the interface, change the algorithm, or remove the feature.

### 9.2 Consistent error classification

Assign at least one primary cause to every failure case:

```text
capture.missed
capture.misclassified
process.false_claim
process.missing_required_step
process.participant_not_invoked
process.model_not_diversified
process.unsupported_completion
episode.wrong_merge
episode.wrong_split
outcome.wrong_link
outcome.missed_link
knowledge.unsupported
knowledge.stale
knowledge.wrong_scope
retrieval.false_positive
retrieval.false_negative
retrieval.context_overload
retrospective.false_pattern
retrospective.missed_counterexample
playbook.wrong_trigger
playbook.wrong_action
control.delete_failure
control.rollback_failure
reliability.degraded
ux.unexplained_behavior
```

Stable categories make it possible to distinguish isolated cases from systemic defects.
Without classification, Feedback usually becomes a list of text that cannot be prioritized.

### 9.3 From failure case to improvement experiment

Use this template for each improvement:

```yaml
problem:
  error_class: retrieval.false_positive
  affected_episodes: 12
  user_impact: repeated correction
evidence:
  - wrong subsystem match
  - trigger ignored generated-file condition
hypothesis:
  adding a generated-file negative trigger will reduce wrong injection
target_metric:
  wrong_injection: "<= 1%"
guardrails:
  retrieval_recall: "no drop greater than 2 percentage points"
evaluation:
  dataset: negative-trigger-2026-08-v4
  method: paired replay
rollout:
  shadow: 7 days
  canary: repository scope only
rollback_condition:
  any severe harm or recall drop above guardrail
```

Strategy changes or improvements to product effectiveness require a target metric and
Guardrails. Deterministic defect fixes can first use a minimal reproduction, targeted regression
checks, and related negative cases. Fixing command parsing or evidence binding does not
always require a full benefit experiment first.

### 9.4 Priority

Address issues in this order:

1. Safety, privacy, permissions, deletion, and irreversible harm.
2. Systemic defects that propagate incorrect learning.
3. Frequent repeated corrections and failures.
4. Usability problems that prevent the first value event.
5. Performance, cost, and maintainability.
6. Infrequent experience and appearance issues.

Within a priority level, compare the number of affected users, frequency, severity of harm,
evidence strength, and repair cost. A priority formula with decimal precision must not hide
weak evidence.

### 9.5 Regular retrospective cadence

Use three review cadences:

- Weekly failure-case Review: examine the worst Episodes, Wrong Injections, repeated
  corrections, and user control operations.
- Each Milestone evaluation: decide whether the research question has been answered
  with evidence.
- Each stable version retrospective: compare versions, Cohorts, and long-term Outcomes.

Retrospectives should produce only three types of decisions:

```text
Keep: Supported by evidence; leave unchanged
Change: A clear gap and a validation plan exist
Stop: No benefit, excessive harm, or unreasonable maintenance cost
```

### 9.6 Validating the product promise with Design Partners

The [product positioning](product-design.md#4-product-positioning) prioritizes reuse of
investigation findings and corrections, with sources and user controls that make reuse
inspectable. Validate whether this reduces total developer effort beyond an existing
memory setup. The [competitive review](research/competitive-analysis.md#1-summary-of-findings)
records why automatic capture, local storage, citations, and a Viewer are insufficient
on their own to establish differentiation.

#### Participants and duration

Recruit 8-12 developers who maintain a repository over time and still repeat
investigations or corrections weekly despite native memory and maintained project
instructions. Ask for concrete recent examples before enrollment. Frequent use of an
agent alone does not establish unmet need.

Plan an initial four-week trial within the D0 discovery window. This is a proposed
sample and duration, not a claim that recruitment or field research has taken place.
Record installation effort, assistance needed, permissions accepted, and first-use
failures as part of the study.

#### Baselines and assignments

Use the participant's supported agent and keep model/version, permissions, task
instructions, and repository starting state comparable. Record native-memory settings
and availability; an unavailable feature cannot be counted as an enabled baseline.

| Condition | Purpose |
|---|---|
| Existing native memory and maintained project instructions | Measure the user's actual starting workflow |
| Existing workflow plus deliberate manual instruction updates | Measure whether manually preserving the same lesson is sufficient, including editing effort |
| Existing workflow plus ProvenLoop | Measure the incremental benefit and cost of the product |
| A representative open-source memory alternative on the same supported host | Compare the complete workflow where a compatible integration exists |

Assign matched later tasks before observing their results. Counterbalance task order
and isolate experimental memory stores to prevent lessons leaking between conditions.
Learning tasks and later evaluation tasks must be separate. If agent or model changes
are necessary for a competitor, report a separate comparison and its confounds.

#### Required user scenarios

| Scenario | What to observe |
|---|---|
| Investigation reuse without a correction | A finding from captured agent work is supplied in a later related task; its sources remain inspectable and the agent checks applicability before relying on it |
| Ordinary correction | A natural-language correction leads to supported guidance in a later Session without manual rule creation or a reminder to retrieve |
| Unrelated task or repository | Guidance is withheld when the conditions do not apply |
| Unrelated code change followed by a new commit | A still-useful finding can be rechecked; record eligible reuse and missed opportunities rather than assuming every new revision invalidates every lesson |
| Changed premise or contrary evidence | Old guidance is withheld or explicitly revalidated; record whether detecting the change required manual help |
| User correction, archive, or deletion of knowledge | The resulting control takes effect and is understandable without database inspection |

Current shell-recovery guidance checks exact command, worktree, branch, and commit
identity. Development research references can cross a commit boundary while requiring
revalidation. Treat these as different delivery policies; test the installed version
and record its behavior. A restrictive policy can be correct yet miss most useful
opportunities. Finding such a gap does not justify bypassing evidence checks.

#### Measures and interpretation

Record the first unprompted reuse with its source, delivered item, subsequent agent
action, and outcome. Time from installation to that event measures activation. Capture
readiness, learning readiness, and repository-hook readiness should be observed
separately, including failures before users reach the first event.

For each participant and task family, report:

- Repeated corrections per predeclared relevant opportunity, failed retries, and time
  to the first valid action or verification.
- Repeated investigation steps and their duration, using comparable tasks or trace
  review. A shorter trace alone does not prove that the work was unnecessary.
- Correct delivery, inappropriate guidance, and missed eligible reuse. Count tasks
  with no returned guidance and unknown outcomes in their proper denominators.
- Setup, rule review, manual instruction editing, cleanup, and troubleshooting time,
  alongside runtime latency and model/service usage.
- Voluntary continued use and concrete reasons for keeping or disabling the product.
  Assess willingness to pay after an observed benefit; hypothetical enthusiasm is
  weaker evidence than an actual purchase decision.

Delivered guidance is not adoption, and adoption alone is not saved work. An avoided
investigation or correction is a comparative claim; ordinary event counts cannot
establish the counterfactual. Keep reported user impressions distinct from trace-backed
observations and controlled comparisons. Do not turn a small sample into a market-size
estimate, a pricing conclusion, or a population-wide improvement percentage.

#### Product decisions after the trial

Report individual outcomes and failure cases before pooling results. Continue expanding
a scenario when several participants show recurring benefit over their existing setup
and the savings exceed the added effort. If delivery is correct but value is absent,
revisit the target task and relevance. If useful experience is repeatedly withheld,
investigate capture, applicability, and revalidation coverage. If the first benefit
requires maintainer intervention, improve onboarding before adding more capabilities.

Use those results to choose the next learning type or adapter. The trial does not
replace the release gates, and no willingness-to-pay or sustained-benefit claim is
established until corresponding evidence has been retained.

### 9.7 Distillation quality, noise, and missed learning

Status: proposed acceptance work for
[FB-008](feedback.md#fb-008-distillation-quality-noise-and-missed-learning). The
[output contract](product-design.md#45-distillation-is-the-product) requires concise,
supported guidance suitable in substance for the relevant Copilot instructions.
Accurate quotations alone do not meet that standard, and suitable wording does not
automatically confer authority or permission to deliver a rule.

#### Evaluate the full set of learning opportunities

Use authorized work samples with their relevant sources, current instructions, and
existing knowledge. Before inspecting model output, independent reviewers identify
the valuable reusable lessons, applicable scope, conditions, and acceptable meanings.
Resolve or report disagreements; do not force one wording as the only valid answer.
Count distinct concepts, not the number of supporting events.

Include routine work with no durable lesson, temporary requests, precise lasting
conventions, duplicates of effective instructions, investigated findings without a
correction, valuable discoveries seen once, failed recoveries, and long investigations
where the important evidence appears early. Add related later tasks, changed premises,
and unrelated negative cases. Retain omitted and failed windows in the report.

#### Keep quality dimensions separate

| Dimension | Measurement |
|---|---|
| Retained quality | Useful, supported, nonredundant final lessons divided by all final lessons; report noise categories and duplicate burden |
| Learning coverage | Reviewer-identified valuable concepts correctly distilled and retained divided by all identified valuable concepts |
| Abstraction quality | Whether the output expresses a reusable decision or constraint, preserves conditions, and avoids incident-only retelling, generic advice, and unsupported generalization |
| Instruction suitability | Whether a reviewer would deliberately include the scoped guidance with no or minor wording edits; report substantive rewriting separately |
| Later use | Relevant opportunities receiving appropriate guidance, agent behavior afterward, wrong guidance, and missed retrieval |
| User effort | Remember prompts, manual recovery of missed lessons, candidate approvals, noise cleanup, rewriting time, and disruptive notifications |

Report retained quality and learning coverage together. A zero-output run has no
measured retained precision and may have zero coverage; it cannot pass as noise-free
success. Retaining every excerpt cannot pass on coverage while leaving the user to
extract the lesson. Successful source matching and candidate isolation remain useful
checks but do not establish semantic quality.

For each missed concept, locate the loss at capture, source selection, interpretation,
retention, consolidation, or retrieval. Report coverage over the original authorized
sample as well as extraction coverage conditional on available evidence. Missing
sources explain a failure without removing that opportunity from end-to-end coverage.
Expected refusal due to inadequate evidence must remain distinct from an avoidable miss.

#### Abstraction and reuse checks

Ask reviewers to compare incident descriptions, candidate lessons, and source support.
The chosen level of abstraction should transfer across irrelevant changes in filenames
or task wording while retaining material repository and tool constraints. Necessary
exact identifiers must remain. A repeated pattern can strengthen evidence, but one
explicit lasting convention or well-supported finding need not recur to be valuable.

Compare the proposed distillation with the current quotation/reference path and a
human-edited instruction baseline. Test later tasks independently from extraction.
An optional review rendering of structured guidance as instruction text checks content
quality only; the evaluation does not write to the user's actual instruction files.

Freeze labels, sampling rules, and acceptance thresholds before measuring model output.
No numerical precision, coverage, or low-effort target is claimed as achieved here.
Carry the results into the Design Partner trial alongside real task outcomes; the
product must satisfy both useful retention and low maintenance burden.

### 9.8 Improvement as experience accumulates

The [scalability review and acceptance matrix](scalability-review.md#6-acceptance-plan)
records diagnostic failures and defines proposed workload, quality and resource
checks for the engineering repair. Its synthetic measurements do not replace
the controlled outcome comparison below.

Status: proposed outcome validation for the FB-008 follow-up. The
[product promise](product-design.md#46-the-agent-should-improve-with-experience) is that
developers experience an agent becoming more capable in their project through use.
Evaluate the full path from distillation to later action; attractive knowledge cards
or high extraction scores alone cannot establish this result.

Compare frozen earlier and later learning collections on held-out tasks from the same
relevant task families. Keep the agent/model version, repository starting state,
native memory, instructions, and permissions comparable, and isolate evaluation
stores from further learning. Include the existing-workflow baseline from section 9.6.
Report model upgrades, task difficulty changes, and user practice as confounds rather
than attributing their effects to ProvenLoop.

Assess fewer repeated corrections and unnecessary investigations, better first actions,
successful transfer to related situations, and correct refusal of stale or inapplicable
guidance. Preserve correctness and verification requirements. Also track context cost,
latency, and user maintenance effort as the collection grows.

During real use, ask developers for concrete examples of needing less supervision,
seeing no change, or encountering worse behavior. Keep these reports separate from
controlled comparisons; both matter to the product decision. Show results by user and
task family so an average gain does not hide recurring degradation.

Record each comparison as improved, no discernible effect, degraded, or insufficient
evidence. A growing collection with no effect calls for investigation of lesson quality,
applicability, delivery, and actual adoption. Degradation calls for tracing and
withdrawing or revising the responsible guidance under existing controls. No result
here is a promise of monotonic improvement on every task or a current quality pass.

---

## 10. What production observations should record

To explain why an outcome improved or worsened, record at least:

- Evaluation Run, code, rule, model, and data versions.
- The declared work protocol, required steps, and completion claims.
- Requested and actual participants, requested/resolved model, invocation IDs, and
  completion status.
- Context Request Scope, Trigger, and candidate count.
- Items actually injected, ranking reasons, Tokens, and latency.
- Whether the Agent used the Knowledge or Playbook.
- Whether the user corrected, ignored, confirmed, deleted, or rolled back the result.
- Verifier results.
- Later Reviews, CI, Fixes, Bugs, and Reverts.
- Final Episode state and observation window.
- Reasons for degradation, timeouts, and failures.

Do not record the following by default:

- Complete Prompts unrelated to evaluation.
- Unbounded tool output.
- Secrets or highly sensitive original text.
- Telemetry fields without an explainable purpose.

Each field must answer a product or reliability question. If it cannot, do not collect it.

### 10.1 Current local observations: 0.10 evidence candidate

```powershell
provenloop observations show
provenloop observations show --date 2026-09-06 --session <session-id>
provenloop observations export --date 2026-09-06 |
  Set-Content -Encoding utf8 .\provenloop-observations.json
```

Dates use UTC and default to today. `show` provides the date window, code/plugin versions,
Session/Repository digests keyed with a local secret, coverage, retrieval status and counts,
explicit adoption, feedback, corrections, verification, and available capture-health snapshots.
`export` outputs a compact observation manifest for the current code version, not a full
database export. Limited samples are marked `bounded_sample`.

Preserve these distinctions:

- `provided` means only that Context was returned; `explicitly_adopted` comes from an
  explicit user report.
- helpful does not automatically count as adoption or successful verification.
- `not_observed` is not equivalent to `not_invoked`; the latter requires sufficient closure
  and coverage evidence.
- Unknown outcomes remain `outcome: unknown`, task duration is null, and control-group
  assignment is unknown.
- No recorded safety events does not mean that measured Severe Harm, Secret leakage,
  or Scope leakage is zero.
- capture-health is a process snapshot. It must not be presented as a complete measurement
  of each Session.

The manifest is marked `evidenceKind: observational` and `controlledEffect: not_established`.
The evaluation library can load it through `observationManifestPath` and validate its version.
The current CLI has no corresponding `eval --observations` option. Do not pass the manifest
to `--evidence` as release evidence.

### 10.2 Artifact binding and maintainer attestations

External probes, automated test reports, and release artifacts must be read, checked against
their schema and version, and matched by digest. Checking that a file exists or accepting
a caller-supplied "passed" is insufficient. The caller must still describe the sample source
and execution scope. The paired-latency probe analyzes input arrays; it does not run a paired
experiment. The capability probe references external test reports; it does not run those tests
itself. Manual records such as Shadow and worst-case reviews are marked
`maintainer_attestation`. Digests establish the binding, but do not automatically prove that
the human judgment or experimental design is correct.

---

## 11. Minimum MVP acceptance package

M1 + M2 form the first product that can undergo formal validation. The package below is
required to establish controlled effects and eligibility for broader adoption. These are not
daily operations that must precede a user trying one explicit rule.

### Data

- 20-50 real Work Episodes for observation quality.
- At least 30 paired Branch Continuation tasks.
- At least 20 independent Correction Opportunities; report cases only if there are fewer.
- Positive Process Claim cases, negative cases with missing steps, and false-completion cases.
- Negative Trigger and cross-Repository samples.
- Seeded Secret, deletion, and failure-recovery samples.

### Required scenarios

1. A new Session on the same Branch retrieves the necessary Context.
2. An unrelated Repository does not receive that Context.
3. After the user corrects Jest/Vitest use, later similar tasks do not repeat the mistake.
4. When the user changes a preference, the old Knowledge is revised instead of remaining active.
5. An explicitly linked direct Later Revert stops injection of the old Knowledge.
6. After Forget, the Knowledge and dependent projections are no longer retrievable. Deleting
   raw evidence requires Source/Session/Episode Delete. The boundary between managed
   storage and separate backups or exports must be explicit.
7. Copilot remains usable when the Backend, Worker, or Extension fails.
8. Explain shows sources, scope, counterevidence, and current state.
9. A claim that tests, review, or consensus were completed has corresponding successful
   execution evidence in the Ledger.
10. The system cannot claim cross-model consensus when available external representatives
    were not invoked, or when representative models do not meet protocol requirements.
11. After a user corrects a Process Claim, a later task of the same type that violates the
    same Correction Key fails the Gate.
12. Installation reuses the current Copilot sign-in without requiring an additional model
    API Key. Persistent feedback and high-impact operations still require explicit user
    approval; the Agent cannot approve on the user's behalf.
13. Disabling an individual capability stops the corresponding capture, injection, or
    background processing. Other capabilities and foreground Copilot remain available.

Item 5 validates in M2 that existing direct counterevidence can immediately disable Knowledge.
M2 does not need to automatically discover and link delayed Reverts. Automatic delayed
Outcome linking belongs to M3 acceptance.

### Product thresholds

- RCR decreases by at least 20% relative to the Baseline.
- Median repeated Context Tokens decrease by at least 30%.
- Median TTV decreases by at least 15%.
- Outcome Success does not decrease by more than 2 percentage points.
- Retrieval Precision@3 is at least 90%.
- Research-stage Wrong Injection is no greater than 2%.
- Critical Unsupported Completion Claim count is 0.
- Severe Harm, Secret leakage, and cross-Repository leakage are all 0.

Only results that meet these conditions on real controlled data support a benefit judgment
for broader trials. Synthetic passes, ordinary observations, human confirmation, and formal
release approval must be displayed separately. These results do not establish Deep
Retrospective or Playbook effectiveness; each requires its own datasets and release gates.

---

## 12. Recommended acceptance report

Produce a Markdown summary and a machine-readable result for each Milestone or Release.

```markdown
# ProvenLoop Evaluation Report

Version:
Commit:
Evaluation Run:
Dataset versions:
Environment:
Evidence kind: synthetic_regression / observational / controlled comparison
Coverage and unknown/censored counts:
Artifact bindings and maintainer attestations:

## Decision
Go / Conditional Go / No-Go

## Product outcomes
- RCR:
- TTV:
- Repeated Context Tokens:
- Outcome Success:

## Guardrails
- Wrong Injection:
- Harm Rate:
- Severe Harm:
- Unsupported Completion Claim:
- Secret/Scope violations:
- Capture Added Latency P95:
- Retrieval P95:

## Subsystem results
- Event Ingestion:
- Episode Builder:
- Outcome Linker:
- Retrieval:
- Retrospective:
- Playbook:

## Worst cases
1.
2.
3.

## Known limitations

## Decision and rollback target
```

The report must list failures and limitations. A report that shows only passes cannot support
a release decision.

The implemented aggregate command is:

```powershell
provenloop eval mvp --out <directory> [--evidence <file>] [--stable]
```

This command fixes the code version, runs M0, M1, and M2, preserves all child reports, and
then reads explicit release evidence. Release evidence must match that code version, all
three dataset versions, and all three stable child-gate digests. Old reports cannot approve
new code. Approval is not possible if evidence is missing, Shadow has not passed, an
observation window remains open, rollback is unverified, or any safety count is nonzero
or unknown. The current implementation also has a fixed field-effect evidence gap, so it
can only return `No-Go`. The rollback target must resolve to a Commit that exists in the
current Git repository and differs from the current version. Research policy requires even
a Conditional Go to provide an unexpired Canary Scope that explicitly lists Repository or
Design Partner targets, but it cannot bypass `field-effect-evidence`. Until future controlled
effect validation is integrated, the current CLI must not be described as capable of Go
simply by supplying all manual documentation.

---

## 13. Implementation sequence

A complete Dashboard is not needed at the start. Make evaluation itself trustworthy first.

### Step one: Before development

- Establish Requirement IDs and acceptance cases for M0-M2.
- Freeze the ReplaySpec, Evidence Ledger, Gate Result, report, and exit-code schemas.
- Define labeling rules for Episode, Correction Key, and Outcome.
- Prepare the first real, sanitized Replays.
- Freeze the Baseline collection method.

### Step two: During development

- Add tests and evaluation events alongside each feature.
- Expand the failure-case library weekly.
- For every user correction, reproduce the original Episode first, then create a minimal
  Replay Case and related negative cases.
- Have evaluation scripts produce machine-readable results.

### Step three: After the MVP is complete

- First verify unprompted retrieval for new tasks and user-visible feedback in the installed
  host. Then verify ordinary correction, automatic extraction, activation of eligible rules,
  and later compliance. Use explicit-rule flows only as diagnostic preflight checks.
- Run `M2-AUTO-001` through `M2-AUTO-008`; check coverage, noise, and the complete
  failure denominator.
- Run the minimum acceptance package.
- Complete manual blind review.
- Run Shadow before entering a limited Canary.
- Wait for the Outcome observation window.
- Make the M1 + M2 Go / No-Go decision.

### Step four: Continuous improvement

- Keep the Final Held-out set fixed; do not casually replace difficult cases.
- Add new failure cases to the Development set without contaminating the final set.
- Compare every strategy change against the current version in paired evaluations.
- Keep complex capabilities without consistent benefits out of the default path.

ProvenLoop could easily mistake increasing system complexity for increasing intelligence.
The acceptance plan requires evidence to justify each addition to that complexity.

### 13.1 Explicitly out of scope for the first round

To keep the shared core from expanding into an evaluation platform, the first M0-M2 round
does not build:

- A Dashboard or general-purpose annotation workbench.
- A complete Agent Sandbox.
- M4-M6-specific evaluation capabilities.
- Complete implementations of all six dataset types.
- An automated Shadow/Canary orchestration platform.
- Metric pages that exist only for display and cannot block release.

These capabilities may later become new Gate Providers, but they must not change the
first-round Spec, Ledger, Report, and Exit Code contracts.

---

## 14. Real failure case: false cross-model consensus

### 14.1 What happened

The system was asked to review a proposal using the consensus protocol. It assigned
different roles to multiple representatives without explicitly assigning different models.
After detecting that Codex and Copilot were available, it did not have them participate,
yet still described the result as "consensus." Only after the user corrected it did the
system acknowledge that the process did not comply with the protocol.

This error shows that:

> Writing a process, detecting tools, and starting representatives do not establish that
> the process was completed.

The error may not fail tests or be caught by CI or a Revert, but it directly damages user trust.

### 14.2 Correction Key

```text
workflow/consensus-review
+ claimed-cross-model-consensus-without-execution-evidence
+ require-diversified-models-and-required-external-participants
+ consensus-or-council-task
```

### 14.3 Capture

Record:

- The declared protocol and version.
- The protocol's required representatives, model diversity, and external participation
  conditions.
- Availability check results.
- Calls actually started and completed successfully.
- requested/resolved provider and model.
- The final completion claim.

### 14.4 Verify

`ClaimExecutionConsistency` is a deterministic Verifier:

```text
If the claim is cross-model consensus:
  Every required representative must have a successful invocation_id
  Model diversity must satisfy the protocol rules
  Required and available external representatives must have actual completion evidence
  Failures or absences must be explicitly disclosed in the conclusion

Otherwise:
  Gate = fail
  Do not use "cross-model consensus" as acceptance or learning evidence
```

This verifies the facts of invocation, not the quality of each model's views. Other Gates
evaluate the quality of the conclusion.

### 14.5 Learn and regress

After the user corrects the error:

1. Classify the failure as `process.false_claim`. This is an evaluation error class, not
   a FeedbackEvent kind.
2. After explicit user confirmation, create User-confirmed Knowledge with a precise Scope,
   or retain the structured correction as a Candidate awaiting verification. Error
   classification alone cannot automatically create Active Knowledge.
3. Add the original case to Development Replay.
4. Create three variants:
   - Multiple roles with the same model: reject the cross-model claim.
   - An external representative detected as available but not invoked: reject the
     completion claim.
   - An external call that failed and was explicitly disclosed: allow degradation to a
     "multi-role review," but do not call it cross-model consensus.
5. If the same Correction Key recurs in a later task of the same type, count it in RCR
   and block release.

The lesson the product needs to learn extends beyond using different models: every critical
completion claim must have actual execution evidence, and failures must lead to an accurate
description of the degraded result.
