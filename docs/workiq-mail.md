# WorkIQ mail

The importer maintains one current outcome per thread. Test procedures, observed results, and remaining limits are recorded in [connector validation](connector-validation.md).

HindsightKit's optional WorkIQ adapter follows the [connector contract](connectors.md). WorkIQ must already be installed. Hindsight owns extraction, storage, consolidation, and recall. The adapter owns source scope, preparation of the current thread outcome, and reliable delivery through official APIs.

## Configuration and acquisition

The settings page uses the current WorkIQ account without an account selector. Users select folders, a historical lookback, and a future synchronization interval. Zero minutes means manual runs. Default folder preferences include Inbox and the DSAPISOT subtree, excluding the Sev3 and PullRequests subtrees. Match actual folders and report unresolved selections. Interface text is English; source content keeps its original language.

An unused connector does not launch WorkIQ, read mail, or create a delivery ledger. Each run verifies the current account and binds reads to it. Pausing releases source resources and preserves accepted memory. Credentials stay with WorkIQ. The local settings service does not execute mail instructions, send mail, download attachments, or follow links in message bodies.

Current acquisition uses fixed time windows with a six-hour overlap, not delta or authoritative deletion tracking. This can miss older modifications and replies outside the selected range. Outcome updates need enough relevant thread context within the authorized scope; missing context must be reported, not treated as a complete investigation. Folder changes affect future reads and do not imply that existing conclusions are false.

## One current outcome per thread

The durable unit is one current outcome document per thread. Replies update that document instead of creating additional permanent message copies or user-facing experiences. A thread can contain several related findings, but they belong in the same concise record.

Keep the information useful after reading the investigation:

- The problem and the affected system or operation.
- The supported conclusion, including any unresolved uncertainty.
- Who owns or applied the fix, which solution was used, and whether it was verified.
- Conditions and limitations needed to apply the conclusion correctly.

Omit fields the evidence does not establish. A suggested fix is not an implemented fix, and a plausible cause is not a confirmed cause. An unresolved thread can still contain a useful diagnostic finding. A thread containing only requests, guesses, courtesy, or routine status produces no durable record.

Do not store the sequence of discussion steps. Omit intermediate dialogue or incorporate the evidence needed to understand the outcome. Original messages remain in the mailbox; retain a small set of supporting message IDs and links instead of copying the complete correspondence into Hindsight.

Exclude temporary PR comments and findings useful only within one PR, project, or repository from shared mail memory. Technical detail alone does not establish lasting usefulness. Do not manufacture a general lesson by rewriting a local review suggestion. Keep the applicable service and operation explicit when a conclusion does qualify.

## Revision behavior

Address a thread by verified mailbox identity and a stable conversation ID, using one deterministic Hindsight document ID. Do not group unrelated messages by subject. Coalesce new replies into one pending thread update, compare them with the existing outcome and necessary source context, and prepare a complete replacement.

| New evidence | Update to the current record |
| --- | --- |
| Adds a useful finding | Incorporate it into the same document. |
| Confirms or corrects a finding | Revise the finding and its supporting sources. |
| Establishes a fix | Add the actual owner, solution, verification, and conditions. |
| Refutes an earlier claim | Remove or correct that claim. |
| Leaves no lasting value | Withdraw the thread record and its searchable derivatives. |
| Adds only courtesy or repetition | Do not write a new version. |

Preserve a rejected explanation only if it is necessary to understand the final conclusion. These updates do not create separate experience objects for each action. There is no permanent history of drafts or per-reply source copies in the connector.

Use official replacement and document APIs. Serialize updates for a thread, persist the target revision and operation ID, and prevent stale retries from replacing newer outcomes. Validate the replacement before submitting it; do not delete the last accepted result before processing a new one. A failed update must leave that result available.

The adapter prepares one evidence-backed outcome through the configured official Copilot SDK. Each claim must cite an exact source excerpt; source IDs, numbers, status, and scope are checked before publication. A new unsupported result leaves the accepted outcome intact. The bounded outcome uses the official Hindsight chunks mode, with observations disabled: it becomes one searchable world unit in one document, without a second model extraction pass. Replacement and withdrawal are verified through the document API and live recall checks.

## Evidence and time

Keep message sent time, synchronization time, and actual event or fix time distinct. A later message may add evidence, change the conclusion, or confirm resolution. It does not automatically override better evidence: a courtesy reply cannot undo a verified fix, and a proposal cannot replace an observed result. Account for late-arriving messages before publishing the current outcome.

Record the last supporting or confirming time and source references for the current conclusion. Unknown quoted authors and dates remain unknown; they do not inherit the outer email's attribution. Track which evidence changed or superseded a conclusion, rather than treating a shared thread ID as proof of that relationship.

Clean mail envelopes, recipient lists, signatures, boilerplate, repeated quotations, and executable or remote markup. Preserve substantive conditions and negation. Temporary processing payloads are bounded and removed after delivery. The operational ledger keeps IDs, revisions, hashes, and checkpoints, not a second searchable memory store.

Metadata remains separate from outcome prose. Each published thread carries its title, source subject, supporting-message authors and dates, source folders, evidence, links, last-supported time, and revision. Source-message authors describe provenance; they do not automatically become fix owners or authors of quoted claims. Tags provide compact filters for source, record kind, current status, and up to five distinctive content concepts or entities grounded in the accepted outcome. Dynamic labels share one topic namespace; systems, APIs, exceptions and mechanisms use the same selection and validation rules. They are produced in the existing outcome call, not a separate tagging pass. Only connector-owned tags are refreshed; unrelated user tags survive subsequent updates. These labels do not create additional memory records.

## Presentation and acceptance

Present one current thread outcome with source links, last update, and resolved or unresolved status. Count source messages separately from retained outcomes. More replies must not cause unbounded growth in durable documents or obsolete recall results.

Validation must replay an initial report, diagnosis, correction, fix, and verification. Check one current document, useful final content, obsolete-claim removal, unchanged-reply idempotency, failed-update recovery, out-of-order updates, source traceability, PR/repository exclusions, and long-thread limits. Maintain the procedures and results in [connector validation](connector-validation.md), updating that file after every new run.

## Implementation limits

Thread context is fetched within the selected folders, including older replies needed to understand a recently changed thread. A protected, missing, ambiguous, or oversized thread is held for review instead of publishing a partial replacement. The limit is 100 messages and 100,000 cleaned characters per thread; outcome content is capped at 6,000 characters. A single writer lock, durable target revision, and operation UUID protect retries and restarts. Original message bodies are not kept in the delivery ledger.

The composer uses one isolated Copilot session per changed thread and permits only its structured result tool. It has no filesystem, shell, mailbox, MCP, skills, or memory tools. The configured model and reasoning settings are preserved. Unchanged source content bypasses composition; a no-op reply can return unchanged without another Hindsight write.

Window polling does not guarantee detection of older mailbox edits or deletions. Deleting outcomes manually in the official UI is not automatically reconciled with the local delivery ledger; rebuilding after an external reset needs a matching empty ledger. Existing message-level ledgers and nonempty unowned banks are refused rather than silently mixed with thread outcomes. HindsightKit does not migrate the deleted pre-rename test installation.
