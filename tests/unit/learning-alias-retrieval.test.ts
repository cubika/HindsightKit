import assert from "node:assert/strict";
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
const rule = "仓库文档使用英语撰写，保留可执行语法和标识符。";
const fixture = async (reviewed = true, retention: { rationale?: string; futureUse?: string } = {}) => {
  const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(":memory:");
  cleanups.push(async () => { await backend.closeAsync(); store.close(); });
  const message = "这个仓库的文档以后都用英语，代码语法和标识符保持原样。";
  for (const [index, item] of [
    { type: "prompt.submitted", trust: "user" as const, content: { message } },
    { type: "agent.turn_completed", trust: "model" as const, content: {} },
  ].entries()) {
    const timestamp = new Date(now.getTime() - 10_000 + index * 1_000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
      sourceEventId: "alias-event-" + index, sessionId: "source-session", repoId: "repo", worktree: "C:/repo",
      branch: "main", commitSha: revision, repositoryState: "known_repo", timestamp, eventType: item.type, trust: item.trust, content: item.content })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "alias-queue-" + index,
      state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const events = store.episodeSourceEnvelopes(); const user = events.find((event) => event.event.trust === "user"); assert(user);
  const input: RuleProposalInput = { rule, trigger: "新增或修改仓库文档时", exclusions: ["不适用于其他仓库，也不翻译代码标识符。"],
    canonicalKey: alias, userSource: { eventId: user.event.eventId, quote: message },
    supportingSources: [{ eventId: user.event.eventId, quote: message }],
    retention: { kind: "convention", lifetime: "durable", rationale: retention.rationale ?? "后续文档需要统一语言并保留可执行代码的含义。",
      futureUse: retention.futureUse ?? "后续为这个仓库新增或修改功能文档时使用这一约定。", targetRepository: { status: "captured", repoId: "repo" } } };
  const coordinator = new LearningCoordinator({ store, now: () => now, enabled: async () => true,
    lease: { tryAcquire: async () => ({ release: async () => undefined }) },
    provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async (window) => {
      const proposal = { ...input, ...(reviewed ? { distillation: createLearningDistillation(input, window.sources,
        { criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true },
          rationale: "The source gives a recurring documentation constraint with explicit limits." },
        { provider: "fixture", model: "fixture", version: "1" }, now.toISOString()) } : {}) };
      return { schemaVersion: 1, proposals: [proposal] };
    } } });
  expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
  const candidate = store.knowledgeCandidates()[0]; const proposal = store.learningProposals()[0]; assert(candidate && proposal);
  await new KnowledgeProjectionManager({ store, backend }).rebuild();
  const retriever = new CanonicalKnowledgeRetriever({ store, backend });
  const query = { text: "documentation", limit: 3, now, repositoryScopeId: "repo", worktree: "C:/repo", headSha: revision };
  return { store, backend, candidate, proposal, input, events, retriever, query };
};

describe("reviewed cross-language search aliases", () => {
  it("retains and retrieves a reviewed lesson with concise Chinese retention reasons", async () => {
    const f = await fixture(true, { rationale: "保持文档语言一致", futureUse: "新增文档时" });
    expect(f.proposal.retention).toMatchObject({ rationale: "保持文档语言一致", futureUse: "新增文档时" });
    expect(f.store.knowledgeCandidates()).toHaveLength(1);
    const service = new ContextRetrievalService({ store: f.store, backend: f.backend, now: () => now, timeoutMs: 5000 });
    const result = await service.context({ cwd: "C:/repo", repoId: "repo", headSha: revision, sessionId: "concise-retention-session",
      prompt: "Write repository documentation", tokenBudget: 600 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toContain(rule);
    expect(result.items[0]?.applicabilitySummary).toContain(f.input.exclusions[0]);
  });

  it("retrieves a Chinese lesson for an English task without changing guidance or scope", async () => {
    const f = await fixture();
    const indexed = await f.backend.search({ text: "documentation", limit: 5 });
    expect(indexed).toHaveLength(1); expect(indexed[0]?.searchAliases).toEqual([alias]);
    expect(indexed[0]?.content).toBe(rule);
    const retrieved = await f.retriever.search(f.query);
    expect(retrieved).toHaveLength(1); expect(retrieved[0]?.searchAliases).toEqual([alias]);
    const service = new ContextRetrievalService({ store: f.store, backend: f.backend, now: () => now, timeoutMs: 5000 });
    const result = await service.context({ cwd: "C:/repo", repoId: "repo", headSha: revision, sessionId: "later-session",
      prompt: "Write repository documentation", tokenBudget: 600 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toContain(rule);
    expect(result.items[0]?.guidance).not.toContain(alias);
    expect(result.items[0]?.applicabilitySummary).toContain(f.input.trigger);
    expect(result.items[0]?.applicabilitySummary).toContain(f.input.exclusions[0]);
    expect(f.store.knowledgeCandidates()[0]).toEqual(f.candidate);
    expect(await f.retriever.search({ ...f.query, repositoryScopeId: "other" })).toEqual([]);
    expect(await f.retriever.search({ ...f.query, worktree: "C:/other" })).toEqual([]);
  });

  it("does not index an unreviewed canonical key", async () => {
    const f = await fixture(false);
    expect((await f.backend.get(f.candidate.knowledgeId))?.searchAliases).toBeUndefined();
    expect(await f.backend.search({ text: "documentation", limit: 5 })).toEqual([]);
    expect(await f.retriever.search(f.query)).toEqual([]);
  });

  it("rejects a stale or edited alias review and preserves the canonical candidate digest check", async () => {
    const f = await fixture();
    const edited = { ...f.proposal, canonicalKey: "deployment secrets" };
    expect(knowledgeProjectionFromCandidate(f.candidate, [edited]).searchAliases).toBeUndefined();
    expect(knowledgeProjectionFromCandidate({ ...f.candidate, content: "改写了没有评审的内容。" }, [f.proposal]).searchAliases).toBeUndefined();
    const originalEvidence = f.store.knowledgeAdmissionEvidence.bind(f.store);
    vi.spyOn(f.store, "knowledgeAdmissionEvidence").mockImplementation((candidates) => ({ ...originalEvidence(candidates), learningProposals: [edited] }));
    expect(await f.retriever.search(f.query)).toEqual([]);
  });

  it("rejects an alias injected into derived storage even when its digest is forged", async () => {
    const f = await fixture();
    const projection = knowledgeProjectionFromCandidate(f.candidate, [f.proposal]);
    const searchAliases = ["deployment"];
    await f.backend.index([{ ...projection, searchAliases, sourceDigest: sha256({ candidate: f.candidate, searchAliases }) }]);
    expect(await f.backend.search({ text: "deployment", limit: 5 })).toHaveLength(1);
    expect(await f.retriever.search({ ...f.query, text: "deployment" })).toEqual([]);
  });

  it("rebuilds without aliases after a review no longer binds to the canonical proposal", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "learningProposals").mockReturnValue([{ ...f.proposal, canonicalKey: "changed without review" } as RuleProposal]);
    await new KnowledgeProjectionManager({ store: f.store, backend: f.backend }).rebuild();
    expect((await f.backend.get(f.candidate.knowledgeId))?.searchAliases).toBeUndefined();
    expect(await f.backend.search({ text: "documentation", limit: 5 })).toEqual([]);
  });
});
