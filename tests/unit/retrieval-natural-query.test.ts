import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  ContextRetrievalService,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

const fixture = async () => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanups.push(async () => {
    await backend.closeAsync();
    store.close();
  });
  const add = async (
    id: string,
    content: string,
    scopeId = "repo-1",
    nonApplicability: readonly string[] = [],
  ) => {
    const candidate: KnowledgeCandidate = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliesWhen: ["Changing code."],
      conflictsWith: [],
      content,
      coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
      createdAt: "2026-09-01T00:00:00.000Z",
      evidenceMarks: ["user_confirmed"],
      evidenceTier: "user_confirmed",
      importance: 1,
      kind: "procedural",
      knowledgeId: id,
      nonApplicability: [...nonApplicability],
      scope: "repository",
      scopeId,
      sourceEpisodeIds: [],
      sourceEvidenceIds: [],
      state: "active",
      topicKey: id,
      utility: { applied: 0, harmful: 0, helpful: 0 },
    };
    store.upsertKnowledgeCandidates([candidate]);
    await new KnowledgeProjectionManager({ backend, store }).rebuild();
  };
  let sequence = 0;
  const service = new ContextRetrievalService({
    backend,
    store,
    timeoutMs: 5_000,
  });
  const query = (prompt: string, fileHints?: readonly string[]) =>
    service.context({
      cwd: "C:\\repo",
      prompt,
      repoId: "repo-1",
      sessionId: `natural-${sequence += 1}`,
      tokenBudget: 600,
      ...(fileHints === undefined ? {} : { fileHints }),
    });
  return { add, query };
};

describe("bounded natural-language retrieval", () => {
  it("does not let an unmatched long word hide relevant shorter terms", async () => {
    const { add, query } = await fixture();
    await add("tests", "Run npm test before merging code.");
    const result = await query("Run comprehensive npm test");
    expect(result.status).toBe("ok");
    expect(result.items.map((item) => item.id)).toEqual(["tests"]);
    expect(result.renderedTokens).toBeLessThanOrEqual(600);
  });

  it("retrieves Chinese fragments and polite paraphrases", async () => {
    const { add, query } = await fixture();
    await add("chinese-tests", "修改代码后运行单元测试");
    for (const prompt of ["修改代码后请运行单元测试", "单元测试"]) {
      expect((await query(prompt)).items.map((item) => item.id))
        .toEqual(["chinese-tests"]);
    }
  });

  it("keeps file hints even when the prompt has many unrelated words", async () => {
    const { add, query } = await fixture();
    await add("parser", "Use streaming for InvoiceParser processing.");
    await add("other-repo", "Use InvoiceParser elsewhere.", "repo-2");
    const result = await query(
      "Please investigate an unusually complicated issue involving several different components without introducing unnecessary structural modifications",
      ["src\\InvoiceParser.ts"],
    );
    expect(result.items.map((item) => item.id)).toEqual(["parser"]);
  });

  it("does not turn a short Chinese query into a more specific exclusion", async () => {
    const { add, query } = await fixture();
    await add("save-first", "测试前保存文件", "repo-1", ["集成测试"]);
    expect((await query("测试")).items.map((item) => item.id)).toEqual(["save-first"]);
    expect((await query("请运行集成测试")).items).toEqual([]);
  });

  it("requires coverage of the exclusion rather than just the query", async () => {
    const { add, query } = await fixture();
    await add("tests", "Run tests before merging code.", "repo-1", ["production database tests"]);
    expect((await query("tests")).items.map((item) => item.id)).toEqual(["tests"]);
    expect((await query("database tests against production")).items).toEqual([]);
  });

  it("does not filter a task that explicitly leaves an excluded area untouched", async () => {
    const { add, query } = await fixture();
    await add("documentation", "Write documentation in English. 文档使用英语", "repo-1", ["Historical archives", "历史存档"]);
    for (const prompt of ["补充文档，不涉及历史存档", "补充文档，历史存档保持原样",
      "Update documentation; do not touch historical archives.", "Update documentation without historical archives."]) {
      expect((await query(prompt)).items, prompt).toHaveLength(1);
    }
    for (const prompt of ["更新历史存档中的文档", "Update historical archives documentation.",
      "Update documentation, not only historical archives.", "不要跳过历史存档中的文档"]) {
      expect((await query(prompt)).items, prompt).toEqual([]);
    }
  });
});
