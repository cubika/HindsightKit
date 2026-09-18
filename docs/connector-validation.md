# Connector validation log

## September 18, 2026: status and memory test consolidation

The integrated status, lifecycle, connection, packaging, and installer run passed 121 tests in 377.7 seconds. Default status checks made no model calls. The optional local-memory test preserved service and connection failure results, skipped stopped or client-only installations, and never wrote a remote test bank. Connector services and memory responses used isolated fixtures; no mailbox or live memory server was accessed.

## September 18, 2026: unshare progress message

The focused lifecycle, remote command, and UI run passed 42 tests in 10.1 seconds. The server unshare fixture checked the restart message, key rotation, local client access, and disabled sharing. Connector responses and service operations were mocked; no mailbox, model, or live memory server was accessed.

## September 18, 2026: device sign-in browser opening

The focused relay, remote command, and lifecycle run passed 68 tests in 11.0 seconds. Tests covered Microsoft and GitHub sign-in pages, manual fallback after browser launch failures, visible terminal output, cached login reuse, and background recovery without opening a browser. Lifecycle fixtures used synthetic connector responses; no mailbox, model, or live memory server was accessed. The installed Dev Tunnels CLI help confirmed the device-code option, and Microsoft's device sign-in URL resolved to its login page. Browser launch and account sign-in were mocked; real desktop login and cross-machine connectivity were not exercised.

## September 18, 2026: command and installation cleanup

The repository suite passed 492 tests in 492.9 seconds after separating the CLI, installer, runtime helpers, and service operations. A final 63-test regression passed after startup rollback and server relay recovery were tightened. Fixtures covered failed connection rollback, remote-client refresh during full upgrades, discovery validation, shared PowerShell rules, and sessions switching A to B and back without uploading old transcripts. MCP tests included optional mail tools; no mailbox or model was accessed. One early test lacked an integration mock and changed managed editor paths; those paths were restored to the installed launcher and checked for temporary-path remnants, and the fixture was corrected.

## September 18, 2026: relay account selection

The focused relay, remote command, lifecycle, and native launcher run passed 71 tests in 24.1 seconds. Checks covered Microsoft and GitHub selection, cached login reuse, failed login preservation, worker restart after login, and repeated attempts to access an unavailable saved tunnel. Lifecycle fixtures included connector shutdown and memory pause/resume; no mailbox or model was accessed. An initial test fixture intercepted Windows directory-permission setup; isolating that setup corrected the fixture, and the focused run passed. Both command help pages listed the account choices. Real account login and cross-machine connectivity were not exercised.

## September 18, 2026: CLI memory lifecycle

The repository suite passed 439 tests in 630.7 seconds. After integrating the relay sign-in update and hardening API shutdown, 135 affected installation, lifecycle, relay, MCP, and integration tests passed in 286.0 seconds. After integrating dependency-cache reuse, another 120 component/lifecycle tests and 50 installation tests passed. MCP dispatch tests used synthetic SDK responses: `stop` blocked core tools and `recall_mail` before transport or SDK work; `start` restored access, and `unshare` required a new connection. Hook fixtures confirmed that sessions spanning a pause are not saved retroactively. The official API-key extension rejected revoked keys. No mailbox, model, or live memory server was accessed.

## September 18, 2026: relay sign-in regression

The repository suite passed all 427 tests in 529.3 seconds after the relay login changed to device-code authentication. Connector fixtures passed without mailbox reads, model calls, or changes to imported memory. Relay checks covered terminal inheritance, login failure and timeout guidance, saved authentication, and background recovery. Microsoft's installed CLI help confirmed the device-code option; account sign-in and access from a second computer were not exercised.

## September 17, 2026: repository memory switch

Synthetic MCP dispatch checks verified that `memory off` blocks `recall_mail` along with the core memory tools before transport startup, bank discovery, or SDK calls. Re-enabling the same MCP process restored access. Existing mail tests now use MCP dispatch so they exercise this guard. The focused `test_m*.py` run passed 163 tests. After integrating the mail batching revert from master, the final `python -m unittest discover -s tests -v` run passed all 397 tests in 396.2 seconds, including connector fixtures. No mailbox, live memory bank, or model was accessed.

Record connector test scope, sample selection, procedures, measurements, failures, cleanup or retention, and conclusions here. Keep mailbox contents, credentials, and opaque cursors out of Git. The entries below describe their recorded runs, not the current state of a particular installation. No live tests were rerun during the documentation review.

