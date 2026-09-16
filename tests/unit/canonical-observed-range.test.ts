import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureQueueItemSchema,
  type ContextUseRecord,
  type FeedbackEvent,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import { createCaptureEnvelope, sha256 } from "@provenloop/domain";
import { CanonicalSqliteStore, DEFAULT_SQLITE_MIGRATIONS } from "@provenloop/storage-sqlite";
import { createCanonicalStoreWorkerModule } from "../fixtures/canonical-store-worker.js";

const roots: string[] = [];
const eventTime = "2026-09-01T00:00:00.000Z";
const firstSeen = "2026-09-02T00:00:00.000Z";
const laterSeen = "2026-09-03T00:00:00.000Z";
const followingDay = "2026-09-04T00:00:00.000Z";
const retryDay = "2026-09-05T00:00:00.000Z";
const range = { since: laterSeen, until: followingDay, timeBasis: "observed" as const };

const queueItem = (id: string, message?: string) => captureQueueItemSchema.parse({
  schemaVersion: 1, attemptCount: 0, failureCount: 0, state: "pending",
  queueItemId: `queue-${id}`, createdAt: eventTime, updatedAt: eventTime,
  envelope: createCaptureEnvelope({
    adapter: "copilot-cli", adapterVersion: "1.0.82-0", sourceEventId: id,
    eventType: "prompt.submitted", sessionId: "observed-session", timestamp: eventTime,
    trust: "user", ...(message === undefined ? {} : { content: { message } }),
  }),
});

const contextRecord = (requestId: string, returned: readonly string[] = []): ContextUseRecord => ({
  schemaVersion: 1, requestId, sessionId: "observed-session", createdAt: eventTime,
  appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [...returned],
  latencyMs: 1, renderedTokens: 1,
  retrievalStatus: returned.length === 0 ? "no_match" : "provided",
});

