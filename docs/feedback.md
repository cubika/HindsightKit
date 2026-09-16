# Product feedback backlog

Feedback collection began on 2026-09-10, followed by an implementation request.
Later entries retain their own dates and status. FB-001 through FB-006 describe
changes included in the 0.15 preview; FB-007 remains unreleased. FB-008 records a
product requirement with an unreleased implementation update below; it is not a
general quality-pass claim.
The dated implementation records distinguish source changes from verified outcomes.

| ID | Collected | Topic | Status | Implementation |
|---|---|---|---|---|
| FB-001 | 2026-09-10 | Conversation learning, evidence, and UI knowledge controls | Implemented with limits | Quoted convention/reference delivery and UI management; semantic verification remains bounded |
| FB-002 | 2026-09-10 | One-time task instructions extracted as reusable experience | Implemented; provider validation pending | Retention checks and regression examples; real host unavailable |
| FB-003 | 2026-09-10 | Episode meaning and ambiguous completion, outcome, and scope labels | Implemented with limits | Activity/closure/source labels; no semantic outcome inference |
| FB-004 | 2026-09-10 | Empty episodes and session-summary prompts shown as work goals | Implemented with limits | Substantive-work and source-role checks; unknown template producer unresolved |
| FB-005 | 2026-09-10 | Duplicate knowledge, incorrect repository scope, and task context stored as repository rules | Implemented with limits | Identity stability, duplicate suggestions, scope correction, and task isolation |
| FB-006 | 2026-09-10 | Captured-event growth, count explanations, and retention controls | Implemented with limits | Growth/storage metrics and reviewed retention cleanup; reported database unavailable |
| FB-007 | 2026-09-11 | Oversized learning input repeated three times | Implemented, unreleased | Select source excerpts, preflight request size, and recover eligible old failures once |
| FB-008 | 2026-09-11 | Distillation quality, noise, and missed valuable learning | Implemented first slice, unreleased; broader quality validation pending | Separate quality review, concise delivery, mixed-message learning, source-change recovery, bilingual discovery, and repository readiness |
| FB-009 | 2026-09-11 | Review found conflicting retained rules, missed learning, wrong task filtering, and invisible automatic reuse | Fixes implemented, unreleased; live validation in progress | Reviewed replacement/renewal, separate task exclusions, prompt-hook independence, and concrete learning/use notices |

FB-002 adds concrete examples and changes the implementation order: establish
useful retention before widening reference delivery. Source accuracy and lasting
value require separate checks.

## Development implementation record