The message-level importer was replaced by the [current thread-outcome contract](workiq-mail.md). Its earlier extraction results are retained as history and do not validate that contract. In particular, the earlier acceptance of PR-specific findings does not satisfy the current shared-memory scope.

## September 16, 2026: historical message-level importer

### Source reads and cleanup

Discovery returned 43 folders. The selected scope included Inbox and two nested work folders, with review and alert subtrees excluded. Reading a bounded sample of 36 messages took 24.8 seconds before explicit-account startup hardening. Bound startup and an account recheck added approximately 13.5 and 8.1 seconds in separate probes. These measurements describe sample acquisition, not daily mailbox throughput.

The sample exposed meeting transport text, automated monitor tables, subscription footers, a protected body, and excessive HTML. Cleanup was adjusted to remove those forms while retaining substantive automated review comments under the rules used at the time. Protected or oversized messages produced individual error receipts without blocking the page. Bare review requests were rejected before model processing.

A separate one-day scan used the real source and a recording test receiver. It processed 49 messages: 39 candidates, two deterministic skips, and eight protected bodies. A metadata/body revision race was corrected. Repeating the scan then submitted no unchanged content and kept the eight protected items visible for retry. This check made no model calls.

### Extraction and recall

The first model run extracted 34 facts from ten emails in 84.7 seconds; consolidation and recall finished in 427 seconds. Review found duplicate quoted facts, incorrect attribution after chunk boundaries, a substituted exception name, and an unresolved investigation missing its latest status. JSONL attribution, exact quotation context, explicit uncertainty rules, and smaller batches corrected those cases. Larger chunks and overlapping model operations encountered repeated upstream Copilot timeouts. Those trials were stopped and cleaned up, and were not counted as passes.

The final acceptance set contained 13 real emails covering technical discussion, corrections, an invitation, an automated alert, and a bare review request. Nine accepted source documents produced 21 source facts and 15 observations. Extraction took 345.2 seconds; consolidation and query checks brought the run to 592.1 seconds with gpt-6-astra/xhigh. The queue had no pending payloads afterward. All test banks were removed and their removal checked through the official API.

Independent source review checked percentile and consistency conditions, compatibility exceptions, distinct error names, unknown quoted authors and timezones, and the latest unresolved status. Later replies added their own explanation or responsibility without re-extracting the earlier quoted diagnosis. Four work questions returned a relevant principal finding first. The first five results had supporting facts, document IDs, and Outlook URLs. Unrelated facts remained possible farther down the result list, so recall still required selection by the answering agent.

These small samples established useful extraction on the inspected material. They did not establish full-mailbox throughput or the accuracy of future outcomes. Model latency remained the main constraint.

### Settings UI

The page passed real discovery, save/reload, two five-message previews, and layout checks at widths of 1280, 800, 390, and 320 pixels. Source HTML remained inert, selections survived polling, and no horizontal overflow or console errors remained. A later failure-list addition passed synthetic DOM checks; a browser was unavailable for a new screenshot of that addition.

## September 17, 2026: historical message-level demonstration

Nine real messages passed through the production WorkIQ reader and durable queue. Five source documents contained 11 source facts and nine observations; four messages were skipped. No pending or failed deliveries remained. Extraction took 161.7 seconds.

Official API reads confirmed completed consolidation, Outlook source links, and useful recall for propagation, payload compatibility, and queue diagnostics. The selection did not cover the full configured seven-day range. Automatic synchronization was off. The records were test data, and their retention through the subsequent installation reset was not verified by the documentation change.

## September 17, 2026: acceptance contract change

Review identified two problems: temporary PR/repository findings entered shared memory, and a growing thread could create multiple durable message documents. The contract changed to one current outcome per thread, containing the problem, supported conclusion, known fix and owner, verification status, and necessary conditions.

At that point the implementation was pending; the decision itself was not a runtime result. The following lifecycle and source runs evaluated the replacement implementation. The earlier message-level results remain separate.

## Optional connector host checks

A local HTTP check loaded the catalog and WorkIQ settings, verified the installed prerequisite, and shut down without creating a mail directory or fetching account data. Synthetic UI checks covered missing dependencies, disabled actions, navigation, and plain-text rendering. No browser was available for new catalog screenshots.

## September 17, 2026: current thread outcomes

### Lifecycle and evidence validation

The importer changed to preparing one outcome per changed thread and replacing a stable document through the official Hindsight SDK. The previous per-message extraction and quotation ledger were removed. Source bodies were used for bounded preparation, and the prepared outcome was stored through chunks mode as one world unit with observations disabled.

