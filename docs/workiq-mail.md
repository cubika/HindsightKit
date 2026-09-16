# WorkIQ mail

ProvenLoop adds one optional mail importer around the official WorkIQ and Hindsight clients. Hindsight continues to own memory extraction, consolidation, storage, and recall. The importer owns mailbox scope, text cleanup, reliable delivery, and its local settings page. It does not modify the official Hindsight UI.

## Configuration and lifecycle

`provenloop connectors` opens a local settings page and starts its background process. Closing the browser leaves synchronization running. The page shows the current WorkIQ account without an account selector. A changed account pauses existing work until the mailbox is checked again. Credentials remain with WorkIQ.

The user selects folders, a historical lookback in days, and a future synchronization interval in minutes. Zero minutes means manual synchronization. The initial preferences select Inbox and the DSAPISOT subtree, excluding the Sev3 and PullRequests subtrees beneath DSAPISOT. Names are matched against the actual mailbox; unresolved names are shown rather than silently replaced.

Starting a connection fixes its historical start date. Each scan has a fixed upper bound and resumes incomplete pages before beginning another window. Folder changes apply to future reads; they do not silently erase prior memory. A short overlap catches delayed mail. Delta is enabled only after the current WorkIQ path, pagination, and restart behavior have been verified; window polling must not claim deletion tracking. A missing message or a folder removal is not proof of permanent mailbox deletion.

The process exposes only loopback HTTP, checks local requests, and never lets a model choose mailbox paths or tools. It uses the current account to discover identity, then binds reads to that verified account. It does not execute mail instructions, send mail, download attachments, or follow body links.

## Content and memory

Fetch structured metadata before bodies. Skip unchanged content, drafts, excluded folders, and previously rejected source versions. Reuse the WorkIQ MCP session and bound body concurrency. Clean HTML deterministically, removing remote and executable markup, recipient headers, signatures, boilerplate, and repeated quoted material. Preserve actual findings, conditions, ownership, and dates. Attribution and source URLs are metadata, not a pasted From/To envelope. Never pass bodyPreview off as complete text.

Evaluate complete threads and substantive short replies. Courtesy messages, event promotion, surveys, and routine notifications should yield no memory unless they contain an actual work finding. Treat plans, reported results, uncertainty, and later corrections distinctly. Use Hindsight bank extraction instructions first; add further screening only if actual samples show that it improves accuracy at an acceptable cost.

Import into a dedicated mail bank with stable source document IDs and source metadata. Revisions replace the same document; duplicate retries reuse an operation UUID. The local operational ledger stores settings, versions, cursors, and bounded pending payloads, not a second searchable memory store. Commit a page checkpoint only after its work is durable. Mark a document imported only after the official operation completes without extraction errors. Track consolidation separately. Remove empty, noise-only test documents and retain no rejected mail body indefinitely.

Make imported mail accessible through a read-only mail recall tool in the existing MCP server. Repository retain and shared memory routing stay intact. Link the settings page to the official Hindsight bank view.

## Interface

Use a small, responsive page with account status, a folder tree, lookback and interval controls, preview, start/pause, and synchronize now. Show simple counts for scanned, imported, skipped, failed, and pending items, plus the last successful run and next scheduled run. A preview compares source text, cleaned text, and exclusion reasons. Errors remain visible and can be retried. No dashboard framework or copied memory browser is needed.

## Validation

The user authorized access to all email and real tests through the configured model provider. Test the preferred folders first, honoring the two excluded subtrees. Keep private samples and reports outside Git, and use disposable mail banks. Review actual cleaned bodies, extracted facts, consolidation, and recall against source evidence. Compare the same examples when changing cleanup or extraction settings, then check fresh examples. Inspect usefulness, omissions, duplicates, attribution, obsolete claims, and elapsed time. A completed API job alone is not a quality result.

Delete each test bank and its pending work before retesting a changed approach. Preserve unrelated memory and services. Test pagination, restart, idempotency, account changes, cancellation, folder exclusions, malformed bodies, model failures, and UI error states. Run the repository suite and real browser checks before merging. Record the final sample size, actual outcomes, limitations, and cleanup results here without private mail content.
