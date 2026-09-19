# WorkIQ email

The optional WorkIQ connector keeps one current outcome for each useful email thread. It prepares the outcome through the official Copilot SDK, then uses the official Hindsight SDK to store and recall it. Hindsight stores each prepared outcome in `chunks` mode as one searchable world memory unit. Observations and automatic consolidation are disabled for this bank, so publication does not add a second model extraction pass.

Ordinary `recall`, `reflect`, and automatic prompt recall include these outcomes through the [shared retrieval path](connectors.md#search-imported-knowledge). Questions do not need to mention email. Pausing synchronization preserves access to imported outcomes; retrieval does not fetch new messages.

## Configure mail synchronization

WorkIQ 1.0.0 must already be installed and signed in. The current adapter verifies the supported Windows x64 executable. Outcome preparation requires the `github-copilot` provider and a configured model; it uses the existing model and reasoning settings.

1. Run `hindsightkit connectors` on the server computer and open WorkIQ email.
2. Discover the current account and its folders. Select the folders to read, a historical lookback, and a synchronization interval. Review the selection before saving it.
3. Use **Preview source** to inspect cleaned messages. Preview does not prepare or publish outcomes.
4. Use **Sync now** for one run or **Start sync** to enable synchronization. An interval of zero disables periodic scans; starting an enabled connector still triggers an initial run.

The connector has no account selector. Reads are bound to the discovered account; an account change pauses synchronization. Credentials stay with WorkIQ, and authentication renewal may require signing in through WorkIQ.

Closing the settings page leaves enabled synchronization running. **Pause sync** releases source resources and preserves imported outcomes. `hindsightkit stop` stops the importer before Hindsight; `hindsightkit start` resumes enabled connectors. Settings and delivery state are described in the [connector guide](connectors.md#stored-state).

The folder suggestions still contain rules for a specific mailbox layout. They may produce irrelevant recommendations or unresolved-folder warnings for other users, and folders marked excluded cannot be selected. The saved selection determines the read scope. This limitation has not been generalized in the current implementation.

## What an outcome contains

An outcome records the problem, its latest supported conclusion, and the conditions needed to use that conclusion correctly. It includes a solution, owner, and verification only when the sources establish them. Proposed fixes remain labeled as proposals. Unresolved investigations can still contain useful findings. Status is recorded as unresolved, resolved, or decision.

Requests, guesses, courtesy replies, and routine status messages alone produce no durable outcome. Temporary PR comments and findings useful only within one PR, project, or repository are excluded from shared mail memory. A service investigation may refer to a PR as supporting context without becoming a code review. The applicable service and operation remain explicit.

The outcome omits the sequence of discussion steps. Relevant evidence is absorbed into the current result, with supporting message IDs and Outlook links retained for traceability. Original messages stay in the mailbox. Source preview preserves the source language; the outcome composer currently writes English.

## Thread updates

A verified mailbox identity and conversation ID determine the stable Hindsight document ID. Subjects do not identify threads. A scan collects changed threads across its pages before preparing a replacement, so several replies can become one update.

| New evidence | Update to the current record |
| --- | --- |
| Adds or corrects a useful finding | Incorporate the finding and its supporting sources. |
| Establishes and verifies a fix | Record the supported solution, owner when known, and verification. |
| Refutes an earlier claim | Correct or remove the claim; withdraw the record when no useful result remains. |
| Shows that the thread is an excluded repository review | Withdraw any previously imported record. |
| Adds only courtesy or repetition | Leave the accepted outcome unchanged. |
| Provides incomplete or unsupported context | Keep the accepted outcome and report the failed update. |

Updates use official replacement and document APIs. A single writer, durable target revision, and operation UUID protect retries and restarts. The prepared replacement is validated before publication. A failed update leaves the accepted result available, and pending work remains visible for retry. A withdrawal removes the current document and its searchable memory.

The page shows the failure count and details after a run finishes. A partially completed run keeps scheduled sync enabled. The next scheduled run, or **Sync now**, retries incomplete updates and scans for new mail; unchanged successful threads are not analyzed again. **Sync now** does not enable a paused schedule. Retry can recover temporary failures, but it does not remove size limits or make unavailable source content readable. Connection and authorization failures are reported separately and may pause the schedule.

Unchanged source content bypasses composition. A reply with no new finding can also return unchanged after composition without another Hindsight write. The connector keeps no permanent draft history or separate memory document for each reply.

## Evidence and provenance

Every published claim must cite an exact excerpt from a supplied message. Validation checks source IDs, excerpts, numeric values and units, supported status, and publication scope. Resolution requires explicit solution and verification evidence. Withdrawal based on a refutation requires a newer direct correction. These structural checks do not establish semantic accuracy on their own.

Message sent time, synchronization time, and actual event or fix time remain distinct. A later courtesy reply cannot undo a verified fix, and a proposed solution cannot establish resolution. The record preserves its latest supporting time and source references. Unknown authors and dates inside quotations remain unknown.

Each published document carries a title, source subject, supporting-message authors and dates, source folders, evidence, links, and revision. Message authors establish provenance; they are not inferred fix owners. Up to six supporting messages are attached to an outcome.

Tags identify source, record kind, status, and up to five distinctive terms that occur in the accepted outcome. Concepts, entities, APIs, and mechanisms use the same `topic:` namespace and validation rules. The outcome call also chooses these tags. Updates refresh connector-owned labels and preserve unrelated user labels.

## Scope and limits

Acquisition uses received-time windows with a six-hour overlap. When a thread changes within that window, the reader fetches its earlier context from the selected folders. It cannot establish completeness outside those folders. Changing the selected folders affects future reads and does not withdraw existing outcomes.

Polling does not mirror mailbox deletions or guarantee detection of edits to older messages. Deleting outcomes in the official UI is not automatically reconciled with the delivery ledger. Rebuilding after an external reset requires a matching empty ledger. A new ledger refuses a nonempty bank, and nonempty legacy message-import ledgers are also refused.

A protected, missing, ambiguous, or oversized thread fails without publishing a partial replacement. The default bounds are 100 messages and 100,000 cleaned characters per thread, with at most 6,000 characters in the outcome. The UI distinguishes messages scanned from current outcomes, and reports imports, updates, withdrawals, failures, and pending threads separately.

The reader removes message envelopes, signatures, boilerplate, repeated quotations, and executable or remote markup while preserving substantive conditions and negation. It does not send mail, download attachments, or follow links in message bodies. Full source bodies are used during preparation and are not stored in the delivery ledger. The ledger retains settings, source metadata, revisions, hashes, and checkpoints; prepared outcomes and their evidence remain pending only until delivery completes.

The composer uses an isolated Copilot session with only its structured result tool. Filesystem, shell, mailbox, MCP, skills, and memory tools are unavailable to that session. Its temporary session directory is removed when preparation ends.

## Validation requirements

Connector changes must check replacement, withdrawal, unchanged-reply idempotency, failed-update recovery, out-of-order evidence, provenance, repository exclusions, and long-thread limits. Lifecycle checks must verify one current document and the removal of obsolete recall results. Record procedures, measured results, cleanup, and limitations in [connector validation](connector-validation.md); historical message-level tests do not validate the current thread contract.
