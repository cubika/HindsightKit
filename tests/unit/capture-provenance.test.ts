import { describe, expect, it } from "vitest";

import { captureEnvelopeSchema, captureQualitySchema } from "@provenloop/contracts";
import { BoundedCaptureBuffer, CopilotEventMapper } from "@provenloop/copilot-adapter";
import { createCaptureEnvelope, redactCaptureEnvelopeForPersistence } from "@provenloop/domain";

const base = {
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  eventType: "verification.completed",
  sessionId: "session-provenance",
  sourceEventId: "complete-1",
  repoId: "repo-1",
  worktree: "C:\\repo",
  operationId: "operation-1",
  exitCode: 0,
  completionStatus: "succeeded" as const,
  timestamp: "2026-09-05T00:00:00.000Z",
  trust: "tool" as const,
};

describe("capture provenance persistence", () => {
  it("preserves typed evidence and redacts every textual provenance field", () => {
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const input = {
      ...base,
      repositoryState: "known_repo" as const,
      captureQuality: {
        schemaVersion: 1 as const,
        truncatedFields: [`message.${secret}`],
        omittedFields: ["toolResult.contents"],
        originalLengths: { [secret]: 20_000 },
      },
      evidence: {
        schemaVersion: 1 as const,
        kind: "command_verification" as const,
        repositoryState: "known_repo" as const,
        sourceStartEventId: `start-${secret}`,
        sourceCompleteEventId: "complete-1",
        operationId: "operation-1",
        commandFamily: "npm-test",
        workingDirectory: `C:\\repo\\${secret}`,
        targetPaths: [`C:\\repo\\${secret}\\test.ts`],
        exitCode: 0,
      },
      verificationBinding: {
        correctionEventId: "event-correction",
        operationEventId: "event-operation",
      },
    };
    const envelope = createCaptureEnvelope(input);
    expect(envelope.event).toMatchObject({
      repositoryState: "known_repo",
      captureQuality: {
        schemaVersion: 1,
        originalLengths: { "[REDACTED]": 20_000 },
      },
      evidence: {
        commandFamily: "npm-test",
        exitCode: 0,
        workingDirectory: expect.stringContaining("[REDACTED]"),
        targetPaths: [expect.stringContaining("[REDACTED]")],
      },
      verificationBinding: input.verificationBinding,
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.redaction.redactedPaths).toContain("event.evidence.targetPaths[0]");
    const persisted = redactCaptureEnvelopeForPersistence(envelope).envelope;
    expect(persisted.event).toEqual(envelope.event);
    expect(JSON.stringify(persisted)).not.toContain(secret);
  });

  it("reapplies provenance redaction to an incoming envelope before canonical persistence", () => {
    const clean = createCaptureEnvelope({
      ...base,
      eventType: "file.changed",
      evidence: {
        schemaVersion: 1,
        kind: "file_change",
        repositoryState: "known_repo",
        targetPaths: ["C:\\repo\\safe.ts"],
      },
    });
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const unsafe = captureEnvelopeSchema.parse({
      ...clean,
      event: {
        ...clean.event,
        evidence: { ...clean.event.evidence, targetPaths: [`C:\\repo\\${secret}`] },
      },
    });
    const persisted = redactCaptureEnvelopeForPersistence(unsafe);
    expect(persisted.redactionApplied).toBe(true);
    expect(JSON.stringify(persisted.envelope)).not.toContain(secret);
    expect(persisted.envelope.event.evidence?.targetPaths).toEqual([
      expect.stringContaining("[REDACTED]"),
    ]);
  });

  it("does not fabricate provenance for legacy events", () => {
    const event = redactCaptureEnvelopeForPersistence(createCaptureEnvelope(base)).envelope.event;
    expect(event.repositoryState).toBeUndefined();
    expect(event.captureQuality).toBeUndefined();
    expect(event.evidence).toBeUndefined();
  });

  it("bounds quality diagnostics to the shared schema without losing the overflow signal", () => {
    const capture = new CopilotEventMapper({
      adapterVersion: "1.0.82-0", sessionId: "bounded-session", copyLimits: { maxStringChars: 8 },
    });
    const long = "x".repeat(100);
    const fields = Array.from({ length: 32 }, () => long);
    const result = capture.map({
      type: "tool.execution_complete", id: "bounded-complete", timestamp: base.timestamp, parentId: null,
      data: {
        toolCallId: "bounded-call", success: true,
        result: {
          content: long, detailedContent: long,
          structuredContent: { paths: fields, files: fields, targets: fields, changedFiles: fields },
          contents: Array.from({ length: 32 }, () => ({
            type: "shell_exit", exitCode: 0, cwd: long, shellId: long, outputFilePath: long, outputPreview: long,
          })),
        },
      },
    });
    if (result.status !== "mapped") throw new Error("Expected a bounded tool event");
    const quality = captureQualitySchema.parse(result.value.captureQuality);
    expect(quality.truncatedFields).toContain("captureQuality.truncatedFields");
    expect(quality.originalLengths["captureQuality.truncatedFields"]).toBeGreaterThan(256);
    const envelope = createCaptureEnvelope(result.value);
    expect(redactCaptureEnvelopeForPersistence(envelope).envelope.event.captureQuality).toEqual(quality);
  });

  it("retains content omission when degrading an event already at the quality field limit", () => {
    const buffer = new BoundedCaptureBuffer({
      maxBytes: 20_000, maxItems: 10, maxGapBytes: 4_096, maxGapContexts: 4,
    });
    expect(buffer.offer({
      ...base,
      content: { message: "x".repeat(100_000) },
      captureQuality: {
        schemaVersion: 1, truncatedFields: [], originalLengths: {},
        omittedFields: Array.from({ length: 256 }, (_, index) => `field-${index}`),
      },
    })).toEqual({ status: "degraded" });
    const item = buffer.peek();
    if (item === undefined) throw new Error("Expected metadata-only capture");
    const quality = captureQualitySchema.parse(item.captureQuality);
    expect(quality.omittedFields).toContain("content");
    expect(quality.omittedFields).toContain("captureQuality.omittedFields");
    expect(createCaptureEnvelope(item).event.captureQuality).toEqual(quality);
  });
});
