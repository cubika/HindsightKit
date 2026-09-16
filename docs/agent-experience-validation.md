# Agent experience validation, 2026-09-08

## Reviewed distillation development check, 2026-09-11

This unreleased schema 18 change was checked with the actual Copilot CLI 1.0.84-1
provider on authored inputs, followed by local runtime replay. It adds a separate
model quality review and concise lesson delivery. The host-selected model ID was
not exposed. No live user history was sent and no installed database was upgraded.

| Authored case | Actual provider result | Local later-task replay |
|---|---|---|
| A Chinese message combines a one-time edit/no-commit request with lasting documentation and conversation conventions | Three proposals reviewed; two retained and one rejected for support/scope | An English documentation task received the relevant distilled English-documentation rule in 300 rendered tokens; another repository received none |
| Investigation finds a generated client overwritten by its build step | One concise lesson about editing the schema and regenerating the client, accepted by review | The lesson and full conditions were returned after a changed commit in 432 rendered tokens, requiring source revalidation; another repository received none |
| Change the default model for the present task without committing | No retained proposal | No guidance returned |

A separate authored behavior probe used the same installed host with no tools. For a
Chinese request to write one sentence of repository API documentation, the baseline
returned a Chinese sentence. Supplying the actually distilled lesson and its full
conditions produced an English sentence while preserving the identifier. This shows
a concrete behavioral difference on one task. Context was supplied explicitly by the
probe, so it is not automatic installed-plugin acceptance or a productivity estimate.

Local evidence is under `.provenloop/distillation-validation/`: `inputs.json`,
`report.json`, `replay.json`, and `behavior/report.json`. Earlier attempts remain in
`attempts.jsonl` and the numbered report snapshots. One first request timed out; two
early harness versions invalidated replay by hashing optional undefined fields before
canonical JSON persistence. Those failed replays were not counted as product success.
The final run used the canonical source representation and kept all rejected cases.

The samples were authored, and no independent human quality labels were collected.
The model review is not an independent semantic oracle. The extraction prompt later
received wording clarifications about lasting requirements without keywords and
checking search-alias meaning; these examples support the implemented path, not an
exact-final-prompt quality threshold.
General precision, missed-learning rates, real installed-hook use, and sustained
improvement still require the broader validation plan.

Repository validation passed 1,174 unit tests with five existing skips and all 273
integration tests. The final short-Chinese-rationale adjustment passed a further
76 relevant tests, followed by all six alias tests including an explicit short-Chinese
case. Type checks, lint, and document link/format checks passed.
Packed installation, viewer startup/CSS/shutdown, upgrade, and cleanup checks passed
using temporary data and a fake Copilot host. The first packaging attempts hit the
sandbox npm-cache and Windows process-inspection boundaries; the isolated check passed
with a workspace cache and authorized native process inspection.

## English lesson follow-up, 2026-09-11

Extractor v10 and reviewer v2 were checked on an authored Chinese conversation. The
actual provider returned English lesson text, applicability, exclusions, retention
explanations, and review rationale while preserving the Chinese source quotations.
No original evidence was translated.

A follow-up with original-language search metadata returned an English documentation
lesson for a Chinese documentation task in 290 rendered tokens. That run retained
one proposal and rejected another for support/scope. An earlier attempt rejected
both proposals; those results remain in the local attempt ledger. This confirms a
working path, not consistent quality across all phrasings. The reviewer prompt was
subsequently clarified to distinguish excluded task contexts from conditions within
an otherwise applicable task.

Evidence is under `.provenloop/english-distillation-validation/` and
`.provenloop/english-query-validation/`. The latter diagnostic uses the same provider
with an injected process runner to retain synthetic responses; it does not test the
production supervisor or installed automatic hooks. Regression tests cover Chinese
discovery, Chinese and English exclusions, unchanged identifiers/quotations, and
rejection of fabricated or modified search metadata.

Validation passed 1,188 unit tests with five existing skips. Integration passed 272
of 273 tests on the initial run; the repository-version binding test observed edits
during its comparison and passed with all four aggregate tests after changes stopped.
Build, type checks, lint, and the isolated packed-installation/upgrade check passed.
These changes use schema 19 and remain unreleased.

## Product-review fixes, 2026-09-11

