# ADR 0002: Copilot Extension event capture spike

**Status:** Accepted for Batch 1; M0 acceptance work remains
**Date:** 2026-08-29

## Context

Command and HTTP lifecycle Hooks added hundreds of milliseconds before
ProvenLoop received an event. The replacement candidate is a Copilot CLI
Extension that observes Session events through `session.on(...)`.

## Probe

The F0 plugin contains a metadata-only Extension and PowerShell harnesses:

- `spikes/f0/run-extension-probe.ps1`
- `spikes/f0/run-extension-opt-in-probe.ps1`

The Extension records event identity, type, timing, parent relation, selected
non-content fields, and callback work duration. It does not persist Prompt,
tool arguments, tool output, or assistant response content.

Tests ran on:

```text
Windows 11 Enterprise 10.0.26100
GitHub Copilot CLI 1.0.82-0
Node.js 22.18.0
```

## Results

Nine directly reported baseline, delayed-callback, and throwing-callback
sessions produced 1,214 events before the final regressions. Initial
all-event delivery latency P95 ranged from 1 to 10 ms. A concurrent run reached
12 ms, and a later sequential prompt-mode run reached 1528 ms.

This metric includes events buffered while the Extension joins a prompt-mode
Session. It measures capture freshness, not foreground added latency. The probe
now reports it by event type and no longer treats 10 ms as its release gate.
In the first corrected report, required capture events had a combined P95 of
1 ms; delayed startup events came from `hook.start` and
`session.tools_updated`.

After the probe was corrected to measure the complete callback work rather than
its first portion, the latest non-internal runs reported work-duration P95
between 0.042 and 0.114 ms.

The required events were observed:

- `user.message`;
- `tool.execution_start`;
- `tool.execution_complete`;
- `assistant.message`;
- `assistant.turn_end`.

Every observed event had a source event ID and timestamp. The metadata log did
not contain the probe Prompt, tool output marker, or final response marker.

Failure tests showed:

- a callback that busy-waited for 500 ms did not stop the foreground task;
- an event callback exception did not stop the foreground task;
- terminating the Extension process on `user.message` did not stop Copilot;
- process termination lost live Extension events, confirming that reconciliation
  is required.

An internal Session registry test skipped 87 events before content copying and
wrote zero normal event records.

The `experimental` setting was enabled in an isolated `COPILOT_HOME`. A normal
Copilot launch without `--experimental` loaded the Extension. Restoring the
setting to `false` prevented a later normal launch from loading it.

Copilot CLI `1.0.82-0` did not persist `/experimental off` back to
`settings.json` in the probe. ProvenLoop installation must preserve the prior
setting and use a JSONC-safe settings update rather than relying on that slash
command.

## Decision

The Extension Session event stream is the primary capture candidate. The F0
implementation may proceed with the Extension probe and recovery experiments.
Synchronous lifecycle Hooks remain excluded from normal capture.

This decision closes the feasibility blocker for Batch 1. Remaining M0
acceptance evidence:

- Windows 10 results;
- paired A/B foreground added-latency measurements;
- cancellation, resume, shutdown, permission denial, and subagent coverage;
- callback backlog and queue failure under controlled load;
- Session file reconciliation after termination before `capture_gap`;
- plugin install, disable, and uninstall behavior with Extension opt-in.

## Consequences

Batch 1 may define the Extension event envelope and adapter contract after the
remaining F0-001 checks pass. Durable capture, redaction, and queue integration
remain Batch 3 work.
