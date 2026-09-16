import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureQueueItemSchema,
  type BranchContext,
  type ContextUseRecord,
  type CorrectionKey,
  type FeedbackEvent,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import { createCaptureEnvelope, redactCaptureEnvelopeForPersistence, sha256 } from "@provenloop/domain";
import {
  CanonicalMigrationRequiredError,
  CanonicalSqliteStore,
  DEFAULT_SQLITE_MIGRATIONS,
  StaleCanonicalStoreError,
} from "@provenloop/storage-sqlite";
import { createCanonicalStoreWorkerModule } from "../fixtures/canonical-store-worker.js";

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";
const sourceId = `event-${"a".repeat(64)}`;
const key: CorrectionKey = {
  schemaVersion: 1,
  correctionKeyId: "correction-race",
  createdAt: timestamp,
  expectedBehavior: "Run the targeted test",
  scope: "repository",
  scopeId: "repo-race",
  sourceCorrectionEventIds: [sourceId],
  trigger: "validation",
  verificationEvidenceIds: [],
  violatedConstraint: "Use the package scripts",
};
const candidate: KnowledgeCandidate = {
  schemaVersion: 1,
  appliesWhen: ["validation"],
  conflictsWith: [],
  content: "Run the targeted test",
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
  createdAt: timestamp,
  evidenceMarks: ["externally_verified"],
  evidenceTier: "externally_verified",
  importance: 1,
  kind: "procedural",
  knowledgeId: "correction-knowledge-race",
  nonApplicability: [],
  scope: "repository",
  scopeId: "repo-race",
  sourceEpisodeIds: [],
  sourceEvidenceIds: [],
  state: "active",
  topicKey: "correction:race",
  utility: { applied: 0, harmful: 0, helpful: 0 },
  validatedAt: timestamp,
};

const queuedEvent = (
  id: string,
  content?: NonNullable<Parameters<typeof createCaptureEnvelope>[0]["content"]>,
  options: Partial<Parameters<typeof createCaptureEnvelope>[0]> = {},
) =>
  captureQueueItemSchema.parse({
    schemaVersion: 1,
    attemptCount: 0,
    failureCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    queueItemId: `queue-${id}`,
    state: "pending",
    envelope: createCaptureEnvelope({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sourceEventId: id,
      sessionId: "session-enrichment",
      timestamp,
      trust: "user",
      ...options,
      ...(content === undefined ? {} : { content }),
    }),
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("canonical event enrichment and bounded queries", () => {
  it("appends redacted missing content without changing the original event", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const original = queuedEvent("missing-content");
    const supplement = queuedEvent("missing-content", {
      message: "Use targeted tests. ghp_1234567890abcdefghijklmnopqrst",
    });
    try {
      store.ingestQueueItem(original);
      expect({
        ...store.rawEvent(original.envelope.deduplicationKey)?.envelope.event,
        redactedArguments: undefined,
        resultDigest: undefined,
      }).toEqual({
        ...redactCaptureEnvelopeForPersistence(supplement.envelope).envelope.event,
        redactedArguments: undefined,
        resultDigest: undefined,
      });
      expect(store.enrichRawEvent({
        envelope: supplement.envelope,
        sourceDigest: "c".repeat(64),
      })).toEqual({ status: "enriched" });
      expect(store.rawEvent(original.envelope.deduplicationKey)?.envelope.content)
        .toBeUndefined();
      const effective = store.effectiveRawEvent(original.envelope.deduplicationKey);
      expect(JSON.stringify(effective)).toContain("Use targeted tests");
      expect(JSON.stringify(effective)).not.toContain("ghp_1234567890abcdefghijklmnopqrst");
      expect(store.episodeSourceEnvelopes()[0]?.content).toEqual(effective?.envelope.content);
      expect(store.enrichRawEvent({
        envelope: supplement.envelope,
        sourceDigest: "c".repeat(64),
      }).status).toBe("duplicate");
      expect(store.enrichRawEvent({
        envelope: queuedEvent("missing-content", { message: "Different instruction" }).envelope,
        sourceDigest: "d".repeat(64),
      }).status).toBe("rejected");
      expect(store.enrichRawEvent({
        envelope: {
          ...supplement.envelope,
          event: { ...supplement.envelope.event, trust: "tool" },
        },
        sourceDigest: "e".repeat(64),
      }).status).toBe("rejected");
    } finally {
      store.close();
    }
  });

  it("deletes supplemental evidence and prevents enrichment after deletion", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const original = queuedEvent("deleted-content");
    const supplement = queuedEvent("deleted-content", { message: "Sensitive user rule" });
    try {
      store.ingestQueueItem(original);
      store.enrichRawEvent({ envelope: supplement.envelope, sourceDigest: "c".repeat(64) });
      const target = { targetId: original.envelope.event.eventId, targetType: "source" as const };
      const operation = store.beginDeletion(target, "delete-enriched");
      store.deleteCanonicalTarget(operation.deletionId, target);
      store.prepareDeletionCompletion({
        deletionId: operation.deletionId, deletedDependentCount: 0,
        deletedQueueItemCount: 0, deletedSourceCount: 2,
        gateDigest: "b".repeat(64), propagationEvidenceId: "enriched-propagation",
      });
      store.completeDeletion(operation.deletionId);
      expect(store.effectiveRawEvent(original.envelope.deduplicationKey)).toBeUndefined();
      expect(store.enrichRawEvent({
        envelope: supplement.envelope, sourceDigest: "d".repeat(64),
      }).status).toBe("rejected");
    } finally {
      store.close();
    }
  });

  it("pages an exclusive-ended time range without dropping equal timestamps", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      for (const id of ["first", "second", "third"]) {
        store.ingestQueueItem(queuedEvent(id));
      }
      const range = {
        since: timestamp,
        until: "2026-09-02T00:00:00.000Z",
        limit: 2,
      };
      const first = store.rawEventsInRange(range);
      expect(first.records).toHaveLength(2);
      assert(first.next !== undefined);
      const second = store.rawEventsInRange({ ...range, after: first.next });
      expect(second.records).toHaveLength(1);
      expect(new Set([...first.records, ...second.records].map((record) => record.eventId)).size).toBe(3);
      expect(store.rawEventsInRange({
        since: "2026-08-31T00:00:00.000Z", until: timestamp,
      }).records).toEqual([]);
      expect(store.contextUseRecordsInRange(range).records).toEqual([]);
      for (const requestId of ["request-a", "request-b", "request-c"]) {
        store.appendContextUseRecord({
          schemaVersion: 1, appliedKnowledgeIds: [], candidateKnowledgeIds: [],
          createdAt: timestamp, latencyMs: 0, renderedTokens: 0,
          requestId, returnedKnowledgeIds: [], sessionId: "session-range",
        });
      }
      const contextPage = store.contextUseRecordsInRange({
        ...range, sessionId: "session-range",
      });
      expect(contextPage.records.map((record) => record.requestId))
        .toEqual(["request-a", "request-b"]);
      assert(contextPage.next !== undefined);
      expect(store.contextUseRecordsInRange({
        ...range, sessionId: "session-range", after: contextPage.next,
      }).records.map((record) => record.requestId)).toEqual(["request-c"]);
      expect(() => store.rawEventsInRange({ ...range, limit: 1_001 })).toThrow(RangeError);
    } finally {
      store.close();
    }
  });
});

