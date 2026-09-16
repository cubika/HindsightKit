import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_FORMAT_VERSIONS,
  classifyRawEvent,
  contextUseRecordSchema,
  CURRENT_SCHEMA_VERSIONS,
  evidenceLedgerEntrySchema,
  feedbackEventSchema,
  gateResultSchema,
  rawEventSchema,
  replaySpecSchema,
  SCHEMA_MIGRATIONS,
  SCHEMA_NAMES,
  UNSUPPORTED_SCHEMA_VERSION_POLICY,
  validateVersionedSchema,
  workEpisodeSchema,
} from "@provenloop/contracts";

interface InvalidFixture {
  readonly expectedStatus: string;
  readonly fixtureId: string;
  readonly fixtureVersion: number;
  readonly input: unknown;
  readonly schemaName: string;
}

const loadFixture = (name: string): InvalidFixture => {
  const path = fileURLToPath(
    new URL(
      `../../packages/contracts/fixtures/invalid/${name}.json`,
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, "utf8")) as InvalidFixture;
};

describe("schema version compatibility", () => {
  it("rejects an unsupported persisted schema version explicitly", () => {
    const fixture = loadFixture("raw-event-unsupported-version");
    const result = validateVersionedSchema(
      "rawEvent",
      rawEventSchema,
      fixture.input,
    );

    expect(fixture.fixtureVersion).toBe(
      ARTIFACT_FORMAT_VERSIONS.fixture,
    );
    expect(result).toEqual({
      status: "unsupported_version",
      receivedVersion: 2,
      supportedVersion: 1,
    });
  });

  it("reports malformed input without fabricating a valid event", () => {
    const fixture = loadFixture("raw-event-malformed");
    const result = validateVersionedSchema(
      "rawEvent",
      rawEventSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("retains unknown RawEvent types through an explicit path", () => {
    const fixture = loadFixture("raw-event-unknown-type");
    const result = classifyRawEvent(fixture.input);

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result).toMatchObject({
      status: "unsupported_event_type",
      eventType: "future.event",
    });
  });

  it("rejects unsupported adapter source versions explicitly", () => {
    const fixture = loadFixture("raw-event-unsupported-adapter-version");
    const result = classifyRawEvent(fixture.input);

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result).toMatchObject({
      status: "unsupported_adapter_version",
      adapter: "copilot-cli",
      adapterVersion: "1.0.70-0",
      supportedVersions: [
        ">=1.0.71",
      ],
    });
  });

  it("accepts compatible newer Copilot adapter versions", () => {
    const input = {
      actorId: "user-1",
      adapter: "copilot-cli",
      adapterVersion: "1.1.0",
      eventId: "event-1",
      eventType: "prompt.submitted",
      schemaVersion: 1,
      sessionId: "session-1",
      timestamp: "2026-09-05T00:00:00.000Z",
      trust: "user",
    };

    expect(classifyRawEvent(input)).toMatchObject({
      status: "supported",
      value: {
        adapterVersion: "1.1.0",
      },
    });
  });

  it("rejects unknown closed-enum values", () => {
    const fixture = loadFixture("gate-result-unknown-status");
    const result = validateVersionedSchema(
      "gateResult",
      gateResultSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("requires ReplaySpec to choose exactly one input form", () => {
    const fixture = loadFixture("replay-spec-conflicting-inputs");
    const result = validateVersionedSchema(
      "replaySpec",
      replaySpecSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("requires Ledger digest fields to be SHA-256 hex", () => {
    const result = evidenceLedgerEntrySchema.safeParse({
      schemaVersion: 1,
      ledgerEntryId: "ledger-1",
      runId: "run-1",
      status: "event.observed",
      inputDigest: "ghp_1234567890abcdefghijklmnopqrst",
      timestamp: "2026-08-29T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("loads pre-Batch-6 WorkEpisode version 1 records", () => {
    const result = workEpisodeSchema.parse({
      schemaVersion: 1,
      episodeId: "episode-1",
      goal: "Preserve version 1 compatibility.",
      branches: [],
      sessionIds: [
        "session-1",
      ],
      commitIds: [],
      pullRequestIds: [],
      issueIds: [],
      startedAt: "2026-08-29T00:00:00.000Z",
      outcome: "unknown",
      outcomeQualification: "open",
      outcomeEvidenceIds: [],
      correctionEventIds: [],
      associationConfidence: 1,
    });

    expect(result.associationEvidenceIds).toEqual([]);
    expect(result.sourceEventIds).toEqual([]);
  });

  it("leaves legacy context observations unknown instead of assuming delivery", () => {
    const record = contextUseRecordSchema.parse({
      schemaVersion: 1,
      appliedKnowledgeIds: [],
      candidateKnowledgeIds: [],
      createdAt: "2026-09-05T00:00:00.000Z",
      latencyMs: 0,
      renderedTokens: 0,
      requestId: "request-legacy",
      returnedKnowledgeIds: [],
      sessionId: "session-legacy",
    });

    expect(record.retrievalStatus).toBeUndefined();
    expect(record.repoId).toBeUndefined();
    expect(record.codeVersion).toBeUndefined();
    expect(record.updatedAt).toBeUndefined();
    expect(
      contextUseRecordSchema.parse({
        ...record,
        branch: "main",
        codeVersion: "revision-1",
        repoId: "repo-1",
        retrievalStatus: "disabled",
      }),
    ).toMatchObject({
      retrievalStatus: "disabled",
      repoId: "repo-1",
    });
    expect(
      contextUseRecordSchema.safeParse({
        ...record,
        retrievalStatus: "successful_task",
      }).success,
    ).toBe(false);
  });

  it("accepts typed branch context feedback without treating it as knowledge", () => {
    const feedback = feedbackEventSchema.parse({
      schemaVersion: 1,
      evidenceRef: "request-1",
      feedbackId: "feedback-branch-1",
      kind: "strengthen",
      source: "user",
      targetId: "branch-1",
      targetType: "branch_context",
      timestamp: "2026-09-05T00:00:00.000Z",
    });

    expect(feedback.targetType).toBe("branch_context");
  });

  it("preserves explicit proof and dispute-resolution references", () => {
    const input = {
      schemaVersion: 1,
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventId: "verification-1",
      eventType: "test.completed",
      timestamp: "2026-09-05T00:00:00.000Z",
      trust: "tool",
      verificationBinding: {
        correctionEventId: "correction-1",
        operationEventId: "operation-1",
      },
    };
    expect(rawEventSchema.parse(input).verificationBinding).toEqual({
      correctionEventId: "correction-1",
      operationEventId: "operation-1",
    });
    expect(
      rawEventSchema.safeParse({
        ...input,
        verificationBinding: {
          correctionEventId: "correction-1",
        },
      }).success,
    ).toBe(false);
    expect(
      feedbackEventSchema.parse({
        schemaVersion: 1,
        evidenceRef: "user-confirmation-1",
        feedbackId: "confirmation-1",
        kind: "confirm",
        resolvesEvidenceIds: ["counterevidence-1"],
        source: "user",
        targetId: "knowledge-1",
        targetType: "knowledge",
        timestamp: "2026-09-05T00:00:00.000Z",
      }).resolvesEvidenceIds,
    ).toEqual(["counterevidence-1"]);
    expect(
      classifyRawEvent({
        ...input,
        eventType: "git.head_changed",
        trust: "system",
        verificationBinding: undefined,
      }).status,
    ).toBe("supported");
  });

  it("retains bounded capture completeness and operation evidence", () => {
    const record = rawEventSchema.parse({
      schemaVersion: 1,
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventId: "event-quality",
      eventType: "tool.completed",
      timestamp: "2026-09-05T00:00:00.000Z",
      trust: "tool",
      repositoryState: "known_repo",
      captureQuality: {
        schemaVersion: 1,
        omittedFields: [],
        truncatedFields: ["tool.result"],
        originalLengths: { "tool.result": 10_000 },
      },
      evidence: {
        schemaVersion: 1,
        kind: "command_verification",
        repositoryState: "known_repo",
        sourceStartEventId: "operation-1",
        sourceCompleteEventId: "completed-1",
        commandFamily: "npm-test",
        exitCode: 0,
      },
    });

    expect(record.captureQuality?.originalLengths["tool.result"]).toBe(10_000);
    expect(record.evidence?.sourceStartEventId).toBe("operation-1");
    expect(rawEventSchema.safeParse({
      ...record,
      captureQuality: {
        ...record.captureQuality,
        originalLengths: { "tool.result": -1 },
      },
    }).success).toBe(false);
  });
});

describe("migration policy", () => {
  it("registers a current version and migration list for every schema", () => {
    for (const schemaName of SCHEMA_NAMES) {
      expect(CURRENT_SCHEMA_VERSIONS[schemaName]).toBe(1);
      expect(SCHEMA_MIGRATIONS[schemaName]).toEqual([]);
    }
    expect(UNSUPPORTED_SCHEMA_VERSION_POLICY).toBe("reject");
  });
});
