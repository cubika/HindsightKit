# Copilot asynchronous event capture design

**Status:** Extension feasibility passed; full M0 acceptance remains open
**Updated:** 2026-09-07

`0.1.0-alpha.0.11` is a Windows Design Partner Preview evidence candidate. It
includes the native proof bridge, capture quality, bounded current-Session
reconciliation, and trusted live Session controls described here. The historical
minimal Windows 11 Extension probe does not establish native-host acceptance
of the full production path. Each new artifact version needs separate validation;
the `0.1.0-alpha.1` quality-release target remains unapproved.

## 1. Problem

ProvenLoop must capture Copilot CLI user messages, tool execution, Agent
completion, and errors without slowing foreground interaction.

Existing lifecycle Hooks are unsuitable for this work. Measurements on Copilot
CLI `1.0.82-0` showed:

- PowerShell command Hook P95 of about 700 to 800 ms;
- localhost HTTP P95 of about 2 ms;
- about 450 to 1260 ms for Copilot to deliver an event to an HTTP Hook.

Making Hook internals asynchronous only reduces the handler's own work. It
cannot remove latency introduced by Copilot before the handler is called.

## 2. Design decision

Use the Copilot CLI Extension Session event stream as the primary capture entry.
The Extension receives JSON-RPC notifications through `session.on(...)`, then
performs lightweight copying and asynchronous enqueueing in a separate Node process.

```text
Copilot CLI Session
        |
        | session events
        v
ProvenLoop Extension mapper
        |
        | bounded memory buffer
        v
Async queue writer
        |
        | atomic file replacement
        v
Persistent event queue
        |
        v
Leased shared worker -> second redaction -> canonical SQLite
```

The normal capture path installs no command or HTTP lifecycle Hooks. Future
Hooks are reserved for policies that need to change Copilot behavior synchronously,
not telemetry.

OpenTelemetry and Copilot Session files serve reconciliation and recovery only.
They must not become the default content-capture entry.

### 2.1 Why other entry points are unsuitable

The `notification` Hook is fire-and-forget, but covers only background shell,
background Agent, permission, elicitation, and similar notifications. It lacks
user messages, ordinary foreground tools, main Agent completion, and the Session
lifecycle needed for the primary event stream.

SDK programmatic Hooks remain request/response calls, and Copilot waits for the
callback result. They suit permission or tool behavior changes, not telemetry.

Continuously tailing `events.jsonl` adds no foreground latency, but its path and
schema are not a stable external protocol. It suits version-bound recovery, not
the primary live entry point.

Enabling full-content OTel broadens capture to prompts, responses, tool arguments,
and system instructions. Enabling it by default conflicts with data minimization.

## 3. Design goals

The design must meet these requirements:

- paired A/B foreground added latency P95 at or below 10 ms;
- Extension, Worker, or storage failures do not block Copilot;
- recognition accuracy of supported events at or above 95%;
- raw content is redacted before disk persistence;
- duplicate delivery does not create duplicate facts;
- gaps can be detected and persisted events recovered after Extension interruption;
- internal ProvenLoop Sessions never enter the learning queue;
- incompatible event/protocol versions are explicitly rejected. New versions
  with compatible capabilities but no ProvenLoop measurement record are marked
  unverified, separately from incompatible versions.

## 4. Explicit exclusions

F0 and M0 do not:

- implement a general message bus;
- pursue exactly-once delivery across machines;
- parse Copilot's internal SQLite in real time;
- enable OTel containing full prompts and tool results by default;
- start multiple resident services solely for capture;
- call models, GitHub, or other external network services from Extension callbacks.

M0 uses Extension, MCP, and shared Worker modules in one release package. They may
run in separate OS processes and coordinate shared state through leases. This
does not promise a single process or introduce independently deployed microservices.

## 5. Component responsibilities

### 5.1 Copilot Extension

The ProvenLoop plugin provides the Extension, which joins the current Copilot
Session. It:

- subscribes to required Session events;
- reads Session IDs, event IDs, timestamps, and parent relationships;
- identifies internal ProvenLoop Sessions;
- copies fields allowed into the buffer;
- passes events to the asynchronous writer;
- maintains received, dropped, backlog, and gap counts.

