# Learning from agent investigation and recovery

Status: implementation contract. Validation results are recorded separately.

Development update (2026-09-11, schema 20): new lessons carry explicit excluded task
contexts separately from in-task conditions. Bounded prior-knowledge comparison lets
the extractor propose equivalent or superseding lessons, with a separate review and
transactional target-digest checks. Fresh independent evidence can renew automatically
expired knowledge; user revocation and deliberate archival remain protected. Reviewed
lessons now have learning and first-use notices. See [FB-009](feedback.md#fb-009-closing-the-gaps-found-by-the-product-review).

Product requirement update (2026-09-11):
[FB-008](feedback.md#fb-008-distillation-quality-noise-and-missed-learning) requires
instruction-quality distillation of experience, with both noise and missed valuable
learning evaluated. The finding/reference implementation below is an intermediate
capability; preserved excerpts alone do not meet the
[final output standard](product-design.md#45-distillation-is-the-product). This update
records the target without changing the implemented evidence or delivery rules.

Language policy (2026-09-11): extractor v10 writes new lesson prose and retention
metadata in English, including when the evidence is Chinese. Reviewer v2 checks the
English output and its fidelity to the original meaning, and writes its rationale
in English. Source quotations retain their original language; code, paths, identifiers,
and necessary literal examples remain exact. Existing knowledge is not bulk-translated.
Schema 19 adds optional original-language search phrases bound to the same review:
positive phrases support discovery, while excluded task contexts suppress inappropriate
matches. These phrases are separate index metadata, not non-English lesson prose.

Development implementation (2026-09-11, unreleased schema 18): new untyped lessons
receive a separate model quality review after extraction. The reviewer checks support,
scope, lasting value, actionability, concision, and redundancy within the supplied
batch. Only accepted lessons pass to source and retention checks. The review is bound
to the exact proposal and source digests; it does not establish external verification
or user confirmation. Legacy references keep their existing delivery mode.

Reviewed conventions can separate a lasting constraint from a mixed task message
without requiring words such as "always". Reviewed user and agent references deliver
the concise lesson with complete applicability, keeping quotations in Explain. The
default context budget never truncates the lesson or its conditions. Reviewed English
concept keys also support retrieval of lessons written in Chinese. Source enrichment
invalidates the review and schedules reassessment within the original lifetime and
attempt budget. Full distillation quality and sustained user benefit remain open.

Development update (2026-09-11): research proposals must pass a retention
assessment with exact sources and lasting value. Eligible references return an
explicitly unverified finding and tool excerpts in the same repository/worktree.
A changed commit is reported with the captured and current revisions and a
requirement to recheck the finding. Legacy candidates remain review-only. Known
internal work is excluded by source metadata.

ProvenLoop should retain useful findings from an agent's own research and repeated attempts, even when the user never states a correction. This first slice operates inside one captured task. Cross-task pattern discovery and proactive external research remain part of the later retrospective work.

## Sources and outcomes

| Experience | Required source | Initial outcome |
|---|---|---|
| Research finding | A captured agent summary and the captured tool results it cites | A repository-scoped candidate. Source text or a URL alone does not prove project applicability. |
| Self-directed recovery | Failed operation, native failure, changed retry, successful completion, and an agent summary tied to that sequence | A candidate; only a supported, narrow recovery verifier may activate it. |
| Speculation or unsupported summary | Agent prose without relevant captured external evidence | No persistent experience proposal. |
| Recalled guidance repeated by the agent | Existing guidance or a result already assisted by that rule | No independent support for learning the same rule. |

An agent statement remains model-authored evidence. It never becomes a user quotation, confirmation or permission grant. Research sources retain their captured event IDs, exact quoted spans and any URL/version text actually present in the result. Missing publication or retrieval metadata remains unknown. This feature does not issue extra searches, visit cited URLs or expand tool permissions.

## Extraction and qualification

The source discriminator distinguishes user correction, agent research and agent recovery. Existing user-correction records remain readable. Agent proposals require an exact quotation from a captured agent message and one or more exact quotations from captured tool results in the same bounded context. A summary cannot nominate another session's events or use the internal learner as its author.

Processing starts after a captured agent message and its turn completion or idle
event. A native turn end closes one model iteration, so later tool activity or
a new iteration invalidates an interim summary. The worklist selects the final
settled summary before idle or the next user task; a file capture without idle
uses the last settled turn. It then streams that task's captured events.
Long investigations retain the task
request, final summary, closure, and up to 29 relevant original tool results.
Evidence ranking uses the summary's terms, so an early code read can survive
hundreds of later reads. Selected quotations keep their original event IDs and
digests. Capture omissions are not repaired by inventing source text.

Windows retain at most 32 events. The provider selects bounded excerpts from
those events within 32 KiB and 24,000 characters. Long sampled windows omit
operation starts and cannot qualify recovery rules from an incomplete trace.
The existing incremental queue, inference lease, consent, daily budget and
cancellation rules apply. Multiple summaries in one task do not create
independent evidence. Window revisions and retries keep the original expiry
and attempt budget.

For self-directed recovery, the initial verifiers cover existing MCP invocation constraints and supported repository test-command substitutions. They require the native failed/retried operation identities, complete arguments, matching workspace and version, a causal recovery chain, and a summary after the selected successful result. No user intervention may be silently bridged into a self-directed recovery. Unrelated success, permission refusals, identical retries after an outage, multiple confounded changes, and missing evidence remain unqualified. The summary's explanation is not proof of causality.

A receipt names the actual source role. Qualified guidance is rendered from the
verified predicate, keeping example values and broader model claims out of
operative advice. Research that passes the development source assessment uses
the separate reference mode. Unsupported recovery claims and unassessed research
remain review-only. References do not produce verified-activation notifications.
Counterevidence, scope, deletion, revocation, and review controls apply to all modes.

## Reusing a research finding

No user correction or request to save a document is required. A retained finding
records the conclusion, its future use, conditions or uncertainty, and exact
supporting quotations. Code passages can support a reference without containing
words such as "requires" or "because". This source check does not verify the
extractor's interpretation.

A later related task can receive one research reference, including after the
repository gains a new commit. Delivery requires the same repository and
worktree and known captured/current commit IDs. It labels the summary and
quotations as untrusted research data and requires checking the current sources.
Changed revisions receive a lower rank. Research remains an inferred candidate;
it never becomes a verified instruction through recall.

The default 600-token Context request can receive a compact preview. Shortened
quotations, omitted sources, and omitted conditions are marked, and Explain
provides the full retained summary and provenance. Existing expiry, deletion,
revocation, and source-availability checks still apply. This is selective memory
of reusable findings, not a complete archive of every research transcript.

## Acceptance cases

| ID | Case | Required check |
|---|---|---|
| EXP-01 | Agent reads documentation and summarizes a reusable requirement | Persist a candidate with exact agent/tool quotations; preserve observed source text without inventing metadata. |
| EXP-02 | Agent invents a finding or cites an unseen URL/event | Reject missing, mismatched or untrusted provenance. |
| EXP-03 | Agent repairs an MCP argument itself and then summarizes | Activate only the supported argument predicate; prove a later matching call can retrieve it. |
| EXP-04 | Agent changes a repository test command itself | Native command proof, exact revision and directory remain mandatory. |
| EXP-05 | Several changes or repeated transient failures precede success | Preserve uncertainty; do not certify a unique cause or count retries as independent support. |
| EXP-06 | Summary appears before completion or borrows another task's result | Reject qualification; never fabricate a user correction. |
| EXP-07 | Search result contains instructions to approve or activate knowledge | Treat those instructions as source data; no permission or lifecycle effects. |
| EXP-08 | Agent repeats recalled guidance | Reject circular support and duplicate activation credit. |
| EXP-09 | New session uses a learned recovery rule | Check scope, contract/revision, actual delivery and source explanation separately. |
| EXP-10 | Disable, delete or revoke while extraction is in progress | Stale results and rebuilds cannot restore the rule or its evidence. |
| EXP-11 | Restart, duplicate capture, late evidence or multiple summaries | Durable scheduling, bounded work, original expiry and no duplicate independent support. |
| EXP-12 | Agent merely completes a task or summarizes routine success | Return no proposal when there is no reusable finding grounded in the captured work. |
| EXP-13 | A long investigation cites an early code read | Select original evidence across the closed task, fit the provider budget, persist the finding, and recover it after a database reopen. |
| EXP-14 | A later task runs after a new commit | Return the unverified finding with source/current revisions and required revalidation; preserve scope and deletion checks. |

Run deterministic provenance, state and qualification regressions first. A real provider replay measures whether the model can discover a finding from these sources; substitute outputs prove only the runtime path. Live installed-host reuse and controlled benefit require their own retained evidence.

## Evaluation entry point

```powershell
npm run build
node scripts/evaluate-automatic-learning.mjs prepare --corpus agent --out .provenloop/agent-input
node scripts/evaluate-automatic-learning.mjs run --prepared .provenloop/agent-input --out .provenloop/agent-run --data-root <consented-data-root> --max-requests 12 --max-attempts 1
```

The authored corpus has 12 windows and eight later-task prompts. Reading those prompts does not execute the later tasks. Use [the validation record](agent-experience-validation.md) for measured results and remaining limits.
