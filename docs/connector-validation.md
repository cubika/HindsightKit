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

The renamed project is HindsightKit at C:/Users/bili1/source/HindsightKit. This documentation change moved the recorded results without changing their measurements, clarified planned versus existing behavior, and updated documentation links. It did not run new email/model tests, alter stored memory, or verify whether old installation data remains after the rename.

## September 17, 2026: one current outcome implementation

The importer now discovers changed threads, prepares one current outcome, and replaces a stable thread document through the official Hindsight SDK. The old per-message extraction and quotation-memory ledger were removed. Source bodies are fetched for bounded thread preparation and are not retained as separate Hindsight documents. The official chunks mode stores the bounded prepared outcome as one world unit; observation consolidation is disabled for this bank.

`tests/live_thread_lifecycle.py` was run against the actual local Hindsight 0.10.0 service. Direct SDK checks passed for replacement, reuse of an operation UUID, rejection of an invalid update without losing the accepted document, and withdrawal with no remaining recall result. A second scenario used the real MailSync runner with synthetic source and composer fixtures: multiple pages coalesced into one update, the document ID remained stable, obsolete text left recall, an unchanged scan made no new source/composer calls, and withdrawal cleared the document, memory, and pending payload. Both disposable banks were removed and verified. These checks made no model calls.

Independent validation review exposed and corrected four evidence-check weaknesses: a negated refutation could allow withdrawal, a one-word excerpt could hide negated verification, numeric substrings could be accepted as different values, and new confirming evidence could be lost when outcome wording was unchanged. Regression tests cover each case. The composer now checks complete local sentence context for destructive/resolved decisions and matches numeric tokens and units. Such structural checks support, but do not replace, reviewing semantic accuracy.

The initial real-mail discovery covered the configured Inbox and DsApiSOT scope, excluding Pull requests and nested Sev3. Five metadata pages contained 291 messages across 194 conversation IDs in the selected seven-day window. This was metadata enumeration, not full content ingestion. Four threads were selected for this demonstration: the repository-local uniqueness-validation PR, KVCacheTaskQueue, SPO proxy propagation, and InvalidTargetProfile. Complete selected-folder context contained 16 messages. Exact quotation packing reduced the three substantive thread inputs from 12,679/4,418/26,625 characters to 4,408/1,516/4,368 while retaining directly verified authors and dates.

A first KV outcome exposed a missing diagnostic time window and an upstream SDK shutdown notification error. The prompt now preserves material diagnostic windows. The isolated composer closes via abort, disconnect, and runtime stop, then removes its temporary session directory; it no longer invokes the SDK session-delete operation that emitted an unsupported shutdown enum. Subsequent preparation completed without that callback error. The PR thread was rejected before a model call.
