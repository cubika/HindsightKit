import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, learningInferenceResponseSchema, learningWindowSchema,
  type CaptureEnvelope,
  type LearningWindow, type RuleProposal } from "@provenloop/contracts";
import { createLearningDistillation, hasAcceptedLearningDistillation, validateLearningResponse } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { CanonicalKnowledgeRetriever, ContextRetrievalService, KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend, knowledgeProjectionFromCandidate } from "@provenloop/retrieval";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const saved = JSON.parse(readFileSync(new URL("../fixtures/retained-retrieval-cases.json", import.meta.url), "utf8")) as
  { id: string; events: CaptureEnvelope[]; window: LearningWindow; output: unknown }[];

const fixture = async (id: string, scoped = false) => {
  const data = saved.find((entry) => entry.id === id); assert(data);
  const window = learningWindowSchema.parse(data.window);
  const output = learningInferenceResponseSchema.parse(data.output);
  expect(validateLearningResponse(window, output).proposals).toHaveLength(output.proposals.length);
  const now = new Date(Math.max(...data.events.map((entry) => Date.parse(entry.event.timestamp))) + 15000);
  if (scoped) for (const proposal of output.proposals) {
    proposal.retrievalScope = { excludedTasks: id === "repository-policy" ? ["integration tests"] : [] };
    const policy = id === "repository-policy";
    proposal.queryTerms = { include: policy ? ["包代码", "单元测试"] : ["文档"], exclude: policy ? ["集成测试"] : [] };
    const original = proposal.distillation; assert(original);
    proposal.distillation = createLearningDistillation(proposal, window.sources,
      { criteria: original.criteria, rationale: original.rationale }, original.reviewer, now.toISOString());
  }
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanups.push(async () => { await backend.closeAsync(); store.close(); });
  for (const envelope of data.events) store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1,
    queueItemId: "scope-" + envelope.event.eventId, state: "pending", attemptCount: 0, failureCount: 0,
    createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
  const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true,
    lease: { tryAcquire: async () => ({ release: async () => undefined }) },
    provider: { identity: { provider: "saved-output-replay", model: "none", version: "1" },
      infer: async (input) => { if (input.origin !== "agent") expect(input.windowId).toBe(window.windowId);
        return input.windowId === window.windowId ? output : { schemaVersion: 1, proposals: [] }; } } });
  const runs = [];
  for (let index = 0; index < 4; index++) runs.push(await coordinator.run());
  expect(store.knowledgeCandidates(), JSON.stringify(runs)).toHaveLength(output.proposals.length);
  expect(store.learningProposals().every((proposal) => hasAcceptedLearningDistillation(proposal, proposal.sourceDigests))).toBe(true);
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const service = new ContextRetrievalService({ store, backend, now: () => now, timeoutMs: 5000 });
  let sequence = 0;
  const query = (prompt: string) => service.context({ cwd: window.worktree, repoId: window.repoId, headSha: "a".repeat(40),
    sessionId: "later-scope-" + sequence++, prompt, tokenBudget: 1200 });
  return { store, backend, query, window, now };
};

describe("reviewed task exclusions", () => {
  it("replays actual old reviewed output without mistaking preservation constraints for excluded tasks", async () => {
    const f = await fixture("mixed-convention");
    for (const prompt of [
      "Write repository API documentation for a new endpoint.",
      "Translate repository documentation into English while preserving source quotations and executable identifiers.",
      "Translate repository documentation into English. Do not translate original source quotations.",
      "Translate repository documentation into English without translating original source quotations or executable identifiers.",
    ]) {
      const result = await f.query(prompt);
      const documentLesson = result.items.find((item) => item.guidance.includes("Write repository documentation in English"));
      expect(documentLesson, prompt).toBeDefined();
      expect(documentLesson?.applicabilitySummary).toContain("Limits: Do not translate original source quotations.");
      expect(documentLesson?.applicabilitySummary).not.toContain("Not when: Do not translate");
    }
  });

  it.each([false, true])("filters actual integration tasks in both languages with structured scope=%s", async (scoped) => {
    const f = await fixture("repository-policy", scoped);
    for (const prompt of ["Run integration tests to validate service connections.", "运行集成测试验证服务连接。",
      "Do not skip integration tests when validating this package.", "不要跳过集成测试，验证包代码。",
      "Validate package unit tests without integration tests, then run integration tests.",
      "Do not run package unit tests\nRun integration tests."]) {
      expect((await f.query(prompt)).items, prompt).toEqual([]);
    }
    for (const prompt of ["Validate a change in one package using its unit tests.", "验证刚修改的包代码。",
      "Run package unit tests, without running integration tests.", "验证刚修改的包代码，不涉及集成测试。",
      "Skip integration tests and validate package unit tests."]) {
      const result = await f.query(prompt);
      expect(result.items, prompt).toHaveLength(1);
      expect(result.items[0]?.guidance).toContain("corresponding package's unit tests");
      if (scoped) expect(result.items[0]?.applicabilitySummary).toContain("Excluded task: integration tests");
    }
  });

  it("uses an explicit reviewed empty task scope while preserving English limitations", async () => {
    const f = await fixture("mixed-convention", true);
    for (const prompt of ["补充仓库文档，保留原始引文和可执行标识符。",
      "Translate repository documentation. Do not translate original source quotations."]) {
      const result = await f.query(prompt);
      const lesson = result.items.find((item) => item.guidance.includes("Write repository documentation in English"));
      expect(lesson).toBeDefined();
      expect(lesson?.guidance).not.toMatch(/[\p{Script=Han}]/u);
      expect(lesson?.applicabilitySummary).toContain("Limits: Do not translate original source quotations.");
    }
  });

  it("rejects an edited scope even when the derived projection still exists", async () => {
    const f = await fixture("repository-policy", true);
    const proposal = f.store.learningProposals()[0]; const candidate = f.store.knowledgeCandidates()[0]; assert(proposal && candidate);
    const edited: RuleProposal = { ...proposal, retrievalScope: { excludedTasks: [] } };
    expect(hasAcceptedLearningDistillation(edited, edited.sourceDigests)).toBe(false);
    expect(knowledgeProjectionFromCandidate(candidate, [edited]).sourceDigest)
      .not.toBe(knowledgeProjectionFromCandidate(candidate, [proposal]).sourceDigest);
    const original = f.store.knowledgeAdmissionEvidence.bind(f.store);
    vi.spyOn(f.store, "knowledgeAdmissionEvidence").mockImplementation((candidates) => ({ ...original(candidates), learningProposals: [edited] }));
    const retriever = new CanonicalKnowledgeRetriever({ store: f.store, backend: f.backend });
    expect(await retriever.search({ text: "unit tests", limit: 3, repositoryScopeId: f.window.repoId,
      worktree: f.window.worktree, headSha: "a".repeat(40), now: f.now })).toEqual([]);
  });
});