const knowledge: KnowledgeCandidate = {
  schemaVersion: 1, knowledgeId: "manual-knowledge-observed", topicKey: "manual:observed",
  content: "Use the package test scripts", appliesWhen: ["testing"], nonApplicability: [],
  conflictsWith: [], sourceEpisodeIds: [], sourceEvidenceIds: [], state: "active",
  evidenceMarks: ["user_confirmed"], evidenceTier: "user_confirmed",
  kind: "procedural", scope: "repository", scopeId: "observed-repo", importance: 1,
  createdAt: eventTime, validatedAt: eventTime,
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
  utility: { applied: 0, helpful: 0, harmful: 0 },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical observed-time ranges", () => {
  it("finds late enrichment without rewriting original facts and pages by last observation", () => {
    let observedAt = firstSeen;
    const store = new CanonicalSqliteStore(":memory:", { now: () => new Date(observedAt) });
    const original = queueItem("late-enrichment");
    const supplement = queueItem("late-enrichment", "The recovered session text");
    try {
      store.ingestQueueItem(original);
      observedAt = laterSeen;
      expect(store.enrichRawEvent({ envelope: supplement.envelope, sourceDigest: "a".repeat(64) }).status)
        .toBe("enriched");
      store.ingestQueueItem(queueItem("same-observation-a"));
      store.ingestQueueItem(queueItem("same-observation-b"));
      const first = store.rawEventsInRange({ ...range, limit: 2 });
      expect(first.records).toHaveLength(2);
      expect(first.next?.timestamp).toBe(laterSeen);
      assert(first.next !== undefined);
      const second = store.rawEventsInRange({ ...range, limit: 2, after: first.next });
      expect(second.records).toHaveLength(1);
      const records = [...first.records, ...second.records];
      expect(new Set(records.map((record) => record.eventId)).size).toBe(3);
      expect(records.every((record) => record.lastSeenAt === laterSeen)).toBe(true);
      expect(records.find((record) => record.eventId === original.envelope.event.eventId)?.envelope.content)
        .toEqual({ message: "The recovered session text" });
      expect(store.rawEvent(original.envelope.deduplicationKey)?.envelope.content).toBeUndefined();
      expect(store.rawEventsInRange({ since: laterSeen, until: followingDay }).records).toEqual([]);
      const oldEvents = store.rawEventsInRange({ since: eventTime, until: firstSeen }).records;
      expect(oldEvents).toHaveLength(3);
      expect(oldEvents.every((record) => record.lastSeenAt === undefined)).toBe(true);
      expect(store.rawEventsInRange({
        since: firstSeen, until: laterSeen, timeBasis: "observed",
      }).records).toEqual([]);

      observedAt = followingDay;
      expect(store.enrichRawEvent({ envelope: supplement.envelope, sourceDigest: "a".repeat(64) }).status)
        .toBe("duplicate");
      expect(store.rawEventsInRange({
        since: followingDay, until: retryDay, timeBasis: "observed",
      }).records).toEqual([]);
      store.ingestQueueItem(original);
      expect(store.rawEventsInRange({
        since: followingDay, until: retryDay, timeBasis: "observed",
      }).records[0]).toMatchObject({ deliveryCount: 2, lastSeenAt: followingDay });
      expect(() => store.rawEventsInRange({ ...range, timeBasis: "invalid" as never }))
        .toThrow(RangeError);
    } finally {
      store.close();
    }
  });

  it.each(["knowledge", "branch_context"] as const)(
    "observes later %s feedback on an old request, including feedback without a mutation callback",
    (targetType) => {
      let observedAt = firstSeen;
      const store = new CanonicalSqliteStore(":memory:", { now: () => new Date(observedAt) });
      const targetId = targetType === "knowledge" ? knowledge.knowledgeId : "observed-branch";
      const targetRef = targetType === "knowledge" ? `knowledge:${targetId}` : `branch-context:${targetId}`;
      const request = contextRecord("late-feedback-request", [targetRef]);
      const event: FeedbackEvent = {
        schemaVersion: 1, feedbackId: "late-feedback", evidenceRef: request.requestId,
        targetType, targetId, source: "user", kind: "strengthen", timestamp: eventTime,
      };
      try {
        store.upsertKnowledgeCandidates([knowledge]);
        store.replaceBranchContextProjection({ contexts: [{
          schemaVersion: 1, branchContextId: "observed-branch", repoId: "observed-repo",
          branch: "main", headSha: "a".repeat(40), updatedAt: eventTime,
          acceptedDecisions: [], explicitConstraints: [], implementationState: [],
          unfinishedItems: [], sourceEpisodeIds: [], sourceEventIds: [],
          recentVerificationEvidenceIds: [],
        }] });
        store.appendContextUseRecord(request);
        expect(store.contextUseRecords()[0]?.updatedAt).toBe(firstSeen);
        observedAt = laterSeen;
        const input = {
          contextRequestId: request.requestId, event,
          updateContextUseRecord: (record: ContextUseRecord) => ({
            ...record, feedback: "helpful" as const, appliedKnowledgeIds: [targetRef],
          }),
        };
        if (targetType === "knowledge") store.recordKnowledgeFeedback(input);
        else store.recordContextFeedback(input);
        expect(store.contextUseRecordsInRange(range).records).toMatchObject([{
          createdAt: eventTime, updatedAt: laterSeen, feedback: "helpful",
        }]);
        expect(store.contextUseRecordsInRange({ since: laterSeen, until: followingDay }).records)
          .toEqual([]);
        expect(store.contextUseRecordsInRange({ ...range, sessionId: "another-session" }).records)
          .toEqual([]);

        observedAt = followingDay;
        const audit = { ...event, feedbackId: "additional-feedback", source: "analyzer" as const };
        if (targetType === "knowledge") store.recordKnowledgeFeedback({ event: audit });
        else store.recordBranchContextFeedback({ event: audit });
        expect(store.contextUseRecordsInRange({
          since: followingDay, until: retryDay, timeBasis: "observed",
        }).records[0]).toMatchObject({ feedback: "helpful", updatedAt: followingDay });
        observedAt = retryDay;
        if (targetType === "knowledge") store.recordKnowledgeFeedback({ event: audit });
        else store.recordBranchContextFeedback({ event: audit });
        expect(store.contextUseRecords()[0]?.updatedAt).toBe(followingDay);
      } finally {
        store.close();
      }
    },
  );

  it("pages context updates using the observed timestamp and request ID rather than creation", () => {
    let observedAt = firstSeen;
    const store = new CanonicalSqliteStore(":memory:", { now: () => new Date(observedAt) });
    try {
      store.upsertKnowledgeCandidates([knowledge]);
      for (const id of ["request-c", "request-a", "request-b"]) store.appendContextUseRecord(contextRecord(id));
      observedAt = laterSeen;
      for (const id of ["request-c", "request-a", "request-b"]) {
        store.recordKnowledgeFeedback({
          event: {
            schemaVersion: 1, feedbackId: `feedback-${id}`, evidenceRef: id, source: "analyzer",
            targetId: knowledge.knowledgeId, targetType: "knowledge", kind: "strengthen", timestamp: eventTime,
          },
        });
      }
      const first = store.contextUseRecordsInRange({ ...range, limit: 2 });
      expect(first.records.map((record) => record.requestId)).toEqual(["request-a", "request-b"]);
      expect(first.next).toEqual({ timestamp: laterSeen, id: "request-b" });
      assert(first.next !== undefined);
      expect(store.contextUseRecordsInRange({
        ...range, limit: 2, after: first.next,
      }).records.map((record) => record.requestId)).toEqual(["request-c"]);
      expect(() => store.contextUseRecordsInRange({ ...range, limit: 1_001 })).toThrow(RangeError);
    } finally {
      store.close();
    }
  });

  it("backfills legacy rows without inventing a migration-time observation and retains bounded indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-observed-migration-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const legacy = new CanonicalSqliteStore(path, {
      migrations: DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version < 10),
      now: () => new Date(firstSeen),
    });
    const request = contextRecord("legacy-context");
    legacy.appendContextUseRecord(request);
    expect(legacy.contextUseRecords()[0]?.updatedAt).toBeUndefined();
    const originalBody = JSON.stringify(legacy.contextUseRecords()[0]);
    legacy.close();
    const migrated = new CanonicalSqliteStore(path, {
      allowSchemaMigration: true, now: () => new Date(laterSeen),
    });
    try {
      expect(migrated.contextUseRecordsInRange(range).records).toEqual([]);
      const legacyPage = migrated.contextUseRecordsInRange({
        since: eventTime, until: firstSeen, timeBasis: "observed",
      });
      expect(legacyPage.records).toEqual([request]);
      const database = new DatabaseSync(path);
      try {
        expect(database.prepare("SELECT updated_at, body_json, source_digest FROM context_use_records").get())
          .toMatchObject({ updated_at: eventTime, body_json: originalBody, source_digest: sha256(request) });
        for (const [table, column, idColumn, index] of [
          ["raw_events", "last_seen_at", "deduplication_key", "raw_events_observed"],
          ["context_use_records", "updated_at", "request_id", "context_use_observed"],
        ] as const) {
          const plan = database.prepare(
            `EXPLAIN QUERY PLAN SELECT ${idColumn} FROM ${table}
              WHERE ${column} >= ? AND ${column} < ? ORDER BY ${column}, ${idColumn} LIMIT 2`,
          ).all(eventTime, laterSeen);
          expect(plan.some((step) => String(step.detail).includes(index))).toBe(true);
        }
        expect(() => database.prepare(
          `INSERT INTO context_use_records (
             request_id, schema_version, session_id, body_json, source_digest, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("obsolete-writer", 1, request.sessionId, JSON.stringify(request), sha256(request), eventTime))
          .toThrow(/NOT NULL constraint failed.*updated_at/u);
      } finally {
        database.close();
      }
    } finally {
      migrated.close();
    }
  });

  it("waits for an in-flight writer before returning an observed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-observed-writer-"));
    roots.push(root);
    const path = join(root, "canonical.db");
    const store = new CanonicalSqliteStore(path);
    const item = queueItem("in-flight-observation");
    const gate = new Int32Array(new SharedArrayBuffer(12));
    const worker = new Worker(`
      const { workerData } = require("node:worker_threads");
      const gate = new Int32Array(workerData.gate);
      (async () => {
        try {
          const { CanonicalSqliteStore } = await import(workerData.moduleUrl);
          const store = new CanonicalSqliteStore(workerData.path, {
            now: () => new Date(workerData.observedAt),
            faultInjector(stage) {
              if (stage !== "after_raw_event_insert") return;
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0);
              Atomics.wait(gate, 1, 0, 10_000);
              Atomics.wait(gate, 2, 0, 30);
            }
          });
          try { store.ingestQueueItem(workerData.item); }
          finally { store.close(); }
        } catch (error) {
          console.error(error);
          Atomics.store(gate, 0, -1);
          Atomics.notify(gate, 0);
        }
      })();
    `, {
      eval: true,
      workerData: {
        gate: gate.buffer, path, item, observedAt: laterSeen,
        moduleUrl: await createCanonicalStoreWorkerModule(root),
      },
    });
    try {
      Atomics.wait(gate, 0, 0, 10_000);
      expect(Atomics.load(gate, 0)).toBe(1);
      const exec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          if (sql === "BEGIN IMMEDIATE;") {
            spy.mockRestore();
            Atomics.store(gate, 1, 1);
            Atomics.notify(gate, 1);
          }
          return exec.call(this, sql);
        });
      expect(store.rawEventsInRange(range).records).toMatchObject([{
        eventId: item.envelope.event.eventId, lastSeenAt: laterSeen,
      }]);
    } finally {
      store.close();
      await worker.terminate();
    }
  });
});
