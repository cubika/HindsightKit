import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  captureQueueItemSchema,
  type CaptureEvidence,
  type CaptureQuality,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  createCaptureDeduplicationKey,
  redactCaptureEnvelopeForPersistence,
} from "@provenloop/domain";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const timestamp = "2026-09-05T00:00:00.000Z";
const quality: CaptureQuality = {
  schemaVersion: 1, omittedFields: ["toolResult.stdout"],
  truncatedFields: [], originalLengths: { "toolResult.stdout": 100 },
};
const evidence: CaptureEvidence = {
  schemaVersion: 1, kind: "command_verification", repositoryState: "known_repo",
  sourceStartEventId: "sdk-start", sourceCompleteEventId: "sdk-complete",
  operationId: "operation-metadata", commandFamily: "test", exitCode: 0,
  workingDirectory: "C:\\repo", targetPaths: ["tests\\example.test.ts"],
};

const item = (
  id: string,
  eventType: string,
  options: Partial<Parameters<typeof createCaptureEnvelope>[0]> = {},
) => captureQueueItemSchema.parse({
  schemaVersion: 1, queueItemId: `queue-${id}-${options.sessionId ?? "session-a"}`,
  state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp,
  envelope: redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
    adapter: "copilot-cli", adapterVersion: "1.0.82-0", sourceEventId: id,
    sessionId: "session-a", repoId: "repo-metadata", worktree: "C:\\repo",
    repositoryState: "known_repo", operationId: "operation-metadata",
    eventType, timestamp, trust: "tool", ...options,
  })).envelope,
});

const candidate = (eventId: string): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "metadata-review", topicKey: "metadata:review",
  content: "Review the available evidence", appliesWhen: [], nonApplicability: [],
  conflictsWith: [], sourceEpisodeIds: [], sourceEvidenceIds: [eventId],
  createdAt: timestamp, evidenceMarks: [], evidenceTier: "inferred", state: "candidate",
  kind: "procedural", scope: "repository", scopeId: "repo-metadata", importance: 1,
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
  utility: { applied: 0, helpful: 0, harmful: 0 },
});

const finishDeletion = (store: CanonicalSqliteStore, sourceId: string) => {
  const target = { targetId: sourceId, targetType: "source" as const };
  const operation = store.beginDeletion(target, "delete-metadata-source");
  store.deleteCanonicalTarget(operation.deletionId, target);
  store.prepareDeletionCompletion({
    deletionId: operation.deletionId, deletedDependentCount: 1,
    deletedQueueItemCount: 0, deletedSourceCount: 2,
    gateDigest: "b".repeat(64), propagationEvidenceId: "metadata-propagation",
  });
  store.completeDeletion(operation.deletionId);
};

