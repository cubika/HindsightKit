# Connector validation log

Maintain connector test procedures, scope, sample selection, actual results, timing, failures, cleanup or retention, and conclusions in this file. Update it after each new run. Keep private email bodies, credentials, and opaque cursors out of Git.

The following entries were moved from the WorkIQ design without changing their measurements. They describe the earlier message-level importer and do not validate the later one-outcome-per-thread contract. Earlier acceptance of PR-specific findings does not satisfy the revised shared-memory scope.

## Observed results, September 16, 2026

The current mailbox returned 43 folders. The suggested scope resolved to Inbox, Inbox / DsApiSOT, and Inbox / DsApiSOT / Directory API team ICM. Pull requests and the nested Sev3 subtree were excluded. A bounded read of 36 messages took 24.8 seconds before explicit-account startup hardening; bound startup and an account recheck added roughly 13.5 and 8.1 seconds in separate probes. This is sample acquisition timing, not a daily mailbox throughput claim.

Real samples exposed meeting transport text, automated monitor tables, subscription footers, a protected body, and excessive HTML. Cleanup now removes those exact forms while retaining substantive automated review comments. Protected or oversized messages produce individual error receipts without blocking the remaining page. A bare review request is rejected before the model.

The first model run extracted 34 facts from ten submitted emails in 84.7 seconds and finished consolidation plus recall in 427 seconds. Review found duplicate quoted facts, wrong author attribution after chunk boundaries, a substituted exception name, and an unresolved investigation presented without its latest status. JSONL attribution, exact quotation context, explicit uncertainty rules, and small batches corrected these cases. Trials with larger chunks and overlapping model operations encountered repeated upstream Copilot timeouts; they were stopped and cleaned, not counted as passes.

The final acceptance set contained 13 real emails, including technical discussion, later corrections, an invitation, an automated alert, and a bare review request. After rejection and cleanup, nine source documents produced 21 source facts and 15 observations. Extraction took 345.2 seconds; consolidation and the query checks brought the run to 592.1 seconds on the configured gpt-6-astra/xhigh provider. The durable queue had no pending payloads afterward. All test banks were removed and checked through the official API.

Independent source review confirmed the API-specific percentile and consistency conditions, compatibility exceptions, distinct error names, unknown quoted authors/timezones, and the latest unresolved investigation status. Later replies added their new explanation or responsibility without re-extracting the prior quoted diagnosis. Four work questions returned a relevant principal finding first; supporting facts, document IDs, and Outlook URLs were available for the first five results. The remaining result tail can still include unrelated facts, so recall output is evidence for the answering agent to select, not a ready-made answer.

The page passed real discovery, save/reload, two five-message previews, and desktop/mobile checks at 1280, 800, 390, and 320 pixels. Source HTML remained inert, selections survived polling, and no horizontal overflow or console errors remained. The final small failure-list addition passed synthetic DOM checks; a browser was unavailable for a new screenshot of that addition.

Model latency remains the main constraint. This test establishes useful extraction on the inspected examples, not a guarantee that a large historical mailbox finishes quickly or that every future fact is correct. Queue state and failures remain visible, and the existing model configuration is preserved.

A separate one-day scan through the real source and a recording test receiver processed 49 emails: 39 candidates, two deterministic skips, and eight protected bodies. After fixing a metadata/body revision race, repeating the scan submitted no unchanged content and kept the eight protected items visible for retry. This check did not call a model.

## Demonstration, September 17, 2026

A bounded selection of nine real messages was processed through the production WorkIQ reader and durable mail queue. Five source documents contained 11 source facts and nine observations; four messages were skipped and no pending or failed deliveries remained. Extraction took 161.7 seconds. Official API reads confirmed completed consolidation, preserved Outlook source links, and useful recall for API propagation, payload compatibility, and queue diagnostics. The scan covered a selected sample, not the full configured seven-day range. This was test data; the project rename resets the local installation instead of carrying it forward. Automatic synchronization remains off.

## Optional connector host verification

The local HTTP check loaded the catalog and WorkIQ settings, verified the installed prerequisite, and shut down successfully without creating a mail directory or fetching account data. Synthetic UI checks covered missing dependencies, disabled actions, navigation, and plain-text rendering. No browser was available for new screenshot checks of the catalog.

## September 17, 2026: revised acceptance contract

User review identified two gaps in the preceding acceptance criteria: temporary PR/repository-specific findings were admitted to shared memory, and a growing thread could create multiple durable message documents. The agreed target is one current outcome per thread: the problem, supported conclusion, actual fix and owner when known, verification status, and necessary conditions. Intermediate dialogue is omitted or absorbed into that outcome.