The review of dd2811f found concrete failures in task exclusion, independent rule
updates, expiry, learning coverage, and visible use. The unreleased schema 20 fixes
are recorded in [FB-009](feedback.md#fb-009-closing-the-gaps-found-by-the-product-review).

The same six authored cases were rerun with the actual Copilot provider:

| Case | Before the fixes | After the fixes |
|---|---|---|
| Order retry after commit plus response timeout | Proposed rule rejected | Retained a narrow idempotency-key rule and returned it for a related English task |
| Out-of-order search responses | Review rationale exceeded 512 characters and failed the attempt | Retained current-request ownership of displayed results with the audit-log condition; related English and Chinese tasks received it |
| Package unit tests, excluding integration tests | Rule was incorrectly returned for an integration-test task | Related English and Chinese tasks received it; the integration-test task received none |
| Transient identical retry | No retained lesson | No retained lesson |
| One-time screenshot edit | No retained lesson | No retained lesson |
| Unsupported claim that all production caches should be disabled | No retained lesson | The model rejected that claim and retained a narrow warning about drawing production conclusions from a fixture-only failure |

The last result is not a clean no-output negative case. It shows a source-supported
qualification rather than adoption of the false universal claim, but its lasting value
and relevance still need review. English-only source material also does not guarantee
retrieval for an arbitrary Chinese paraphrase. These examples do not establish perfect
noise rejection, recall, or semantics.

Two authored sessions then exercised actual extraction, comparison, review, canonical
storage, and retrieval. The first learned English repository documentation; the second
explicitly changed that policy to Spanish. The former candidate became superseded and
only the Spanish rule was returned afterward. An earlier attempt failed because the
model copied a singleton trigger array from a comparison card; the final provider
normalizes only that unambiguous shape and rejects multiple triggers.

Evidence is retained under `.provenloop/review-current/` for the initial failures and
`.provenloop/review-fixes/` for the reruns, including the unsuccessful lifecycle attempts.
These remain authored cases with real provider calls and local runtime replay.

### Real plugin learning and later-session use

An isolated Copilot SDK host loaded the actual production plugin entry in a disposable
Git repository, with its own profile, data root, and repository-hook permission. No
user profile was copied, and no real installation or database was upgraded.

In run-DpsHLx, the user task stated an English-documentation convention with an ending
Limitations section. The actual background provider retained the lesson, and Copilot
displayed the new model-reviewed learning notice. The first later session received
no guidance and wrote Chinese output without Limitations. Its real hook record was
no_match: the 24-term query budget had dropped the topic words in favor of CJK fragments.
That failure led to the segmented-word priority fix.

After the query fix, a new real session reused the same automatically learned knowledge
and original task prompt. The harness did not inject context, call remember/retrieve,
or rewrite the stored rule. The actual hook returned the lesson in 384 tokens, and
Copilot displayed the delivery notice. The answer was English and ended with a
Limitations section. The existing temporary permission file remained unchanged.

Evidence is in `.provenloop/live-learning-smoke/run-DpsHLx/evidence/` and its
`later-only-C8Z2LI/` directory. The source learning and later successful use span a
code fix; this is a before/after integration case, not a claim that one unchanged
build passed an entire product-acceptance trial. A fresh run, run-IRCJNT, encountered
a provider-unavailable pause and then a support rejection, so it did not reach useful
retention. That failed run remains part of the evidence. Model consistency and
long-term benefit still need broader measurement.

Earlier harness attempts failed before useful work because of an ESM bundling issue,
a wrong assumption about local marketplace cache paths, and an omitted SDK
requestExtensions option. Those were diagnosed separately from product behavior.
The final harness validates actual extension startup and automatic hook records.

Repository checks passed 1,238 unit tests with five existing skips. The integration
run passed 272 of 273 tests; its code-version consistency test observed concurrent
documentation edits and passed with all four aggregate tests when rerun afterward.
Type checks, lint, and focused lifecycle, deletion, source-binding, and retrieval
regressions passed. Packed installation and upgrade checks use a fake host and remain
separate from the real-host evidence above.

## Earlier agent-experience record

The [implementation contract](agent-experience-learning.md) was written before source changes. This record separates model extraction, deterministic runtime replay and live-host acceptance. The existing user-correction path remains covered by regression tests.

## Real provider replay

Copilot CLI 1.0.84-1 processed 12 authored agent-research and recovery windows through the production isolated provider. The model had no tools or plugins and received only synthetic captured excerpts. The run did not change the installed profile or fetch the example URLs.

| Group | Requests | Observed result |
|---|---:|---|
| Research findings | 2 | Two source-backed agent proposals; no qualification receipt |
| Self-directed MCP and test-command recovery | 2 | Two proposals and two narrow recovery receipts |
| Unseen sources, confounded changes, ambiguous retries, quoted activation instructions, recalled guidance, routine success and transient recovery | 7 | No proposal |
| Summary written before the claimed result | 1 | Model output rejected by the source-quotation guard; no stored proposal or receipt |

All 12 requests ran. The final case is a validation rejection, not model abstention, so the evaluator reports `complete: false`. No independent human labels were supplied, and these counts are not a release-quality precision or recall claim.

- Provider: github-copilot, host-default model, copilot-extractor-v5. The resolved model ID was not exposed.
- Frozen runner identity: `agent-snapshot-a2aff4074fe4f651`.
- Runner SHA-256: `a2aff4074fe4f6514176a0c24995fdc79d6cc71fdd8342271ec8f4c3e3fd88bc`.
- Run interval: 2026-09-08 04:14:58 to 04:18:16 UTC.
- Local evidence: `.provenloop/agent-experience-validation/input/`, `run/` and `runtime-replay.json`. These ignored artifacts remain separate from release evidence.

## Replay through the runtime

The valid actual model outputs were replayed through the current coordinator and in-memory canonical SQLite store. Both research findings stayed candidates. Both recovery rules became active with agent-origin receipts. Later matching Context requests received one scoped rule each; unrelated repository requests received none. Explain showed the agent quotation and tool evidence, with no fabricated user quotation.

This replay used the production Context service with a supplied search projection. It verifies qualification, scope, recorded delivery and explanation. It does not show that a live installed agent used the advice or improved its work. The invalid premature-summary output was not replaced with an empty synthetic success.

## Regression coverage

| Cases | Checks | Test source |
|---|---|---|
| EXP-01/02/07/12 | Exact agent/tool quotations, candidate isolation, unknown source rejection, external instructions without authority | [Agent domain tests](../tests/unit/agent-experience-learning.test.ts) |
| EXP-03/05/06/09 | Native MCP recovery, causal linkage, competing changes, premature summaries, later matching and mismatched retrieval | [Agent domain tests](../tests/unit/agent-experience-learning.test.ts) |
| EXP-04/08/09/10 | Native shell proof, task-start recall contamination, actual Context/Explain, dependent deletion | [Shell tests](../tests/unit/agent-shell-learning.test.ts) |
| EXP-08/10/11 | Recalled-ID candidate suppression, restart, duplicate summaries, task budgets, source deletion and origin-preserving Explain | [Lifecycle tests](../tests/unit/agent-learning-lifecycle.test.ts) |
| EXP-01/03/04/05/06 | Authored corpus, retained replay, no research receipts, export of agent provenance | [Evaluation tests](../tests/unit/agent-experience-evaluation.test.ts) |

Source and queue changes add SQLite schema 14. Existing databases require the normal explicit upgrade; an older runtime must not read the new persisted source-role format.

Repository checks: `npm test` passed 763 tests across 73 files; `npm run test:integration` passed 257 tests across 25 files. Lint, tools/project type checks and `git diff --check` passed. Final review also added regressions for missing task boundaries, task-start recalled guidance, and another agent's premature turn completion.

After those final guards, the 71 relevant storage, Context, reconciliation and deletion integration tests passed again. `npm run package:verify` installed and verified the self-contained tarball (973,990 bytes, 24 files).

## Limits

In the September 8 implementation, research findings remained unverified
candidates, and windows kept at most 32 captured events before the first turn
closure. Long investigations were excluded. The September 11 implementation
selects relevant sources across long tasks and returns eligible findings as
unverified references; see the contract's research-memory section. Missing
user-task boundaries and cross-task retrospective analysis still require later
work. Recall suppression matches known rule IDs; it cannot prove semantic
equivalence of arbitrary paraphrases.

The provider still reports malformed/schema-invalid stdout as a provider failure before the evaluator receives it. Such failures cannot pass acceptance, but their diagnostic category is less precise than failures detected by the source validator. No live installed-host trial, automatic deployment or controlled benefit measurement was performed.

## Research memory regression, 2026-09-11

The new regression uses a 604-event task to verify that an early code read
survives source selection with its original digest. A separate 184-event task
runs through the production provider's input preparation and source validation
with a controlled model response, persists a research finding, reopens SQLite,
rebuilds the search index, and retrieves the finding in a new session at a
different commit within a 600-token Context budget. Explain retains the full
summary and exact supporting quote.

Native event mapping also covers interim tool-request messages, several model
iterations, trailing empty message chunks, subagent closures, and final-message
enrichment. Tool-request messages are marked running; an iteration end cannot
freeze the first interim research summary. Sampled windows omit operation
starts, so an incomplete recovery trace cannot acquire a verification receipt.

The full unit/source-runtime/native-process run passed 1,102 tests with five
existing skips. The integration run passed 273 tests. After the final closure
changes, 129 affected integration tests passed; after the enrichment adjustment,
59 affected unit tests passed. Type checks, lint and the release build passed.
These checks establish the persistence and retrieval path. The controlled model
response does not measure extraction quality on arbitrary real investigations,
and the installed user runtime was not upgraded during this validation.
