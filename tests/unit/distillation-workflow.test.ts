import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type LearningDistillationCriteria, type RuleProposalInput } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, createLearningDistillation, hasAcceptedLearningDistillation, redactCaptureEnvelopeForPersistence, sha256 } from "@provenloop/domain";
import { CopilotLearningProvider } from "@provenloop/copilot-adapter";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const roots: string[] = [];
const disposables: { close(): void }[] = [];
afterEach(async () => {
  for (const disposable of disposables.splice(0).reverse()) disposable.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const now = new Date("2026-09-11T08:00:10.000Z");
const revision = "a".repeat(40);
const conventionQuote = "Repository documentation must be written in English. Preserve executable syntax and identifiers.";
const mixedMessage = "这次只修复文档导航。" + conventionQuote + "\n" + "Task context: the navigation sidebar currently has several unfinished links.\n".repeat(35);
const referenceQuote = "src/cache.ts:17 Configuration entries require workspace and revision keys because both affect invalidation.";
const positive: LearningDistillationCriteria = { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true };
const review = (index = 0, changes: Partial<LearningDistillationCriteria> = {}) => ({
  index, criteria: { ...positive, ...changes }, rationale: "The captured evidence supports this concise repository-scoped lesson and its stated limits.",
});

const fixture = (kind: "convention" | "reference" = "convention", message = kind === "convention" ? mixedMessage : "Investigate configuration cache isolation.") => {
  const store = new CanonicalSqliteStore(":memory:");
  const backend = new SqliteFtsKnowledgeBackend(":memory:");
  disposables.push(store, backend);
  const inputs = [
    { id: "user", type: "prompt.submitted", trust: "user" as const, content: { message } },
    { id: "tool", type: "tool.completed", trust: "tool" as const, content: { toolResult: referenceQuote } },
    { id: "closed", type: "agent.turn_completed", trust: "model" as const, content: {} },
  ];
  for (const [index, input] of inputs.entries()) {
    const timestamp = new Date(now.getTime() - 10_000 + index * 1_000).toISOString();
    const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({
      adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: input.id, sessionId: "source-session",
      repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", branch: "main", commitSha: revision,
      eventType: input.type, trust: input.trust, timestamp, content: input.content,
    })).envelope;
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "queue-" + index,
      state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  }
  const events = store.episodeSourceEnvelopes();
  const window = buildLearningWindows(events, now).find((entry) => entry.origin !== "agent"); assert(window);
  const user = events.find((entry) => entry.event.trust === "user");
  const tool = events.find((entry) => entry.event.trust === "tool"); assert(user && tool);
  const quote = kind === "convention" ? message.includes(conventionQuote) ? conventionQuote : message : message;
  const proposal: RuleProposalInput = {
    rule: kind === "convention" ? "Write repository documentation in English; preserve executable syntax and identifiers." : "Key configuration cache entries by workspace and revision to prevent stale configuration reuse.",
    trigger: kind === "convention" ? "Writing repository documentation" : "Implementing configuration cache keys and invalidation",
    exclusions: kind === "convention" ? ["Do not translate executable syntax or identifiers."] : ["Verify the current implementation before changing other cache types."],
    userSource: { eventId: user.event.eventId, quote },
    supportingSources: [{ eventId: kind === "convention" ? user.event.eventId : tool.event.eventId, quote: kind === "convention" ? quote : referenceQuote }],
    canonicalKey: kind === "convention" ? "English repository documentation preserving executable syntax" : "configuration cache workspace revision invalidation",
    retention: { kind, lifetime: "durable", rationale: kind === "convention" ? "Consistent documentation language applies to later features without changing executable examples." : "Both dimensions determine which later configuration reads can safely share cached entries.",
      futureUse: kind === "convention" ? "When documenting another repository feature." : "When implementing another configuration cache consumer.", targetRepository: { status: "captured", repoId: "repo" } },
  };
  return { store, backend, events, window, proposal, message };
};

const production = async (f: ReturnType<typeof fixture>, options: { proposals?: RuleProposalInput[]; response?: unknown; dailyLimit?: number } = {}) => {
  const root = await mkdtemp(join(process.cwd(), ".provenloop-distillation-test-")); roots.push(root);
  const proposals = options.proposals ?? [f.proposal];
  const calls: { prompt: string; session: string | undefined }[] = [];
  const runner = { run: vi.fn(async (_command: string, args: readonly string[]) => {
    const prompt = args[args.indexOf("--prompt") + 1] ?? "";
    calls.push({ prompt, session: args[args.indexOf("--session-id") + 1] });
    expect(args).toContain("--no-custom-instructions");
    expect(args).toContain("--available-tools=");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    return { exitCode: 0, stdout: JSON.stringify(prompt.startsWith("Review proposed engineering lessons")
      ? options.response ?? { reviews: proposals.map((_proposal, index) => review(index)) }
      : { schemaVersion: 1, proposals }), stderr: "" };
  }) };
  const provider = new CopilotLearningProvider({ temporaryRoot: join(root, "scratch"), runner, enabled: async () => true });
  const coordinator = new LearningCoordinator({ store: f.store, provider, now: () => now, enabled: async () => true,
    lease: { tryAcquire: async () => ({ release: async () => undefined }) }, ...(options.dailyLimit ? { dailyLimit: options.dailyLimit } : {}) });
  return { coordinator, provider, runner, calls };
};
const retrieve = async (f: ReturnType<typeof fixture>, prompt: string, tokenBudget = 600) => {
  await new KnowledgeProjectionManager({ store: f.store, backend: f.backend }).rebuild();
  const service = new ContextRetrievalService({ store: f.store, backend: f.backend, now: () => now, timeoutMs: 5000 });
  const result = await service.context({ cwd: "C:/repo", repoId: "repo", headSha: revision, sessionId: "later-session", prompt, tokenBudget });
  return { service, result };
};

describe("reviewed distillation production workflow", () => {
  it("accepts an unambiguous singleton trigger copied from comparison-card shape", async () => {
    const f = fixture();
    const raw = { ...f.proposal, trigger: [f.proposal.trigger] } as unknown as RuleProposalInput;
    const p = await production(f, { proposals: [raw] });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(f.store.learningProposals()[0]?.trigger).toBe(f.proposal.trigger);
  });

  it("does not combine several trigger values into a broader condition", async () => {
    const f = fixture();
    const raw = { ...f.proposal, trigger: [f.proposal.trigger, "All unrelated tasks"] } as unknown as RuleProposalInput;
    const p = await production(f, { proposals: [raw] });
    expect(await p.coordinator.run()).toMatchObject({ status: "failed" });
    expect(f.store.learningProposals()).toEqual([]);
  });
  it("keeps valid review decisions when their explanatory rationale exceeds the storage limit", async () => {
    const f = fixture();
    const response = { reviews: [{ ...review(), rationale: "The source supports the stated scope and unchanged exceptions. ".repeat(30) }] };
    const p = await production(f, { response });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    const saved = f.store.learningProposals()[0];
    expect(saved?.distillation?.rationale.length).toBeLessThanOrEqual(512);
    expect(saved?.distillation?.criteria).toEqual(positive);
    expect(saved && hasAcceptedLearningDistillation(saved, saved.sourceDigests)).toBe(true);
  });

  it("cannot hide an invalid review decision behind a long rationale", async () => {
    const f = fixture();
    const response = { reviews: [{ ...review(), criteria: { ...positive, scoped: "true" }, rationale: "Repeated explanation. ".repeat(80) }] };
    const p = await production(f, { response });
    expect(await p.coordinator.run()).toMatchObject({ status: "failed" });
    expect(f.store.learningProposals()).toEqual([]);
  });

  it("rejects relationships to knowledge that was not supplied for comparison", async () => {
    const f = fixture();
    f.proposal.relations = [{ kind: "supersedes", knowledgeId: "unseen-rule", targetDigest: "a".repeat(64), reason: "Invented comparison" }];
    const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "failed" });
    expect(p.calls).toHaveLength(1);
    expect(f.store.learningProposals()).toEqual([]);
  });
  it("retains English lessons from Chinese evidence while preserving literal identifiers and quotations", async () => {
    const message = '仓库文档必须用英文，聊天仍用中文；标识符 healthCheck 和界面文本“已完成”保持原样。';
    const f = fixture("convention", message);
    f.proposal.rule = 'Write repository documentation in English; preserve healthCheck and the UI label "已完成".';
    f.proposal.exclusions = ["Conversation with the user remains in Chinese."];
    f.proposal.queryTerms = { include: ["仓库文档"], exclude: ["聊天"] };
    const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(p.calls[0]?.prompt).toContain("Use English for all newly authored lesson prose");
    expect(p.calls[1]?.prompt).toContain("Mark concise false if prose violates this output-language requirement");
    expect(p.calls[1]?.prompt).toContain("Write your review rationale in English");
    const retained = f.store.learningProposals()[0];
    expect(retained?.rule).toBe(f.proposal.rule);
    expect(retained?.userSource?.quote).toBe(message);
    expect(retained?.supportingSources?.[0]?.quote).toBe(message);
    expect(retained?.queryTerms).toEqual({ include: ["仓库文档"], exclude: ["聊天"] });
    const { result } = await retrieve(f, "Write repository documentation");
    expect(result.items[0]?.guidance).toContain("Write repository documentation in English");
    expect(result.items[0]?.guidance).toContain("healthCheck");
    expect(result.items[0]?.guidance).toContain("已完成");
    expect(result.items[0]?.applicabilitySummary).toContain("Conversation with the user remains in Chinese");
  });

  it("does not retain non-English lesson prose when the language review rejects it", async () => {
    const f = fixture("convention", "仓库文档必须用英文，聊天仍用中文。");
    f.proposal.rule = "仓库文档必须用英文。";
    const p = await production(f, { response: { reviews: [review(0, { concise: false })] } });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 0 });
    expect(f.store.knowledgeCandidates()).toEqual([]);
    expect(f.store.learningJobs()[0]?.distillation).toMatchObject({ accepted: 0, rejected: 1 });
    expect(f.store.learningJobs()[0]?.distillation?.reasons[0]).toContain("Quality review: concise:");
  });

  it("rejects invented discovery phrases before the review request", async () => {
    const f = fixture();
    f.proposal.queryTerms = { include: ["invented source topic"], exclude: [] };
    const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "failed", reason: "inference_or_validation_failed" });
    expect(p.calls).toHaveLength(1);
    expect(f.store.knowledgeCandidates()).toEqual([]);
  });
  it("learns an independent repository constraint from a long mixed task message without always", async () => {
    const f = fixture(); const p = await production(f);
    expect(f.message.length).toBeGreaterThan(2048);
    expect(f.message).not.toMatch(/always|every time|以后|每次/u);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]?.session).not.toBe(p.calls[1]?.session);
    expect(p.calls[1]?.prompt).toContain(JSON.stringify(f.message));
    const saved = f.store.learningProposals()[0]; assert(saved);
    expect(hasAcceptedLearningDistillation(saved, saved.sourceDigests)).toBe(true);
    expect(f.store.learningJobs()[0]?.distillation).toEqual({ proposed: 1, accepted: 1, rejected: 0, reasons: [] });
    expect(f.store.learningReceipts()).toEqual([]);
    expect(f.store.knowledgeCandidates()[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred", evidenceMarks: [] });

    const { service, result } = await retrieve(f, "Write repository documentation in English");
    expect(result.items).toHaveLength(1); expect(result.renderedTokens).toBeLessThanOrEqual(600);
    const item = result.items[0]; assert(item);
    expect(item.guidance).toContain(f.proposal.rule);
    expect(item.applicabilitySummary).toContain(f.proposal.trigger);
    expect(item.applicabilitySummary).toContain(f.proposal.exclusions[0]);
    expect(item.guidance).toContain("current instructions take precedence");
    expect(item.guidance).not.toContain("这次");
    expect(item.guidance).not.toContain(conventionQuote);
    expect(item.sources).toEqual([]);
    const explanation = service.explain({ sessionId: "later-session", explanationRef: item.explanationRef });
    expect(JSON.stringify(explanation)).toContain(conventionQuote);
    expect((await retrieve(f, "Write repository documentation in English", 100)).result.items).toEqual([]);
  });

  it("delivers the reviewed lesson from a user-origin reference while preserving original tool evidence in Explain", async () => {
    const f = fixture("reference"); const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
    const { service, result } = await retrieve(f, "Inspect configuration cache keys and invalidation");
    expect(result.items).toHaveLength(1); expect(result.renderedTokens).toBeLessThanOrEqual(600);
    const item = result.items[0]; assert(item);
    expect(item).toMatchObject({ deliveryMode: "reference", evidenceTier: "inferred", sources: [], reference: { requiresRevalidation: true } });
    expect(item.guidance).toContain(f.proposal.rule);
    expect(item.guidance).not.toContain(referenceQuote);
    expect(item.applicabilitySummary).toContain(f.proposal.exclusions[0]);
    expect(JSON.stringify(service.explain({ sessionId: "later-session", explanationRef: item.explanationRef }))).toContain(referenceQuote);
  });

  it("preserves previously verified quotes when review has to use shorter background excerpts", async () => {
    const quote = conventionQuote + "说明条件".repeat(125);
    const message = quote + "背景说明".repeat(1800);
    const f = fixture("convention", message);
    assert(f.proposal.userSource && f.proposal.supportingSources?.[0]);
    f.proposal.userSource.quote = quote; f.proposal.supportingSources[0].quote = quote;
    const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]?.prompt).toContain(JSON.stringify(quote));
    expect(f.store.learningJobs()[0]?.distillation).toMatchObject({ accepted: 1 });
  });

  it("reviews enriched provenance again and refreshes only the obsolete inferred candidate without renewing its lifetime", async () => {
    const f = fixture(); const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    const previous = f.store.knowledgeCandidates()[0]; const previousJob = f.store.learningJobs()[0]; assert(previous && previousJob);
    const tool = f.events.find((entry) => entry.event.trust === "tool"); assert(tool);
    const enriched = { ...tool, content: { ...tool.content, message: "The tool result now includes additional captured context." } };
    expect(f.store.enrichRawEvent({ envelope: enriched, sourceDigest: sha256(enriched) }).status).toBe("enriched");
    // A changed exclusion keeps the rule identity while requiring refreshed candidate content.
    f.proposal.exclusions = ["Preserve executable syntax, identifiers and quoted API fields."];
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(p.calls).toHaveLength(4);
    const current = f.store.knowledgeCandidates()[0]; assert(current);
    expect(current).toMatchObject({ knowledgeId: previous.knowledgeId, state: "candidate", evidenceTier: "inferred",
      createdAt: previous.createdAt, expiresAt: previous.expiresAt, nonApplicability: f.proposal.exclusions });
    const currentJob = f.store.learningJobs().find((job) => job.state === "evaluated"); assert(currentJob);
    expect(currentJob.attempts).toBe(previousJob.attempts + 1);
    expect(currentJob.expiresAt).toBe(previousJob.expiresAt);
    const { result } = await retrieve(f, "Write repository documentation in English");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.applicabilitySummary).toContain(f.proposal.exclusions[0]);
    expect(await p.coordinator.run()).toMatchObject({ status: "idle" });
    expect(p.calls).toHaveLength(4);
  });

  it("does not restore a revoked reviewed candidate when captured evidence is enriched", async () => {
    const f = fixture(); const p = await production(f);
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    const candidate = f.store.knowledgeCandidates()[0]; const tool = f.events.find((entry) => entry.event.trust === "tool"); assert(candidate && tool);
    f.store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "revoke-reviewed", evidenceRef: "user-review", kind: "revoke",
      source: "user", targetType: "knowledge", targetId: candidate.knowledgeId, timestamp: now.toISOString() } });
    const enriched = { ...tool, content: { ...tool.content, message: "Additional captured context." } };
    expect(f.store.enrichRawEvent({ envelope: enriched, sourceDigest: sha256(enriched) }).status).toBe("enriched");
    await p.coordinator.run();
    expect(p.calls).toHaveLength(2);
    expect((await retrieve(f, "Write repository documentation in English")).result.items).toEqual([]);
  });

  it("rejects source-matched false claims and task noise and records the rejected discoveries", async () => {
    const f = fixture();
    const wrong = { ...f.proposal, rule: "Translate all repository documentation and code identifiers into Chinese." };
    const noise = { ...f.proposal, rule: "The navigation sidebar had several unfinished links during the task." };
    const p = await production(f, { proposals: [wrong, noise], response: { reviews: [review(0, { supported: false, scoped: false }), review(1, { reusable: false, actionable: false })] } });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 0 });
    expect(p.calls).toHaveLength(2);
    expect(f.store.learningProposals()).toEqual([]); expect(f.store.knowledgeCandidates()).toEqual([]);
    expect(f.store.learningJobs()[0]).toMatchObject({ result: "no_rule", distillation: { proposed: 2, accepted: 0, rejected: 2 } });
    expect(f.store.learningJobs()[0]?.distillation?.reasons).toHaveLength(2);
    expect(f.store.learningJobs()[0]?.distillation?.reasons.join(" ")).toMatch(/supported.*reusable/u);
  });

  it.each([
    ["missing", { reviews: [{ criteria: positive, rationale: review().rationale }] }],
    ["out of range", { reviews: [review(1)] }],
    ["negative", { reviews: [review(-1)] }],
    ["omitted proposal", { reviews: [] }],
    ["invented approval", { reviews: [{ ...review(), userConfirmed: true }] }],
  ] as const)("rejects a review with %s index or authority data without persisting a lesson", async (_name, response) => {
    const f = fixture(); const p = await production(f, { response });
    expect(await p.coordinator.run()).toMatchObject({ status: "failed", reason: "inference_or_validation_failed" });
    expect(p.calls).toHaveLength(2); expect(f.store.learningProposals()).toEqual([]);
    expect(f.store.learningJobs()[0]?.state).toBe("failed");
  });

  it("rejects duplicate review indices even when the response count matches", async () => {
    const f = fixture(); const p = await production(f, { proposals: [f.proposal, { ...f.proposal, rule: "Another proposed lesson." }], response: { reviews: [review(0), review(0)] } });
    expect(await p.coordinator.run()).toMatchObject({ status: "failed" });
    expect(f.store.learningProposals()).toEqual([]);
  });

  it("binds reordered reviews to the nominated proposal instead of response position", async () => {
    const f = fixture();
    const wrong = { ...f.proposal, rule: "Use Chinese for every repository document." };
    const p = await production(f, { proposals: [f.proposal, wrong], response: { reviews: [review(1, { supported: false }), review(0)] } });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(f.store.learningProposals().map((proposal) => proposal.rule)).toEqual([f.proposal.rule]);
    expect(f.store.learningJobs()[0]?.distillation).toMatchObject({ proposed: 2, accepted: 1, rejected: 1 });
  });

  it("does not let the proposing model provide its own accepted review", async () => {
    const f = fixture();
    const forged = { ...f.proposal, distillation: createLearningDistillation(f.proposal, f.window.sources, { criteria: positive, rationale: review().rationale },
      { provider: "invented", model: "invented", version: "1" }, now.toISOString()) };
    const p = await production(f, { proposals: [forged] });
    expect(await p.coordinator.run()).toMatchObject({ status: "failed" });
    expect(p.calls).toHaveLength(1); expect(f.store.learningProposals()).toEqual([]);
  });

  it("charges the separate review request to the shared daily budget", async () => {
    const f = fixture(); const reserve = vi.spyOn(f.store, "reserveLearningAttempt"); const p = await production(f, { dailyLimit: 2 });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(p.calls).toHaveLength(2); expect(reserve).toHaveBeenCalledTimes(2);
    expect(f.store.reserveLearningAttempt(now, 2)).toBe(false);
    expect(await p.coordinator.run()).toMatchObject({ status: "idle" });
    expect(p.calls).toHaveLength(2);
  });

  it("does not spend a review request when extraction finds no lesson", async () => {
    const f = fixture(); const reserve = vi.spyOn(f.store, "reserveLearningAttempt"); const p = await production(f, { proposals: [], dailyLimit: 1 });
    expect(await p.coordinator.run()).toMatchObject({ status: "evaluated", proposals: 0 });
    expect(p.calls).toHaveLength(1); expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.store.learningJobs()[0]).toMatchObject({ state: "evaluated", result: "no_rule" });
    expect(f.store.learningJobs()[0]?.distillation).toBeUndefined();
  });

  it("pauses before review when its daily request budget is exhausted", async () => {
    const f = fixture(); const p = await production(f, { dailyLimit: 1 });
    expect(await p.coordinator.run()).toMatchObject({ status: "paused", reason: "daily_budget" });
    expect(p.calls).toHaveLength(1); expect(f.store.learningProposals()).toEqual([]);
    expect(f.store.learningJobs()[0]).toMatchObject({ state: "paused", pauseReason: "daily_budget", retryAfter: "2026-09-12T00:00:00.000Z" });
    await p.coordinator.run(); expect(p.calls).toHaveLength(1);
  });

  it.each(["convention", "reference"] as const)("keeps legacy %s delivery semantics without treating it as reviewed", async (kind) => {
    const f = fixture(kind, kind === "convention" ? "Always write repository documentation in English. Preserve executable syntax and identifiers." : "Investigate configuration cache isolation.");
    const coordinator = new LearningCoordinator({ store: f.store, now: () => now, enabled: async () => true,
      lease: { tryAcquire: async () => ({ release: async () => undefined }) },
      provider: { identity: { provider: "legacy-fixture", model: "fixture", version: "1" }, infer: async () => ({ schemaVersion: 1, proposals: [f.proposal] }) } });
    expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(f.store.learningProposals()[0]?.distillation).toBeUndefined();
    const { result } = await retrieve(f, kind === "convention" ? "Write repository documentation in English" : "Inspect configuration cache keys and invalidation", 1200);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.guidance).toContain(kind === "convention" ? f.message : referenceQuote);
    expect(result.items[0]?.guidance).not.toContain("Lesson distilled");
    expect(result.items[0]?.guidance).not.toContain(f.proposal.rule);
  });
});
