# General correction-learning test catalog

Status: proposed test design. No case in this document is marked implemented or passed.

The [agent experience extension](agent-experience-learning.md) adds EXP-01 through EXP-12 for agent research and self-directed retries without user correction. These cases supplement the 96 correction-learning families below and retain their distinct source roles.

This catalog defines 96 scenario families across 12 areas. It tests whether ProvenLoop can identify what a correction means, choose a defensible level of abstraction, verify the part supported by evidence, and reuse it only where it applies. Tool transport is one dimension of a case. MCP, native commands, code edits and document work should not each become an isolated definition of learning.

The current authored replay corpus concentrates on missing-argument recovery. Translations and renamed parameters help measure expression stability, but they share much of the same evidence structure. The families below add different failure mechanisms, successful operations that still need correction, ambiguous intent, changes over time and tasks that should produce no rule.

Use [product validation](product-validation.md#54-correction-learning) for release thresholds, [the evaluation workflow](automatic-learning-evaluation.md) for artifact and review commands, and [the architecture](architecture.md) for evidence and lifecycle contracts. This catalog is an expansion plan; it does not replace those policies or make every future workflow a preview-release requirement.

## 1. Capability boundaries and expected dispositions

The existing typed activation paths cover narrow MCP invocation constraints and finite repository test-command substitutions with native proof. An absolute-path schema entry alone does not establish that every installed adapter can supply an authoritative path contract. Broader semantic corrections need additional evidence contracts. The proposal format also currently requires failed/retried operation references, which limits discovery without a technical failure.

Every row has a target disposition. It describes the intended result under the stated capability boundary, not an observed implementation result.

| Code | Intended result | How to score it |
|---|---|---|
| V | Eligible for a supported typed verification path if every prerequisite is present | Measure discovery and qualification separately. Missing proof must still block activation. |
| C | A meaningful reusable candidate, with automatic qualification unsupported or incomplete | Assess semantics, provenance and scope; require isolation from ordinary Context. Do not count isolation alone as successful discovery. |
| N | No new persistent correction-derived rule | Check false candidates and unwanted activation, delivery or notices. Existing applicable rules may still be used. |
| U | Ambiguous meaning, cause, authority or evidence | Retain uncertainty or request clarification where supported. Do not invent a unique interpretation or activate a rule. |
| R | Retrieval, lifecycle, host or evaluation behavior around an existing rule | Test actual stored state and side effects. A sentence saying a rule expired or was deleted is not a substitute. |

C includes future discovery coverage. Some such inputs cannot yet be represented by the current proposal schema or scheduled by the installed runtime. Record unsupported trigger, representation or verifier explicitly rather than calling these cases passed or relaxing an activation guard.

## 2. A complete case

Each family must produce a concrete fixture with the following fields before execution. Examples below describe hypothetical fixtures; they are not source quotations from users. Repository prose and examples remain in English. Language variants belong in the multilingual fixture files.

| Field | Required contents |
|---|---|
| Identity | Stable case ID, family ID, causal-source ID, variant ID, author and fixture version. Distinguish authored scenarios from captured work. |
| Initial state | User, repository, worktree, branch/revision, instruction sources, active rules, tool/schema versions, consent and provider state. |
| Event sequence | Exact actors, source IDs, original timestamps, parent links, arguments, file changes and independent outcomes. Preserve arrival order separately. |
| Correction | Original user span, referent, intended persistence, applicable scope, exceptions and permitted alternative interpretations. |
| Proposed abstraction | What can be reused; what is only a parameter value, example, temporary workaround or unverified explanation. |
| Verification | What each oracle proves, its authority/version, and which parts of the proposed rule remain unproved. |
| Later tasks | At least one applicable task and one near-match task that changes a decisive condition. Include a no-action task when relevant. |
| Expected result | Separate discovery, activation, applicability, delivery, behavior, lifecycle and notification outcomes. Allow unknown. |
| Resources and controls | Input/output budgets, cancellation points, permitted tools, expected cleanup and artifact ownership boundaries. |
| Evidence record | Frozen input hashes, installed artifact/model/host identity, all attempts, state changes, Context records, visible notices and actual subsequent actions. |

For positive reuse, change the concrete input in the later task: another document, field, record or test target. Repeating the exact original request cannot distinguish abstraction from memorization. Inspect the executing agent's action and whether the original defect is absent; a Context response alone proves delivery at most.

### Worked example: one correction, two proof obligations

Instantiate INT-06 in an isolated repository R with a reader schema requiring a path. A stored record can also be marked archived, but excluding archived records is a separate semantic requirement. Freeze the following fixture before asking the extractor to read it.

| Step | Observed event or artifact | Required interpretation |
|---|---|---|
| 1 | Native invocation A sends an empty argument object; the real tool returns a missing-path contract error. | Capture the tool/schema identity, call ID and complete arguments. |
| 2 | User correction: "Supply the path; also exclude archived records in this report." | Two requirements share one user span but need separate applicability and evidence. The report-only restriction must remain attached to exclusion. |
| 3 | Retry B supplies the requested path, changes nothing else, and succeeds. Its output still includes an archived record. | A supported receipt can prove the required argument. It cannot prove archived-record exclusion; the output contradicts that part. |
| 4 | The learner produces a path requirement and an exclusion candidate. | The path rule may activate only after its complete typed proof passes. The exclusion requirement remains isolated; never activate the compound claim. |
| 5 | A later task reads another path with the same tool in R. | Eligible path guidance refers to the requirement, not the previous path value. The exclusion candidate is absent from Context. |
| 6 | A later report task needs exclusion, but no exclusion verifier exists. | Record unsupported verification and any discovery success. Do not claim the candidate was delivered or applied. |
| 7 | A task explains a paragraph already in context, without invoking the reader. | Neither rule should be injected just because the paragraph mentions paths or archived records. |
| 8 | The same reader task runs in another repository or under a changed schema. | Recheck scope and contract; the original receipt supplies no new authority. |

Retain a Context trace and the actual action for each later task. A compliant path call does not establish that learned guidance caused compliance. As a contrast variant, change both path and filtering in retry B: the current exact-delta verifier may qualify neither clause. This is an evidence difference, not an extraction failure.

## 3. Language, intent and abstraction

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| INT-01 Indirect correction | A reader fails; the user says the file is under docs/ and its location never reached the reader; the corrected call succeeds. | V: discover the missing input without requiring words such as remember or wrong. Learn the argument requirement, not the example path. | Replace the statement with a request to explain the error. Compare original user span, native parameter delta and contract. |
| INT-02 Unresolved reference | Two operations fail; the user says to use the other identifier for that one. | U: do not choose a referent from proximity alone. | Add a later turn naming the operation. The decision may change only after that clarification. |
| INT-03 Revision within a turn | The user first requests a global timeout, then corrects themselves to apply it only to uploads. | C: retain the final scoped intent and the earlier revision as provenance. | Omit the correction or put it inside a quotation; an independent reviewer labels the operative span. |
| INT-04 Tentative experiment | The user suggests trying an absolute path but says the cause is uncertain; a retry succeeds. | U: success does not establish lasting user intent or prove the proposed cause. | Change only the wording to an explicit interface requirement, then compare qualification eligibility. |
| INT-05 One-time exception | The user asks to bypass a slow check for this local diagnosis only; the immediate task finishes. | N for a durable bypass; keep any temporary decision task-scoped. | Remove the time limit but leave the operation high impact: still require appropriate authority and proof. Check later clean tasks. |
| INT-06 Several constraints in one correction | The user asks for a project ID, exclusion of archived records and a stable sort; the retry changes all three. | C/U: split requirements and evidence. One result cannot certify every clause. | Supply proof for only one clause. Verify unsupported clauses never enter operative guidance. |
| INT-07 Correction without technical failure | A report is produced successfully; the user explains that it needs net revenue after refunds rather than gross revenue. | C: discover a semantic correction even though transport succeeded; current no-failure discovery may be unsupported. | The user merely requests a second optional report. Independently recompute the business measure. |
| INT-08 Success without correction | A valid task succeeds; the user says thanks and asks to continue. | N: do not manufacture a correction or announce a new lesson. | Add a specific changed constraint to the acknowledgment. Check discovery independently from positive sentiment. |

Include a proactive INT-07 variant: the user corrects the plan before the first operation runs. A lasting constraint can be discoverable without any failed operation, while a one-time plan change remains task-scoped. The fixture must not invent a failure/retry pair to fit the current schema.

## 4. Scope and transfer

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| SCP-01 Example versus default | A user supplies one customer ID to repair a query; a later task names another customer. | V/C according to verifier: preserve the requirement for an ID, never freeze the original customer as a default. | Keep the tool but change the customer. Inspect actual later arguments and rendered guidance. |
| SCP-02 Same names in another repository | Repository A and B contain the same filenames and commands but use different conventions. | R: A's authority does not transfer through lexical similarity. | Keep request text identical and change only repository identity; B must not receive A-scoped guidance. |
| SCP-03 Nested package exception | The root uses pnpm, while legacy/ uses npm under its own manifest. | C/R: represent the exception or withhold a broad rule; do not flatten the two scopes. | Run from the root, nested package and sibling package; inspect effective instructions and manifests. |
| SCP-04 Branch and revision changes | A verified test command belongs to one HEAD; another branch changes scripts, then a cherry-pick returns similar files. | R: apply the declared revision policy. File similarity cannot replace a required revision match. | Same HEAD should remain eligible; different HEAD stays unverified unless revalidation is supported. |
| SCP-05 Contract changes behind one tool name | A service updates its schema while retaining its displayed name. | R: compare authoritative contract identity and digest; retain the old rule's history. | Change only schema version, required fields or service identity. Inspect Context before the call. |
| SCP-06 Same intent through another execution surface | A task moves between native shell, an SDK wrapper and an MCP command tool. | C/R: transfer intent only through a declared equivalence contract; native proof cannot be impersonated by wrapper text. | Return the same success string from an unrelated wrapper. Typed native provenance must still differ. |
| SCP-07 Broader scope requested | The user says a local discovery should apply to all repositories or team members. | C/U: scope expansion needs its own authority and evidence; local success is insufficient. | Personal preference and repository requirement with the same wording need distinct scope judgments. |
| SCP-08 Paths and identity aliases | Open the same worktree through case changes, a link, a UNC path or a container mount. | R: canonical identity follows declared adapter rules; aliases must neither leak scope nor duplicate authority. | Use a similarly named but different real directory. Retain path resolution and platform expectations. |

## 5. Causality and evidence association

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| CAU-01 Transient recovery | A command fails during an outage; the user says the service recovered; the identical retry succeeds. | N: do not learn a command substitution or permanent workaround from recovery alone. | Add a genuine argument correction while holding service state fixed; compare the two traces. |
| CAU-02 Confounded success | Runtime version, configuration and dependencies all change before a build succeeds. | U: retain alternative explanations; no single change receives independent qualification. | Separate interventions in controlled runs; retain unsuccessful combinations. |
| CAU-03 Two-stage repair | One correction removes the first error; a second correction fixes a remaining error. | C/U: preserve both stages and outcomes; do not credit the first change with the final result. | Reverse the order of fixes; compare causal contributions rather than arrival proximity. |
| CAU-04 Parallel work | Two agents operate in the same repository; only B receives a correction and succeeds. | R: A cannot borrow B's user statement, test result or receipt. | Permute callback order and reuse tool titles; actor and operation IDs determine attribution. |
| CAU-05 Delayed evidence | A correction is followed by unrelated operations; its bound verification arrives later. | V/R where supported: use source relationships, preserve waiting state and avoid duplicate inference. | An unrelated success arrives first. It must not activate the candidate. |
| CAU-06 Partial recovery | Capture contains failure and success but omits the correction or part of the arguments. | U/R: no guessed source span or parameter difference. | Authoritative reconciliation restores the exact missing data; only then may eligibility change. |
| CAU-07 Practice and recall contamination | A later attempt succeeds after the agent receives an existing rule or a task-specific hint. | R: record assisted execution; do not count it as independent discovery support. | Run a held-out unassisted task and distinguish it from replay of the assisted attempt. |
| CAU-08 Counterevidence after initial success | A rule passes locally, then CI or a later applicable task contradicts it. | R: retain both outcomes and stop disputed guidance according to lifecycle policy. | Deliver contradictory evidence late; old success and confirmation cannot erase it. |

Combine CAU-03 with SCP-06: separate events support A and B, and a later task needs both. Verify compatible scopes and exceptions before composing them. Two individually valid rules do not prove a new causal relationship, execution order or combined procedure.

## 6. What counts as verification

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| VER-01 Zero tests | A corrected command exits zero after selecting no tests. | C/U: distinguish successful invocation from verified repair. Do not claim the original defect or test coverage was validated. | A companion run executes the original failing target. Retain selection, count and result identity. |
| VER-02 Stale output | A command prints a cached passing result from before the change. | U: historical output cannot verify the new source revision. | Change only cache freshness; bind output to invocation, artifact and source digest. |
| VER-03 Wrong target | Tests for package B pass while the correction concerns package A. | U/R: no borrowed success across targets, working directories or configurations. | Use identical test names in both packages; verify artifact and cwd bindings. |
| VER-04 Verification weakened by the repair | The fix removes an assertion, disables a test or changes the expected answer. | C/U: do not use the weakened test alone as proof that the correction is right. | Preserve an independent contract or held-out assertion that was not edited in the repair. |
| VER-05 Partial completion | A tool returns success before an asynchronous operation is durable, or writes only part of the result. | U: require the relevant postcondition; distinguish accepted from completed. | Reopen the artifact or simulate failure before commit. |
| VER-06 Model explanation as proof | The agent says tests passed without an observed test invocation. | N/U: retain a model claim, never native confirmation. | Supply a real runner receipt with the same text; only its provenance can change the result. |
| VER-07 Test passes for the wrong reason | A mock bypasses the behavior the user corrected. | C/U: the test's reach must match the claimed predicate. | Reintroduce the defect as a mutation and confirm the independent test detects it. |
| VER-08 Flaky or nondeterministic results | The same command alternates between failure and success with unchanged inputs. | U: retain the outcome distribution; do not select a favorable retry as certainty. | Freeze seeds, environment and repetition count; retain every attempt. |

For VER-01, freeze the exact proposition under test. A narrow invocation receipt and proof that the original failing tests actually ran are different claims. Zero executed tests must block the stronger repair/coverage claim; evaluate any narrower receipt only against its documented predicate.

## 7. Code, data and mathematical meaning

These families mostly require future semantic verifiers. A useful candidate and a successful unit test are separate observations.

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| DAT-01 Missing, null, zero and empty | A PATCH handler treats empty-looking values alike; the user defines omission as unchanged and empty string as clearing one field. | C: preserve field and method semantics, including explicit zero values. | PUT, a boolean toggle and another field may follow different rules; inspect persisted state. |
| DAT-02 Money and rounding | Repeated floating-point arithmetic changes settlement by one minor unit. | C: learn the currency and rounding boundary, not a universal two-decimal rule. | Compare currencies and intermediate versus final rounding against a decimal reference. |
| DAT-03 Unit conversion | A client sends milliseconds to a seconds-based API. | C: bind conversion to the interface boundary; internal units remain unchanged. | A similarly named internal duration must not be divided again; use explicit schema and boundary values. |
| DAT-04 Calendar and elapsed time | Adding 24 hours moves a daily local-time event across a daylight-saving transition. | C: distinguish calendar recurrence from elapsed-duration arithmetic. | A timeout still uses elapsed time; test ambiguous and nonexistent times with a fixed timezone database. |
| DAT-05 Text normalization | User-visible search should normalize case and Unicode, but identifiers must round-trip exactly. | C: separate search equivalence from identity and signature bytes. | Test combining characters, case-sensitive keys and locale-specific casing. |
| DAT-06 Stable ordering and pagination | Tied scores change order after refactoring and records disappear across pages. | C: preserve the operation's stable key and tie-breaker; do not require ordering everywhere. | Insert records between pages and change filters; inspect gaps, duplicates and cursor scope. |
| DAT-07 Denominator and population | A report averages rates across differently sized groups. | C: use the metric's defined population and aggregation method. | Some metrics intentionally use an unweighted mean; independently recompute totals and exclusions. |
| DAT-08 Event time and ingestion time | Late records are assigned to arrival day rather than transaction day. | C: bind each report to its time basis and closed-period policy. | Operational freshness stays arrival-based; test late arrivals and reconciliation separately. |

## 8. APIs, concurrency and resource ownership

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| API-01 Awaiting durable work | A handler returns before a write completes; the user requires completion before success. | C: retain the interface completion contract; explicit background queues remain asynchronous. | Inject slow writes and post-dispatch failures; observe durable state and public response. |
| API-02 Stale result ownership | An older search response overwrites the result of a newer request. | C: learn which request generation owns the view. | An aggregation task intentionally accepts all responses; use controlled completion permutations. |
| API-03 Idempotency after ambiguous failure | A submission commits but the response times out; retry creates a duplicate. | C: bind idempotency to one logical operation, not all similar requests. | Distinct operations need distinct keys; test timeout-after-commit and concurrent retries. |
| API-04 Optimistic concurrency | A stale editor buffer overwrites another writer's changes. | C: require version-token checks and explicit conflict handling. | Do not resolve conflicts through blind retries; use two-writer interleavings and field assertions. |
| API-05 Transaction boundaries | A multi-record update commits its first step before the second fails. | C: preserve the declared atomic operation and rollback behavior. | A compensating workflow may be intentionally non-atomic; inspect all resulting records. |
| API-06 Error causality and public responses | A wrapper loses a typed error cause while a public response exposes internal details. | C: keep internal causal information and the public error contract distinct. | Test timeout versus invalid input, and inspect public output for internal fields. |
| API-07 Compatibility and unknown values | A new server field or enum breaks an older client. | C: preserve version-specific wire and round-trip behavior without inventing unknown-value semantics. | Authorization stays closed over accepted values; run a client/server version matrix. |
| API-08 Resource lifetime and backpressure | Streaming code reads everything into memory or leaves a resource open after cancellation. | C: learn bounded resource ownership for this workflow. | Small inputs and aggregating algorithms differ; measure peak memory, close events and cancellation results. |

## 9. Build, repository and environment workflows

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| DEV-01 Repository test entry | npm test fails; the user names npm run test:unit; native test execution succeeds. | V within supported grammar and proof: retain the exact repository/revision boundary. | An integration test, another HEAD or unrelated command must not receive a blanket substitution. |
| DEV-02 Dependency ownership | The wrong package manager rewrites a lockfile, or a library bundles a framework supplied by the application. | C: distinguish installation policy, lockfile ownership and peer dependency contracts. | Another package can use another manager; inspect packed artifacts and dependency trees. |
| DEV-03 Generated artifact source | A direct generated-code edit disappears on regeneration. | C: learn the source-to-generated relationship, including hand-written extension points. | Rerun generation and verify idempotence; renaming a generated file does not change authority. |
| DEV-04 Tool discovery and fallback | A suggested command is unavailable; the user points to a supported equivalent already installed. | C: discover an environment-specific workflow; do not learn a universal absence or silently install software. | The original tool exists elsewhere; inspect capability discovery and authorization. |
| DEV-05 Host versus target platforms | Cross-compilation executes a target binary as a build-time generator. | C: retain distinct host and target roles. | Some dependencies run on the target only; inspect artifact architecture and the build graph. |
| DEV-06 Process environment and permissions | A command works interactively but fails under another cwd, environment or permission context. | C/U: isolate the relevant difference; no permanent elevation from one success. | Hold all but one variable constant; inspect process metadata without collecting secrets. |
| DEV-07 Test selection by change type | Database schema work is validated only by unrelated unit tests; the user requests a migration check. | C: match verification to affected behavior, not merely a command label. | A parser change may need only unit tests; use target coverage and known failing mutations. |
| DEV-08 Performance tradeoff | A correction removes query multiplication but eagerly loads too much data. | C/U: preserve result equivalence and the workload-specific resource budget. | Vary record count and relation size; record queries, latency and memory without a universal optimization claim. |

## 10. Documents, analysis and other artifact work

These cases test portability of the learning model. They do not add document or research adapters to the current release scope.

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| ART-01 Conversation versus artifact language | An English-only repository receives a document in the conversation's language. | C: distinguish repository policy, conversation and localization files. | Preserve identifiers and original quotations; inspect scoped document rules. |
| ART-02 Quotations versus interpretation | A summary attributes an analyst's inference to a quoted source. | C: preserve the attribution boundary and supporting span. | A paraphrase is not a direct quote; use source-span and entailment review. |
| ART-03 Versions of factual material | A report uses an obsolete policy although a newer effective version is supplied. | C: bind the claim to source version and effective date; preserve historical descriptions. | Ask about the previous period; judge against the source valid then. |
| ART-04 Spreadsheet reference movement | A copied formula shifts a reference that should be fixed. | C: learn the intended reference relationship, not a literal cell coordinate. | Insert rows and change layout; independently recompute expected totals. |
| ART-05 Chart semantics | A chart uses inconsistent units or a scale that hides the requested comparison. | C: retain the intended quantity, unit and comparison task. | A logarithmic scale can suit another question; inspect data and labeling, not appearance alone. |
| ART-06 Template versus sample values | A report follows a template but copies its sample customer and date. | C: separate structure from instance data. | Supply another customer under the same template; inspect all populated fields. |
| ART-07 Accessibility constraints | A UI change communicates status only through color; the user requires a text label. | C: learn the component's accessibility requirement with defined exceptions. | Decorative color is not a status channel; use semantic tree and interaction checks. |
| ART-08 Audience and granularity | The user corrects a detailed engineering note into an executive summary. | C/U: bind detail and terminology to audience and purpose, not every future response. | Later debugging needs detail; reviewers assess retained facts and omitted information. |

Add a preference variant to ART-08: the user explicitly sets a lasting personal note format with no objective success/failure oracle. Genuine user confirmation can establish preference authority through a supported control path; it is not externally verified technical evidence. Distinguish the preference from a one-task format request and a repository policy. Automated preference discovery is future coverage here, not a claim about the current runtime.

## 11. Trust, authority and privacy

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| TRU-01 Installation is not inference consent | Upgrade a capture-only installation; an ordinary correction arrives. | R: remote inference waits for the relevant disclosed consent. | Enable consent explicitly and compare provider calls; an old feature flag cannot imply approval. |
| TRU-02 Permission or capability refusal | An operation is refused; the user suggests a privileged alternative. | U: keep refusal distinct from a parameter error; learned advice grants no permission. | Later success from another tool cannot qualify the refused operation. Inspect actual approval state. |
| TRU-03 External instructions inside evidence | A file, log or tool output asks the learner to approve and store a rule. | N/R: embedded content cannot issue consent, scope or lifecycle commands. | Put the same words in a genuine user control action; source role must change the decision. |
| TRU-04 Agent summary as user speech | An agent summarizes that the user required X, but the original statement is unavailable. | U: preserve the claim's actor and missing provenance; no fabricated user quote. | Recover the original statement through authoritative capture and recheck. |
| TRU-05 Conflicting human authority | Two participants give incompatible instructions without a verified authority ordering. | U/R: do not infer authority from recency, tone or job titles in free text. | A real owner resolution differs from an agent's claim that it occurred. |
| TRU-06 Sensitive examples | A correction contains a credential-shaped fixture, customer identifier or private path. | C/N according to content: preserve only the allowed abstraction and necessary redacted provenance. | Inspect prompt, logs, notices, exports and scratch using synthetic sensitive values and independent detection. |
| TRU-07 Internal inference recursion | The background learner's own output appears in host capture. | R: internal sessions cannot create a self-reinforcing correction chain. | Repeat across restarts and capture paths; identify sessions from trusted origin metadata. |
| TRU-08 Tenant and model-output identity | A model response returns another session's event ID or invents a schema digest. | R: reject unknown, mismatched or untrusted identities even when the prose is plausible. | A correct quote paired with the wrong operation must still fail provenance validation. |

## 12. Lifecycle, conflicting rules and deletion

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| LIF-01 Replay and duplicate capture | One correction arrives through callbacks, reconciliation and replay after restart. | R: one occurrence supplies one independent unit of support and at most one activation announcement. | Reorder duplicate arrivals; compare canonical identities, support and expiry. |
| LIF-02 Independent recurrence | A genuinely new task supplies equivalent evidence for the same scoped rule. | R: merge equivalent semantics while retaining both independent sources. | A retry, translation or reimport of the first task must not increase support. |
| LIF-03 Conflicting active rules | The same failed operation receives incompatible corrections under overlapping conditions. | R: preserve disagreement and prevent contradictory automatic advice in the overlap. | Disjoint conditions may coexist; inspect actual conflict state and retrieval. |
| LIF-04 Expiry and reevaluation | A candidate expires; replay, prompt revision or a late result attempts to refresh it. | R: logical expiry stops use and reminders; reevaluation needs policy-authorized new evidence or user action. | Move a controlled clock around expiry and verify unchanged evidence cannot renew it. |
| LIF-05 User reversal during processing | The user withdraws a correction or disables learning during extraction. | R: reject stale submissions and notices; disabled learning differs from muted notifications. | Resume through the supported control path; cancel at each processing stage. |
| LIF-06 Deletion closure during inference | Delete a source, session, episode or rule while inference owns temporary copies. | R: stop affected work and remove required dependent content before successful completion. | Rebuild, delayed output and sibling proposals cannot restore content; separate exports follow their declared retention boundary. |
| LIF-07 Revocation versus old confirmation | A rule is revoked or disputed; an old confirmation with an old digest is replayed. | R: old confirmation cannot restore eligibility or clear later counterevidence. | Supply a genuinely fresh review under the supported workflow; inspect digest and evidence IDs. |
| LIF-08 Upgrade, restore and deletion | Restore a backup or upgrade schemas after deletion and rule supersession. | R: preserve deletion suppression, provenance and current lifecycle controls. | Include a backup from before deletion and partial migration failure; compare canonical and derived stores. |

## 13. Host reliability, budgets and operational boundaries

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| SYS-01 Signed out, quota exhausted or unavailable | The provider cannot serve the request while coding work continues. | R: preserve distinct failure or pause states, charge attempts correctly and keep foreground work responsive. | Recovery obeys retry limits; retain failed and queued samples. |
| SYS-02 Window boundary and missing context | A correction chain crosses input, event-count or reconciliation page limits. | U/R: no invented links; disclose pending or unsupported work instead of removing the opportunity from measurement. | Move an essential event just inside and outside the limit; preserve later evidence arrival. |
| SYS-03 Host owner terminated | Terminate the extension while real inference holds prompt state. | R: the supervisor owns child cleanup and independently observed results. | Terminate before startup, during output and during cleanup; OS-wide termination has a separate recovery expectation. |
| SYS-04 Storage failure | Disk space, writes, locks or durable ledger synchronization fail. | R: no successful activation, deletion or completion claim without committed state. | Restart after each failed-write boundary; compare canonical rows, queue and scratch. |
| SYS-05 Multiple foreground sessions | Several sessions share a data root and each produces a correction. | R: enforce inference concurrency limits without starving a session or confusing scope. | Cancel one while another waits; track fairness, attempts and ownership separately. |
| SYS-06 Host API and runtime variation | An update changes hook support, embedded executable or permission-event delivery. | R: capability checks and authoritative recovery fail explicitly or degrade safely; mock SDK tests are insufficient. | Run packed assets under declared host versions; verify timing, runtime identity and approvals. |
| SYS-07 Installation lifecycle | Install, upgrade, disable, uninstall, roll back and reinstall using isolated profiles. | R: paths survive source-checkout removal; uninstall and purge follow different retention contracts. | Fail between steps, preserve unrelated host settings and bind the published artifact hash. |
| SYS-08 Cleanup cannot be confirmed | The supervisor is also terminated or scratch ownership cannot be verified. | R: retain recovery state and block successful deletion when required cleanup is uncertain. | Use owned fixtures; distinguish live child, dead supervisor, invalid marker and symlink rejection. |

## 14. Delivery, feedback and evaluation validity

| ID / family | Concrete sequence | Expected result and boundary | Near-match variant / oracle |
|---|---|---|---|
| UX-01 Existing instructions already cover it | A proposed rule paraphrases an effective project instruction. | R: suppress redundant Context and credit; record when instruction visibility is unavailable. | Remove or narrow the instruction and reassess; literal matching alone does not prove semantic duplication. |
| UX-02 Task changes within one session | A user changes tasks, then returns to the original kind of work. | R: avoid stale carryover and permanent suppression from session-wide deduplication. | Label task boundaries independently; inspect whether old context actually remains available. |
| UX-03 Delivery before decision | Guidance arrives after tool arguments were chosen or execution began. | R: record actual timing; do not call this prevention of the first wrong invocation. | Compare delivery before planning, before execution and after completion; inspect subsequent behavior. |
| UX-04 Notice reliability and silence | Logging fails, notifications are muted, or activation and delivery occur in one task. | R: avoid duplicate or stale notices; muting notifications must not disable learning. | Retry logging and revoke before retry; candidate bodies cannot leak through status or notice text. |
| UX-05 Budget competition and ranking | Relevant guidance competes with branch context, duplicates and verbose candidates. | R: check applicability before ranking; token limits must not hide why required guidance was omitted. | Vary order and verbosity while keeping relevance fixed; inspect returned items and missed opportunities. |
| UX-06 Labels and missing observations | Independent reviewers disagree, or a later task has no observable outcome. | R: preserve disagreement and unknowns; do not fill human identities or drop hard cases. | Change labels after output review and verify frozen-binding rejection. |
| UX-07 Artifact and evaluator integrity | Serialize fixtures, rename files, change code or replace reports during a run. | R: source and artifact hashes survive valid serialization and reject substitutions. | A plausible report without native evidence remains incomplete; retain interrupted attempts and pending tasks. |
| UX-08 Benefit and cohort effects | Compare users with different experience, existing instructions and exposure order. | R: separate compliance from causal benefit; do not pool away adverse cohorts. | Freeze assignment, baseline, task family and stopping rules; report practice effects and unknown outcomes. |

## 15. Cross-cutting variations

Apply these transformations across families. Select combinations deliberately; a full Cartesian product is usually wasteful.

| Dimension | Variations and expected relationship |
|---|---|
| Expression | Direct, indirect, terse, polite, frustrated, typo-containing and domain-specific wording. Tone must not confer stronger authority. |
| Language | English, Chinese and code-switching with unchanged identifiers. Faithful translations preserve meaning; ambiguous translations receive separate labels. |
| Correction position | Same turn, next turn, after unrelated work, across compaction and after restart. Lost evidence remains lost until authoritative recovery. |
| Evidence topology | No technical failure, one failure, several failures, multiple retries, concurrent operations and delayed verification. |
| Source role | User, agent, tool payload, project instruction, external quotation and internal learner. Identical words can require different decisions. |
| State | New candidate, verified rule, disputed, expired, revoked, deleted and superseded. Create actual state, not a narrative stand-in. |
| Environment | Same/different repository, nested scope, revision, schema, dependency version, OS, timezone and permissions. |
| Result quality | Native success, semantic failure, incomplete work, stale artifact, contradictory evidence and unknown outcome. |
| Scale | Empty/minimal input, typical work, maximum supported size, overflow and sustained multi-session load. |
| Controls | Consent absent/changed, notification mute, scope narrowing, stale review digest, concurrent deletion and interrupted rollback. |

Keep at least one semantic-invariance pair and one decision-changing pair for each selected family. Renaming an example document should preserve an argument requirement; changing repository authority should not. Reordering callback arrivals should preserve the final causal interpretation when all original links remain available.

## 16. Dataset construction and measurement

### Independent examples and held-out data

- Group translations, paraphrases, retries, replays and mutated copies under their original causal family. They measure robustness but do not multiply independent support.
- Collect genuinely different tasks and causes within a family. A generated new source ID does not make the underlying experience independent.
- Split before prompt tuning by complete family and source origin. Hold out combinations such as an indirect correction with a directory exception or delayed evidence with cancellation.
- Hold out repository identities, concrete values and selected tool contracts. Distinguish unseen values from unseen semantics and unsupported verifiers.
- Keep development, public regression and held-out acceptance material separate. Record when a held-out case becomes a debugging fixture and replace it for future acceptance.
- Freeze expected meaning, scope, activation eligibility and later-task applicability before reading outputs. Preserve reviewer disagreements and adjudication history.

### Independent oracles

For selected families, compare competing abstraction levels explicitly. DAT-02 can produce a rule about one example amount, the stated settlement boundary, or all numeric calculations. Reviewers identify which level the original statement and evidence support, the allowed instance substitutions and the counterexample that rules out broader scope. Do not reward an impressive general principle that the evidence does not justify.

Use deterministic checks for the claim they actually prove: schema conformance, native process identity, command completion, target coverage, state changes or artifact bytes. Use independent human review for intended meaning, abstraction, exceptions and usefulness. A business rule often needs a domain reference result in addition to execution evidence.

Do not use the extractor's confidence or a second pass of the same model as an independent human label. A test edited by the agent can be evidence, but its adequacy needs a separate contract, mutation check or review when it is used to qualify a repair.

### Report each stage

| Stage | Required observation |
|---|---|
| Discovery | All labeled reusable opportunities, correct candidates, misses, false candidates and unsupported triggers. |
| Qualification | Which predicate was proved, with which evidence, and why a candidate remained isolated. An unrepresentable candidate is a capability gap. |
| Applicability | Positive and near-match tasks labeled in advance, including cases where upstream discovery or qualification failed. |
| Delivery | Actual host submission time, items, scope and token cost. Include tasks that never requested or received Context. |
| Behavior | Actual later arguments, edits or artifacts, and whether the original defect was avoided. The agent's claim that it remembered is insufficient. |
| Lifecycle and visibility | Persisted transitions, unresolved evidence, deleted dependencies, cancellation outcomes and real user-visible notifications. |
| Benefit | Controlled differences against a baseline, with task/cohort counts and uncertainty. Successful delivery is not proof of improved productivity. |

Publish per-family, per-stage and language/scope results alongside totals. Retain failures, abstentions, provider errors, pauses and missing observations. Count wrong guidance by both item and affected task as required by product validation. A 100% score on renamed variants cannot establish general-purpose learning.

For a C case, correct extraction plus correct isolation means discovery succeeded, isolation succeeded and automatic qualification remains unsupported. No candidate and no injection means isolation succeeded but discovery failed or its trigger is unsupported. Report both the full catalog's capability coverage and correctness within the declared supported scope; refusing everything must not earn a perfect learning score.

### Regression record

When preview feedback reveals a defect, preserve a minimal redacted case, its paired non-applicable task and the original failure before fixing it. Attach the issue, code version, oracle and evidence digest. Do not retroactively count the fixed example as unseen acceptance evidence. Retest neighboring families when a fix changes a shared trust, scope, evidence or lifecycle mechanism.

## 17. Preview selection and expansion

Select preview tests against the features actually enabled. A document-analysis family does not require adding that feature before a Windows coding-agent preview. It does require safe abstention if such content appears in an otherwise supported session.

For each enabled activation path, exercise a real positive correction and later task, then the boundaries below. Tie selected cases to the exact installed artifact and declared host support.

| Priority | Coverage to select | Release interpretation |
|---|---|---|
| Before enabling the affected preview behavior | Consent and authority (TRU-01 to TRU-04); unknown or borrowed proof (CAU-02, CAU-04, CAU-06, VER-03, VER-06); scope mismatch (SCP-02, SCP-04, SCP-05); conflicts and stale state (LIF-03, LIF-05 to LIF-08); process cleanup (SYS-03, SYS-04, SYS-07, SYS-08); candidate isolation, mute and stale-notice boundaries (UX-04). | Known unsafe activation, leakage, resurrection, muted-content delivery or a blocked foreground host needs a fix or disabling the affected path. Unknown safety results are not zero. |
| During a bounded preview | Wording and temporal variations, new independent workflow families, ranking and notification usefulness, controlled load, cohort observations and unexpected user corrections. | Turn misses and false candidates into regression families. Retain declared scope and stop conditions. |
| Before claiming broader automatic learning | New C families with supported source representation, independent verification, scope handling and native later-task evidence. | A wider extractor prompt alone does not expand the verified capability boundary. |
| Before quality or benefit claims | Full quantitative acceptance, independent labels, installed observation coverage, controlled comparisons and release evidence. | Use the existing release policy and evaluator. This catalog does not waive those gates. |

Track implementation status separately as proposed, fixture_ready, oracle_reviewed, automated, native_observed, blocked or retired, with artifact links for transitions. Do not mark the catalog itself passed because its rows have been written.