This records a design decision, not a new runtime result. The thread outcome implementation is pending. Future runs must validate replacement, withdrawal, idempotency, out-of-order updates, provenance, and bounded memory growth against the [WorkIQ design](workiq-mail.md). The preceding extraction results do not establish that these requirements passed.

The renamed project is HindsightKit. This documentation change moved the recorded results without changing their measurements, clarified planned versus existing behavior, and updated documentation links. It did not run new email/model tests, alter stored memory, or verify whether old installation data remains after the rename.

## September 17, 2026: one current outcome implementation

The importer now discovers changed threads, prepares one current outcome, and replaces a stable thread document through the official Hindsight SDK. The old per-message extraction and quotation-memory ledger were removed. Source bodies are fetched for bounded thread preparation and are not retained as separate Hindsight documents. The official chunks mode stores the bounded prepared outcome as one world unit; observation consolidation is disabled for this bank.

`tests/live_thread_lifecycle.py` was run against the actual local Hindsight 0.10.0 service. Direct SDK checks passed for replacement, reuse of an operation UUID, rejection of an invalid update without losing the accepted document, and withdrawal with no remaining recall result. A second scenario used the real MailSync runner with synthetic source and composer fixtures: multiple pages coalesced into one update, the document ID remained stable, obsolete text left recall, an unchanged scan made no new source/composer calls, and withdrawal cleared the document, memory, and pending payload. Both disposable banks were removed and verified. These checks made no model calls.

Independent validation review exposed and corrected four evidence-check weaknesses: a negated refutation could allow withdrawal, a one-word excerpt could hide negated verification, numeric substrings could be accepted as different values, and new confirming evidence could be lost when outcome wording was unchanged. Regression tests cover each case. The composer now checks complete local sentence context for destructive/resolved decisions and matches numeric tokens and units. Such structural checks support, but do not replace, reviewing semantic accuracy.

The initial real-mail discovery covered the configured Inbox and DsApiSOT scope, excluding Pull requests and nested Sev3. Five metadata pages contained 291 messages across 194 conversation IDs in the selected seven-day window. This was metadata enumeration, not full content ingestion. Four threads were selected for this demonstration: the repository-local uniqueness-validation PR, KVCacheTaskQueue, SPO proxy propagation, and InvalidTargetProfile. Complete selected-folder context contained 16 messages. Exact quotation packing reduced the three substantive thread inputs from 12,679/4,418/26,625 characters to 4,408/1,516/4,368 while retaining directly verified authors and dates.

A first KV outcome exposed a missing diagnostic time window and an upstream SDK shutdown notification error. The prompt now preserves material diagnostic windows. The isolated composer closes via abort, disconnect, and runtime stop, then removes its temporary session directory; it no longer invokes the SDK session-delete operation that emitted an unsupported shutdown enum. Subsequent preparation completed without that callback error. The PR thread was rejected before a model call.

The first production run preserved two thread outcomes and held KVCacheTaskQueue for evidence review. The numeric guard had rejected legitimate `QueueTimeMs=789615` and `LimitMs=20000` evidence because it recognized suffix units but not explicit field-name units. The guard now recognizes a numeric value assigned to an identifier ending in Ms as milliseconds, while still rejecting numeric substring matches or conversion to seconds without evidence. This case is covered by a regression test; the held thread is retried independently without rebuilding successful outcomes.

Source and UI verification distinguishes three different counts: metadata messages enumerated, selected threads analyzed, and current outcomes stored. The current demonstration intentionally selects a small set of discussions rather than importing all metadata-enumerated threads. Full-history checkpoints are not advanced for omitted threads. The UI exposes current outcomes plus latest-scan imports, updates, and withdrawals. English source-preview labels explicitly state that preview has not performed outcome analysis.

The final retained demonstration contains exactly three documents and three world units in `hindsightkit-mail`: KVCacheTaskQueue, SPO proxy propagation, and InvalidTargetProfile. There are no observation duplicates or PR-review documents. Each document contains the current problem, supported conclusion, unresolved status where appropriate, conditions, and a proposed solution only when supported. The KV result incorporates the later September 11 evidence that the original queue error was no longer reported and distinguishes a backend fallback from a verified final client outcome. No repair completion or named fix owner was invented.