Callbacks must not perform synchronous file I/O, network requests, Git queries,
database operations, or content analysis. They perform only bounded memory work.

Repository, Branch, and HEAD come from an asynchronously maintained workspace
snapshot. The Extension creates it at Session start and refreshes it after tools
that may change Git state complete. Callbacks attach the current snapshot without
running Git commands. Unavailable snapshots produce `unknown`; later observations
must not backfill earlier state. Keep `known_repo`, `known_outside_repo`, and
`unknown` distinct. A refreshing or stale workspace cannot issue proof for new
events using the previous Repository.

### 5.2 Memory buffer

Each Extension process maintains a bounded FIFO buffer with both event-count and
total-byte limits. The source defines explicit count, byte, and field limits;
F0 load tests must still establish whether the defaults handle real workloads.

The 0.10 installed entry uses these fixed defaults. Underlying constructors are
configurable, but these are neither new CLI options nor measurements that have
passed performance acceptance on every platform:

| Item | Current default |
|---|---:|
| Callback string copy | 32,768 characters |
| In-memory event buffer | 1 MiB / 1,000 events |
| Separate gap buffer | 128 KiB / 64 contexts |
| Writer retry interval | 1,000 ms |
| Shutdown drain deadline | 5,000 ms |

A full buffer must not silently drop data:

1. Stop accepting new large fields; retain event metadata and content digests.
2. Accumulate missing ranges and event counts.
3. Write a `capture_gap` when the writer recovers.
4. Let the Reconciler attempt recovery while supported Session files retain the events.

`captureQuality` records omitted or truncated fields and their original lengths.
Omitted fields are not complete empty values, and metadata-only events are not
complete verification evidence. Gap aggregation is also bounded. Gaps spanning
workspaces must carry `contextMixed`, rather than being assigned to the first Repository.

This is not normal flow control. Every `capture_gap` affects health status and the
M0 Gate. Capture is bounded best effort, not lossless raw archival. A crash before
durable enqueueing or an exhausted drain deadline can still lose in-memory events
and unpersisted gaps. The absence of a gap record does not prove that no loss occurred.

### 5.3 Asynchronous queue writer

The writer runs inside the Extension process, outside the callback stack. It:

- performs the first secret-redaction pass;
- generates stable event IDs and deduplication keys;
- serializes events into versioned envelopes;
- writes temporary files in the destination directory;
- flushes write handles;
- renames files to their final queue names;
- updates the process's persistence watermark.

Each event has a separate file and unique name. Multiple Copilot Sessions may
write concurrently. An atomic identity index and short-lived operation
coordination handle deduplication; per-event files do not remove the need for
concurrency control.

The writer neither waits for the Worker nor writes canonical SQLite directly.
The queue continues to grow while the Worker is stopped. The durable queue has
no total byte/count quota; the 1 MiB / 1,000-event limit applies only to the memory
buffer. The Worker's 10,000-event queue-depth threshold signals pressure, not a
disk-capacity ceiling. The current per-item read safety limit is 2 MiB, and the
default worker batch is 100 events.

After acquiring its lease, the Worker prunes acknowledged queue items older
than seven days and their related state/source indexes. This does not expire
pending/dead-letter items or define canonical Raw Event retention. These
underlying defaults have no corresponding new installation CLI options.

### 5.4 Shared Host and Worker

The existing Host continues to handle:

- claiming and acknowledging queue items;
- schema validation;
- the second redaction pass;
- adapter-version checks;
- canonical SQLite transactions;
- dead letters, retries, and explicit errors;
- downstream consumers such as Work Episodes.

The Extension safely delivers raw events and contains no domain logic.

### 5.5 Reconciler

The Reconciler is a recovery component and does not continuously tail all Copilot
history. Its current explicit maintainer entry is `provenloop acceptance complete`.
The 0.10 installed entry connects bounded reconciliation of the trusted current
Session to the existing background observation schedule; the underlying helper
also remains a programmatic export. `doctor --repair-capture` is not an implemented
CLI command, and Doctor must not be treated as an arbitrary history scanner.

