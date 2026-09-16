import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeCandidate } from "@provenloop/contracts";
import { CanonicalKnowledgeRetriever, ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend, knowledgeProjectionFromCandidate, type KnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const date = new Date("2026-09-11T00:00:00.000Z");
const lesson = (discovery?: KnowledgeCandidate["discovery"]): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "cache-rule", topicKey: "cache-rule", kind: "semantic", scope: "repository", scopeId: "repo",
  content: "Cache entries need revision keys.", appliesWhen: [], nonApplicability: [], conflictsWith: [],
  sourceEvidenceIds: [], sourceEpisodeIds: [], state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"],
  createdAt: date.toISOString(), importance: 1, utility: { applied: 0, helpful: 0, harmful: 0 },
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, ...(discovery ? { discovery } : {}),
});
const fixture = async (candidate = lesson()) => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanup.push(async () => { await backend.closeAsync(); store.close(); });
  store.upsertKnowledgeCandidates([candidate]);
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const service = new ContextRetrievalService({ store, backend, now: () => date, timeoutMs: 5000 });
  const request = { cwd: "C:/repo", repoId: "repo", sessionId: "review-session", prompt: "Cache revision keys", tokenBudget: 1200 };
  return { store, service, request };
};

describe("discovery integration review regressions", () => {
  it("uses explicit entity hints as an actual discovery route", async () => {
    const f = await fixture({ ...lesson(), content: "InvoiceParser streams data from the input buffer." });
    const result = await f.service.search({ ...f.request, prompt: "Investigate the implementation", entityHints: ["InvoiceParser"], protocolVersion: 1 });
    expect(result.items.map((item) => item.id)).toEqual(["cache-rule"]);
  });

  it("does not reuse an earlier page admission for a changed canonical revision", async () => {
    const original = lesson();
    const f = await fixture(original);
    const staleHit = { ...knowledgeProjectionFromCandidate(original), score: 1 };
    let searches = 0;
    const backend: KnowledgeBackend = {
      async get() { return staleHit; },
      async health() { return { fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }; },
      async index() { throw new Error("Read-only review backend."); }, async rebuild() { throw new Error("Read-only review backend."); }, async remove() { throw new Error("Read-only review backend."); },
      async search() {
        searches += 1;
        if (searches === 1) return Array.from({ length: 20 }, () => staleHit);
        f.store.upsertKnowledgeCandidates([{ ...original, content: "Cache rules changed after the first candidate admission." }]);
        return [staleHit];
      },
    };
    let assessments = 0;
    const retriever = new CanonicalKnowledgeRetriever({ store: f.store, backend });
    const found = await retriever.search({ text: "cache", limit: 1, repositoryScopeId: "repo" }, {
      accept: () => { assessments += 1; return assessments > 1; },
    });
    expect(searches).toBe(2);
    expect(found).toEqual([]);
  });

  it("does not reuse an earlier page admission after a revoke without changing candidate content", async () => {
    const original = lesson();
    const f = await fixture(original);
    const hit = { ...knowledgeProjectionFromCandidate(original), score: 1 };
    let searches = 0;
    const backend: KnowledgeBackend = {
      async get() { return hit; },
      async health() { return { fts5Available: true, quickCheck: "ok", recordCount: 1, status: "healthy" }; },
      async index() { throw new Error("Read-only review backend."); }, async rebuild() { throw new Error("Read-only review backend."); }, async remove() { throw new Error("Read-only review backend."); },
      async search() {
        searches += 1;
        if (searches === 1) return Array.from({ length: 20 }, () => hit);
        f.store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "between-pages", evidenceRef: "explicit-control", kind: "revoke",
          source: "user", targetType: "knowledge", targetId: original.knowledgeId, timestamp: date.toISOString() } });
        return [hit];
      },
    };
    let assessments = 0;
    const retriever = new CanonicalKnowledgeRetriever({ store: f.store, backend });
    const found = await retriever.search({ text: "cache", limit: 1, repositoryScopeId: "repo" }, { accept: () => ++assessments > 1 });
    expect(searches).toBe(2);
    expect(found).toEqual([]);
  });

  it("keeps useful summaries when optional locator metadata exceeds automatic delivery budget", async () => {
    const sourceReferences = Array.from({ length: 16 }, (_, index) => ({
      sourceRefId: "ref-" + index, kind: "url" as const,
      locator: "https://example.com/" + "reference-material/".repeat(65) + index,
      evidenceIds: [], availability: "pointer_only" as const, relationship: "background" as const,
    }));
    const f = await fixture(lesson({ producer: "user", sourceReferences }));
    const result = await f.service.context(f.request);
    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.id)).toEqual(["cache-rule"]);
    expect(result.renderedTokens).toBeLessThanOrEqual(f.request.tokenBudget);
  });

  it("rechecks current revoke controls before explaining a prior deliberate search result", async () => {
    const f = await fixture();
    const result = await f.service.search({ ...f.request, protocolVersion: 1 });
    expect(result.items).toHaveLength(1);
    f.store.recordKnowledgeFeedback({ event: {
      schemaVersion: 1, feedbackId: "revoke-after-search", evidenceRef: "review-control", kind: "revoke", source: "user",
      targetType: "knowledge", targetId: "cache-rule", timestamp: date.toISOString(),
    } });
    expect((await f.service.search({ ...f.request, protocolVersion: 1 })).items).toEqual([]);
    expect(f.service.explain({ sessionId: f.request.sessionId, explanationRef: "knowledge:cache-rule", cwd: f.request.cwd, repoId: f.request.repoId }).status).toBe("not_found");
  });
});