The successful KV retry took 151.5 seconds including source discovery and publication. A subsequent run created no new outcomes, made no updates or withdrawals, and left three current records with zero failures and zero pending work. The first pass had retained the other two outcomes while holding KV; it took 294.2 seconds. These are measured small-sample runs with gpt-6-astra/xhigh, not full-mailbox throughput. Independent read-back checked exact supporting excerpts, numeric values/units, unknown event times, and all three result contents. Three service questions each returned the corresponding thread outcome first. The successful records are intentionally retained for user inspection.

The final combined repository suite passed 175 tests. The UI JavaScript syntax and synthetic DOM checks passed, and a local HTTP check verified the English thread-outcome labels and state response. No browser was available for a new visual screenshot check in this run. The official direct and runner lifecycle checks also passed, and their disposable banks were deleted. All procedures and results for this revision are recorded here rather than in the design document.

## September 17, 2026: thread metadata and tags

Read-back confirmed that the thread rewrite retained status, evidence, source links, last-supported time and revision, but omitted earlier source subject/author/date/folder fields. Each record also had only a source tag. The official document list displays a small subset of metadata chips, which can hide the remaining fields; this was separate from the actual omitted fields.

The three retained outcomes were enriched with title, original subject, supporting-message authors and timestamps, source folder names/IDs, and message counts. Their existing evidence, links and unknown quoted attribution were preserved. Compact tags now identify source, thread-outcome kind, current status and explicitly named systems. Source authors describe the containing messages and are not inferred fix owners. User-created labels outside the connector's recorded managed set are retained on updates.

The real records were updated through the official same-document API without model calls. Their text and content hashes remained unchanged, and there are still three documents and three world units. The current tags include ManagerChain/KVCacheTaskQueue/DSAPI, PAPI/DSAPI, and SPO/ESS/Admin API/DSAPI, with unresolved status on all three. Source reads were restricted to their selected-folder threads.

The reproducible `tests/live_thread_metadata.py` check uses a disposable bank and verifies metadata propagation to both document and memory, unchanged text/hash, one memory unit, preservation of a user tag, and positive/negative tag-filtered recall. The test passed and the temporary bank was removed. A first probe compared tag arrays in order and failed because the server returns tags as a set; the assertion was corrected to compare sets and the read-back succeeded.

Regression review also found and fixed two user-label ownership cases: a tag added after a failed publication could be lost on retry, and an existing user tag matching a generated system tag could be incorrectly claimed by the connector. The frozen operation request remains unchanged; recovered user labels are reconciled with an official tags update after publication. Source dates are compared as timestamps rather than strings so differing UTC offsets sort correctly. Tests cover these cases along with preserved source metadata and grounded system names.

## September 17, 2026: generic content tags

The systems-only field was replaced with content_tags. Dynamic labels now share the topic namespace and use one set of selection rules for concepts, entities, identifiers and mechanisms. The outcome model chooses them in its existing structured response; no extra tagging call was added to normal ingestion. Validation checks source occurrence in the accepted outcome, length, count, case/whitespace duplicates and supported characters. Fixed source/kind/status labels and user-label ownership behavior are retained.

For the three existing outcomes, one isolated Copilot request selected labels from the already accepted text without rewriting it. It completed in 29.7 seconds. The selected terms included single-master flow, SPO proxy address, all-zero OIDs, -ForReconciliation, DsApiWrongServerException, EntityResolver.ResolveAsync and P2P-to-SNS fallback. These were not selected by exception-specific or service-specific extraction rules. All labels passed the shared validator. This one-time backfill call is separate from normal ingestion.

After confirming no prepared publication was pending, the existing documents were retagged through the official API. Old connector-owned system labels were replaced; other user labels were preserved. All three text bodies and content hashes were unchanged, and the bank still held three documents and three world units. Metadata provenance remained intact. The live metadata test also verified positive and negative topic-filtered recall in a disposable bank, then deleted it. Regression cases cover namespace migration, user-label collisions, case/whitespace handling, Unicode terms, punctuation-bearing identifiers and labels absent from the final text.

## September 17, 2026: installation and release regression

After integrating the metadata changes with the release installer, all 222 repository tests passed, including the connector fixtures. These checks did not read a mailbox, call a model, or change imported memory. Release setup now stops the managed connector host before replacing server runtime components; saved connector settings remain in place. Installation and packaging checks are recorded in [release verification](releases.md#local-verification-september-17-2026).

The later connection-command and authenticated-release regression passed all 270 tests, including the connector fixtures. No mailbox reads, model calls, or imported-memory changes were made. A real private relay test used only synthetic HTTP responses; its workers and tunnels were removed.