`runInstalledCopilotExtension` reads `sessionId` and public `workspacePath` from
the SDK Session it actually joins. It trusts the path's dirname as
`sessionStateRoot` only when `SESSION_ID` matches, the path is an absolute
directory, and its basename equals the Session ID. The join observation time
becomes `minimumTimestamp`. A missing or mismatched SDK path produces diagnostics
and skips automatic reconciliation, without guessing paths or enumerating history.

The background loop first runs worker/admission. Only after that run completes
does it perform due current-Session reconciliation every 30 seconds, then collect
observations. Newly queued/enriched data or an exhausted budget schedules a
two-second catch-up. Idle work or repair pending without progress keeps the
30-second interval. The helper still checks plugin/capture/worker/internal state,
the worker lease, and path/link boundaries. Actual runtime `onStopped` or `SIGTERM`
stops the loop without foreground callback I/O or a new service.

The built integration fixture uses the real Extension entry, SDK/command-runner
fixtures, and real queue/worker/store. It covers automatic enrichment of omitted
arguments, preservation of original envelopes, exclusion of records before the
observation start, and joining a Session only once. This is regression coverage,
not a substitute for 0.10 artifact validation, native SDK host observations, or
controlled benefit evidence.

Reconciliation cannot rely solely on `capture_gap`, because the Extension may
crash before persisting it. Bound inputs by trusted Session root, version, and
time window, with file/line/event/byte/time budgets and a recoverable cursor.
Budget exhaustion must report incomplete recovery, never full recovery. Query
queue and canonical completeness only for source identities in the current
batch, avoiding a full canonical-history scan for a few new events.

The current-Session helper defaults to 8 MiB / 500 events / 1,500 ms per call,
with a 1 MiB source-line ceiling. It processes complete lines only; an unterminated
tail waits for later completion. Sources are limited to the current Session's
regular `events.jsonl` under the trusted SDK root. Links and path escapes are
rejected; sibling and historical Sessions are not enumerated. The observation
lower bound is persisted and cannot precede the current capability-state revision
or a later caller-specified bound. Older records may locate causal mappings but
cannot be presented as new observations.

The resume cursor is opaque in-process state, not a persisted seek checkpoint.
The pending-enrichment cache is bounded to 500 items / 8 MiB with limited retries.
Excess work is reported and left for a later scan; recovery of every oversized
field is not guaranteed.

Late complete start/complete evidence can trigger controlled enrichment. Preserve
the original envelope, initial `captureQuality`, and source digest, and store
enrichment separately. Missing parent chains, conflicting sources, workspace
changes, or incomplete commands still cannot create a `VerificationBinding`.
Recovery must not bypass deletion Tombstones.

The Reconciler reads `events.jsonl` for supported Copilot versions. Internal file
formats have no stable compatibility promise, so each parser must declare its
supported versions and return explicit errors for unknown formats.

The Reconciler does not read Copilot's internal SQLite directly, avoiding lock
conflicts and internal-schema coupling.

### 5.6 OpenTelemetry

OTel is an optional metadata-reconciliation channel. By default, it permits only:

- Session or conversation IDs;
- Agent and tool spans;
- tool call IDs, names, durations, and error types;
- model-call durations and token statistics.

