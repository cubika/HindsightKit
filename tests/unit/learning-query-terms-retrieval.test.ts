import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type RuleProposal, type RuleProposalInput } from "@provenloop/contracts";
import { createCaptureEnvelope, createLearningDistillation, redactCaptureEnvelopeForPersistence, sha256 } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { CanonicalKnowledgeRetriever, ContextRetrievalService, KnowledgeProjectionManager, knowledgeProjectionFromCandidate,
  SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const now = new Date("2026-09-11T08:00:10.000Z");
const revision = "a".repeat(40);
const alias = "documentation language preserve executable identifiers";
const rule = "Write repository documentation in English while preserving executable syntax and identifiers.";
const message = "这个仓库的文档以后都用英语，历史存档除外；代码语法和标识符保持原样。另外检查付款记录。";
const review = { criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true },
  rationale: "The source states a lasting documentation convention and preserves its archive exception." };
const reviewer = { provider: "fixture", model: "fixture", version: "1" };

const fixture = async (reviewed = true, fileBacked = false, originalTerm = "文档") => {
  const directory = fileBacked ? await mkdtemp(join(tmpdir(), "provenloop-query-terms-")) : undefined;
  const path = directory ? join(directory, "knowledge.sqlite") : ":memory:";
  const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(path);
  cleanups.push(async () => { await backend.closeAsync(); store.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  for (const [index, item] of [
    { type: "prompt.submitted", trust: "user" as const, content: { message: message.replaceAll("文档", originalTerm) } },
    { type: "agent.turn_completed", trust: "model" as const, content: {} },
  ].entries()) {
    const timestamp = new Date(now.getTime() - 10_000 + index * 1_000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
      sourceEventId: "query-terms-event-" + index, sessionId: "source-session", repoId: "repo", worktree: "C:/repo",
      branch: "main", commitSha: revision, repositoryState: "known_repo", timestamp, eventType: item.type, trust: item.trust, content: item.content })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "query-terms-queue-" + index,
      state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const user = store.episodeSourceEnvelopes().find((event) => event.event.trust === "user"); assert(user);
  const input: RuleProposalInput = { rule, trigger: "Creating or editing repository documentation.",
    exclusions: ["Historical archives"], canonicalKey: alias,
    queryTerms: { include: [originalTerm], exclude: ["历史存档"] },
    userSource: { eventId: user.event.eventId, quote: message.replaceAll("文档", originalTerm) },
    supportingSources: [{ eventId: user.event.eventId, quote: message.replaceAll("文档", originalTerm) }],
    retention: { kind: "convention", lifetime: "durable", rationale: "Keep repository documentation consistent without altering archived material or code.",
      futureUse: "Apply when adding or revising repository documentation.", targetRepository: { status: "captured", repoId: "repo" } } };
  const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true,
    lease: { tryAcquire: async () => ({ release: async () => undefined }) },
    provider: { identity: reviewer, infer: async (window) => ({ schemaVersion: 1, proposals: [{ ...input,
      ...(reviewed ? { distillation: createLearningDistillation(input, window.sources, review, reviewer, now.toISOString()) } : {}),
    }] }) } });
  expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
  const candidate = store.knowledgeCandidates()[0]; const proposal = store.learningProposals()[0]; assert(candidate && proposal);
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const retriever = new CanonicalKnowledgeRetriever({ store, backend });
  const service = new ContextRetrievalService({ store, backend, now: () => now, timeoutMs: 5000 });
  const query = { text: "文档", limit: 3, now, repositoryScopeId: "repo", worktree: "C:/repo", headSha: revision };
  let sequence = 0;
  const context = (prompt: string) => service.context({ cwd: "C:/repo", repoId: "repo", headSha: revision,
    sessionId: "later-session-" + sequence++, prompt, tokenBudget: 600 });
  return { store, backend, candidate, proposal, retriever, query, context, path };
};

