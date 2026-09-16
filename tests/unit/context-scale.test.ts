import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeCandidate } from "@provenloop/contracts";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const candidate = (
  knowledgeId: string,
  content = "Run npm test before merging code.",
  overrides: Partial<KnowledgeCandidate> = {},
): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId, topicKey: knowledgeId, content,
  appliesWhen: ["Changing code."], nonApplicability: [], conflictsWith: [],
  scope: "repository", scopeId: "repo-1", kind: "procedural", state: "active",
  evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"],
  sourceEpisodeIds: [], sourceEvidenceIds: [], createdAt: "2026-09-01T00:00:00.000Z",
  importance: 1, utility: { applied: 0, harmful: 0, helpful: 0 },
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, ...overrides,
});

const fixture = async (records: readonly KnowledgeCandidate[]) => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanups.push(async () => { await backend.closeAsync(); store.close(); });
  store.upsertKnowledgeCandidates(records);
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const service = new ContextRetrievalService({ store, backend, timeoutMs: 5000 });
  let sequence = 0;
  const query = (prompt: string, sessionId = "query-" + sequence++) => service.context({
    cwd: "C:/repo", repoId: "repo-1", sessionId, prompt, tokenBudget: 1200,
    now: new Date("2026-09-11T00:00:00.000Z"),
  });
  return { store, query };
};

describe("context selection with accumulated knowledge", () => {
  it.each([20, 120])("refills past %s task-excluded hits", async (count) => {
    const f = await fixture([
      ...Array.from({ length: count }, (_, index) => candidate("excluded-" + index, "Run tests before release.", { nonApplicability: ["release"] })),
      candidate("valid", "Tests execute repository validation after all selected checks complete."),
    ]);
    const result = await f.query("Run tests before release");
    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.id)).toEqual(["valid"]);
  });

  it("reports candidate-budget exhaustion instead of an ordinary no-match", async () => {
    const f = await fixture(Array.from({ length: 501 }, (_, index) => candidate("excluded-" + index,
      "Run tests before release.", { nonApplicability: ["release"] })));
    const result = await f.query("Run tests before release");
    expect(result.status).toBe("degraded");
    expect(result.statusDetail).toContain("candidate budget exhausted");
    expect(result.items).toEqual([]);
  });

  it("keeps already validated guidance when duplicate growth exhausts the candidate budget", async () => {
    const f = await fixture(Array.from({ length: 501 }, (_, index) => candidate("duplicate-" + index)));
    const result = await f.query("npm test");
    expect(result.status).toBe("degraded");
    expect(result.statusDetail).toContain("validated partial results");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toBe("Run npm test before merging code.");
  });

  it("refills after the session has already received the first twenty hits", async () => {
    const records = Array.from({ length: 21 }, (_, index) => candidate("rule-" + String(index).padStart(2, "0"),
      "Run tests before release for component " + index + "."));
    const f = await fixture(records);
    f.store.appendContextUseRecord({ schemaVersion: 1, requestId: "earlier", sessionId: "continued",
      createdAt: "2026-09-10T00:00:00.000Z", appliedKnowledgeIds: [], candidateKnowledgeIds: [],
      returnedKnowledgeIds: records.slice(0, 20).map((item) => "knowledge:" + item.knowledgeId),
      latencyMs: 1, renderedTokens: 100, retrievalStatus: "provided",
    });
    expect((await f.query("Run tests before release", "continued")).items.map((item) => item.id)).toEqual(["rule-20"]);
  });

  it("selects distinct guidance without letting duplicate IDs hide another lesson", async () => {
    const f = await fixture([
      ...Array.from({ length: 21 }, (_, index) => candidate("duplicate-" + index)),
      candidate("different", "Inspect test failures before retrying."),
    ]);
    const result = await f.query("Run npm test before merging code.");
    expect(result.items).toHaveLength(2);
    expect(result.items.filter((item) => item.guidance === "Run npm test before merging code.")).toHaveLength(1);
    expect(result.items.some((item) => item.id === "different")).toBe(true);
    expect(f.store.knowledgeCandidates()).toHaveLength(22);
  });

  it("does not combine identical wording from different scopes", async () => {
    const { scopeId: unusedScope, ...personal } = candidate("personal", undefined, { scope: "personal" });
    void unusedScope;
    const f = await fixture([personal, candidate("repository"), candidate("other-repository", undefined, { scopeId: "repo-2" })]);
    expect((await f.query("npm test")).items.map((item) => item.id).sort()).toEqual(["personal", "repository"]);
  });

  it("keeps valid knowledge searchable when a legacy repository record has no scope identity", async () => {
    const { scopeId: ignored, ...legacy } = candidate("legacy-missing-scope");
    void ignored;
    const f = await fixture([legacy, candidate("valid-scope")]);
    expect((await f.query("npm test")).items.map((item) => item.id)).toEqual(["valid-scope"]);
    expect(f.store.knowledgeCandidates()).toHaveLength(2);
  });

  it("preserves case-sensitive command differences", async () => {
    const f = await fixture([candidate("uppercase", "Run tool -X for validation."), candidate("lowercase", "Run tool -x for validation.")]);
    expect((await f.query("tool validation")).items.map((item) => item.id).sort()).toEqual(["lowercase", "uppercase"]);
  });

  it("checks exclusions before duplicate suppression and preserves different conditions", async () => {
    const f = await fixture([
      candidate("excluded", undefined, { nonApplicability: ["release"] }),
      candidate("eligible"),
      candidate("different-conditions", undefined, { nonApplicability: ["integration tests"] }),
    ]);
    expect((await f.query("Run npm test before release")).items.map((item) => item.id).sort()).toEqual(["different-conditions", "eligible"]);
  });

  it.each([
    ["Run npm test before merging code.", "Run database migration in production."],
    ["运行单元测试", "运行数据库迁移"],
  ])("abstains when the only shared term is a generic action: %s", async (content, prompt) => {
    const f = await fixture([candidate("tests", content)]);
    expect((await f.query(prompt)).items).toEqual([]);
  });

  it.each([
    ["Run npm test before merging code.", "test"],
    ["修改代码后运行单元测试", "单元测试"],
    ["Use streaming for InvoiceParser processing.", "InvoiceParser"],
  ])("keeps sparse task or object queries: %s", async (content, prompt) => {
    const f = await fixture([candidate("relevant", content)]);
    expect((await f.query(prompt)).items.map((item) => item.id)).toEqual(["relevant"]);
  });
});