describe("canonical capture metadata", () => {
  it("rejects a queue identity that changes when provenance is redacted", () => {
    const source = item("safe-source", "tool.started");
    assert(source.envelope.event.sessionId !== undefined);
    const sourceEventId = "ghp_1234567890abcdefghijklmnopqrst";
    const deduplicationKey = createCaptureDeduplicationKey({
      adapter: source.envelope.event.adapter,
      adapterVersion: source.envelope.event.adapterVersion,
      eventType: source.envelope.event.eventType,
      sessionId: source.envelope.event.sessionId,
      sourceEventId,
    });
    const invalid = {
      ...source,
      envelope: {
        ...source.envelope, sourceEventId, deduplicationKey,
        event: { ...source.envelope.event, eventId: `event-${deduplicationKey}` },
      },
    };
    const store = new CanonicalSqliteStore(":memory:");
    try {
      expect(store.ingestQueueItem(invalid)).toMatchObject({
        status: "rejected", reason: "Capture envelope identity is inconsistent.",
      });
      expect(store.rawEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves quality and repository state and redacts paths and opaque source identities on both passes", () => {
    const startSecret = "ghp_1234567890abcdefghijklmnopqrst";
    const completeSecret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const start = item(startSecret, "tool.started");
    const complete = item(completeSecret, "tool.completed");
    const verification = item("metadata-verification", "test.completed", {
      captureQuality: {
        ...quality, truncatedFields: [`output.${startSecret}`],
        originalLengths: { [startSecret]: 100 },
      },
      evidence: {
        ...evidence, sourceStartEventId: startSecret, sourceCompleteEventId: completeSecret,
        workingDirectory: `C:\\repo\\${startSecret}`,
        targetPaths: [`C:\\repo\\${completeSecret}.ts`],
      },
    });
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const value of [start, complete, verification]) {
        expect(store.ingestQueueItem(value)).toMatchObject({ status: "stored" });
      }
      const originalRecord = store.rawEvent(verification.envelope.deduplicationKey);
      assert(originalRecord !== undefined);
      const original = originalRecord.envelope;
      assert(original.event.captureQuality !== undefined);
      expect(original.event.repositoryState).toBe("known_repo");
      expect(original.event.captureQuality?.truncatedFields).toHaveLength(1);
      expect(Object.values(original.event.captureQuality.originalLengths)).toEqual([100]);
      expect(original.event.evidence).toMatchObject({
        kind: "command_verification", repositoryState: "known_repo", exitCode: 0,
      });
      expect(original.event.evidence?.sourceStartEventId)
        .toBe(store.rawEvent(start.envelope.deduplicationKey)?.sourceEventId);
      expect(original.event.evidence?.sourceCompleteEventId)
        .toBe(store.rawEvent(complete.envelope.deduplicationKey)?.sourceEventId);
      expect(JSON.stringify(store.rawEvents())).not.toContain(startSecret);
      expect(JSON.stringify(store.rawEvents())).not.toContain(completeSecret);
      expect(store.enrichRawEvent({
        envelope: { ...verification.envelope, content: { message: "Recovered output" } },
        sourceDigest: "a".repeat(64),
      }).status).toBe("enriched");
      const effectiveRecord = store.effectiveRawEvent(verification.envelope.deduplicationKey);
      assert(effectiveRecord !== undefined);
      const effective = effectiveRecord.envelope;
      expect(effective.event.evidence).toEqual(original.event.evidence);
      expect(effective.event.captureQuality).toEqual(original.event.captureQuality);
      expect(effective.content).toEqual({ message: "Recovered output" });
      expect(store.rawEvent(verification.envelope.deduplicationKey)?.envelope.content).toBeUndefined();
      expect(store.knowledgeAdmissionEvidence([candidate(verification.envelope.event.eventId)])
        .envelopes.map((envelope) => envelope.event.eventId).sort())
        .toEqual([start, complete, verification].map((value) => value.envelope.event.eventId).sort());
      finishDeletion(store, start.envelope.event.eventId);
      expect(store.effectiveRawEvent(verification.envelope.deduplicationKey)).toBeUndefined();
      expect(store.ingestQueueItem(item("late-secret-proof", "test.completed", {
        evidence: {
          ...evidence, sourceStartEventId: startSecret, sourceCompleteEventId: completeSecret,
        },
      })).status).toBe("duplicate");
    } finally {
      store.close();
    }
  });

  const evidenceChanges: readonly { name: string; patch: Partial<CaptureEvidence> }[] = [
    { name: "working directory", patch: { workingDirectory: "C:\\other" } },
    { name: "targets", patch: { targetPaths: ["other.test.ts"] } },
    { name: "start identity", patch: { sourceStartEventId: "different-start" } },
    { name: "completion identity", patch: { sourceCompleteEventId: "different-complete" } },
    { name: "operation identity", patch: { operationId: "another-operation" } },
    { name: "command family", patch: { commandFamily: "build" } },
    { name: "exit status", patch: { exitCode: 1 } },
    { name: "repository evidence", patch: { repositoryState: "unknown" } },
  ];
  it.each(evidenceChanges)("rejects an enrichment that changes $name", ({ patch }) => {
    const store = new CanonicalSqliteStore(":memory:");
    const original = item("immutable-evidence", "test.completed", { evidence, captureQuality: quality });
    try {
      store.ingestQueueItem(original);
      expect(store.enrichRawEvent({
        envelope: {
          ...original.envelope,
          event: { ...original.envelope.event, evidence: { ...evidence, ...patch } },
          content: { message: "Changed proof" },
        },
        sourceDigest: "c".repeat(64),
      }).status).toBe("rejected");
      expect(store.effectiveRawEvent(original.envelope.deduplicationKey)?.envelope.event.evidence).toEqual(evidence);
    } finally {
      store.close();
    }
  });

  it("does not erase quality flags or reinterpret explicit repository uncertainty during enrichment", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const original = item("immutable-quality", "test.completed", {
      evidence: { ...evidence, repositoryState: "unknown" },
      repositoryState: "known_outside_repo", captureQuality: quality,
    });
    try {
      store.ingestQueueItem(original);
      for (const event of [
        { ...original.envelope.event, captureQuality: { ...quality, omittedFields: [] } },
        { ...original.envelope.event, repositoryState: "known_repo" as const },
      ]) {
        expect(store.enrichRawEvent({
          envelope: { ...original.envelope, event, content: { message: "Changed metadata" } },
          sourceDigest: "c".repeat(64),
        }).status).toBe("rejected");
      }
    } finally {
      store.close();
    }
  });

  const contradictoryPayloads: readonly Record<string, string | number | string[]>[] = [
    { sourceStartEventId: "different-start" },
    { sourceCompleteEventId: "different-complete" },
    { exitCode: 1 },
    { commandFamily: "build" },
    { targetPaths: ["different.test.ts"] },
    { cwd: "C:\\other" },
  ];
  it.each(contradictoryPayloads)("rejects supplemental payload that contradicts immutable proof metadata: %j", (arguments_) => {
    const store = new CanonicalSqliteStore(":memory:");
    const original = item("conflicting-payload", "test.completed", { evidence });
    try {
      store.ingestQueueItem(original);
      expect(store.enrichRawEvent({
        envelope: {
          ...original.envelope,
          event: { ...original.envelope.event, redactedArguments: arguments_ },
        },
        sourceDigest: "c".repeat(64),
      })).toMatchObject({ status: "rejected", reason: "Enrichment contains conflicting capture evidence." });
      expect(store.effectiveRawEvent(original.envelope.deduplicationKey)?.envelope.event.redactedArguments)
        .toBeUndefined();
    } finally {
      store.close();
    }
  });

  it.each(["start", "complete", "failed"] as const)(
    "deletes %s provenance and its parser/supplement dependants without affecting same-named SDK IDs in another session",
    (deleted) => {
      const store = new CanonicalSqliteStore(":memory:");
      const sequence = (sessionId: string) => {
        const proof = { ...evidence, exitCode: deleted === "failed" ? 1 : 0 };
        return {
          start: item("sdk-start", "tool.started", { sessionId }),
          complete: item("sdk-complete", deleted === "failed" ? "tool.failed" : "tool.completed", { sessionId }),
          verification: item("sdk-proof", "test.completed", { sessionId, evidence: proof }),
        };
      };
      const selected = sequence("session-a");
      const unrelated = sequence("session-b");
      try {
        for (const value of [...Object.values(selected), ...Object.values(unrelated)]) store.ingestQueueItem(value);
        expect(new Set(store.knowledgeAdmissionEvidence([
          candidate(selected.verification.envelope.event.eventId),
        ]).envelopes.map((envelope) => envelope.event.sessionId))).toEqual(new Set(["session-a"]));
        const invalid = item("malformed-metadata", "test.completed", {
          evidence: selected.verification.envelope.event.evidence,
        });
        expect(store.ingestQueueItem({
          ...invalid, envelope: {
            ...invalid.envelope, event: { ...invalid.envelope.event, eventId: `event-${"e".repeat(64)}` },
          },
        }).status).toBe("rejected");
        store.enrichRawEvent({
          envelope: { ...selected.verification.envelope, content: { message: "Supplemented proof" } },
          sourceDigest: "a".repeat(64),
        });
        const targetId = (deleted === "start" ? selected.start : selected.complete).envelope.event.eventId;
        finishDeletion(store, targetId);
        expect(store.effectiveRawEvent(selected.verification.envelope.deduplicationKey)).toBeUndefined();
        expect(store.parserErrors()).toEqual([]);
        expect(store.remainingDeletionIdentities([{ identityType: "event", identifier: targetId }])).toEqual([]);
        expect(store.rawEvent(unrelated.verification.envelope.deduplicationKey)).toBeDefined();
        expect(store.ingestQueueItem(item("late-proof", "test.completed", {
          evidence: selected.verification.envelope.event.evidence,
        })).status).toBe("duplicate");
        expect(store.ingestQueueItem(item("late-proof", "test.completed", {
          sessionId: "session-b", evidence: unrelated.verification.envelope.event.evidence,
        })).status).toBe("stored");
      } finally {
        store.close();
      }
    },
  );

  it("tracks legacy source IDs added in supplemental payload and refuses deleted provenance", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const start = item("sdk-start", "tool.started");
    const complete = item("sdk-complete", "tool.completed");
    const verification = item("legacy-proof", "test.completed");
    const arguments_ = { sourceStartEventId: "sdk-start", sourceCompleteEventId: "sdk-complete" };
    try {
      for (const value of [start, complete, verification]) store.ingestQueueItem(value);
      expect(store.enrichRawEvent({
        envelope: {
          ...verification.envelope,
          event: { ...verification.envelope.event, redactedArguments: arguments_ },
        },
        sourceDigest: "b".repeat(64),
      }).status).toBe("enriched");
      expect(store.knowledgeAdmissionEvidence([candidate(verification.envelope.event.eventId)]).envelopes)
        .toHaveLength(3);
      finishDeletion(store, complete.envelope.event.eventId);
      expect(store.effectiveRawEvent(verification.envelope.deduplicationKey)).toBeUndefined();
      const subsequent = item("new-unbound-proof", "test.completed");
      store.ingestQueueItem(subsequent);
      expect(store.enrichRawEvent({
        envelope: {
          ...subsequent.envelope,
          event: { ...subsequent.envelope.event, redactedArguments: arguments_ },
        },
        sourceDigest: "c".repeat(64),
      }).status).toBe("rejected");
    } finally {
      store.close();
    }
  });
});
