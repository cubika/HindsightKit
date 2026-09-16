# WorkIQ mail

ProvenLoop's optional WorkIQ adapter implements the [connector contract](connectors.md). Hindsight continues to own memory extraction, consolidation, storage, and recall. The adapter owns mailbox scope, text cleanup, reliable delivery, and its local settings page. WorkIQ must already be installed before the adapter can run. It does not modify the official Hindsight UI.

## Configuration and lifecycle

`provenloop connectors` opens a local settings page on the server installation and starts its background process. Closing the browser leaves synchronization running. The page shows the current WorkIQ account without an account selector. Each run checks the current account, then binds all reads to that account. A changed default account pauses the next run. Credentials remain with WorkIQ.

The user selects folders, a historical lookback in days, and a future synchronization interval in minutes. Zero minutes means manual synchronization. The initial preferences select Inbox and the DSAPISOT subtree, excluding the Sev3 and PullRequests subtrees beneath DSAPISOT. Names are matched against the actual mailbox; unresolved names are shown rather than silently replaced.

Starting a connection fixes its historical start date. Each scan has a fixed upper bound and resumes incomplete pages before beginning another window. Folder changes apply to future reads; they do not erase prior memory. Extending the lookback backfills the expanded range. A six-hour overlap catches delayed mail. This implementation uses window polling, not delta or deletion tracking. A missing message or a folder removal is not proof of permanent mailbox deletion.

The process exposes only loopback HTTP, checks local requests, and never lets a model choose mailbox paths or tools. It uses the current account to discover identity, then binds reads to that verified account. It does not execute mail instructions, send mail, download attachments, or follow body links.

## Content and memory

Fetch structured metadata before bodies. Skip unchanged content, drafts, excluded folders, and previously rejected source versions. Reuse the WorkIQ MCP session and bound body concurrency. Clean HTML deterministically, removing remote and executable markup, recipient headers, signatures, boilerplate, and repeated quoted material. Preserve actual findings, conditions, ownership, and dates. Attribution and source URLs are metadata, not a pasted From/To envelope. Never pass bodyPreview off as complete text.

Courtesy messages, event promotion, surveys, and routine notifications should yield no memory unless they contain an actual work finding. Treat plans, reported results, uncertainty, and later corrections distinctly. Hindsight receives bounded JSONL records that keep the current author/date separate from unknown historical quotation. A short current reply can qualify quoted evidence. Exact quotation hashes already imported in the same thread mark that text as context only. Only one message per thread is submitted in a batch. The ledger stores hashes, not a second copy of accepted text.

The mail bank uses custom extraction instructions, 4,000-character chunks, and explicit consolidation after the scan, so extraction does not compete with consolidation throughout a backfill. Raw facts become searchable before consolidation completes. Recall uses native keyword and semantic retrieval, disables graph and temporal expansion for this bank, prefers observations over their supporting facts, and includes source facts for attribution. Precise log timestamps should be checked in the source text; Hindsight's structured event timestamps are not a lossless log index.

Import into a dedicated mail bank with stable source document IDs and source metadata. Revisions replace the same document; duplicate retries reuse an operation UUID. The local operational ledger stores settings, versions, cursors, and bounded pending payloads, not a second searchable memory store. Commit a page checkpoint only after its work is durable. Mark a document imported only after the official operation completes without extraction errors. Track consolidation separately. Remove empty, noise-only test documents and retain no rejected mail body indefinitely.

Imported mail is accessible through a read-only `recall_mail` tool in the local MCP server. Fixed-bank remote clients do not gain access to this separate mail bank. Repository retain and shared memory routing stay intact. The settings page links to the official Hindsight bank view.

## Interface

Use a small, responsive page with account status, a folder tree, lookback and interval controls, preview, start/pause, and synchronize now. Show simple counts for scanned, imported, skipped, failed, and pending items, plus the last successful run and next scheduled run. A preview compares source text, cleaned text, and exclusion reasons. Errors remain visible and can be retried. No dashboard framework or copied memory browser is needed.

## Validation

The user authorized access to all email and real tests through the configured model provider. Test the preferred folders first, honoring the two excluded subtrees. Keep private samples and reports outside Git, and use disposable mail banks. Review actual cleaned bodies, extracted facts, consolidation, and recall against source evidence. Compare the same examples when changing cleanup or extraction settings, then check fresh examples. Inspect usefulness, omissions, duplicates, attribution, obsolete claims, and elapsed time. A completed API job alone is not a quality result.

Delete each test bank and its pending work before retesting a changed approach. Preserve unrelated memory and services. Test pagination, restart, idempotency, account changes, cancellation, folder exclusions, malformed bodies, model failures, and UI error states. Run the repository suite and real browser checks before merging. Record the final sample size, actual outcomes, limitations, and cleanup results here without private mail content.

### Observed results, September 16, 2026

The current mailbox returned 43 folders. The suggested scope resolved to Inbox, Inbox / DsApiSOT, and Inbox / DsApiSOT / Directory API team ICM. Pull requests and the nested Sev3 subtree were excluded. A bounded read of 36 messages took 24.8 seconds before explicit-account startup hardening; bound startup and an account recheck added roughly 13.5 and 8.1 seconds in separate probes. This is sample acquisition timing, not a daily mailbox throughput claim.

Real samples exposed meeting transport text, automated monitor tables, subscription footers, a protected body, and excessive HTML. Cleanup now removes those exact forms while retaining substantive automated review comments. Protected or oversized messages produce individual error receipts without blocking the remaining page. A bare review request is rejected before the model.

The first model run extracted 34 facts from ten submitted emails in 84.7 seconds and finished consolidation plus recall in 427 seconds. Review found duplicate quoted facts, wrong author attribution after chunk boundaries, a substituted exception name, and an unresolved investigation presented without its latest status. JSONL attribution, exact quotation context, explicit uncertainty rules, and small batches corrected these cases. Trials with larger chunks and overlapping model operations encountered repeated upstream Copilot timeouts; they were stopped and cleaned, not counted as passes.

The final acceptance set contained 13 real emails, including technical discussion, later corrections, an invitation, an automated alert, and a bare review request. After rejection and cleanup, nine source documents produced 21 source facts and 15 observations. Extraction took 345.2 seconds; consolidation and the query checks brought the run to 592.1 seconds on the configured gpt-6-astra/xhigh provider. The durable queue had no pending payloads afterward. All test banks were removed and checked through the official API.

Independent source review confirmed the API-specific percentile and consistency conditions, compatibility exceptions, distinct error names, unknown quoted authors/timezones, and the latest unresolved investigation status. Later replies added their new explanation or responsibility without re-extracting the prior quoted diagnosis. Four work questions returned a relevant principal finding first; supporting facts, document IDs, and Outlook URLs were available for the first five results. The remaining result tail can still include unrelated facts, so recall output is evidence for the answering agent to select, not a ready-made answer.

The page passed real discovery, save/reload, two five-message previews, and desktop/mobile checks at 1280, 800, 390, and 320 pixels. Source HTML remained inert, selections survived polling, and no horizontal overflow or console errors remained. The final small failure-list addition passed synthetic DOM checks; a browser was unavailable for a new screenshot of that addition.

Model latency remains the main constraint. This test establishes useful extraction on the inspected examples, not a guarantee that a large historical mailbox finishes quickly or that every future fact is correct. Queue state and failures remain visible, and the existing model configuration is preserved.

A separate one-day scan through the real source and a recording test receiver processed 49 emails: 39 candidates, two deterministic skips, and eight protected bodies. After fixing a metadata/body revision race, repeating the scan submitted no unchanged content and kept the eight protected items visible for retry. This check did not call a model.
