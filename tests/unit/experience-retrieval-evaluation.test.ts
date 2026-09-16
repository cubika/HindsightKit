import { describe, expect, it } from "vitest";
import { createSyntheticExperienceRetrievalCorpus, evaluateExperienceRetrieval, experienceRetrievalCorpusSchema,
  runLocalExperienceRetrievalEvaluation, type ExperienceRetrievalCorpus, type ExperienceRetrievalObservation } from "@provenloop/evaluation";

const smallCorpus = (): ExperienceRetrievalCorpus => {
  const original = createSyntheticExperienceRetrievalCorpus();
  return { ...original, knowledge: original.knowledge.slice(0, 3), queries: [
    { id: "two-relevant", text: "external retries and stale cache", repoId: "repo", cwd: "C:/repo",
      relevantKnowledgeIds: ["duplicate-write", "cache-revision"], strata: ["literal"] },
    { id: "negative", text: "homepage font", repoId: "repo", cwd: "C:/repo", relevantKnowledgeIds: [], strata: ["negative"] },
  ] };
};
const observe = (candidateIds: string[], returnedIds: string[], latencyMs = 4): ExperienceRetrievalObservation => ({ candidateIds, returnedIds, latencyMs, degraded: false });

describe("experience retrieval local evaluation", () => {
  it("separates candidate recall, returned precision, P@3, coverage, and negative injection", async () => {
    const corpus = smallCorpus();
    const report = await evaluateExperienceRetrieval(corpus, {
      current: async (query) => query.id === "two-relevant" ? observe(["duplicate-write", "cache-revision", "migration"], ["duplicate-write", "migration"]) : observe([], []),
      lexicalBaseline: async (query) => query.id === "two-relevant" ? observe(["duplicate-write"], ["duplicate-write"]) : observe(["migration"], ["migration"]),
    });
    expect(report.current.metrics).toMatchObject({ candidateRecall: 1, returnedItemPrecision: 0.5, precisionAt3: 1 / 3,
      hitCoverage: 1, irrelevantInjectionRate: 0.5, negativeQueryInjectionRate: 0, returnedItems: 2, relevantReturnedItems: 1, meanLatencyMs: 4 });
    expect(report.lexicalBaseline.metrics).toMatchObject({ candidateRecall: 0.5, returnedItemPrecision: 0.5,
      negativeQueryInjectionRate: 1, degradedQueries: 0 });
    expect(report.strata.negative?.current).toMatchObject({ queries: 1, candidateRecall: null, precisionAt3: null, negativeQueryInjectionRate: 0 });
    expect(report.sourceKind).toBe("synthetic");
    expect(report.limitations.join(" ")).toContain("not a real incident corpus");
  });

  it("counts each candidate and returned ID once and uses null for empty precision denominators", async () => {
    const report = await evaluateExperienceRetrieval(smallCorpus(), {
      current: async (query) => query.id === "two-relevant" ? observe(["duplicate-write", "duplicate-write"], ["duplicate-write", "duplicate-write"]) : observe([], []),
      lexicalBaseline: async () => observe([], []),
    });
    expect(report.current.metrics).toMatchObject({ candidateRecall: 0.5, returnedItems: 1, returnedItemPrecision: 1, precisionAt3: 1 / 3 });
    expect(report.lexicalBaseline.metrics).toMatchObject({ candidateRecall: 0, returnedItemPrecision: null, precisionAt3: 0, hitCoverage: 0 });
  });

  it("records provider failures and invalid IDs as degraded without returning source text", async () => {
    const report = await evaluateExperienceRetrieval(smallCorpus(), {
      current: async () => { throw new Error("private captured source content"); },
      lexicalBaseline: async () => observe(["invented"], ["invented"]),
    });
    expect(report.current.metrics).toMatchObject({ failedQueries: 2, degradedQueries: 2, candidateRecall: 0 });
    expect(report.lexicalBaseline.cases[0]?.error).toBe("invalid_observation");
    expect(JSON.stringify(report)).not.toContain("private captured source content");
  });

  it("keeps frozen query labels isolated from an injected runner", async () => {
    const corpus = smallCorpus();
    const report = await evaluateExperienceRetrieval(corpus, { current: async (query) => {
      query.relevantKnowledgeIds.length = 0; return observe(["duplicate-write"], ["duplicate-write"]);
    }, lexicalBaseline: async () => observe([], []) });
    expect(report.current.cases[0]?.relevantIds).toEqual(["duplicate-write", "cache-revision"]);
    expect(corpus.queries[0]?.relevantKnowledgeIds).toHaveLength(2);
  });

  it("requires explicit bounded labels and unique corpus identities", () => {
    const corpus = smallCorpus();
    expect(experienceRetrievalCorpusSchema.safeParse(corpus).success).toBe(true);
    expect(experienceRetrievalCorpusSchema.safeParse({ ...corpus, queries: [...corpus.queries, corpus.queries[0]] }).success).toBe(false);
    const query = corpus.queries[0];
    expect(experienceRetrievalCorpusSchema.safeParse({ ...corpus, queries: [{ ...query, relevantKnowledgeIds: ["missing"] }] }).success).toBe(false);
    expect(experienceRetrievalCorpusSchema.safeParse({ ...corpus, sourceKind: "field_verified" }).success).toBe(false);
  });

  it("runs the actual local context service and lexical ablation over the synthetic bilingual corpus", async () => {
    const corpus = createSyntheticExperienceRetrievalCorpus();
    expect(corpus.queries.length).toBeGreaterThanOrEqual(20);
    const strata = new Set(corpus.queries.flatMap((query) => query.strata));
    expect([...strata]).toEqual(expect.arrayContaining(["paraphrase", "bilingual", "negative", "exact_entity", "scope", "lifecycle"]));
    const report = await runLocalExperienceRetrievalEvaluation(corpus);
    expect(report.current.cases).toHaveLength(corpus.queries.length);
    expect(report.lexicalBaseline.cases).toHaveLength(corpus.queries.length);
    expect(report.current.metrics.failedQueries).toBe(0);
    expect(report.lexicalBaseline.metrics.failedQueries).toBe(0);
    for (const strategy of [report.current, report.lexicalBaseline]) {
      expect(strategy.metrics.returnedItems).toBeGreaterThan(0);
      for (const queryId of ["empty-scope", "archived", "expired"]) {
        expect(strategy.cases.find((entry) => entry.queryId === queryId)?.returnedIds).toEqual([]);
      }
    }
    expect(report.current.cases.find((entry) => entry.queryId === "literal-retry")?.returnedIds).toContain("duplicate-write");
  }, 30_000);
});