`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is disabled by default. It
captures complete prompts, responses, tool arguments, results, and system
instructions, exceeding the default data-minimization scope.

M0 does not enable OTel by default. It is only a diagnostic option or a candidate
fallback when the Extension is unavailable, and must first pass separate
performance and privacy tests.

ProvenLoop does not silently change Copilot's own `remoteExport` setting.
Dedicated checks for strictly local operation remain unvalidated operational
requirements. Ordinary `doctor` must not be described as auditing all Copilot
telemetry configuration.

## 6. Event mapping

| Copilot Session event | Canonical event | Required fields | Notes |
|---|---|---|---|
| Extension joins Session | `session.started` | session, cwd, adapter version | Not a learning outcome |
| `user.message` | `prompt.submitted` or `user.corrected` | event ID, session, timestamp, content | Complete explicit correction markers map to `user.corrected`; otherwise an ordinary prompt |
| `tool.execution_start` | `tool.started` | call ID, tool name, arguments | Invocation, not completion |
| `tool.execution_complete` | `tool.completed` or `tool.failed` | call ID, success, result or error | Stored separately from start |
| `assistant.turn_start` | `agent.turn_started` | event ID, turnId, parent | turnId maps to operationId; running state and model trust; preserves available model identity, not verification success |
| `assistant.message` | `agent.message` | message ID, content, parent | Stores bounded response content |
| `assistant.turn_end` | `agent.turn_completed` | turn ID | Only indicates turn completion |
| `session.idle` | `session.idle` | session, timestamp | Ephemeral; not a recovery basis |
| `session.error` | `session.error` | safe error, error type | Raw stack traces are redacted first |
| `session.shutdown` | `session.ended` | session, reason, timestamp | Best effort; not the only shutdown signal |
| `subagent.started` | `subagent.started` | parent, agent identity | M0 can capture but does not yet consume it |
| `subagent.completed` or `subagent.failed` | Corresponding subagent event | parent, status, error | Preserves process evidence |

The native SDK semantic bridge may emit `test.completed`, `build.completed`,
or `verification.completed` in addition to the original tool-completion event,
but only when:

- the command comes from a captured trusted built-in shell start, with complete
  target and cwd belonging to the same known worktree;
- a supported structured terminal / `shell_exit` result supplies an explicit exitCode;
- start and complete agree on call, Session, Repository, and Branch/HEAD state;
- async/detached execution, unknown exit codes, conflicting states, identically
  named MCP tools, and truncated commands cannot serve as successful verification;
- automatic correction proof also has a `VerificationBinding` pointing to the
  correction and operation, with a complete ordered parent chain to that user correction.

SDK `success: true` may indicate only tool-protocol completion, not a zero test
exitCode. Turn completion does not establish task success, and a changed HEAD
snapshot does not establish that the current task created a Commit. Preserve
new turn/parent variants according to actual supported events; never fabricate
execution to fill a chain. Native event fixtures validate the mapper but do not
establish observation of every variant on an actual installed Copilot host.
Unknown SDK event names that resemble canonical names still follow the
unsupported path and cannot gain trusted-system authority.

The Adapter must preserve the Copilot source event ID. The preferred
deduplication key is:

```text
adapter + adapterVersion + sessionId + eventType + sourceEventId
```

If a required event lacks a source event ID, the Adapter marks it malformed or
incompatible. It cannot synthesize another ID and claim deduplication across
the Extension and Reconciler.

## 7. Normal path

A tool invocation is processed in this order:

```text
tool.execution_start
  -> Extension callback copies fields
  -> callback returns
  -> writer redacts and atomically enqueues
  -> Worker writes canonical SQLite

tool.execution_complete
  -> separate canonical event
  -> linked to start by call ID