`tests/live_thread_lifecycle.py` ran against a local Hindsight 0.10.0 service. Direct SDK checks passed for replacement, reuse of an operation UUID, invalid-update rejection without losing the accepted document, and withdrawal with no remaining recall result. A second scenario used the real `MailSync` runner with synthetic source and composer fixtures. Multiple pages became one update, the document ID stayed stable, obsolete text left recall, an unchanged scan made no new source/composer calls, and withdrawal cleared the document, memory, and pending payload. Both disposable banks were removed and checked. These scenarios made no model calls.

Independent review found four weaknesses in evidence validation: a negated refutation could permit withdrawal, a short excerpt could hide negated verification, a numeric substring could support a different value, and new confirming evidence could be lost when the wording stayed unchanged. Fixes and regression tests added sentence-context checks, numeric token and unit checks, and provenance updates for new evidence. These checks reduce structural errors but do not prove semantic accuracy.

### Bounded real-mail run

Discovery covered selected work folders while excluding review and alert subtrees. Five metadata pages contained 291 messages across 194 conversation IDs in a seven-day window. Four threads were selected: one repository review and three substantive investigations. Their complete context within the selected folders contained 16 messages. Quotation packing reduced the three substantive inputs from 12,679/4,418/26,625 characters to 4,408/1,516/4,368, while retaining verified authors and dates. The repository review was rejected before a model call.

The first queue-related outcome omitted a diagnostic time window and exposed an upstream SDK shutdown notification error. The prompt was corrected to preserve material diagnostic windows. Composer cleanup switched to abort, disconnect, runtime stop, and removal of its temporary session directory. Subsequent preparation completed without the unsupported shutdown callback error.

The first publication pass retained two outcomes but held the queue investigation for evidence review. Numeric validation had rejected legitimate `QueueTimeMs=789615` and `LimitMs=20000` evidence because it recognized suffix units but not units in field names. A regression fix recognized numeric values assigned to identifiers ending in `Ms` as milliseconds. Numeric substring matches and unsupported conversion to seconds remained rejected. The held thread was retried without rebuilding successful outcomes.

The first pass took 294.2 seconds. The successful retry took 151.5 seconds, including discovery and publication. A later scan created no outcomes, updates, or withdrawals, and left three current records with zero failures and zero pending work. These were small-sample runs with gpt-6-astra/xhigh, not full-mailbox throughput measurements. Omitted threads did not advance full-history checkpoints.

At read-back, `hindsightkit-mail` contained three documents and three world units, with no observation duplicates or PR-review documents. All three outcomes remained unresolved. They preserved the problem, supported conclusion, conditions, and supported proposals without inventing completed repairs or fix owners. The queue outcome included later September 11 evidence that the original error was no longer reported while distinguishing a backend fallback from a verified final client result.

Independent read-back checked exact excerpts, numeric values and units, unknown event times, and the contents of all three outcomes. Three service questions each returned the corresponding outcome first. Those three records were deliberately retained for inspection at the end of the run.

### UI and repository regression

Source and UI checks separated metadata messages enumerated, selected threads analyzed, and current outcomes stored. The UI exposed current outcomes and the latest scan's imports, updates, and withdrawals. Source-preview labels stated that no outcome analysis had yet occurred.

The combined repository suite passed 175 tests. JavaScript syntax, synthetic DOM checks, and a local HTTP check of the English outcome labels and state response passed. No browser was available for new screenshots. The direct and runner lifecycle checks also passed and deleted their disposable banks.

## September 17, 2026: metadata and tags

### Source metadata and label ownership

Read-back showed that the thread rewrite retained status, evidence, source links, last-supported time, and revision, but omitted source subject, author, date, and folder fields. The official document list also displayed only a subset of metadata fields; that display limit was separate from the missing data.

Three retained outcomes were enriched through the official same-document API with titles, subjects, supporting-message authors and timestamps, source folders, and message counts. Evidence and unknown quoted attribution were preserved. No model calls were made. Text bodies and content hashes were unchanged, and the bank still held three documents and three world units. Source reads were limited to those threads in the selected folders. All three records retained unresolved status.

`tests/live_thread_metadata.py` verified propagation to document and memory, unchanged text/hash, one memory unit, preservation of a user tag, and positive/negative filtered recall. The disposable-bank test passed and removed its bank. An initial probe failed because it compared tag arrays in order; tags are returned as a set. Set comparison corrected the assertion, and read-back succeeded.