describe("reviewed original-language query terms", () => {
  it.each([
    ["文档", "请为这个仓库写一份简短的缓存设计文档，介绍按仓库路径缓存配置的方案。只返回正文，不读文件也不创建文件。"],
    ["说明", "请直接给我一份简短的缓存设计说明正文，介绍按仓库路径缓存配置的方案。只返回正文，不读文件也不创建文件。"],
  ])("preserves the reviewed %s alias in a bounded Chinese task query", async (term, prompt) => {
    const f = await fixture(true, false, term);
    const backendSearch = vi.spyOn(f.backend, "searchWithTimeout");
    const result = await f.context(prompt);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toContain(rule);
    const selected = backendSearch.mock.calls[0]?.[0].text.split(" ") ?? [];
    expect(selected).toContain(term);
    expect(selected).toContain("缓存");
    expect(selected.length).toBeLessThanOrEqual(24);
  });

  it("retrieves an English lesson for a Chinese task while retaining English guidance and scope", async () => {
    const f = await fixture();
    expect(await f.backend.get(f.candidate.knowledgeId)).toMatchObject({
      content: rule, searchAliases: [alias, "文档"], searchExclusions: ["历史存档"],
    });
    const result = await f.context("请帮我补充文档");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toContain(rule);
    expect(result.items[0]?.guidance).not.toMatch(/[\p{Script=Han}]/u);
    expect(result.items[0]?.applicabilitySummary).toContain("Historical archives");
    expect(f.store.knowledgeCandidates()[0]).toEqual(f.candidate);
    expect(await f.retriever.search({ ...f.query, repositoryScopeId: "other" })).toEqual([]);
    expect(await f.retriever.search({ ...f.query, worktree: "C:/other" })).toEqual([]);
  });

  it("preserves Chinese exclusions without treating them or unrelated source text as positive terms", async () => {
    const f = await fixture();
    expect((await f.context("更新历史存档中的文档")).items).toEqual([]);
    expect((await f.context("Update documentation in historical archives")).items).toEqual([]);
    expect((await f.context("更新历史分析文档")).items).toHaveLength(1);
    expect(await f.backend.search({ text: "历史存档", limit: 5 })).toEqual([]);
    expect((await f.context("检查付款记录")).items).toEqual([]);
    expect(await f.retriever.search({ ...f.query, text: "文档 付款", match: "all" })).toEqual([]);
    const unrelated = Array.from({ length: 40 }, (_, index) => "context" + index).join(" ");
    expect((await f.context("文档 " + unrelated + " 历史存档 " + unrelated)).items).toEqual([]);
  });

  it("does not use unreviewed original-language terms", async () => {
    const f = await fixture(false);
    const projection = await f.backend.get(f.candidate.knowledgeId);
    expect(projection?.searchAliases).toBeUndefined();
    expect(projection?.searchExclusions).toBeUndefined();
    expect(await f.retriever.search(f.query)).toEqual([]);
    expect((await f.context("请帮我补充文档")).items).toEqual([]);
  });

  it.each(["include", "exclude"] as const)("invalidates an edited %s list and removes stale hints on rebuild", async (field) => {
    const f = await fixture();
    const edited: RuleProposal = { ...f.proposal, queryTerms: { include: ["文档"], exclude: ["历史存档"], [field]: ["付款记录"] } };
    const projection = knowledgeProjectionFromCandidate(f.candidate, [edited]);
    expect(projection.searchAliases).toBeUndefined();
    expect(projection.searchExclusions).toBeUndefined();
    const originalEvidence = f.store.knowledgeAdmissionEvidence.bind(f.store);
    vi.spyOn(f.store, "knowledgeAdmissionEvidence").mockImplementation((candidates) => ({ ...originalEvidence(candidates), learningProposals: [edited] }));
    expect(await f.retriever.search(f.query)).toEqual([]);
    vi.spyOn(f.store, "learningProposals").mockReturnValue([edited]);
    await new KnowledgeProjectionManager({ store: f.store, backend: f.backend }).rebuild();
    expect(await f.backend.search({ text: "文档", limit: 5 })).toEqual([]);
  });

  it("rejects forged index hints and removed exclusions even when their digest is recomputed", async () => {
    const f = await fixture();
    const projection = knowledgeProjectionFromCandidate(f.candidate, [f.proposal]);
    const searchAliases = [...projection.searchAliases ?? [], "付款记录"];
    await f.backend.index([{ ...projection, searchAliases, sourceDigest: sha256({ candidate: f.candidate, searchAliases,
      searchExclusions: projection.searchExclusions }) }]);
    expect(await f.backend.search({ text: "付款记录", limit: 5 })).toHaveLength(1);
    expect(await f.retriever.search({ ...f.query, text: "付款记录" })).toEqual([]);
    await f.backend.index([{ ...projection, searchExclusions: [],
      sourceDigest: sha256({ candidate: f.candidate, searchAliases: projection.searchAliases }) }]);
    expect(await f.retriever.search(f.query)).toEqual([]);
  });

  it("does not project query terms absent from reviewed source quotations", async () => {
    const f = await fixture();
    const edited: RuleProposal = { ...f.proposal, queryTerms: { include: ["虚构关键词"], exclude: ["历史存档"] } };
    edited.distillation = createLearningDistillation(edited, edited.sourceDigests, review, reviewer, now.toISOString());
    const projection = knowledgeProjectionFromCandidate(f.candidate, [edited]);
    expect(projection.searchAliases).toEqual([alias]);
    expect(projection.searchExclusions).toBeUndefined();
  });

  it("retains query hints across file-backed reopen and worker search", async () => {
    const f = await fixture(true, true);
    expect((await f.context("请补充文档")).items).toHaveLength(1);
    await f.backend.closeAsync();
    const reopened = new SqliteFtsKnowledgeBackend(f.path);
    cleanups.push(async () => reopened.closeAsync());
    expect(await reopened.searchWithTimeout({ text: "文档", limit: 3 }, 5000)).toEqual([expect.objectContaining({
      content: rule, searchAliases: [alias, "文档"], searchExclusions: ["历史存档"],
    })]);
    const service = new ContextRetrievalService({ store: f.store, backend: reopened, now: () => now, timeoutMs: 5000 });
    const result = await service.context({ cwd: "C:/repo", repoId: "repo", headSha: revision, sessionId: "reopened-query",
      prompt: "更新历史存档中的文档", tokenBudget: 600 });
    expect(result.items).toEqual([]);
  });
});
