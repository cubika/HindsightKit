import { describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type KnowledgeCandidate } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import { applyCaptureRetention, DeletionService, planCaptureRetention, type CaptureRetentionStore } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const now = new Date("2026-09-10T00:00:00Z");
const cutoff = new Date("2026-06-01T00:00:00Z");
const old = new Date("2026-05-01T00:00:00Z");
const ingest = (store: CanonicalSqliteStore, sessionId: string, closed = true, timestamp = old.toISOString()) => {
  for (const [index, type] of (closed ? ["prompt.submitted", "session.ended"] : ["prompt.submitted"]).entries()) {
    const envelope = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `${sessionId}-${index}`,
      sessionId, repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", eventType: type, timestamp,
      trust: type === "prompt.submitted" ? "user" : "system", ...(index === 0 ? { content: { message: "PRIVATE_SOURCE_CONTENT" } } : {}) });
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `${sessionId}-${index}`, state: "pending",
      attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
};
const knowledge = (eventId: string): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "knowledge", content: "A retained reference", kind: "semantic", scope: "repository", scopeId: "repo",
  createdAt: old.toISOString(), topicKey: "topic", state: "candidate", evidenceTier: "inferred", evidenceMarks: [],
  sourceEpisodeIds: [], sourceEvidenceIds: [eventId], appliesWhen: ["Editing"], nonApplicability: [], conflictsWith: [],
  importance: 0, utility: { applied: 0, helpful: 0, harmful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
});
const queue = () => ({
  activeDeletionBarrier: async () => undefined, beginDeletionBarrier: async () => undefined, endDeletionBarrier: async () => undefined,
  blockIdentities: async () => undefined, deleteByIdentifiers: async () => ({ identities: [], queueItemIds: [] }),
  remainingIdentifiers: async () => [], remainingIdentities: async () => [],
});

describe("reviewed capture retention", () => {
  it("suggests 90 days without deleting and protects recent, open and referenced sessions", () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => old });
    try {
      ingest(store, "eligible"); ingest(store, "open", false); ingest(store, "recent", true, now.toISOString()); ingest(store, "referenced");
      const source = store.rawEvents().find((event) => event.sessionId === "referenced");
      if (!source) throw new Error("Missing reference fixture.");
      store.upsertKnowledgeCandidates([knowledge(source.eventId)]);
      const before = store.rawEvents().length;
      const plan = planCaptureRetention(store, { now });
      expect(plan.olderThan).toBe("2026-06-12T00:00:00.000Z");
      expect(plan.candidates.map((session) => session.sessionId)).toEqual(["eligible"]);
      expect(plan.candidateEventCount).toBe(2); expect(plan.estimatedCandidateBytes).toBeGreaterThan(0);
      expect(plan.protected.find((session) => session.sessionId === "open")?.reasons).toContain("session_not_closed");
      expect(plan.protected.find((session) => session.sessionId === "recent")?.reasons).toContain("recent_activity");
      expect(plan.protected.find((session) => session.sessionId === "referenced")?.reasons).toContain("knowledge_reference");
      expect(JSON.stringify(plan)).not.toContain("PRIVATE_SOURCE_CONTENT");
      expect(store.rawEvents()).toHaveLength(before);
    } finally { store.close(); }
  });

  it("requires a current plan and explicit selected-session confirmation", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => old });
    try {
      ingest(store, "eligible");
      const plan = planCaptureRetention(store, { olderThan: cutoff, now });
      const remove = vi.fn(async () => undefined);
      const request = { olderThan: cutoff, now, expectedDigest: plan.expectedDigest, sessionIds: ["eligible"], userConfirmed: false };
      await expect(applyCaptureRetention(store, request, remove)).rejects.toThrow("explicit user confirmation");
      await expect(applyCaptureRetention(store, { ...request, userConfirmed: true, sessionIds: ["missing"] }, remove)).rejects.toThrow("eligible sessions");
      ingest(store, "new-session");
      await expect(applyCaptureRetention(store, { ...request, userConfirmed: true }, remove)).rejects.toThrow("changed after review");
      expect(remove).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it("protects branch references, pending inference and recently observed old events", () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => old });
    try {
      ingest(store, "branch"); ingest(store, "learning"); ingest(store, "late-import");
      const records = store.rawEvents();
      const branchEvent = records.find((event) => event.sessionId === "branch");
      const learningEvent = records.find((event) => event.sessionId === "learning");
      if (!branchEvent || !learningEvent) throw new Error("Missing protected fixture.");
      const read: CaptureRetentionStore = {
        rawEvents: () => records.map((record) => record.sessionId === "late-import" ? { ...record, lastSeenAt: now.toISOString() } : record),
        workEpisodes: () => [], knowledgeCandidates: () => [], hasActiveDeletion: () => false,
        branchContexts: () => [{ schemaVersion: 1, branchContextId: "branch-context", branch: "main", headSha: "head", repoId: "repo",
          updatedAt: old.toISOString(), acceptedDecisions: [], explicitConstraints: [], implementationState: [], unfinishedItems: [],
          recentVerificationEvidenceIds: [], sourceEventIds: [branchEvent.eventId], sourceEpisodeIds: [] }],
        learningJobs: () => [{ schemaVersion: 1, jobId: "job", windowId: "window", revision: "a".repeat(64), state: "pending",
          attempts: 0, createdAt: old.toISOString(), updatedAt: old.toISOString(), expiresAt: now.toISOString(), extractorVersion: "fixture" }],
        learningWindow: () => ({ schemaVersion: 1, windowId: "window", revision: "a".repeat(64), sessionId: "learning", repoId: "repo", worktree: "C:/repo",
          createdAt: old.toISOString(), events: [learningEvent.envelope], sources: [{ eventId: learningEvent.eventId, digest: "a".repeat(64) }] }),
      };
      const plan = planCaptureRetention(read, { olderThan: cutoff, now });
      expect(plan.candidates).toEqual([]);
      expect(plan.protected.find((session) => session.sessionId === "branch")?.reasons).toContain("branch_context_reference");
      expect(plan.protected.find((session) => session.sessionId === "learning")?.reasons).toContain("learning_in_progress");
      expect(plan.protected.find((session) => session.sessionId === "late-import")?.reasons).toContain("recent_activity");
    } finally { store.close(); }
  });

  it("executes selected cleanup through the existing deletion service and validates removal", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => old });
    try {
      ingest(store, "eligible"); ingest(store, "keep-open", false);
      const plan = planCaptureRetention(store, { olderThan: cutoff, now });
      const service = new DeletionService({ store, queue: queue(), recordEvidence: async () => undefined });
      const result = await applyCaptureRetention(store, { olderThan: cutoff, now, expectedDigest: plan.expectedDigest, sessionIds: ["eligible"], userConfirmed: true },
        async (sessionId) => service.delete({ targetType: "session", targetId: sessionId }));
      expect(result.deletedSessionIds).toEqual(["eligible"]);
      expect(store.rawEvents().map((event) => event.sessionId)).toEqual(["keep-open"]);
    } finally { store.close(); }
  });
});