Follow-up implemented on 2026-09-11: `provenloop records clear --confirm` and
Overview's Clear all records form reset all stored activity and derived records
without uninstalling or changing configuration. Schema 16 retains only reset
metadata alongside the schema ledger. Queue replay filtering, stale-handle
invalidation, and a durable pending marker protect the reset across interruption.
The command preserves Copilot's source histories and project files. Detailed
instructions are in [the local viewer guide](local-viewer.md#clear-all-records).

Reset validation: 1,047 unit tests pass with five existing skips. The full
integration run passed 271 of 273 tests before the continuation-evaluation
fixture was updated for explicit task resume; the affected release-gate suite
and deletion/adapter regressions then passed all 77 tests. Reset-specific checks
cover every business table, queue replay, stale handles, pending-state recovery,
linked-path refusal, configuration preservation, and real HTTP/CLI actions.
Browser automation was unavailable on this host; the HTTP tests exercised the
actual reset service against temporary installations.

Canonical schema 15 protects the new persisted proposal, episode, and Branch
Context fields from older readers. Upgrade through the existing maintenance
flow. No user database was migrated or cleaned during this implementation.

- Extraction now requests a retention decision, future-use rationale, target
  scope assessment, exact supporting quotations, and a concept key. Known
  temporary instructions, completed setup edits, short approvals, examples,
  and unsupported cross-repository targets are rejected. Original roles, paths,
  quoted spans, and capture completeness are checked again in code.
- Source-supported conventions return the exact user wording. References return
  captured tool excerpts at the matching worktree and revision. Both remain
  `inferred`; neither fabricates an execution receipt. Reference delivery has
  its own small budget. Old candidates without retention provenance remain
  review-only. Saved candidates now trigger index refresh even without verified
  recovery output.
- Ordinary jobs finish as `evaluated`; only a specific missing recovery artifact
  or contract retains an evidence wait. Existing ordinary waiting jobs are
  settled by the coordinator when processed.
- Episode rebuilding removes empty and known internal work from the projection
  while preserving raw events. Goals have bounded length and source references.
  Last activity and explicit session closure are separate fields.
- Host updates for the same worktree preserve the canonical repository ID.
  Similar rules in the same resolved scope are suggested for review, including
  the reported bilingual model-choice pattern. UI edits can correct the scope
  through a new user-confirmed replacement and preserve the original lineage.
- Branch Context retains the latest task snapshot, source session, and goal
  anchor. New tasks do not inherit the previous task's temporary constraints.
  Cross-session retrieval requires explicit `continuationEpisodeId`; closed
  work is excluded from automatic continuation.
- The local UI supports adoption, content and scope editing, archiving, and
  deletion through the existing control services. Forms check current review
  digests and explicit user intent. GET remains read-only; POST checks origin,
  CSRF, and size. Counterevidence cannot be cleared by an unrelated action.
- Overview shows cumulative counts, one/seven-day ingestion growth, source
  distributions, queue depth, and database size. `capture retention plan`
  proposes old closed sessions; explicit selected-session cleanup uses the
  deletion service and protects references and pending capture. No background
  raw-event deletion is enabled.

### Validation and limits

Validation covers source eligibility, task isolation, UI writes and deletion,
scope correction, episode filtering, and capture retention. `npm run lint` and
`npm run typecheck` pass. The full integration suite passes 273 tests across
26 files. The latest full unit run passed 1,009 tests with five intentional
skips; two existing native plugin-refresh fixtures hit Windows `EPERM` during
directory rename. Their isolated rerun passed all 52 tests. Later targeted
source-delivery, UI, duplicate, and retention tests also pass.

`npm run package:verify` passes, including a temporary installed CLI upgrade and
the viewer/CSS/shutdown checks. It required a workspace npm cache and native
Windows process inspection outside the sandbox; the initial sandbox run failed
at that inspection. Browser accessibility inspection also verified the overview
and knowledge-edit forms using a temporary synthetic database.

The actual-provider experiment prepared six synthetic cases and attempted the
production provider once. It returned `unavailable` before producing output;
the current environment could not resolve the Copilot executable. No real-model
quality pass is claimed. The local report is under
`.provenloop/feedback-validation/provider/report.json`; it contains no captured
user history.

Remaining scope is explicit:

- The retention rules are conservative and do not establish general semantic
  entailment. Source references return original excerpts, not model-expanded
  claims as verified facts. Real-provider precision and recall need validation
  on a host where Copilot can run.
- Historical repository aliases are not guessed or bulk-merged. A shared
  captured session/worktree/branch/revision can support duplicate-review
  suggestions across alias strings, but does not automatically merge them. Scope
  correction is available through review; an unresolved cross-repository target
  is excluded from automatic retention.
- Episode segmentation still associates sessions; it does not split every
  multi-goal session. One latest Branch Context snapshot is retained per branch,
  so explicit episode continuation retrieves that snapshot, not every historic
  task state.
- The unknown session-summary producer and the user's 30,000-event database
  were not available for source-specific diagnosis. New metrics and origin
  checks make those cases inspectable on the installed host.
- Cleanup estimates serialized event bytes. Logical deletion does not promise
  immediate SQLite file shrinkage. Existing candidate cleanup remains an
  explicit user action; the implementation does not bulk-promote old records.

## FB-001: Conversation learning, evidence, and UI knowledge controls

### User feedback

The following summarizes the feedback from the 2026-09-10 conversation:

- Retain user statements that have lasting value. Temporary instructions and
  low-value content should not become persistent knowledge.
- Some findings have already been checked through code search, source inspection,
  or other tools during the conversation. Preserve those findings with the
  evidence that supports them.
- Allow users to edit knowledge, delete it, and change its usage state in the UI.
- Collect this feedback and its proposed solution now; implement the fixes
  together after feedback collection.

### Current behavior and impact

Automatic extraction can retain conversation-derived rules and research findings
as candidates. Automatic qualification currently recognizes narrow MCP argument
recoveries and supported repository test-command substitutions. A useful finding
outside those verifiers can remain a candidate even when its source is available.

The coordinator sets a job to `waiting_evidence` whenever at least one proposal
lacks a recovery receipt. Unqualified candidates are excluded from ordinary
retrieval. The current default expires them after 30 days from window creation;
background maintenance archives the expired job and its remaining candidates.
Users can therefore see extracted experience that never helps a later task.

The local viewer currently uses a read-only database connection. Manual
confirmation, replacement, and deletion are available through existing controls,
but the viewer has no editing workflow.

Implementation references:

- [Job scheduling and result handling](../packages/host/src/learning-coordinator.ts)
- [Proposal validation and candidate construction](../packages/domain/src/automatic-learning.ts)
- [Shell recovery verification](../packages/domain/src/shell-learning.ts)
- [Knowledge admission](../packages/domain/src/knowledge-admission-policy.ts)
- [Retrieval eligibility](../packages/retrieval/src/retriever.ts) and
  [learning applicability](../packages/retrieval/src/learning-applicability.ts)
- [Current viewer behavior](local-viewer.md) and
  [manual knowledge controls](../packages/host/src/knowledge-control-service.ts)

### Proposed behavior

Separate a record's lifecycle, source, evidence, and permitted use. The following
categories describe the intended behavior; final schema names remain open.

| Content | Retention decision | Evidence and later use |
|---|---|---|
| Explicit, lasting user convention | Retain when its scope and future value are clear and it adds to existing project instructions | Preserve the user's exact words; apply within that scope as a stated convention |
| Temporary instruction, casual remark, or generic advice | Produce no persistent knowledge | Keep existing event-retention behavior; do not create a knowledge item merely because capture occurred |
| Finding directly supported by captured code or documentation | Retain when it adds useful future context; preserve the precise supported claim and its version | Reuse within the checked scope, with the source and limits visible |
| Useful experience with sources but incomplete validation | Retain as an experience reference when its future value is clear | Retrieve as a lead to check, with its uncertainty visible |
| Recovery with a valid execution receipt | Retain the verified rule | Continue using the existing rules for operative guidance |
| Unsupported speculation or an ambiguous inference | Discard, or hold for review if clarification would make it useful | Exclude from automatic guidance |

#### Retention and lasting value

Judge whether an item would change a decision in a future task, whether it is
specific to the project or workflow, and whether its scope is known. A clear
lasting convention can be useful after one statement; repetition is not required.
Distinguish a project convention such as "Write repository documentation in
English" from a task instruction such as "Write this reply in English." These
are illustrative examples.

Keep original wording and conditions for user conventions. A model's expanded
paraphrase must not acquire a `user_confirmed` mark. Quoted text, hypothetical
examples, and tool output must retain their actual source roles. If duration or
scope is unclear, retain a review candidate only when it has plausible future
value. Merge duplicates without treating repeated summaries as independent
support.

Review expiration by content type and evidence freshness. Useful conventions and
checked findings should not inherit a deadline solely because no recovery receipt
exists. Version changes can make a finding need review. Low-value candidates can
still expire; exact retention defaults remain a design decision.

#### Evidence already present in the conversation

Use captured searches, source reads, documentation excerpts, and test results
before requesting another verification step. Retain the tool event, exact
supporting excerpt, repository/worktree, file location or URL, and the revision
or version actually available. Missing metadata stays unknown.

Verify claims at the level the source supports. For example, a captured source
read can establish that a particular implementation uses a 30-day default at the
recorded revision. A search match alone does not establish runtime behavior,
performance, or correctness. Broader conclusions stay references until supported
by suitable evidence. Record why a claim qualifies and what remains unchecked.

Add validation paths for source inspection and documentation where those sources
can establish the claim. Model confidence and a summary saying "verified" are
insufficient. Existing recovery receipts retain their current meaning.

#### Retrieval and job states

Provide separate delivery modes for user conventions, experience references, and
verified guidance. References should carry their source and limitations in the
Context result and be selected by project scope and task relevance, within a
small separate budget. They can guide inspection; retrieval or repetition cannot
turn them into new proof or expand permission.

Finish an extraction job as `evaluated` when analysis is complete, including when
the result is a reference or review candidate. Reserve `waiting_evidence` for
work with a specific pending check or missing artifact that the system can
reassess. Show the reason and next step. A mixed job should expose the disposition
of each proposal. Background polling must not manufacture evidence.

The UI should distinguish "Reference available," "Needs review," "Awaiting tool
result," and "Verified" without implying that elapsed time establishes a claim.

#### UI knowledge controls

Show the original source, extracted content, applicability, evidence, and reason
for the current state together. Provide actions to edit content and scope, adopt
a reference or convention, disable or archive an item, reassess it, and delete it.
Users should be able to filter records needing review without being interrupted
for every candidate.

Route mutations through the existing knowledge control and deletion services,
with current-record checks and an audit trail. A user edit or adoption remains a
user action; it cannot label a rewritten claim as externally verified. Evidence
that no longer supports edited text must be reassessed. Preserve source lineage
and the distinction between disabling a rule and deleting it.

Revocation, unresolved counterevidence, scope boundaries, and source deletion
apply to every delivery mode. Stale UI actions, in-flight extraction, replay, and
index rebuilds must not restore deleted or revoked knowledge.

### Implementation outline for the consolidated fix

1. Apply the retention criteria and negative examples in [FB-002](#fb-002-one-time-task-instructions-extracted-as-reusable-experience).
   Define separate source, evidence, lifecycle, and usage fields in contracts
   and extraction output. Specify how existing candidates migrate without
   receiving unsupported evidence labels.
2. Add checks for claims supported by code or documentation and record their
   scope, versions, and limits. Reuse already captured evidence.
3. Update admission, retrieval eligibility, learning applicability, Context
   serialization, and storage transitions together. Current learning admission
   requires a recovery receipt, and applicability requires a matching MCP or
   shell invocation; changing `candidate` to `active` alone cannot enable reuse.
4. Separate job completion from knowledge qualification and display actionable
   reasons for proposals that remain pending.
5. Add UI actions using the existing control services and deletion behavior,
   then update product and viewer documentation to match the implemented policy.

This proposal changes the delivery policy in
[Product design](product-design.md) and
[Agent experience learning](agent-experience-learning.md). Reconcile those
contracts during the consolidated fix. This entry records proposed work and
does not change the current implementation or release claims.

### Acceptance checks for implementation

- A clear lasting user convention is available in a later matching task with its
  original scope. A temporary instruction, quoted example, or generic remark
  produces no persistent knowledge.
- A narrow finding supported by a captured source read retains its excerpt and
  revision and can be reused without requiring an unrelated command failure.
  A changed source or unsupported broader claim cannot retain that qualification.
- Useful references reach a relevant later task with their uncertainty intact.
  Irrelevant references, unsupported claims presented as facts, and recalled
  text reused as independent evidence are rejected.
- Extraction jobs complete for ordinary experience. Each remaining evidence wait
  names a missing check or artifact; retries preserve attempt and retention rules.
- UI edits, adoption, state changes, and deletion persist across restart and
  projection rebuild. Stale edits and attempts to fabricate verification fail.
- Existing recovery verification, scope checks, counterevidence, and deletion
  regressions still pass. Evaluate reuse on later tasks that were not the source
  of extraction, including temporary-instruction and false-learning cases.

### Details to settle after feedback collection

- The threshold for useful retention and the treatment of ambiguous duration.
- Initial source-verification coverage and the limits of reference delivery.
- Version invalidation, review intervals, and retention defaults by content type.
- Final UI state names and the migration of existing candidates and waiting jobs.

## FB-002: One-time task instructions extracted as reusable experience

### Reported examples

The user supplied the following proposals and their task context on 2026-09-10.
Descriptions below are English paraphrases of the supplied examples; identifiers
and model names are preserved. All four displayed proposals were labeled
`user_correction` and `candidate`. Full session traces and the resulting code or
configuration were not inspected for this feedback entry.

| Case | Supplied instruction and extracted proposal | User's context | Expected learning decision |
|---|---|---|---|
| 1 | Change the default model to `gpt6`; proposal says to set the GitHub Copilot CLI default to `gpt6` for `DefaultCollection/O365 Core/DirExchangeMgmtApi` | The configuration change takes effect once Copilot performs it | No knowledge item for the completed setting change; use current configuration as the source of truth |
| 2 | Make the requested edits without committing; proposal applies that instruction to the current documentation task in `C:\repos\DirExchangeMgmtApi` | The restriction applied only to that session's changes | No persistent rule or reference; keep the instruction limited to that task |
| 3a | A short approval to delete something becomes a rule to omit explicit `postComments = true` and keep only necessary `[review.default]` configuration | A local cleanup while onboarding agency review | No reusable rule from the approval alone; resolve its referent and recognize the completed edit |
| 3b | Remove the `SDM` qualifier from agency review naming because the feature is shared by the repository; proposal restates that naming instruction | A specific naming cleanup during the same onboarding work | No separate experience item for the completed rename without additional evidence of lasting value |

The user reports that these proposals have little value for later work. This is
a qualitative report about the supplied examples; the overall extraction error
rate has not been measured.

### Problem

These proposals restate requested edits and task restrictions as knowledge.
Adding a repository name or imperative wording does not establish a future use.
Case 2 even retains the words "current documentation-editing task," which should
prevent promotion into a rule for later sessions.

The `user_correction` label also needs review: a setup request, an approval, or a
scope clarification does not necessarily describe an error or a lesson. In case
3a, the brief deletion approval cannot independently establish either the
`postComments` default or the broader configuration rule. The preceding proposal
and relevant source inspection would be needed to support those claims.

Cases 1 and 3 already have a durable result in configuration or code according to
the user. Repeating that result in memory can add no decision value and can become
stale after later edits. Even a fully verified statement can be unnecessary to
retain. Filtering only at retrieval time would leave the candidate list noisy.

### Proposed retention check

Assess value before creating a persistent knowledge candidate, including one
intended only for reference. Use the surrounding task and available completion
evidence to distinguish an instruction, its execution, and a reusable finding.
For an incomplete task, postpone a decision that depends on its outcome rather
than assuming the requested change happened.

For each proposed item, establish:

- A concrete later situation in which the information changes a decision.
- The lesson, constraint, or rationale that would still help after the current
  edit is complete. A restatement of the requested end state is insufficient.
- Whether current configuration, code, or project instructions already provide
  the same information. Prefer that source; link provenance when useful instead
  of creating a second authoritative copy.
- Evidence for the proposed scope and duration. Repository prefixes, model
  confidence, and the fact that a user said it do not establish persistence.

If these checks do not establish useful retention, return `no_rule`. Record a
bounded reason such as temporary instruction, completed edit, redundant stored
state, insufficient context, or no future use. Do not create review work for every
rejected item. Proposed reason names remain an implementation detail.

Resolve brief replies against their actual antecedent. A reply equivalent to
"yes, delete it" authorizes the referenced change; it does not approve a
generalized knowledge rule. Inspect the actual configuration target before
assigning scope, since the active repository does not establish ownership of a
CLI setting.

Abstraction must add a supported lesson. Removing concrete nouns or rewriting
these examples as generic advice about simple configuration or clear naming
would still produce low-value content. Preserve reusable causes, constraints,
or decision rationale only when the conversation and sources establish them.
An implemented fix can contain such a lesson, but its completion alone does not
establish one.

### Changes to the consolidated plan

Evaluate extraction quality before enabling the broader reference path in
FB-001. Its proposed reference mode should contain useful experience that passed
retention checks. It should not expose all existing candidates to later tasks.

Reassess existing candidates under the revised criteria. Plan a reviewable
classification and cleanup through the UI controls in FB-001, with reasons for
keeping, archiving, or deleting items. Do not promote the current backlog as part
of a schema migration. No stored knowledge is changed by this feedback entry.

### Acceptance checks for implementation

- Cases 1, 2, 3a, and 3b produce no persistent knowledge proposal from the supplied
  task context. They neither enter reference delivery nor request confirmation.
- The model-setting change is not learned as a permanent preference, and the
  session-specific commit restriction does not affect later sessions.
- A short approval is resolved to the original change; missing context cannot
  produce an invented default, causal claim, or repository-wide convention.
- Adding repository names or generic advice does not make a rejected instruction
  pass the value check. Successful execution alone does not establish usefulness.
- Positive controls still retain useful new conventions, supported recurring
  failure causes, and findings that materially reduce future investigation.
  Include cases where implementing a fix leaves a useful rationale to preserve.
- Replays evaluate the provider's actual extraction output with task context,
  rather than supplying a hand-authored proposal. Measure false retention of
  temporary instructions, redundancy with stored state, retained-item usefulness,
  and missed useful lessons. Track precision alongside recall; candidate count
  and model confidence are not success measures.

Keep this entry open for more examples. Test fixtures, corpus cleanup, and code
changes belong to the consolidated implementation batch.

## FB-003: Episode meaning and ambiguous completion, outcome, and scope labels

### Reported example

The user asked whether an episode with the following details represents a
reasonable unit of work. The goal below is an English paraphrase of the supplied
prompt; identifiers and metadata values are preserved. Only the displayed
metadata was provided. The source events and actual outcome were not inspected.

| Field | Displayed value |
|---|---|
| Goal | Can I log into the NPE tenant to inspect the managed identity associated with `devSpce`, and how? |
| Started | `2026-09-10T05:44:18.821Z` |
| Finished | `2026-09-10T06:02:42.248Z` |
| Outcome | `unknown` |
| Qualification | `open` |
| Repository | `Unknown` |

### Assessment and current behavior

An investigation can form an episode without a code change. This example is a
plausible investigation goal if its source events show related inspection,
research, attempts, or a substantive answer. The title and elapsed time alone
do not establish the episode's quality, boundaries, or completion. A trivial
exchange need not become a separate episode.

The [episode builder](../packages/domain/src/episode-builder.ts) currently groups
captured sessions and uses the first available user prompt as the goal. It assigns
`finishedAt` from the last captured event. That timestamp establishes the last
observed activity, not that the user's goal was achieved. Its outcome calculation
returns `unknown` / `open` when there is no recognized verification or revert
result. These values alone cannot distinguish an unanswered question from a
completed investigation whose result the current outcome rules do not recognize.

The [episode detail page](../packages/cli/src/ui-page.ts) displays `finishedAt` as
"Finished" and absent repository identity as "Unknown." A tenant-access
investigation may legitimately have no repository, or repository capture may be
incomplete. The supplied metadata cannot determine which explanation applies.

### Proposed changes

- Use a concise work goal while retaining the original prompt as a source. A
  possible title for this example is "Investigate NPE tenant access for inspecting
  the managed identity associated with devSpce." This is a proposed title, not
  a claim that inspection occurred.
- Identify meaningful investigation work from its events and findings. Keep
  episode boundaries aligned with the work goal, including when a session has
  several unrelated goals.
- Separate last observed activity from explicit task closure. Display "Last
  activity" for the former, and reserve "Finished" for supported closure.
- Show a source-linked result when available, such as instructions established,
  access blocked, or a question still unresolved. Distinguish that result from
  the strength of its verification; do not infer successful login from an answer.
- Distinguish confirmed work outside a repository from missing repository
  identity. Preserve known tenant or environment context without inventing scope
  or converting unknown scope into personal knowledge.

### Acceptance checks for implementation

- The supplied metadata does not produce a fabricated login result, permission
  diagnosis, or completion claim. Source events determine the summary.
- A substantive investigation with no edits can have a useful episode summary;
  an isolated low-information question does not require its own episode.
- A final captured event does not mark the task complete. A completed explanatory
  answer and an unresolved investigation can be distinguished when their source
  evidence supports the distinction.
- Scope labels distinguish a known non-repository task from missing capture.
- An episode can be useful without producing any persistent knowledge. Apply
  the retention criteria in FB-002 independently.

Keep the actual episode unchanged during feedback collection. Reassess this
example against its full event history when implementing the consolidated fix.

## FB-004: Empty episodes and session-summary prompts shown as work goals

### Reported examples

The user supplied two further episode examples on 2026-09-10.

| Field | Example 1 |
|---|---|
| Goal | `Work in C:\repos\DirExchangeMgmtApi\.git` |
| Started | `2026-09-07T09:17:10.069Z` |
| Finished | `2026-09-07T09:17:10.069Z` |
| Outcome | `unknown` |
| Qualification | `open` |
| Repository | `C:\repos\DirExchangeMgmtApi\.git` |

The second example displays a long session-analysis prompt as the goal. The
following excerpts are copied from the user's report:

> Session File Path: 'C:\Users\bili1\.copilot\session-state\f3dee075-7ad6-4285-afb2-296c7ae79431\events.jsonl'

> Read the session file at the path above and analyze its content to summarize what the session was about.

> Ignore session lifecycle and plumbing events such as session start, resume, and shutdown, model or reasoning-effort changes, and MCP connection warnings; these describe the runtime, not what the session was about.

The user reports that the goal continues at length and contains a truncation
indicator. The file path is a reference inside the reported prompt; it does not
identify the session that generated that prompt. The referenced session file was
not opened for this investigation.

### Confirmed behavior and remaining unknowns

The first example matches the builder's fallback when no nonempty
`prompt.submitted` text is available: `Work in <repoId or sessionId>`. The
[episode builder](../packages/domain/src/episode-builder.ts) creates a cluster for
each captured session without first requiring substantive work. Matching start
and finish timestamps are consistent with a single event or several events at
the same time; they do not prove either case. Source events are needed to
determine whether this record contains only lifecycle activity.

The `.git` suffix is explainable without assuming a repository-detection failure.
The [Copilot adapter](../packages/copilot-adapter/src/copilot-cli-adapter.ts) uses
the Git common directory as its canonical repository ID when available. The UI
is displaying that internal identity as the repository and using it in a
fallback goal. The canonical identity can remain useful while the UI displays a
repository name and worktree path.

The second example exposes a confirmed gap in goal selection. The
[event mapper](../packages/copilot-adapter/src/event-mapper.ts) distinguishes
user messages from system continuations and agent messages through `trust` and
`actorId`. All can still have the event type `prompt.submitted`. The episode
builder selects the first such event with text, without checking its source
role, and copies the full text into `goal`. A system or model message can
therefore become the displayed work goal.

Existing internal-session exclusions recognize ProvenLoop's environment marker
and registered internal session IDs in
[extension startup](../packages/copilot-adapter/src/start-extension.ts) and
[reconciliation](../packages/copilot-adapter/src/capture-reconciler.ts). They do
not establish that every host-generated summary session is excluded.

The quoted template was not found by exact-phrase searches in the repository or
the installed Copilot `1.0.84-1` `app.js` and `index.js`. Its text suggests a
session-summary workflow, but its producer, actual source role, and capture path
remain unconfirmed. The layer responsible for truncation also remains unknown.
The supplied examples were not replayed against their full event histories.

### Proposed changes

- Require a substantive goal, investigation, action, or finding before creating
  a user-facing episode. Keep lifecycle-only records in Activity or diagnostics.
  A missing prompt alone must not discard useful work captured through other
  events; duration and event count alone are insufficient quality checks.
- Identify session purpose and message origin. Exclude known internal summaries,
  probes, and maintenance work from user-work episodes and derived learning.
  Retain relevant tool and agent evidence within legitimate user work.
- Select or summarize the actual user goal with source references. Do not treat
  a system continuation as user intent, or hide the problem by merely truncating
  an internal prompt. A genuine user request to summarize a session remains
  eligible; template wording alone must not trigger exclusion.
- Display a concise goal and keep the original prompt in source details. Make
  capture truncation visible separately from title shortening.
- Show a repository name or worktree path in the UI while preserving canonical
  repository IDs for identity checks and associations.
- Reassess existing episode projections after the filtering rules change, with
  an inspectable reason for exclusion. Keep raw-event retention and deletion
  policies separate from episode filtering.

### Acceptance checks for implementation

- Lifecycle-only capture produces no work episode, including the case with
  identical start and finish timestamps and a fallback goal. Brief substantive
  work remains eligible.
- A system or model `prompt.submitted` cannot supply the user's goal merely
  because it is the first message. Source roles survive capture and replay.
- Known internal summary sessions produce neither user-work episodes nor
  reusable experience. Legitimate user-requested analysis is still represented.
- A long real user request produces a concise, traceable goal. A truncated source
  cannot be presented as a complete original request.
- The repository display does not expose a Git common-directory ID as a task
  description; repository associations continue to use verified identity.
- Rebuilding projections excludes existing noise without resurrecting deleted
  data or losing substantive work. Measure episode usefulness alongside capture
  coverage rather than treating every session as a successful episode.

Verify the producer and event provenance of example 2 during the consolidated
fix. This entry records source inspection and user-reported examples only;
runtime behavior and stored episodes remain unchanged.

## FB-005: Duplicate knowledge, incorrect repository scope, and task context stored as repository rules

### Reported examples

The user supplied these examples on 2026-09-10 and reported that all are
`candidate` / `inferred`. English descriptions below paraphrase the reported
content. Record IDs preserve the lookup references without retaining temporary
viewer URLs. The three supplied local links were inaccessible during this
investigation, so their stored source events and capture history were not read.

| Case | Supplied records and behavior | Expected treatment |
|---|---|---|
| 1 | `learning-knowledge-a4215f95baf89eb9b3839543` says to use GPT-5.6 instead of GPT-5.4 for code review, in English, under `C:\repos\DirExchangeMgmtApi\.git`. `learning-knowledge-4e0a8540783bb6a7225cdaf9` states the same rule in Chinese under `DefaultCollection/O365 Core/DirExchangeMgmtApi`. | If the sources establish the same repository, scope, and lasting intent, represent one rule with both source references. First apply FB-002 to determine whether either item should be retained. |
| 2 | `learning-knowledge-e52ea8133852b1adc7f31502` limits internally derived fields to uniqueness checks. The session started in `DirGenericMgmtApi`, but the user explicitly requested changes to another repository. The rule was stored under `C:\repos\DirGenericMgmtApi\.git`. | Resolve applicability from the actual requested and observed target. Keep the source session's repository distinct from the repository the rule concerns. |
| 3 | A rule under `DirGenericMgmtApi` says that an SDMC development EV2 investigation concerns `sdmc-dev-ev2-deployment`, not `sdmc-dev-msi`. It was created at `2026-09-10T05:53:07.067Z`, has no validation timestamp, and expires at `2026-10-10T05:53:07.067Z`. | Treat the resource selection as context for that investigation. Retain it only if needed to resume the work, and do not apply it to unrelated tasks. |

The user asks why duplicates form, whether temporary knowledge belongs to a
task or branch, and how candidates become usable. The report adds scope and
identity failures to the extraction-quality problems in FB-002. It does not
authorize merging, deleting, reassigning, or activating these stored records
during feedback collection.

### Confirmed implementation behavior

For ordinary proposals without a typed recovery predicate, the
[learning coordinator](../packages/host/src/learning-coordinator.ts) derives
`knowledgeId` from `window.repoId`, the generated rule text, and its trigger.
Changing the language or wording changes that hash; a different repository ID
also changes it. The [store](../packages/storage-sqlite/src/canonical-store.ts)
checks for an existing identical knowledge ID and does not perform semantic
deduplication in this insertion path. These mechanics explain how the reported
pair can coexist. Their individual capture paths remain unverified.
Repository identity also has two inputs: the adapter can use the Git common
directory, while host context events can provide `context.repository` directly.
These representations need verified reconciliation.

The [candidate constructor](../packages/domain/src/automatic-learning.ts) always
sets `scope` to `repository` and `scopeId` to the learning window's repository.
The [proposal contract](../packages/contracts/src/learning.ts) has no target
repository or task-lifetime field. A repository mentioned in the model's prose
does not change the stored scope. This can misassign a cross-repository task to
the repository where its session was captured. The binding follows the captured
workspace, which can change through host context events; it is not invariably
the session's initial directory.

The [event mapper](../packages/copilot-adapter/src/event-mapper.ts) retains
execution-directory and target-path evidence. Its current verification path
rejects commands outside the bound workspace rather than transferring their
proof to another repository. Preserve that check until the actual target can be
bound explicitly; weakening it would create false verification.

The repository already has a [Branch Context contract](../packages/contracts/src/branch-context.ts)
for goals, explicit constraints, accepted decisions, and unfinished work.
Branch-scoped knowledge matching also exists in
[retrieval types](../packages/retrieval/src/types.ts). Automatic learning does not
currently select either path for a temporary proposal. A fixed 30-day expiry
does not provide task isolation.

### Proposed changes

#### Repository identity and duplicate detection

Resolve verified aliases to a canonical repository identity before comparing
rules. A Git common-directory path and a hosted repository name may identify
the same repository, but matching a short name is insufficient evidence. Use
captured Git/worktree and remote identity, and retain the alias mapping's source.
Do not merge unrelated repositories with similar names.

Within a resolved scope, compare the meaning, trigger, exclusions, intended
lifetime, and versions of potential duplicates across languages. Model similarity
can nominate a pair for comparison; it cannot override different conditions or
counterevidence. Preserve the original source texts and controls when merging.
Repeated capture of one instruction is not independent support. A later model
preference may supersede an earlier one only when its source supports that change.

#### Source repository and target repository

Record where the conversation happened separately from what the knowledge
applies to. Establish the target using explicit user intent plus actual file
paths, tool working directories, and resolved repository/worktree identity where
available. A prose mention of another project can be a comparison or an example
and must not silently reassign scope.

When the target cannot be established, mark scope unresolved and exclude the
item from repository guidance. Split a task involving several repositories
into appropriately scoped findings. UI scope corrections must show the affected
rule and its source, preserve lineage, and recheck evidence that depends on the
previous repository.
Update admission with the same target-binding model. Current learning admission
requires every source event's repository to match the candidate scope, so merely
editing `scopeId` cannot make a cross-repository proof valid. Keep the original
conversation source and validate the relevant target operations explicitly.

#### Task context and lasting knowledge

Store a temporary target selection or one-time constraint only when it helps
resume unfinished work. Bind it to the actual task or episode, with branch and
worktree context when known. A branch name alone is insufficient because a branch
can be reused for unrelated work. Explicit continuation should recover the
context; unrelated tasks should not receive it.

End its automatic applicability when the task closes or is superseded. Retained
history may remain inspectable under the existing retention policy. A completed
task with no useful continuity state should produce no separate memory item.
Promoting an item to a lasting convention or lesson requires a new retention
decision, correct scope, and suitable evidence. For case 3, selecting one resource
does not establish a permanent rule to avoid the other resource.

#### Candidate visibility and actual use

The current Knowledge page lists stored records, including candidates. Display
eligibility and the reason for exclusion separately from storage state. Provide
distinct views or filters for usable knowledge, task context, and items needing
review. Do not imply that every record on the Knowledge page is delivered to an
agent.

Current automatic promotion needs a supported recovery receipt and passing
admission checks; it yields `active` / `externally_verified`. Explicit adoption
through knowledge controls creates an `active` / `user_confirmed` rule with its
own lineage. Neither path makes an incorrectly scoped or temporary rule useful.
Elapsed time, translation, duplication, or changing the state label cannot
establish verification.

Apply the proposed FB-001 reference, convention, and source-validation paths
after retention and scope checks. Task context is usable only for its work item;
references remain labeled as references. Keep existing verification, deletion,
and counterevidence checks for every path.

### Acceptance checks for implementation

- Equivalent Chinese and English rules in a verified common repository scope
  are suggested for consolidation and do not create duplicate guidance. Rules
  from distinct repositories or with different conditions remain separate.
- Repository aliases resolve using retained identity evidence. Rebuilds and
  migration preserve deletion, revocation, provenance, and counterevidence.
- A session launched in repository A that works on repository B does not create
  B's rule under A. Unresolved targets remain visibly unresolved; multi-repository
  findings keep their separate applicability.
- The resource selection in case 3 is available when explicitly continuing that
  investigation, if still needed, and absent from unrelated tasks in the same
  repository or branch. Closed work does not retain an operative restriction.
- Temporary instructions and redundant completed edits still produce `no_rule`
  under FB-002. Giving them a short expiry does not bypass retention checks.
- Candidates remain excluded from ordinary guidance until a valid use path
  applies. UI adoption and scope edits do not fabricate external evidence.
- The UI exposes why an item is stored, where it applies, whether it will be
  returned, and how the user can edit, adopt, archive, or delete it.

Investigate the original source events and identity aliases for the reported
records during the consolidated fix. This entry changes the backlog only.

## FB-006: Captured-event growth, count explanations, and retention controls

### User report

After one or two days of use, the user reports more than 30,000 Captured events
and asks whether this volume is expected. The reported database's growth rate,
event distribution, and size have not been measured. A high cumulative count
alone does not establish either healthy capture or a duplication defect.

### Confirmed behavior

The [viewer summary](../packages/storage-sqlite/src/inspection-reader.ts) counts
all rows in `raw_events`. This is a cumulative stored-event count, including
supported and unsupported records, not the number of user messages, knowledge
items, events from the last two days, or items waiting for processing.

The [event mapper](../packages/copilot-adapter/src/event-mapper.ts) records tool
starts and completions separately, alongside agent messages, turn boundaries,
and session activity. A completion may also produce a verification event or
file-change event. A single user request can therefore account for many records.
Message and reasoning deltas, streaming deltas, and partial tool progress are
intentionally ignored; the count is not one record per output token.

The [capture identity](../packages/domain/src/capture.ts) includes adapter,
adapter version, event type, session ID, and source event ID. An identical-key
redelivery updates `delivery_count` in the
[canonical store](../packages/storage-sqlite/src/canonical-store.ts) rather than
adding another row. Version changes can change that identity, so an audit should
check for repeated source events across versions without assuming that ordinary
retry delivery increases the displayed count.

No automatic raw-event age limit or total storage cap was found in the current
implementation. The [capture queue](../packages/platform-windows/src/capture-queue.ts)
defaults to removing acknowledged queue files after seven days. This does not
delete canonical event rows. Candidate and Branch Context expiry likewise does
not reclaim the underlying raw-event storage. Queue pressure limits and worker
batch sizes are separate from cumulative storage volume.

### Scope of the local check

A read-only aggregate query of this machine's default ProvenLoop data root found
6,650 events across four sessions, with the latest event on 2026-09-08 and a
database file of 31,330,304 bytes. It contained none of the three record IDs
reported in FB-005, so it does not match the dataset under discussion and cannot
explain the user's 30,000-event count. No event bodies were read and no database
records were changed.

### Proposed investigation and changes

- Verify the viewer's selected data location before diagnosing the reported
  count. Measure event-time and ingestion-time ranges separately, so historical
  reconciliation is visible alongside new activity.
- Show cumulative events, recent additions, distinct sessions, database and
  queue sizes, and pending/retry/dead-letter counts as separate metrics. Provide
  breakdowns by event type, source role, session, and capture version.
- Check repeated native events across ingestion paths or versions, unusually
  chatty sessions, and internal summary or maintenance traffic. Reuse the source
  filtering investigation in FB-004. Legitimate derived events should remain
  distinguishable from duplicate delivery.
- Define a configurable raw-event retention and storage policy. Treat necessary
  proof references separately from disposable runtime telemetry; do not prune
  parent events or source spans needed by retained knowledge without handling
  the affected records' validity. Report logical retention separately from
  physical disk reclamation. Exact defaults remain open.
- Preserve adequate raw evidence while applying the stricter Episode and
  Knowledge value checks from the earlier feedback. Event counts do not establish
  learning quality, and a fixed count alone should not trigger deletion.

### Acceptance checks for implementation

- Viewer metrics distinguish cumulative capture from daily growth and processing
  backlog, using the same database the user selected.
- Tool and turn event expansion is explainable. Replaying the same native event
  through supported ingestion paths does not silently inflate canonical counts;
  version-dependent reprocessing has an explicit provenance policy.
- Unchanged or inactive sessions do not cause unexplained sustained growth.
  Internal traffic is classified without discarding legitimate user work.
- Retention tests cover knowledge dependencies, source deletion, replay, and
  projection rebuild. UI storage figures state what has actually been reclaimed.
- Growth and storage checks include real capture workloads. A lower event count
  achieved by losing relevant execution evidence does not pass.

The actual source of the reported 30,000 events remains to be audited against
the matching database during the consolidated fix.

## FB-007: Oversized learning input repeated three times

The user reported a 0.15 job with three attempts and the error
`Learning window exceeds the inference budget.` The provider serialized whole
event bodies and added extraction instructions before checking a 32 KiB UTF-8
and 24,000 UTF-16-unit request limit. The coordinator retried this deterministic
failure as if another provider call could resolve it.

The new extractor creates a separate inference view. It retains the anchor,
user boundaries, and the relevant failed/retried operation chain, and selects
continuous source excerpts from long messages and tool results. Duplicate log
lines and binary-like fields do not consume most of the input. Source offsets,
event IDs, and explicit omission flags make each displayed excerpt traceable.
Selection includes all extraction instructions and JSON escaping in the final
byte and character budget. It does not modify captured events or their digests.

Returned quotations must fit one actually displayed source span. Recovery
proposals cannot reference omitted operations or omitted start arguments.
Existing qualification and retention checks still use the full original window,
including exceptions or contrary evidence outside the selected excerpts.

Preparation runs before attempt and daily-request accounting. Inputs whose
necessary metadata cannot fit become `input_too_large` failures without model
dispatch. The same extractor does not repeat them. A source revision or extractor
change can trigger reassessment. Jobs with the exact 0.15 input-size error may
receive one recovery call when sources remain current, no proposal was created,
and the original expiry and deletion controls permit it. Historical attempt
counts remain intact; the allowance is recorded separately and cannot be renewed
by replaying a window. Schema 17 provides the persisted-format boundary.

Tests cover thousand-line output, Chinese/emoji/escaped JSON, 32-event budgets,
continuous citations, source immutability, MCP and shell proof preservation,
omitted-argument rejection, zero-charge preparation failures, and one-time
legacy recovery. These are deterministic/injected-provider tests, not a new
measurement of model extraction quality.

Validation for this fix passed 90 focused unit tests, all 273 integration tests,
type checking, lint, and packed-runtime installation/upgrade verification. The
full unit run also exercised concurrently changing MCP diagnostics; its two
temporary mock failures passed on the final 18-test rerun. A Windows plugin
fixture rename failure passed on a separate 52-test rerun. This change remains
unreleased and does not modify the existing 0.15 installation.

## FB-008: Distillation quality, noise, and missed learning

### User feedback

The following is an English summary of the user's 2026-09-11 feedback, not a verbatim
quotation:

- Actual use already leaves the user uncertain whether retained experience contains
  noise and whether valuable learning was missed. Both concerns matter at once.
- Extraction should derive a more reusable lesson from the work instead of simply
  retaining original text.
- The experience should feel effortless, with the final collection containing the
  useful substance rather than requiring the user to sort and rewrite it.
- Retained learning should be close to something the user would put in Copilot
  instructions, stored in a structured form. The product's central job is distillation.
- In a follow-up, the user defined the desired experience as an agent that becomes
  noticeably more capable with use. No discernible improvement or worsening behavior
  would fail that expectation, even if the product stores more experience.

### Product interpretation

This refines the earlier investigation-reuse positioning. Fewer repeated investigations
and corrections remain the desired benefit; the product must earn it by selecting and
formulating high-value guidance. Source-preserving reference delivery addressed an
earlier loss of useful material but does not by itself meet this output standard.
The report establishes a user experience problem, not measured noise or miss rates.

The [distillation contract](product-design.md#45-distillation-is-the-product) separates
final lessons from evidence and intermediate candidates. It requires a concise useful
conclusion, supported scope and conditions, and enough rationale to explain future
use. Original quotations remain evidence; rewriting must not invent a cause, broaden
scope, or inherit a user-confirmed authority label. An existing precise convention
can already be suitable without changing its wording.

Instruction quality is a content benchmark. This feedback does not request writing
Copilot instruction files, activating every extracted rule, or deleting existing
history. Routine manual filtering or approving every candidate would shift the
product's work back to the user. Optional inspection and correction remain necessary.

### Acceptance direction

Evaluate retained noise and missed valuable lessons separately using independently
reviewed work samples. Include investigation findings without a user correction,
valuable one-off discoveries, existing-instruction duplicates, and cases with no
worthwhile lesson. Measure abstraction quality, conditions retained, and the amount
of substantive user rewriting required. Distinguish capture omissions, extraction
misses, retention rejection, and later retrieval misses.

The [evaluation plan](product-validation.md#97-distillation-quality-noise-and-missed-learning)
defines these checks. The initial feedback record was a requirement; the development
update below records the implemented subset and its validation limits.

The follow-up adds [improvement over time](product-validation.md#98-improvement-as-experience-accumulates)
as the outcome criterion. Evaluate whether accumulated lessons improve later decisions
and reduce supervision, while recording unchanged results and regressions. This is a
requirement for observable benefit, not evidence that such improvement has occurred.

### Development update: reviewed distillation and usable delivery

The unreleased schema 18 implementation adds a separate bounded model review for new
untyped conventions and references. It assesses each proposed lesson against its
captured sources and full anchor message, including exceptions outside the selected
quotation. Six criteria must pass before retention: supported meaning, correct scope,
lasting value, actionability, concision, and no redundant concept within the batch.
The host binds the assessment to proposal content, source digests, and review metadata.
The extraction model cannot supply its own pre-approved review.

Accepted lessons remain inferred. They do not acquire user confirmation or a recovery
receipt. Existing path, source-role, secret, deletion, and applicability checks still
apply. Both extraction and review consume the shared daily request budget. Each model
request has a 45-second limit; the provider has a 100-second total budget for both
stages. Failed review cannot silently fall back to unreviewed concise guidance.

The changes address several observed implementation gaps:

- A whole-message keyword filter no longer discards an independently reviewed lasting
  requirement merely because another sentence concerns the current task.
- Reviewed conventions and user-origin references deliver their distilled lesson,
  including complete conditions, rather than repeating the whole user message or
  dropping the proposed conclusion. Source excerpts remain available through Explain.
- Source enrichment schedules a fresh review instead of copying a stale assessment
  into an already-finished job. User controls, expiry, and attempt limits survive.
- English concept keys from bound reviews participate in search, allowing an English
  task to discover a Chinese lesson without translating its operative content.
- Automatic hook context includes applicability and scope as well as the lesson.
- Learning details record proposed, accepted, and rejected counts with bounded reasons.
  Installation and the viewer distinguish capture, extraction, and repository reuse
  readiness instead of equating an enabled setting with successful use.

This release candidate does not bulk-rewrite old knowledge, solve general semantic
deduplication, or establish population-level precision, recall, or improvement over
time. Current exact-revision recovery rules retain their existing proof requirements.
No user's installed database was migrated during development.

Actual Copilot provider checks on authored cases retained a documentation convention
and a generated-client workflow, while a temporary setting request produced no lesson.
A separate before/after documentation task changed from Chinese output to English
after receiving the distilled convention. These bounded examples and the runtime
regressions are recorded in [agent experience validation](agent-experience-validation.md#reviewed-distillation-development-check-2026-09-11);
they do not establish broad semantic quality or sustained productivity gains.

### Follow-up: English as the stored lesson language

The user requested one language for distilled experience on 2026-09-11. New lesson
prose, applicability, exclusions, retention explanations, and concept keys now target
English regardless of the input language. The separate reviewer checks this policy
and translation fidelity. Original evidence quotations and executable identifiers
remain unchanged. The language of a lesson does not override a preference within
it, such as communicating with the user in Chinese. Extractor v10 and reviewer v2
identify this behavior; existing records retain their content and provenance.
Schema 19 adds bounded source-language search phrases so Chinese task requests can
still discover English lessons. Excluded contexts remain separate from positive
search terms, and both are checked against quoted sources and the model review.

## FB-009: Closing the gaps found by the product review

The review of dd2811f reproduced failures despite passing regressions: later policy
changes could leave contradictory rules active, changes to exceptions could be ignored,
and renewed evidence could still expire under an old job. Task-internal safeguards
were mistaken for excluded tasks. Unrelated auxiliary reads and an old oversized
failure chain could suppress new learning. A 100 ms tool-metadata timeout could skip
ordinary prompt retrieval. Reviewed lessons did not receive learning notifications.

The unreleased schema 20 changes address those paths:

- Extraction and review receive bounded prior knowledge from the same repository.
  Reviewed equivalence and supersession relations name the exact compared digest.
  Commit rechecks that digest, scope, current evidence state, and user controls.
  Explicitly changed conventions replace their earlier version; independently
  reaffirmed equivalent lessons renew their usefulness window.
- Auto-expiry is recorded separately from deliberate user archival or revocation.
  Fresh independent evidence can restore an automatically expired lesson. Old jobs
  cannot archive a candidate whose evidence has since been renewed. Reset, deletion,
  and backup restore preserve these distinctions.
- A same-concept conflict without an accepted relationship stops use pending review
  instead of silently returning both rules. This bounded comparison does not claim
  exhaustive semantic conflict detection across the whole knowledge base.
- New retrievalScope metadata names whole excluded tasks. Other caveats remain
  conditions within an applicable task. Legacy output receives conservative syntax
  handling, including negated exclusions in English and Chinese. Word-overlap scores
  no longer turn identifier-preservation instructions into a task exclusion.
- Tool metadata is checked only where tool identity is needed. Ordinary prompt
  retrieval continues independently. Installation and session messages explain
  missing hook permission or unsupported versions without granting permission.
- Reviewed lessons receive accurately labeled learning notices; first use displays
  the actual guidance and conditions. Muting affects notices, not eligibility.
- An unrelated, unquoted, explicitly read-only auxiliary operation no longer changes
  the target of a reviewed user convention. External writes, cited external targets,
  and ambiguous shell operations keep their existing restrictions. An incomplete
  old recovery trace does not prevent a separate semantic learning window.
- Long review rationale is sanitized and bounded before storage validation. A
  singleton trigger array copied from comparison input is normalized without
  broadening its condition. Malformed decisions and multi-trigger ambiguity still
  fail. Review input keeps full anchors and cited evidence while removing redundant
  serialization.
- The live two-session check exposed another missed-retrieval path: CJK bigram
  fragments displaced the actual topic words from the bounded search query. Query
  construction now prioritizes segmented words before optional fragments.
- Prior-knowledge comparison uses reviewed source-language topics and scans the
  repository candidates instead of truncating to the latest 128 records. Deleting
  an earlier lesson also follows dependent supersession/equivalence references,
  preserving deletion verification across a chain of replacements.

Extractor v11 and reviewer v3 identify these changes. Source excerpts, model review,
and external verification remain separate. The updated behavior is validated with
regressions and actual-provider cases; full learning quality and sustained improvement
still require observations beyond these examples.
