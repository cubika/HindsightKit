# Local learning viewer

The viewer in `0.1.0-alpha.0.16` includes knowledge management and record cleanup.
It requires canonical schema 23. Use `provenloop upgrade` before opening an older
database. See the [release notes](releases/0.1.0-alpha.0.16.md) for this preview
and its validation limits.

The unreleased distillation work uses schema 20, following schema 19 source-language
search and schema 18 model review
and the schema 17 input-budget fix. New lesson prose is English; source quotations
retain their original language. Source-language discovery and exclusion phrases are
separate index metadata. The work adds model quality review, concise delivery, and recovery
when captured sources change. Learning details show review counts and reasons;
knowledge details distinguish model review from external verification. Overview
checks the repository from which the viewer was launched and explains missing hook
setup. These diagnostics do not prove that a live session has used a rule.
Schema 20 separates automatic expiry from user-controlled states, adds reviewed
replacement/renewal, and distinguishes excluded tasks from conditions shown as Limits.

The input-budget fix selects exact source excerpts
before model dispatch and checks the complete prompt against both size limits.
Learning details distinguish preparation failures from model attempts and show
the one-time recovery request for eligible old input-size failures. An input
that still cannot fit is not resubmitted with the same extractor and revision.

Run the viewer from the existing CLI:

```powershell
provenloop ui
```

The command starts a local web server and opens the default browser. It prints
the address in the terminal. Keep that terminal running; press Ctrl+C to stop.
The operating system chooses an available port. To select a port or open the
browser yourself:

```powershell
provenloop ui --port 4317 --no-open
provenloop ui --data-root C:/path/to/ProvenLoop
```

For a development checkout, build and run the bundled CLI:

```powershell
npm run build
node packages/cli/dist/bin.js ui
```

## What can be viewed

| Page | Contents |
|---|---|
| Overview | Cumulative counts, additions over one and seven days, event distributions, queue depth, database size, knowledge states, usage, and selected data location |
| Knowledge | Searchable rules, applicability, sources, evidence, possible duplicates, and review actions to adopt, edit scope or content, archive, and delete |
| Activity | Event metadata filtered by text or session, with retained content and capture limits on the detail page |
| Work episodes | Goals, recorded outcomes, source events, and outcome evidence references |
| Learning | Job state, attempts, pause reasons, results, proposals, and source references |
| Usage | Recorded context requests, returned guidance, explicit adoption counts, and feedback |

Lists show 40 records per page. Detail sections show up to 100 related records.
Use the Usage page for older context requests. Search matches substrings in the
fields described on each page; Activity search does not scan event content.
Refresh the page to read a new snapshot. All timestamps use UTC.

Episode pages separate last activity from recorded closure. Empty runtime-only
sessions are excluded when episodes are rebuilt. Repository display names use
worktree paths where available; stored canonical IDs remain visible in details.

## Reviewing knowledge

Open a knowledge item to inspect its exact sources and current evidence. Adopt
creates a user-confirmed rule; editing may also correct its scope. Both actions
preserve the old record through a supersession link. They do not label a user
decision as external verification. Review listed counterevidence explicitly
before adopting an item that has contrary evidence.

Archive stops use while preserving history. Delete uses the existing deletion
service and its dependency handling. Each form requires an explicit action and
the current review digest; stale forms must be refreshed. Candidate, active,
and disputed records appear in the default list, with archived and superseded
history available through state filters. Similar-item links are review hints;
the viewer does not merge rules or evidence automatically.

New proposals that pass retention and source checks can be delivered as quoted
user conventions or source references while retaining their `inferred` evidence
label. References include the original tool excerpts and require the captured
worktree and revision. They preserve source findings without establishing a
broader reusable lesson. Task-local constraints remain in their originating
session. The viewer explains this eligibility separately from
stored state. Ordinary legacy candidates remain review-only.

The viewer shows effective automatic-learning eligibility and reasons
it is off. All prerequisites enable it by default; an explicit disable takes
precedence across upgrades and restarts.

The viewer is an explicit local administration surface across the selected data
root. It does not run task retrieval or authorize guidance for another scope.
Knowledge state and evidence tier are shown as stored. Actual delivery still
checks scope, expiry, conflicts, and current evidence. A learning proposal with
no recovery receipt remains unverified. Missing or deleted sources are shown
as unavailable. Usage counts do not establish task success or productivity benefit.

## Local operation

Page reads use a read-only SQLite connection. Explicit knowledge forms use
the existing control services and rebuild the knowledge projection. Browsing
does not initialize installations, migrate schemas, or run learning. SQLite may
create WAL/shared-memory coordination files when opening an existing database.
Database handles and maintenance leases are released after each request. An
upgrade, restore, or incomplete deletion temporarily makes records unavailable.

## Captured-event retention

### Clear all records

To start with an empty record set while keeping the installation and its
configuration, open Overview, expand **Clear all records**, type `CLEAR`, and
select the confirmation checkbox. This removes all events, knowledge, episodes,
learning jobs, usage, queues, indexes, and local record artifacts in the displayed
data root. It also removes ProvenLoop's pre-upgrade database snapshots because
they contain the old records. Plugin/configuration backups are retained.

The Copilot integration, capability settings, project files, and Copilot's own
conversation history remain in place. The same action is available in the CLI:

```powershell
# Preview the selected location and record counts
provenloop records clear

# Clear the records and keep installation/configuration
provenloop records clear --confirm
```

Use `--data-root <directory>` when the viewer uses a custom location. The reset
stops ProvenLoop extension activity and waits for storage users to finish.
Restart Copilot afterward to resume collection with the same settings. A
persistent cutoff prevents old events from being imported again, while new
events remain eligible. A small reset marker is retained for this purpose.

If the process is interrupted after cleanup starts, capture remains paused.
Repeat the same clear action to finish it. The UI offers this retry even while
other records are unavailable. A reset cannot be undone through the viewer.
Logical deletion does not guarantee immediate reduction of SQLite file size.

### Review old sessions

Captured events is a cumulative record count. It includes tool starts, results,
messages, and supported derived evidence. Recent additions use ingestion time.
The database size includes SQLite WAL and shared-memory files; the queue count
is separate from cumulative capture. These metrics do not establish learning
quality or confirm that every captured session contains useful work.

Create a review plan for old, closed sessions:

```powershell
provenloop capture retention plan
```

The suggested cutoff is 90 days ago. The plan protects sessions with knowledge
or Branch Context dependencies, unfinished learning, incomplete capture, or
recent activity. It changes no records. To remove eligible sessions, use the
exact cutoff and digest from that plan and select the session IDs explicitly:

```powershell
provenloop capture retention apply --older-than <ISO-time> --expect <digest> --sessions <id,id> --confirm
```

Both commands support `--data-root`. Cleanup uses the existing session-deletion
flow and rechecks eligibility. No background raw-event deletion is enabled. The
plan estimates serialized event bytes; SQLite file size may not shrink after
logical deletion.

The server listens only on `127.0.0.1`. Each launch has a random access path;
use the full printed URL. Treat that URL as local access to the selected data.
Pages reject foreign hosts and cross-origin requests. Writes are accepted only
through the knowledge and reset POST routes with valid form tokens and explicit
confirmation. Pages use no external assets or browser scripts, disable caching,
escape captured content, and redact recognized secret values for display. The
CLI also provides the corresponding review and cleanup commands.

If the data cannot be read, the page shows an error with the selected location.
Check `provenloop version`, `provenloop status`, and `provenloop doctor`. A schema
mismatch requires a matching CLI or the normal upgrade procedure; opening the
viewer does not perform an upgrade.