describe("canonical verification evidence", () => {
  const proof = () => {
    const correction = queuedEvent("proof-correction");
    const intermediate = queuedEvent("proof-intermediate", undefined, {
      parentEventId: correction.envelope.event.eventId.toUpperCase(),
    });
    const operation = queuedEvent("proof-operation", {
      toolArguments: { command: "npm run test:unit" },
    }, {
      eventType: "tool.started", operationId: "operation-proof", toolName: "powershell",
      parentEventId: intermediate.envelope.event.eventId.toUpperCase(),
      trust: "tool",
    });
    const verification = queuedEvent("proof-verification", undefined, {
      eventType: "test.completed", operationId: "operation-proof", trust: "tool",
      verificationBinding: {
        correctionEventId: correction.envelope.event.eventId.toUpperCase(),
        operationEventId: operation.envelope.event.eventId.toUpperCase(),
      },
    });
    return { correction, intermediate, operation, verification };
  };

  it("normalizes proof references and loads the actual operation and its parent chain", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const events = proof();
    try {
      for (const event of Object.values(events)) {
        expect(store.ingestQueueItem(event).status).toBe("stored");
      }
      store.replaceCorrectionProjection({
        correctionKeys: [{
          ...key,
          sourceCorrectionEventIds: [events.correction.envelope.event.eventId.toUpperCase()],
          verificationEvidenceIds: [events.verification.envelope.event.eventId.toUpperCase()],
        }],
        opportunities: [],
      });
      const verification = store.rawEvent(events.verification.envelope.deduplicationKey);
      assert(verification !== undefined);
      assert(verification.envelope.event.verificationBinding !== undefined);
      expect(verification.envelope.event.verificationBinding).toEqual({
        correctionEventId: events.correction.envelope.event.eventId,
        operationEventId: events.operation.envelope.event.eventId,
      });
      expect(store.enrichRawEvent({
        envelope: { ...verification.envelope, content: { message: "Targeted test passed" } },
        sourceDigest: "c".repeat(64),
      }).status).toBe("enriched");
      expect(store.enrichRawEvent({
        envelope: {
          ...verification.envelope,
          event: {
            ...verification.envelope.event,
            verificationBinding: {
              ...verification.envelope.event.verificationBinding,
              operationEventId: `event-${"e".repeat(64)}`,
            },
          },
        },
        sourceDigest: "d".repeat(64),
      }).status).toBe("rejected");
      const evidence = store.knowledgeAdmissionEvidence([{
        ...candidate, sourceEvidenceIds: [events.verification.envelope.event.eventId.toUpperCase()],
      }]);
      expect(evidence.envelopes.map((envelope) => envelope.event.eventId).sort())
        .toEqual(Object.values(events).map((event) => event.envelope.event.eventId).sort());
      expect(evidence.envelopes.find((envelope) => envelope.event.eventType === "tool.started")?.event)
        .toMatchObject({
          operationId: "operation-proof",
          parentEventId: events.intermediate.envelope.event.eventId,
          toolName: "powershell",
        });
      expect(evidence.correctionKeys).toHaveLength(1);
      expect(evidence.envelopes.find((envelope) => envelope.event.eventType === "test.completed")?.content)
        .toEqual({ message: "Targeted test passed" });
      expect(verification.envelope.content).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it.each(["correction", "operation"] as const)(
    "deletes a verification and its dependent records through the bound %s without a parent link",
    (targetEvent) => {
      const store = new CanonicalSqliteStore(":memory:");
      const events = proof();
      try {
        for (const event of Object.values(events)) store.ingestQueueItem(event);
        const invalid = queuedEvent("invalid-proof", undefined, {
          eventType: "test.completed",
          verificationBinding: events.verification.envelope.event.verificationBinding,
        });
        expect(store.ingestQueueItem({
          ...invalid,
          envelope: {
            ...invalid.envelope,
            event: { ...invalid.envelope.event, eventId: `event-${"e".repeat(64)}` },
          },
        }).status).toBe("rejected");
        store.upsertKnowledgeCandidates([{
          ...candidate, sourceEvidenceIds: [events.verification.envelope.event.eventId],
        }, {
          ...candidate, knowledgeId: "manual-unrelated",
          evidenceMarks: ["user_confirmed"], evidenceTier: "user_confirmed",
        }]);
        store.recordKnowledgeFeedback({
          event: {
            schemaVersion: 1, feedbackId: "resolved-proof", kind: "confirm", source: "user",
            evidenceRef: "explicit-user-confirmation", targetType: "knowledge",
            targetId: "manual-unrelated", timestamp,
            resolvesEvidenceIds: [events[targetEvent].envelope.event.eventId.toUpperCase()],
          },
        });
        expect(store.feedbackEvents("manual-unrelated")[0]?.resolvesEvidenceIds)
          .toEqual([events[targetEvent].envelope.event.eventId]);
        const target = {
          targetId: events[targetEvent].envelope.event.eventId, targetType: "source" as const,
        };
        const operation = store.beginDeletion(target, `delete-proof-${targetEvent}`);
        store.deleteCanonicalTarget(operation.deletionId, target);
        expect(store.rawEvent(events.verification.envelope.deduplicationKey)).toBeUndefined();
        expect(store.parserErrors()).toEqual([]);
        expect(store.knowledgeCandidates([candidate.knowledgeId])).toEqual([]);
        expect(store.feedbackEvents("manual-unrelated")).toEqual([]);
        expect(store.remainingDeletionIdentities([{
          identityType: "event", identifier: target.targetId,
        }])).toEqual([]);
        store.prepareDeletionCompletion({
          deletionId: operation.deletionId, deletedDependentCount: 1,
          deletedQueueItemCount: 0, deletedSourceCount: 2,
          gateDigest: "b".repeat(64), propagationEvidenceId: "proof-propagation",
        });
        store.completeDeletion(operation.deletionId);
        expect(() => store.recordKnowledgeFeedback({
          event: {
            schemaVersion: 1, feedbackId: "replayed-resolution", kind: "confirm", source: "user",
            evidenceRef: "explicit-user-confirmation", targetType: "knowledge",
            targetId: "manual-unrelated", timestamp, resolvesEvidenceIds: [target.targetId],
          },
        })).toThrow("deleted evidence");
        expect(store.ingestQueueItem(events.verification).status).toBe("duplicate");
        expect(store.ingestQueueItem(queuedEvent("replayed-proof", undefined, {
          eventType: "test.completed",
          verificationBinding: events.verification.envelope.event.verificationBinding,
        })).status).toBe("duplicate");
        expect(store.rawEvents().some((event) => event.envelope.event.eventType === "test.completed"))
          .toBe(false);
      } finally {
        store.close();
      }
    },
  );

  it("rechecks bound evidence after another connection deletes the operation before BEGIN", async () => {
    await withStores((writer, deleter) => {
      const events = proof();
      for (const event of [events.correction, events.intermediate, events.operation]) {
        writer.ingestQueueItem(event);
      }
      deleteBeforeNextTransaction(deleter, {
        targetId: events.operation.envelope.event.eventId, targetType: "source",
      });
      expect(writer.ingestQueueItem(events.verification).status).toBe("duplicate");
      expect(writer.rawEvent(events.verification.envelope.deduplicationKey)).toBeUndefined();
    });
  });

  it("invalidates legacy automated claims while retaining original evidence and user confirmations", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-proof-migration-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const legacy = new CanonicalSqliteStore(path, {
      migrations: DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version < 8),
    });
    const original = queuedEvent("legacy-proof");
    const manual: KnowledgeCandidate = {
      ...candidate, knowledgeId: "manual-user-confirmed", evidenceTier: "user_confirmed" as const,
      evidenceMarks: ["user_confirmed"],
    };
    const confirmed = {
      ...manual, knowledgeId: "correction-knowledge-user-confirmed",
    };
    legacy.ingestQueueItem(original);
    legacy.replaceCorrectionProjection({ correctionKeys: [key], opportunities: [] });
    legacy.upsertKnowledgeCandidates([candidate, manual, confirmed]);
    legacy.recordKnowledgeFeedback({
      event: {
        schemaVersion: 1, feedbackId: "legacy-confirmation", kind: "confirm", source: "user",
        evidenceRef: "user-command", targetType: "knowledge", targetId: manual.knowledgeId, timestamp,
      },
    });
    legacy.close();
    const upgraded = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try {
      expect(upgraded.rawEvents()).toHaveLength(1);
      expect(upgraded.rawEvents()[0]?.envelope.event.verificationBinding).toBeUndefined();
      expect(upgraded.correctionKeys()).toEqual([]);
      expect(upgraded.knowledgeCandidates().map((value) => value.knowledgeId).sort())
        .toEqual([manual.knowledgeId, confirmed.knowledgeId].sort());
      expect(upgraded.feedbackEvents()).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });
});

describe("canonical verified recovery", () => {
  it("does not restore an automatic-revival marker over a later explicit archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-expiry-restore-")); roots.push(root);
    const path = join(root, "canonical.db"); const snapshot = join(root, "auto-expired.db");
    const store = new CanonicalSqliteStore(path);
    try {
      const lesson: KnowledgeCandidate = { ...candidate, knowledgeId: "learning-knowledge-expiry", evidenceTier: "inferred", evidenceMarks: [], state: "candidate", expiresAt: timestamp };
      store.upsertKnowledgeCandidates([lesson]); expect(store.archiveExpiredLearning(lesson.knowledgeId, new Date("2026-09-02T00:00:00Z"))).toBe(true);
      await store.backupTo(snapshot);
      store.upsertKnowledgeCandidates([{ ...lesson, state: "archived" }]);
      await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path)).rejects.toThrow("explicit lifecycle control");
    } finally { store.close(); }
  });

  it("cascades new learning lifecycle markers when their knowledge is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-expiry-delete-")); roots.push(root);
    const path = join(root, "canonical.db"); const store = new CanonicalSqliteStore(path); const db = new DatabaseSync(path);
    try {
      const lesson: KnowledgeCandidate = { ...candidate, knowledgeId: "learning-knowledge-expiry", evidenceTier: "inferred", evidenceMarks: [], state: "candidate", expiresAt: timestamp };
      store.upsertKnowledgeCandidates([lesson]); store.archiveExpiredLearning(lesson.knowledgeId, new Date("2026-09-02T00:00:00Z"));
      db.prepare("INSERT INTO learning_relation_conflicts VALUES (?)").run(lesson.knowledgeId); db.exec("PRAGMA foreign_keys=ON;");
      db.prepare("DELETE FROM knowledge_candidates WHERE knowledge_id=?").run(lesson.knowledgeId);
      for (const table of ["learning_auto_expiry", "learning_relation_conflicts"]) expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); store.close(); }
  });

  it.each(["revoke", "correct"] as const)("refuses an older backup that would undo the user %s control", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-control-restore-")); roots.push(root);
    const path = join(root, "canonical.db"); const snapshot = join(root, "before-control.db");
    const store = new CanonicalSqliteStore(path);
    try {
      store.upsertKnowledgeCandidates([candidate]);
      await store.backupTo(snapshot);
      store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: `restore-${kind}`, kind, source: "user", targetType: "knowledge",
        targetId: candidate.knowledgeId, evidenceRef: "current-user-control", timestamp: "2026-09-02T00:00:00.000Z" } });
      store.upsertKnowledgeCandidates([{ ...candidate, state: kind === "revoke" ? "archived" : "disputed" }]);
      await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path)).rejects.toThrow("user knowledge control");
      expect(store.feedbackEvents(candidate.knowledgeId)).toHaveLength(1);
      expect(store.knowledgeCandidates([candidate.knowledgeId])[0]?.state).toBe(kind === "revoke" ? "archived" : "disputed");
    } finally { store.close(); }
  });

  it("does not migrate an existing database merely because a worker or doctor opens it", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-migration-policy-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const legacy = new CanonicalSqliteStore(path, {
      migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, -1),
    });
    legacy.ingestQueueItem(queuedEvent("legacy-retained"));
    legacy.upsertKnowledgeCandidates([candidate]);
    legacy.recordKnowledgeFeedback({
      event: {
        schemaVersion: 1, feedbackId: "legacy-feedback-without-receipt", evidenceRef: "user-command",
        kind: "confirm", source: "user", targetType: "knowledge",
        targetId: candidate.knowledgeId, timestamp,
      },
    });
    legacy.close();
    expect(() => new CanonicalSqliteStore(path)).toThrow(CanonicalMigrationRequiredError);
    expect(CanonicalSqliteStore.databaseVersion(path))
      .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
    const snapshot = join(root, "before-upgrade.db");
    const manifest = await CanonicalSqliteStore.backupDatabase(path, snapshot, {
      runtimeVersion: "previous-runtime",
    });
    expect(manifest).toMatchObject({
      schemaVersion: DEFAULT_SQLITE_MIGRATIONS.length - 1,
      runtimeVersion: "previous-runtime",
    });
    const upgraded = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try {
      expect(upgraded.rawEvents()).toHaveLength(1);
      expect(upgraded.feedbackEvents()).toHaveLength(1);
      upgraded.ingestQueueItem(queuedEvent("post-upgrade-only"));
      expect(await CanonicalSqliteStore.verifyBackup(snapshot)).toEqual(manifest);
      const previousRuntime = new CanonicalSqliteStore(snapshot, {
        migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, -1),
      });
      try {
        expect(previousRuntime.rawEvents().map((record) => record.sourceEventId))
          .toEqual(["legacy-retained"]);
        expect(previousRuntime.knowledgeCandidates()).toEqual([candidate]);
        expect(previousRuntime.feedbackEvents()).toHaveLength(1);
      } finally {
        previousRuntime.close();
      }
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT replacement_json FROM feedback_events").get()?.replacement_json)
          .toBeNull();
      } finally {
        database.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("pairs snapshots with their runtime and invalidates all pre-restore handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const snapshot = join(root, "snapshot.db");
    const store = new CanonicalSqliteStore(path);
    try {
      store.ingestQueueItem(queuedEvent("retained"));
      await store.backupTo(snapshot, { runtimeVersion: "previous-runtime" });
      expect(await CanonicalSqliteStore.verifyBackup(snapshot)).toMatchObject({
        runtimeVersion: "previous-runtime", schemaVersion: DEFAULT_SQLITE_MIGRATIONS.length,
      });
      await CanonicalSqliteStore.restoreFromBackup(snapshot, path);
      expect(() => store.rawEvents()).toThrow(StaleCanonicalStoreError);
    } finally {
      store.close();
    }
    const reopened = new CanonicalSqliteStore(path);
    try {
      expect(reopened.rawEvents()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("restores the pre-operation data and key when installation fails after key replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-failure-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const sourcePath = join(root, "source.db");
    const snapshot = join(root, "snapshot.db");
    const current = new CanonicalSqliteStore(path);
    current.ingestQueueItem(queuedEvent("existing-data"));
    current.close();
    const previousKey = await readFile(`${path}.deletion.key`, "utf8");
    const source = new CanonicalSqliteStore(sourcePath);
    source.ingestQueueItem(queuedEvent("replacement-data"));
    await source.backupTo(snapshot);
    source.close();

    await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path, {
      faultInjector: (stage) => {
        if (stage === "after_restore_key_install") {
          throw new Error("simulated installation failure");
        }
      },
    })).rejects.toThrow("simulated installation failure");
    expect(await readFile(`${path}.deletion.key`, "utf8")).toBe(previousKey);
    const restored = new CanonicalSqliteStore(path);
    try {
      expect(restored.rawEvents().map((record) => record.sourceEventId))
        .toEqual([queuedEvent("existing-data").envelope.sourceEventId]);
    } finally {
      restored.close();
    }
    await expect(access(`${path}.restore.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an abandoned installation from its verified pre-restore snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-installing-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const id = "11111111-1111-4111-8111-111111111111";
    const previousPath = `${path}.restore-${id}.previous`;
    const temporaryPath = `${path}.restore-${id}.tmp`;
    const original = new CanonicalSqliteStore(path);
    original.ingestQueueItem(queuedEvent("original"));
    await original.backupTo(previousPath);
    original.close();
    const replacement = new CanonicalSqliteStore(":memory:");
    replacement.ingestQueueItem(queuedEvent("replacement"));
    await replacement.backupTo(temporaryPath);
    replacement.close();
    const previousDigest = CanonicalSqliteStore.databaseFingerprint(path);
    const replacementDigest = CanonicalSqliteStore.databaseFingerprint(temporaryPath);
    const source = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      await backup(source, path);
    } finally {
      source.close();
    }
    await writeFile(`${path}.deletion.key`, await readFile(`${temporaryPath}.deletion.key`));
    await writeFile(`${path}.restore.lock`, JSON.stringify({
      formatVersion: 1, pid: 2147483647, operationId: id, targetPath: path,
      temporaryPath, previousPath, hadTarget: true, phase: "installing",
      previousDigest, replacementDigest,
    }), "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
    });
    try {
      await CanonicalSqliteStore.recoverInterruptedRestore(path);
    } finally {
      kill.mockRestore();
    }
    const recovered = new CanonicalSqliteStore(path);
    try {
      expect(recovered.rawEvents()[0]?.sourceEventId)
        .toBe(queuedEvent("original").envelope.sourceEventId);
    } finally {
      recovered.close();
    }
    await expect(access(`${path}.restore.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unexpected concurrent data and recovery evidence instead of overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-concurrent-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const snapshot = join(root, "snapshot.db");
    const store = new CanonicalSqliteStore(path);
    await store.backupTo(snapshot);
    store.close();
    await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path, {
      faultInjector: (stage) => {
        if (stage === "after_restore_key_install") {
          const uncoordinated = new DatabaseSync(path);
          try {
            uncoordinated.prepare(
              "INSERT INTO metrics(metric_name,metric_value,dimensions_json,recorded_at) VALUES(?,?,?,?)",
            ).run("unexpected-new-data", 1, "{}", timestamp);
          } finally {
            uncoordinated.close();
          }
          throw new Error("simulated interruption");
        }
      },
    })).rejects.toThrow("requires recovery");
    const diagnostic = new DatabaseSync(path, { readOnly: true });
    try {
      expect(diagnostic.prepare("SELECT metric_name FROM metrics").get()?.metric_name)
        .toBe("unexpected-new-data");
    } finally {
      diagnostic.close();
    }
    await expect(access(`${path}.restore.lock`)).resolves.toBeUndefined();
  });

  it("checks optimistic rollback expectations after establishing the restore barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-expectation-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const snapshot = join(root, "snapshot.db");
    const store = new CanonicalSqliteStore(path);
    try {
      await store.backupTo(snapshot);
      const expectedTargetFingerprint = CanonicalSqliteStore.databaseFingerprint(path);
      store.ingestQueueItem(queuedEvent("concurrent-write"));
      await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path, {
        expectedTargetFingerprint,
      })).rejects.toThrow("refusing to overwrite new writes");
      expect(store.rawEvents()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses a mismatched backup key and safely reclaims an abandoned preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-recovery-stale-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const snapshot = join(root, "snapshot.db");
    const source = new CanonicalSqliteStore(path);
    await source.backupTo(snapshot);
    source.close();
    await writeFile(`${snapshot}.deletion.key`, "f".repeat(64), "utf8");
    await expect(CanonicalSqliteStore.verifyBackup(snapshot)).rejects.toThrow("do not match");

    const id = "11111111-1111-4111-8111-111111111111";
    await writeFile(`${path}.restore.lock`, JSON.stringify({
      formatVersion: 1, pid: 2147483647, operationId: id,
      targetPath: path, temporaryPath: `${path}.restore-${id}.tmp`,
      previousPath: `${path}.restore-${id}.previous`,
      hadTarget: true, phase: "preparing",
    }), "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
    });
    try {
      await CanonicalSqliteStore.recoverInterruptedRestore(path);
    } finally {
      kill.mockRestore();
    }
    await expect(access(`${path}.restore.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = new CanonicalSqliteStore(path);
    recovered.close();
  });
});

const withStores = async (
  run: (writer: CanonicalSqliteStore, deleter: CanonicalSqliteStore) => void,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-store-race-"));
  roots.push(root);
  const path = join(root, "canonical.db");
  const writer = new CanonicalSqliteStore(path);
  const deleter = new CanonicalSqliteStore(path);
  try {
    run(writer, deleter);
  } finally {
    writer.close();
    deleter.close();
  }
};

const deleteBeforeNextTransaction = (
  store: CanonicalSqliteStore,
  target: { targetId: string; targetType: "knowledge" | "source" | "session" },
): void => {
  const exec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE;") {
        spy.mockRestore();
        const operation = store.beginDeletion(target, "interleaved-delete");
        store.deleteCanonicalTarget(operation.deletionId, target);
        store.prepareDeletionCompletion({
          deletionId: operation.deletionId,
          deletedDependentCount: 1,
          deletedQueueItemCount: 0,
          deletedSourceCount: 0,
          gateDigest: "b".repeat(64),
          propagationEvidenceId: "interleaved-propagation",
        });
        store.completeDeletion(operation.deletionId);
      }
      return exec.call(this, sql);
    });
};

describe("atomic confirmed-rule replacement", () => {
  const replacementInput = (
    previous: KnowledgeCandidate = candidate,
  ): Parameters<CanonicalSqliteStore["replaceKnowledgeWithConfirmedRule"]>[0] => {
    const confirmedAt = "2026-09-02T00:00:00.000Z";
    return {
      previousKnowledgeId: previous.knowledgeId,
      expectedDigest: sha256(previous),
      candidate: {
        ...previous, knowledgeId: "manual-knowledge-resolution", topicKey: "manual:resolution",
        content: "Use the confirmed package test command", evidenceMarks: ["user_confirmed"],
        evidenceTier: "user_confirmed", state: "active", supersedes: previous.knowledgeId,
        conflictsWith: [], sourceEpisodeIds: [], sourceEvidenceIds: [],
        coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
        utility: { applied: 0, harmful: 0, helpful: 0 },
        createdAt: confirmedAt, validatedAt: confirmedAt, expiresAt: undefined,
      },
      event: {
        schemaVersion: 1, feedbackId: "feedback-resolution", evidenceRef: "control:feedback-resolution",
        kind: "confirm", source: "user", targetType: "knowledge", targetId: previous.knowledgeId,
        timestamp: confirmedAt, resolvesEvidenceIds: [],
      },
    };
  };

  it("persists an idempotent receipt and does not reactivate superseded claims during rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-confirmed-rule-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const input = replacementInput();
    const store = new CanonicalSqliteStore(path);
    try {
      store.upsertKnowledgeCandidates([candidate]);
      expect(store.replaceKnowledgeWithConfirmedRule(input)).toMatchObject({
        recorded: true, candidate: { evidenceTier: "user_confirmed", state: "active" },
      });
      expect(store.knowledgeCandidates([candidate.knowledgeId])[0])
        .toEqual({ ...candidate, state: "superseded" });
      store.upsertKnowledgeCandidates([candidate]);
      store.replaceCorrectionKnowledgeCandidates({ candidates: [candidate] });
      store.replaceCorrectionKnowledgeCandidates({ candidates: [] });
      expect(store.knowledgeCandidates([candidate.knowledgeId])[0]?.state).toBe("superseded");
      expect(store.recordKnowledgeFeedback({
        event: { ...input.event, feedbackId: "late-old-confirm" },
        updateCandidate: (current) => ({ ...current, state: "active" }),
      }).candidate.state).toBe("superseded");
      store.recordKnowledgeFeedback({
        event: { ...input.event, feedbackId: "helpful-new-rule", targetId: input.candidate.knowledgeId, kind: "strengthen" },
        updateCandidate: (current) => ({ ...current, utility: { ...current.utility, helpful: 1 } }),
      });
    } finally {
      store.close();
    }
    const reopened = new CanonicalSqliteStore(path);
    try {
      const retriedAt = "2026-09-03T00:00:00.000Z";
      const retried = reopened.replaceKnowledgeWithConfirmedRule({
        ...input,
        candidate: { ...input.candidate, createdAt: retriedAt, validatedAt: retriedAt },
        event: { ...input.event, timestamp: retriedAt },
      });
      expect(retried).toMatchObject({
        recorded: false,
        candidate: { createdAt: input.candidate.createdAt, utility: { helpful: 1 } },
      });
      expect(reopened.feedbackEvents().filter((event) => event.feedbackId === input.event.feedbackId))
        .toHaveLength(1);
      expect(() => reopened.replaceKnowledgeWithConfirmedRule({
        ...input, expectedDigest: "f".repeat(64),
      })).toThrow("different or incomplete content");
      expect(() => reopened.replaceKnowledgeWithConfirmedRule({
        ...input, candidate: { ...input.candidate, content: "Different confirmation" },
      })).toThrow("different or incomplete content");
      expect(() => reopened.replaceKnowledgeWithConfirmedRule({
        ...input, event: { ...input.event, feedbackId: "colliding-replacement" },
      })).toThrow("without matching audit feedback");
    } finally {
      reopened.close();
    }
  });

  it.each(["scope", "trust", "tier", "source", "digest"] as const)(
    "rejects an invalid %s without partially changing Knowledge",
    (invalid) => {
      const store = new CanonicalSqliteStore(":memory:");
      const input = replacementInput();
      if (invalid === "scope") input.candidate.scopeId = "another-repository";
      if (invalid === "trust") input.event.source = "test";
      if (invalid === "tier") input.candidate.evidenceTier = "externally_verified";
      if (invalid === "source") input.candidate.sourceEvidenceIds = [sourceId];
      const request = invalid === "digest" ? { ...input, expectedDigest: "f".repeat(64) } : input;
      try {
        store.upsertKnowledgeCandidates([candidate]);
        expect(() => store.replaceKnowledgeWithConfirmedRule(request))
          .toThrow(/scope|explicitly user-confirmed|changed after review/u);
        expect(store.knowledgeCandidates()).toEqual([candidate]);
        expect(store.feedbackEvents()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it("rechecks the review digest after an actual second connection updates the old rule", async () => {
    await withStores((writer, concurrent) => {
      writer.upsertKnowledgeCandidates([candidate]);
      const input = replacementInput();
      const changed = { ...candidate, content: "Changed before transaction" };
      const exec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql === "BEGIN IMMEDIATE;") {
            spy.mockRestore();
            concurrent.upsertKnowledgeCandidates([changed]);
          }
          return exec.call(this, sql);
        });
      expect(() => writer.replaceKnowledgeWithConfirmedRule(input)).toThrow("changed after review");
      expect(writer.knowledgeCandidates()).toEqual([changed]);
      expect(writer.feedbackEvents()).toEqual([]);
    });
  });

  it("rolls back both Knowledge writes if the audit insert fails", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      store.upsertKnowledgeCandidates([candidate]);
      const prepare = DatabaseSync.prototype.prepare;
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql.includes("INSERT INTO feedback_events") && sql.includes("replacement_json")) {
            spy.mockRestore();
            throw new Error("Injected audit failure");
          }
          return prepare.call(this, sql);
        });
      expect(() => store.replaceKnowledgeWithConfirmedRule(replacementInput()))
        .toThrow("Injected audit failure");
      expect(store.knowledgeCandidates()).toEqual([candidate]);
      expect(store.feedbackEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("does not bypass a predecessor forgotten by another connection before BEGIN", async () => {
    await withStores((writer, deleter) => {
      writer.upsertKnowledgeCandidates([candidate]);
      deleteBeforeNextTransaction(deleter, {
        targetId: candidate.knowledgeId, targetType: "knowledge",
      });
      expect(() => writer.replaceKnowledgeWithConfirmedRule(replacementInput()))
        .toThrow("forgotten Knowledge");
      expect(writer.knowledgeCandidates()).toEqual([]);
      expect(writer.feedbackEvents()).toEqual([]);
    });
  });

  it.each(["replacement", "source"] as const)(
    "removes replacement receipts when the %s is deleted and blocks replay",
    (deleted) => {
      const store = new CanonicalSqliteStore(":memory:");
      const original = queuedEvent("replacement-source");
      const previous = { ...candidate, sourceEvidenceIds: [original.envelope.event.eventId] };
      const input = replacementInput(previous);
      try {
        store.ingestQueueItem(original);
        store.upsertKnowledgeCandidates([previous]);
        store.replaceKnowledgeWithConfirmedRule(input);
        const target = deleted === "source"
          ? { targetId: original.envelope.event.eventId, targetType: "source" as const }
          : { targetId: input.candidate.knowledgeId, targetType: "knowledge" as const };
        const operation = store.beginDeletion(target, `delete-rule-${deleted}`);
        store.deleteCanonicalTarget(operation.deletionId, target);
        expect(store.knowledgeCandidates([input.candidate.knowledgeId])).toEqual([]);
        expect(store.feedbackEvents()).toEqual([]);
        expect(store.remainingIdentifiers(new Set([
          `knowledge:${input.candidate.knowledgeId}`, input.event.feedbackId,
        ]))).toEqual([]);
        store.prepareDeletionCompletion({
          deletionId: operation.deletionId, deletedDependentCount: 1,
          deletedQueueItemCount: 0, deletedSourceCount: 2,
          gateDigest: "b".repeat(64), propagationEvidenceId: "replacement-propagation",
        });
        store.completeDeletion(operation.deletionId);
        expect(() => store.replaceKnowledgeWithConfirmedRule(input))
          .toThrow(/forgotten Knowledge|target does not exist/u);
        if (deleted === "replacement") {
          store.replaceCorrectionKnowledgeCandidates({ candidates: [] });
          store.upsertKnowledgeCandidates([previous]);
          expect(store.knowledgeCandidates([previous.knowledgeId])[0]?.state).toBe("superseded");
        }
      } finally {
        store.close();
      }
    },
  );
});

describe("canonical transaction boundaries", () => {
  it("blocks stale Branch Context use after deletion but permits a valid same-ID rebuild", async () => {
    await withStores((writer, deleter) => {
      const context: BranchContext = {
        schemaVersion: 1, acceptedDecisions: [], branch: "feature",
        branchContextId: "rebuildable-context", explicitConstraints: [],
        headSha: "a".repeat(40), implementationState: [],
        recentVerificationEvidenceIds: [sourceId.toUpperCase()], repoId: "repo-race",
        sourceEpisodeIds: [], sourceEventIds: [], unfinishedItems: [], updatedAt: timestamp,
      };
      const request: ContextUseRecord = {
        schemaVersion: 1, appliedKnowledgeIds: [], candidateKnowledgeIds: [],
        createdAt: timestamp, latencyMs: 0, renderedTokens: 1,
        requestId: "rebuildable-request", returnedKnowledgeIds: ["branch-context:rebuildable-context"],
        sessionId: "rebuildable-session",
      };
      writer.replaceBranchContextProjection({ contexts: [context] });
      deleteBeforeNextTransaction(deleter, { targetId: sourceId, targetType: "source" });
      expect(() => writer.appendContextUseRecord(request)).toThrow("cannot restore a deleted identity");
      expect(writer.contextUseRecords()).toEqual([]);
      expect(writer.branchContexts()).toEqual([]);
      expect(() => writer.replaceBranchContextProjection({ contexts: [context] }))
        .toThrow("deleted identity");
      writer.replaceBranchContextProjection({
        contexts: [{ ...context, recentVerificationEvidenceIds: [] }],
      });
      expect(writer.appendContextUseRecord(request)).toBe(true);
    });
  });

  it("persists typed Branch Context feedback without promoting Knowledge and deletes it with its source", () => {
    const store = new CanonicalSqliteStore(":memory:");
    const branchId = candidate.knowledgeId;
    try {
      store.replaceCorrectionKnowledgeCandidates({
        candidates: [{ ...candidate, state: "candidate" }],
      });
      store.replaceBranchContextProjection({ contexts: [{
        schemaVersion: 1, acceptedDecisions: [], branch: "feature",
        branchContextId: branchId, explicitConstraints: [],
        headSha: "a".repeat(40), implementationState: [],
        recentVerificationEvidenceIds: [], repoId: "repo-race",
        sourceEpisodeIds: [], sourceEventIds: [sourceId],
        unfinishedItems: [], updatedAt: timestamp,
      }] });
      store.appendContextUseRecord({
        schemaVersion: 1, appliedKnowledgeIds: [], candidateKnowledgeIds: [],
        createdAt: timestamp, latencyMs: 1, renderedTokens: 20,
        requestId: "branch-request",
        returnedKnowledgeIds: [`branch-context:${branchId}`],
        sessionId: "branch-session",
      });
      expect(store.contextUseRecords()[0]?.retrievalStatus).toBeUndefined();
      const event: FeedbackEvent = {
        schemaVersion: 1, evidenceRef: "branch-request",
        feedbackId: "branch-feedback", kind: "confirm",
        source: "user", targetId: branchId,
        targetType: "branch_context", timestamp,
      };
      expect(() => store.recordContextFeedback({
        contextRequestId: "branch-request",
        event: { ...event, feedbackId: "invalid-branch-feedback" },
        updateContextUseRecord: (record) => ({ ...record, sessionId: "different-session" }),
      })).toThrow("cannot replace context request identity");
      expect(store.feedbackEvents(branchId)).toEqual([]);
      expect(store.recordContextFeedback({
        contextRequestId: "branch-request",
        event,
        updateContextUseRecord: (record) => ({ ...record, feedback: "helpful" }),
      })).toEqual({ recorded: true });
      expect(store.recordBranchContextFeedback({ event })).toEqual({ recorded: false });
      expect(store.recordBranchContextFeedback({
        event: { ...event, feedbackId: "branch-strengthen", kind: "strengthen" },
      })).toEqual({ recorded: true });
      expect(store.contextUseRecords()[0]?.feedback).toBe("helpful");
      expect(store.knowledgeCandidates([branchId])[0]?.state).toBe("candidate");
      expect(() => store.recordKnowledgeFeedback({ event })).toThrow("must target Knowledge");
      const target = { targetType: "source" as const, targetId: sourceId };
      const operation = store.beginDeletion(target, "delete-branch-feedback");
      store.deleteCanonicalTarget(operation.deletionId, target);
      expect(store.feedbackEvents(branchId)).toEqual([]);
      expect(store.contextUseRecords()).toEqual([]);
      expect(store.knowledgeCandidates([branchId])[0]?.state).toBe("candidate");
    } finally {
      store.close();
    }
  });

  it("rejects stale correction evidence after a real concurrent writer completes deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-process-race-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const store = new CanonicalSqliteStore(path);
    store.replaceCorrectionProjection({ correctionKeys: [key], opportunities: [] });
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      const gate = new Int32Array(workerData.gate);
      (async () => {
        try {
          const { CanonicalSqliteStore } = await import(workerData.moduleUrl);
          Atomics.wait(gate, 0, 0);
          const store = new CanonicalSqliteStore(workerData.path);
          try {
            const target = { targetId: workerData.sourceId, targetType: "source" };
            const operation = store.beginDeletion(target, "child-delete");
            store.deleteCanonicalTarget(operation.deletionId, target);
            store.prepareDeletionCompletion({
              deletionId: operation.deletionId, deletedDependentCount: 1,
              deletedQueueItemCount: 0, deletedSourceCount: 2,
              gateDigest: "b".repeat(64), propagationEvidenceId: "child-propagation"
            });
            store.completeDeletion(operation.deletionId);
          } finally { store.close(); }
          Atomics.store(gate, 0, 2);
        } catch (error) {
          console.error(error);
          Atomics.store(gate, 0, -1);
        } finally { Atomics.notify(gate, 0); }
      })();
    `, {
      eval: true,
      workerData: {
        gate: gate.buffer, path, sourceId,
        moduleUrl: await createCanonicalStoreWorkerModule(root),
      },
    });
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (sql === "BEGIN IMMEDIATE;") {
          spy.mockRestore();
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
          Atomics.wait(gate, 0, 1, 10_000);
          if (Atomics.load(gate, 0) !== 2) {
            throw new Error("The concurrent deletion did not complete.");
          }
        }
        return exec.call(this, sql);
      });
    try {
      expect(() => store.replaceCorrectionProjection({
        correctionKeys: [key], opportunities: [],
      })).toThrow("deleted identity");
      expect(store.correctionKeys()).toEqual([]);
    } finally {
      spy.mockRestore();
      store.close();
      await worker.terminate();
    }
  });

  it("rejects a context record whose session is deleted before its transaction starts", async () => {
    await withStores((writer, deleter) => {
      deleteBeforeNextTransaction(deleter, {
        targetId: "context-race-session", targetType: "session",
      });
      expect(() => writer.appendContextUseRecord({
        schemaVersion: 1, appliedKnowledgeIds: [], candidateKnowledgeIds: [],
        createdAt: timestamp, latencyMs: 0, renderedTokens: 0,
        requestId: "context-race", returnedKnowledgeIds: [],
        sessionId: "context-race-session",
      })).toThrow("cannot restore a deleted identity");
      expect(writer.contextUseRecords()).toEqual([]);
    });
  });

  it("chunks large queue-artifact deletions under SQLite's variable limit", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      expect(store.deleteQueueArtifacts(
        Array.from({ length: 32_767 }, (_value, index) => `queue-${index}`),
      )).toBe(0);
    } finally {
      store.close();
    }
  });
  it("rejects a correction source deleted by another connection before BEGIN", async () => {
    await withStores((writer, deleter) => {
      writer.replaceCorrectionProjection({
        correctionKeys: [key],
        opportunities: [],
      });
      deleteBeforeNextTransaction(deleter, {
        targetId: sourceId,
        targetType: "source",
      });
      expect(() => writer.replaceCorrectionProjection({
        correctionKeys: [key],
        opportunities: [],
      })).toThrow("deleted identity");
      expect(writer.correctionKeys()).toEqual([]);
      expect(writer.hasActiveDeletion()).toBe(false);
    });
  });

  it("rejects knowledge forgotten by another connection before BEGIN", async () => {
    await withStores((writer, deleter) => {
      writer.replaceCorrectionKnowledgeCandidates({ candidates: [candidate] });
      deleteBeforeNextTransaction(deleter, {
        targetId: candidate.knowledgeId,
        targetType: "knowledge",
      });
      expect(() => writer.replaceCorrectionKnowledgeCandidates({
        candidates: [candidate],
      })).toThrow("was forgotten");
      expect(writer.knowledgeCandidates()).toEqual([]);
    });
  });

  it("allows legitimate projection downgrade and verification time rollback", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      store.replaceCorrectionKnowledgeCandidates({ candidates: [candidate] });
      const downgraded = {
        ...candidate,
        state: "archived" as const,
        validatedAt: "2026-08-30T00:00:00.000Z",
      };
      store.replaceCorrectionKnowledgeCandidates({ candidates: [downgraded] });
      expect(store.knowledgeCandidates()).toEqual([downgraded]);
    } finally {
      store.close();
    }
  });
});