```

Tool start and completion must not be merged into one record. Copilot, the
Extension, or the tool process may exit between them; missing completion is
itself evidence.

## 8. Internal Session isolation

ProvenLoop background inference generates an explicit Session ID before starting
Copilot and registers it in the local `internal_sessions` registry. The Extension
uses the Session ID to decide whether to skip capture.

`PROVENLOOP_INTERNAL=1` remains a launch hint and diagnostic field, but is not the
sole basis for exclusion. F0 must measure whether it reaches the Extension.

Internal Sessions may record minimal runtime metrics, but must not persist
prompts, tool arguments, or tool results, or enter Work Episode or Knowledge processing.

## 9. Content minimization and redaction

Before entering the durable queue, event fields fall into three categories.

Always retain:

- event, Session, tool, and call IDs;
- timestamps, ordering, status, and error types;
- Repository, Branch, HEAD, and worktree identity;
- adapter and schema versions;
- content digests and truncation information.

Retain within limits and redact first:

- user messages;
- tool arguments;
- tool results;
- safe errors;
- final Agent responses.

Do not retain by default:

- environment-variable values;
- Copilot, GitHub, or MCP credentials;
- complete system prompts;
- MCP server secret configuration;
- binary attachments;
- complete file contents exceeding limits.

The Worker performs the second redaction pass before writing canonical SQLite.
Both boundaries use the same rule version but independently record the redaction
result and rule version. Both cover `captureQuality`, structured evidence, target
paths, working directories, and content, not just body strings. Redacted evidence
must still identify unavailable fields; enrichment cannot restore secrets. The
combined field count of quality records and the pending-enrichment cache is also
bounded. Saturation markers preserve the fact that some details were discarded.

### 9.1 Separate trusted live Context from content capture

When retrieval is enabled and capture is disabled, an independent trusted Context
publisher may still maintain SDK Session identity without writing capture events.
Snapshots are at most 16 KiB, with a heartbeat every 10 seconds and a maximum age
of 60 seconds. Repository observations also expire after 60 seconds; heartbeats
cannot refresh old Git facts. Git queries run asynchronously and refresh on real
user messages, related SDK/tool changes, and an approximately 30-second cycle.
Old repo/branch/HEAD values are hidden while refresh is pending. Readers check
producer/Session leases and serialize short-lived liveness probes. Contention
returns unavailable rather than stale trust.

Snapshots retain only exact `confirm PL-<12 lowercase hexadecimal digits>`
messages or the corresponding Chinese confirmation from the last five minutes.
Other real user messages, invalid/oversized messages, and workspace identity
changes invalidate prior approval. Agent, autopilot, and subagent messages cannot
authorize actions. Non-approval prompts are not stored in trusted Context snapshots.

## 10. Delivery semantics

Capture uses at-least-once delivery with idempotent consumption:

- the Extension may resend unacknowledged events;
- queue filenames cannot serve as canonical identity;
- the Worker creates a unique constraint on the deduplication key;
- duplicates retain reception counts but produce only one canonical fact;
- malformed and unknown-version events enter dead letter and cannot appear successful.

Distributed exactly-once delivery is out of scope. ProvenLoop runs on one
machine; idempotent persistence and reconcilable recovery address the main risks.

## 11. Startup and shutdown

### Installation

`provenloop install`:

1. Installs the plugin from the marketplace.
2. Statically checks the plugin manifest, CLI version, and bundled SDK protocol.
3. Validates the Extension runtime in the next real Session, without claiming
   real capture has already occurred during installation.
4. Creates data directories and permissions.
5. Registers MCP and the Extension.
6. Leaves existing user sign-in credentials unchanged.

If Copilot requires a global experimental setting to run Extensions, the
installer must explain it and obtain confirmation. It cannot require future
Copilot launches through a wrapper command. The installer records ownership of
the setting change only when the prior value was `false` or absent, and restores
it accordingly on disable or uninstall. It cannot overwrite a setting the user
had already enabled.

F0 must establish that this opt-in persists, affects only the required feature,
and can be rolled back on disable or uninstall. Otherwise the Extension route
is No-Go.

### Session startup

After joining a Session, the Extension:

- validates the CLI and SDK protocol;
- establishes Session capture state;
- loads the internal Session registry;
- starts the writer;
- subscribes to events.

Failure at any step sets capture state to `paused` or `incompatible` without
exiting Copilot.

### Session shutdown

`session.shutdown` may not be visible before the Extension is terminated. The
Extension also handles `SIGTERM` and attempts to drain its buffer within the
CLI's exit grace period. Whichever signal arrives first, draining has a short
deadline. The Reconciler attempts recovery of unfinished work when supported
source records exist; missing records or exhausted budgets must be reported.

Shutdown cannot wait indefinitely for disk, the Worker, or a model.

## 12. Failure behavior

| Failure | ProvenLoop behavior | Copilot behavior |
|---|---|---|
| Extension cannot start | Set capture state to `paused`; record reason | Starts normally |
| Incompatible Extension API | Set capability to `incompatible` | Starts normally |
| Temporary writer failure | Bounded retries; retain in-memory events | Does not wait |
| Full buffer | Write `capture_gap`; stop copying large fields | Does not wait |
| Disk full or permission denied | Stop persistence; report explicit error | Does not wait |
| Worker stopped | Queue accumulates | Unaffected |
| Malformed event | Dead letter | Unaffected |
| OTel unavailable | Disable OTel reconciliation | Extension continues |
| Unknown Session file format | Reconciler skips it and reports version error | Unaffected |
| Extension process crash | Later bounded current-Session reconciliation or explicit acceptance recovery; history before the new observation lower bound is not guaranteed to recover | Current Session continues |

Every failure must have an explicit state. Empty success, fabricated completion,
and silent dropping are prohibited.

## 13. Versions and capability gates

Version numbers provide a quick filter; capability probes determine compatibility.

For each supported Copilot CLI version, record:

- CLI version;
- bundled SDK protocol;
- Extension host availability;
- observed event types;
- required field compatibility;
- Session file parser version;
- OTel attribute mapping version;
- latest probe result.

Missing required events or fields at startup make capture `incompatible`. New
unknown events may be stored as unknown envelopes, but cannot automatically map
to known domain events.

The historical Extension spike passed feasibility on Copilot CLI `1.0.82-0`.
The installation compatibility baseline is `>=1.0.71`, with compatibility
records for `1.0.82-0` and `1.0.83-4`. This does not establish acceptance of the
new proof bridge on all versions and event paths.

## 14. Implementation sequence

### A. Extension latency spike

- Create a minimal plugin Extension.
- Subscribe to user messages, tool start and completion, turn end, error, and shutdown.
- Count events without persisting content.
- Compare foreground duration with the Extension enabled and disabled.
- Inject slow callbacks, exceptions, and process exits.

This phase only determines whether the Extension suits primary capture; it
does not establish the domain model.

### B. Batch 1 capture contracts

- Freeze the versioned envelope and event identity.
- Define `CaptureAdapter`, the capability matrix, and error types.
- Fix the version boundary between Extension and Worker.
- Add event fixtures and the unknown-version path.

A passing minimal Extension spike permits Batch 1 to proceed. Full F0-001 still
blocks M0 quality acceptance.

### C. Batch 3 durable capture

- Add the versioned envelope.
- Add a bounded buffer and asynchronous writer.
- Connect the first redaction pass.
- Implement atomic queue files.
- Implement deduplication keys and `capture_gap`.
- Run Worker-stop, disk-error, and crash-recovery tests.

### D. Recovery and compatibility

- Add the Session file Reconciler.
- Add the capability matrix.
- Evaluate metadata-only OTel.
- Complete Doctor states, explicit acceptance reconciliation, and bounded
  current-Session recovery.
- Freeze the first supported Extension version range.

## 15. Acceptance and Go/No-Go

These M0 capture acceptance targets still require complete supporting evidence.
They are not claims about 0.10 artifact test results:

- capture at least 500 representative events on each of Windows 10 and 11;
- include prompt, tool success, tool failure, cancellation, resume, shutdown,
  and subagent samples;
- paired A/B foreground added latency P95 at or below 10 ms;
- callback work duration P95 at or below 1 ms;
- Copilot can still complete tasks when the Extension callback deliberately
  sleeps, throws, or exits;
- Worker stoppage and queue backlog do not affect Copilot;
- zero missing persisted events after Extension restart and Reconciler execution;
- the Reconciler detects and repairs gaps even when the Extension terminates
  before writing `capture_gap`;
- zero duplicate canonical facts;
- zero persisted seeded secrets;
- zero persisted internal Session content;
- unsupported versions enter `incompatible`, without guessed parsing.

Report event-timestamp-to-callback delivery latency separately as P50, P95,
maximum, and event-type distribution. It measures capture freshness, not
user-visible latency. F0 does not impose a 10 ms threshold for it, but must
establish that backlog does not grow continuously and that persistence or
Reconciler recovery can complete after the Session ends.

Stop the Extension route if it cannot meet latency or fault-isolation
requirements. The next candidate is metadata-only OTel as the primary metadata
stream, paired with incremental Session file recovery for supported versions.
Do not return to synchronous lifecycle Hooks.

## 16. Items requiring further validation

- whether the Extension inherits `PROVENLOOP_INTERNAL`;
- whether Extension callback backlog affects the CLI;
- Extension shutdown deadlines and forced-termination behavior;
- bundled SDK compatibility across CLI patch versions;
- OTel exporter buffering, dropping, and shutdown flushing;
- `events.jsonl` append, partial-line, and resume behavior on Windows;
- how the installer preserves user comments and other fields when changing
  JSONC settings.

Each question has a corresponding experiment and does not require additional
abstractions first.

## 17. Official sources

- [About Copilot CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions)
- [Create a Copilot CLI extension](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot Hooks performance considerations](https://docs.github.com/en/copilot/concepts/agents/hooks#performance-considerations)
- [Copilot Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI OpenTelemetry monitoring](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring)
- [Copilot CLI Session data](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
