import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeCandidate } from "@provenloop/contracts";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const now = new Date("2026-09-11T00:00:00Z");
const lesson = (id: string, content: string, overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: id, topicKey: id, kind: "semantic", scope: "repository", scopeId: "repo",
  content, appliesWhen: [], nonApplicability: [], conflictsWith: [], sourceEvidenceIds: [], sourceEpisodeIds: [],
  state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"], createdAt: now.toISOString(),
  importance: 0, utility: { applied: 0, helpful: 0, harmful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, ...overrides,
});
const fixture = async (items: KnowledgeCandidate[]) => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanup.push(async () => { await backend.closeAsync(); store.close(); });
  store.upsertKnowledgeCandidates(items);
  const projection = new KnowledgeProjectionManager({ store, backend });
  await projection.rebuild();
  let sequence = 0;
  const service = new ContextRetrievalService({ store, backend, now: () => now, timeoutMs: 5000 });
  const request = (prompt: string, sessionId = "s-" + sequence++) => ({
    prompt, sessionId, cwd: "C:/repo", repoId: "repo", now, tokenBudget: 1200,
  });
  return { store, backend, projection, service, request };
};

describe("general experience discovery", () => {
  it("uses alternate queries for discovery without assuming their conditions are true", async () => {
    const f = await fixture([lesson("external", "Use an idempotency key for external writes.", {
      appliesWhen: ["Retrying external writes."],
    })]);
    const result = await f.service.search({ ...f.request("Investigate this behavior"), protocolVersion: 1,
      alternateQueries: ["idempotency for retrying external writes"] });
    expect(result.items.map((item) => item.id)).toEqual(["external"]);
    expect(result.items[0]?.relevance?.band).toBe("conditional");
    const denied = await f.service.search({ ...f.request("Read-only health probes without external writes"), protocolVersion: 1,
      alternateQueries: ["idempotency for retrying external writes"] });
    expect(denied.items).toEqual([]);
  });

  it("retrieves a bilingual paraphrase without requiring a shared original word", async () => {
    const f = await fixture([lesson("idempotency", "Use idempotency keys to prevent duplicate writes.")]);
    const result = await f.service.context(f.request("如何避免重复执行产生多次写入？"));
    expect(result.items.map((item) => item.id)).toContain("idempotency");
    expect(result.items[0]?.classification?.topics).toContain("idempotency");
  });

  it("keeps an unresolved external-effect prerequisite conditional", async () => {
    const f = await fixture([lesson("retry-lesson", "Use idempotency keys for retries.", {
      appliesWhen: ["When retrying operations with external side effects."],
      nonApplicability: ["read-only health probes"],
    })]);
    const result = await f.service.context(f.request("Design retries for a queue worker"));
    expect(result.items[0]?.relevance?.band).toBe("conditional");
    expect(result.items[0]?.relevance?.unresolvedConditions.length).toBeGreaterThan(0);
    const excluded = await f.service.context(f.request("Retry read-only health probes"));
    expect(excluded.items).toEqual([]);
  });

  it("supports deliberate rediscovery, browse filters and source navigation without fetching", async () => {
    const f = await fixture([lesson("retry", "Use retry backoff for temporary failures.", { discovery: { producer: "user",
      topics: [{ value: "retries", basisIds: ["content:0"], polarity: "positive" }],
      sourceReferences: [{ sourceRefId: "notes", kind: "url", locator: "https://example.org/retry-notes",
        evidenceIds: [], availability: "pointer_only", relationship: "background" }],
    } })]);
    const request = f.request("retry failures", "same");
    expect((await f.service.context(request)).items).toHaveLength(1);
    expect((await f.service.context(request)).items).toHaveLength(0);
    const result = await f.service.search({ ...request, protocolVersion: 1, tokenBudget: 3000, topics: ["retries"] });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.sourceReferences?.[0]?.locator).toBe("https://example.org/retry-notes");
    expect(f.store.contextUseRecord(result.requestId)?.retrievalMode).toBe("search");
    expect(f.service.explain({ sessionId: "same", explanationRef: "knowledge:retry" }).status).toBe("available");
    expect((await f.service.search({ ...request, protocolVersion: 1, topics: ["caching"] })).items).toEqual([]);
  });

  it("does not let concept matches cross repositories or revive deleted knowledge", async () => {
    const f = await fixture([lesson("own", "Use idempotency keys."), lesson("other", "Use idempotency keys.", { scopeId: "other" })]);
    const req = f.request("幂等");
    expect((await f.service.search({ ...req, protocolVersion: 1 })).items.map((item) => item.id)).toEqual(["own"]);
    f.store.upsertKnowledgeCandidates([lesson("own", "Use idempotency keys.", { state: "archived" })]);
    expect((await f.service.search({ ...req, protocolVersion: 1 })).items).toEqual([]);
  });

  it("uses irrelevant feedback only for the matching query context and lesson revision", async () => {
    const item = lesson("retry", "Use retries with exponential backoff.");
    const f = await fixture([item]);
    const first = await f.service.context(f.request("retry backoff", "first"));
    expect(first.items).toHaveLength(1);
    await f.service.feedback({ requestId: first.requestId, sessionId: "first", targetId: item.knowledgeId, action: "irrelevant", source: "user" });
    const later = await f.service.context(f.request("retry backoff"));
    expect(later.items[0]?.rank).toBeLessThan(first.items[0]?.rank ?? 0);
    expect(f.store.knowledgeCandidates([item.knowledgeId])[0]?.state).toBe("active");
    f.store.upsertKnowledgeCandidates([{ ...item, content: "Use retries with jitter and exponential backoff." }]);
    await f.projection.synchronize();
    const changed = await f.service.context(f.request("retry backoff"));
    expect(changed.items[0]?.rank).toBeGreaterThan(later.items[0]?.rank ?? 0);
  });

  it("shares one backend candidate budget across alternate queries", async () => {
    const f = await fixture([lesson("retry", "Use retries with exponential backoff.")]);
    const request = { ...f.request("retry backoff"), protocolVersion: 1 as const };
    const one = await f.service.search(request);
    const many = await f.service.search({ ...request, alternateQueries: ["retry backoff", "retry backoff", "retry backoff"] });
    expect(many.items.map((item) => item.id)).toEqual(one.items.map((item) => item.id));
    expect(many.items[0]?.rank).toBe(one.items[0]?.rank);
  });
});
