import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { KnowledgeControlService } from "@provenloop/host";
import {
  ContextRetrievalService,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

describe("context confirmation evidence", () => {
  it("requires explicit current counterevidence IDs and cannot replay an old resolution over a new correction", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    const backend = new SqliteFtsKnowledgeBackend(":memory:");
    let timestamp = Date.parse("2026-09-01T00:00:00.000Z");
    const now = () => new Date(timestamp);
    const projection = new KnowledgeProjectionManager({ backend, store });
    const control = new KnowledgeControlService({
      now,
      store,
      projection: {
        acquireLease: async () => ({ release: async () => undefined }),
        rebuild: () => projection.rebuild().then(() => undefined),
      },
    });
    const service = new ContextRetrievalService({ backend, store, now, timeoutMs: 5_000 });
    try {
      const remembered = await control.remember({
        content: "Run focused tests.",
        appliesWhen: ["Changing code."],
        scope: "personal",
      });
      assert(remembered.candidate !== undefined, "Remember must return a candidate.");
      const targetId = remembered.candidate.knowledgeId;
      const context = await service.context({
        cwd: "C:\\repo",
        prompt: "Run focused tests",
        sessionId: "session-one",
        tokenBudget: 600,
      });
      const request = {
        requestId: context.requestId,
        sessionId: "session-one",
        source: "user" as const,
        targetId,
      };
      timestamp += 1_000;
      const wrong = await service.feedback({
        ...request,
        action: "wrong",
        evidenceRef: "user-correction-one",
      });
      assert(wrong.feedbackId !== undefined, "Wrong feedback must return an ID.");
      const evidenceId = wrong.feedbackId;
      timestamp += 1_000;
      const ordinary = await service.feedback({
        ...request,
        action: "confirm",
        evidenceRef: "user-ordinary-confirm",
      });
      expect(ordinary.candidate?.state).toBe("disputed");
      expect(service.explain({
        explanationRef: `knowledge:${targetId}`,
        sessionId: "session-one",
      }).unresolvedEvidenceIds).toEqual([evidenceId]);

      timestamp += 1_000;
      await expect(service.feedback({
        ...request,
        action: "confirm",
        evidenceRef: "user-invalid-resolution",
        resolvesEvidenceIds: ["invented-evidence"],
      })).rejects.toThrow("current unresolved evidence");

      timestamp += 1_000;
      const resolution = {
        ...request,
        action: "confirm" as const,
        evidenceRef: "user-explicit-resolution",
        resolvesEvidenceIds: [evidenceId],
      };
      expect((await service.feedback(resolution)).candidate).toMatchObject({
        state: "active",
        evidenceTier: "user_confirmed",
      });
      timestamp += 1_000;
      const later = await service.feedback({
        ...request,
        action: "wrong",
        evidenceRef: "user-correction-two",
      });
      expect(later.status).toBe("recorded");
      expect((await service.feedback(resolution)).status).toBe("already_recorded");
      expect(store.knowledgeCandidates([targetId])[0]?.state).toBe("disputed");
      expect(service.explain({
        explanationRef: `knowledge:${targetId}`,
        sessionId: "session-one",
      }).unresolvedEvidenceIds).toContain(later.feedbackId);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });
});