Regression review also found two label-ownership problems: a tag added after failed publication could be lost on retry, and an existing user tag matching a generated label could be claimed by the connector. Tests were added for both cases. Recovered user labels were reconciled through an official tag update after publication without changing the frozen request. Date comparisons were changed to compare instants across UTC offsets.

### Generic content tags

The initial system-specific field was replaced with `content_tags` in the shared `topic:` namespace. The outcome model selected labels in its existing structured response, with no extra call during normal ingestion. Validation covered occurrence in accepted text, length, count, case/whitespace duplicates, and supported characters. Fixed source/kind/status labels and user-label ownership were preserved.

One isolated Copilot request selected labels for the three existing outcomes from their accepted text. It took 29.7 seconds and did not rewrite the outcomes. All labels passed the shared validator. This was a one-time backfill, separate from normal ingestion.

After confirming that no prepared publication was pending, an official API update replaced the connector-owned system labels and preserved other user labels. All three text bodies, hashes, and provenance stayed unchanged, with three documents and three world units remaining. The live metadata test verified positive and negative topic-filtered recall and removed its disposable bank. Regression cases covered namespace migration, ownership collisions, case and whitespace, Unicode terms, punctuation-bearing identifiers, and labels absent from the final text.

## September 17, 2026: installation and release regression

Integration of metadata changes with the release installer passed 222 repository tests, including connector fixtures. These tests made no mailbox reads or model calls and did not change imported memory. The release setup stopped the managed connector host before replacing runtime components while preserving saved settings.

The subsequent connection-command and authenticated-release regression passed 270 tests, including connector fixtures. It made no mailbox reads, model calls, or imported-memory changes. A private relay check used synthetic HTTP responses and removed its workers and tunnels.

The v0.1.0 hosted release CI runs also passed all 270 tests without a mailbox account or Copilot model calls. Packaging and installation results are recorded in [release verification](release-validation.md). These fixture and packaging passes do not establish that every user's dependency downloads or fresh installation will succeed.

The v0.1.1 candidate CI passed 303 repository tests, including connector fixtures, without live mailbox reads. Its installation acceptance used a disposable synthetic memory to verify upgrade preservation and then removed that bank. Python bundle and affected-network installation evidence is recorded in [release verification](release-validation.md).

The final v0.1.1 release builds also passed 303 tests, including those fixtures. The actual local installation and repeat-install checks preserved the server profile, database metadata, and a pre-install synthetic memory; that temporary bank was deleted afterward. No live mailbox read was part of these acceptance checks.

The v0.1.2 client-installation candidate passed 323 tests, including connector fixtures. No live mailbox acquisition was used. Client-only setup on an existing full installation left its server and database configuration unchanged; packaging and installation evidence is in [release validation](release-validation.md).

The published v0.1.2 builds also passed 323 tests and final full/client package checks. No mailbox reads or model calls were part of the isolated client-installation acceptance.

The v0.1.3 installation changes, integrated with the current mail connector changes, passed all 358 repository tests. Connector checks used fixtures; no mailbox reads or model calls were made.

Removing the bundled Copilot CLI passed 369 repository tests; after integrating newer master changes, the 80 affected mail source and sync tests also passed. All connector checks used fixtures.

The v0.1.4 repository-memory switch candidate passed all 397 tests. Connector checks used fixtures without mailbox reads or model calls.

## September 18, 2026: mail ledger and session refactor

The repository suite passed all 503 tests with `PYTHONPATH` set to the checkout's `src` directory. The local virtual environment otherwise imported an older installed package. The 16 connector registry tests also passed after removing an unused test import. After integrating the newer device sign-in change, all 254 affected mail, connector registry, relay, remote setup, and lifecycle tests passed. Checks used synthetic data and made no mailbox reads or model calls.

Regression cases verified index creation after migration of an older ledger, preservation of discovery errors, folder filtering and thread deduplication, matching active and saved status, the ten-item failure limit, and read-only snapshots. Existing publication recovery and cancellation tests passed. New session-creation timeout and cancellation tests verified runtime cleanup and the prefilter's uncertain result on timeout.

An in-memory SQLite benchmark used 100,000 synthetic sources across 10,000 threads and 200 thread lookups per round. The median of three rounds was 1.86 ms with the production indexes and 1,140.86 ms after dropping the thread index. The query plan changed from an indexed search to a table scan. These measurements cover the local lookup only; they do not measure mailbox or model throughput.
