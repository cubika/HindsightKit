import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import type { LearningWindow, RuleProposalInput } from "@provenloop/contracts";
import { assessLearningRetention, buildLearningWindows, createCaptureEnvelope, createLearningDistillation, sha256 } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const disposables: { close(): void }[] = [];
afterEach(() => { for (const item of disposables.splice(0).reverse()) item.close(); });
const initial = Date.parse("2026-09-11T00:00:00Z");
const day = 86_400_000;
const scope = { repoId: "repo", worktree: "C:/repo" };
const identity = { provider: "fixture", model: "fixture", version: "1" };
const assessment = { criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true }, rationale: "The source and compared lesson support the proposed meaning and relationship." };
const rule = "Write repository documentation in English.";
const event = (id: string, type: string, trust: "user" | "tool" | "model", timestamp: number, content = {}, extra = {}) => createCaptureEnvelope({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sessionId: id.split("/")[0] ?? id, sourceEventId: id, ...scope, repositoryState: "known_repo",
  branch: "main", commitSha: "a".repeat(40), eventType: type, trust, timestamp: new Date(timestamp).toISOString(), content, ...extra,
});
const proposal = (window: LearningWindow, content = rule, exclusions = ["Conversation language is unaffected."]): RuleProposalInput => {
  const user = window.events.find((entry) => entry.event.trust === "user" && entry.event.timestamp === window.createdAt); assert(user?.content?.message);
  return { rule: content, trigger: "Writing repository documentation", exclusions, canonicalKey: "Repository documentation language",
    userSource: { eventId: user.event.eventId, quote: user.content.message }, supportingSources: [{ eventId: user.event.eventId, quote: user.content.message }],
    retention: { kind: "convention", lifetime: "durable", rationale: "The requirement applies to subsequent repository documentation.", futureUse: "When documenting another repository feature.", targetRepository: { status: "captured", repoId: scope.repoId } } };
};
const fixture = () => {
  let clock = initial + 10_000; let sequence = 0;
  const store = new CanonicalSqliteStore(":memory:", { now: () => new Date(clock) });
  const backend = new SqliteFtsKnowledgeBackend(":memory:"); disposables.push(store, backend);
  const learn = async (message: string, options: { rule?: string; exclusions?: string[]; relation?: "equivalent" | "supersedes"; mutateTarget?: boolean; enrichTarget?: boolean; queryTerms?: RuleProposalInput["queryTerms"] } = {}) => {
    const session = "case-" + sequence++;
    for (const envelope of [event(session + "/user", "prompt.submitted", "user", clock - 10_000, { message }), event(session + "/close", "agent.turn_completed", "model", clock - 9_000)]) {
      store.ingestQueueItem({ schemaVersion: 1, queueItemId: "queue-" + envelope.sourceEventId, state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope });
    }
    const coordinator = new LearningCoordinator({ store, now: () => new Date(clock), enabled: async () => true, lease: { tryAcquire: async () => ({ release: async () => undefined }) },
      provider: { identity, infer: async (window, inference) => {
        const input = proposal(window, options.rule, options.exclusions);
        if (options.queryTerms) input.queryTerms = options.queryTerms;
        if (options.relation) {
          const target = inference.priorKnowledge?.find((entry) => entry.state === "candidate" || entry.state === "active") ?? inference.priorKnowledge?.[0]; assert(target);
          input.relations = [{ kind: options.relation, knowledgeId: target.knowledgeId, targetDigest: target.targetDigest, reason: "The new user instruction explicitly updates the compared convention." }];
          if (options.mutateTarget) { const candidate = store.knowledgeCandidates([target.knowledgeId])[0]; assert(candidate); store.upsertKnowledgeCandidates([{ ...candidate, importance: 1 }]); }
          if (options.enrichTarget) {
            const prior = store.learningProposals([target.knowledgeId])[0]; assert(prior);
            const captured = store.learningWindow(prior.jobId)?.events.find((entry) => entry.event.eventType === "agent.turn_completed"); assert(captured);
            const enriched = { ...captured, content: { ...captured.content, message: "Historical archives are exempt." } };
            expect(store.enrichRawEvent({ envelope: enriched, sourceDigest: sha256(enriched) }).status).toBe("enriched");
          }
        }
        return { schemaVersion: 1, proposals: [{ ...input, distillation: createLearningDistillation(input, window.sources, assessment, identity, new Date(clock).toISOString()) }] };
      } } });
    return coordinator.run();
  };
  const context = async () => { await new KnowledgeProjectionManager({ store, backend }).rebuild(); return new ContextRetrievalService({ store, backend, now: () => new Date(clock), timeoutMs: 5000 }).context({ cwd: scope.worktree, repoId: scope.repoId, headSha: "a".repeat(40), sessionId: "later", prompt: "Write repository documentation for a feature.", tokenBudget: 1800 }); };
  return { store, learn, context, advance: (days: number) => { clock += days * day; }, now: () => new Date(clock) };
};

describe("reviewed knowledge renewal and replacement", () => {
  it.each([true, false])("finds an old English lesson from Chinese evidence beyond 128 newer records (query terms: %s)", async (withTerms) => {
    const f = fixture();
    await f.learn("修改这个仓库的包代码时，先运行对应包的单元测试，不要默认跑整个仓库。集成测试仅在明确要求时执行。", {
      rule: "Run the affected package unit tests when editing package code; run integration tests only when requested.",
      ...(withTerms ? { queryTerms: { include: ["修改这个仓库的包代码", "先运行对应包的单元测试", "不要默认跑整个仓库"], exclude: [] } } : {}),
    });
    const target = f.store.knowledgeCandidates()[0]; assert(target);
    f.store.upsertKnowledgeCandidates(Array.from({ length: 140 }, (_, index) => ({ ...target, knowledgeId: "unrelated-" + index,
      content: `Set generated component ${index} color to teal.`, appliesWhen: ["Editing generated component colors"], nonApplicability: [], sourceEvidenceIds: [], createdAt: new Date(initial + 1000 + index).toISOString() })));
    const user = event("later/user", "prompt.submitted", "user", initial + day, { message: "以后修改包代码，集成测试也要执行，不再只运行单元测试。" });
    const end = event("later/end", "agent.turn_completed", "model", initial + day + 1000);
    const window = buildLearningWindows([user, end], new Date(initial + day + 10_000))[0]; assert(window);
    const selected = f.store.learningComparisonCandidates(window);
    expect(selected[0]?.knowledgeId).toBe(target.knowledgeId); expect(selected.length).toBeLessThanOrEqual(8); expect(JSON.stringify(selected).length).toBeLessThanOrEqual(7000);
  });
  it("replaces a prior convention after a reviewed explicit user change and returns only the new lesson", async () => {
    const f = fixture(); await f.learn("From now on repository documentation must be English."); f.advance(1);
    expect(await f.learn("The policy changed: from now on repository documentation must be Spanish instead of English.", { rule: "Write repository documentation in Spanish.", relation: "supersedes" })).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(f.store.knowledgeCandidates().map((item) => [item.content, item.state])).toEqual(expect.arrayContaining([[rule, "superseded"], ["Write repository documentation in Spanish.", "candidate"]]));
    const result = await f.context(); expect(result.items).toHaveLength(1); expect(result.items[0]?.guidance).toContain("Spanish");
  });
  it("updates changed exceptions even when rule and trigger keep the same identity", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(1);
    await f.learn("Keep English repository documentation, but now historical archives are exempt.", { exclusions: ["Historical archives are exempt."], relation: "supersedes" });
    const result = await f.context(); expect(result.items).toHaveLength(1); expect(result.items[0]?.applicabilitySummary).toContain("Historical archives");
    expect(f.store.knowledgeCandidates().filter((item) => item.state === "superseded")).toHaveLength(1);
  });
  it("can later restore a previous policy through a fresh reviewed replacement", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(1);
    await f.learn("Change documentation to Spanish from now on.", { rule: "Write repository documentation in Spanish.", relation: "supersedes" }); f.advance(1);
    expect(await f.learn("The Spanish policy is withdrawn; restore English documentation from now on.", { relation: "supersedes" })).toMatchObject({ status: "evaluated", proposals: 1 });
    expect(f.store.knowledgeCandidates().filter((item) => item.state === "candidate")).toHaveLength(1);
    const result = await f.context(); expect(result.items).toHaveLength(1); expect(result.items[0]?.guidance).toContain("English");
  });
  it.each(["knowledge", "source", "session"] as const)("deleting a compared lesson by %s also deletes review-bound replacements and their descendants", async (targetType) => {
    const f = fixture(); await f.learn("Repository documentation must be English."); const original = f.store.knowledgeCandidates()[0]; assert(original); f.advance(1);
    await f.learn("Change documentation to Spanish from now on.", { rule: "Write repository documentation in Spanish.", relation: "supersedes" }); f.advance(1);
    await f.learn("Change documentation to French from now on.", { rule: "Write repository documentation in French.", relation: "supersedes" });
    expect(f.store.knowledgeCandidates()).toHaveLength(3);
    const target = { targetType, targetId: targetType === "knowledge" ? original.knowledgeId : targetType === "session" ? "case-0" : original.sourceEvidenceIds[0] ?? "" };
    const deletion = f.store.beginDeletion(target); const result = f.store.deleteCanonicalTarget(deletion.deletionId, target);
    expect(result).toBeDefined(); expect(f.store.knowledgeCandidates()).toEqual([]); expect(f.store.learningProposals()).toEqual([]);
    expect(f.store.learningJobs()).toEqual([]); expect(f.store.pendingLearningActivationIds()).toEqual([]);
    expect(f.store.remainingIdentifiers(new Set([original.knowledgeId, "knowledge:" + original.knowledgeId]))).toEqual([]);
  });
  it("does not silently keep obsolete exceptions when no reviewed relationship resolves them", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(1);
    await f.learn("Historical archives are now exempt from English documentation.", { exclusions: ["Historical archives are exempt."] });
    expect(f.store.knowledgeCandidates()[0]?.state).toBe("disputed"); expect((await f.context()).items).toEqual([]);
  });
  it("rejects a relationship when the compared candidate changes before commit", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(1);
    expect(await f.learn("Use Spanish documentation now.", { rule: "Write repository documentation in Spanish.", relation: "supersedes", mutateTarget: true })).toMatchObject({ status: "cancelled" });
    expect(f.store.knowledgeCandidates()).toHaveLength(1); expect(f.store.knowledgeCandidates()[0]?.content).toBe(rule);
  });
  it("rejects a relationship when only the compared source changes while review is in flight", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); const target = f.store.knowledgeCandidates()[0]; assert(target); f.advance(1);
    expect(await f.learn("Use Spanish documentation now.", { rule: "Write repository documentation in Spanish.", relation: "supersedes", enrichTarget: true })).toMatchObject({ status: "cancelled" });
    expect(f.store.knowledgeCandidates()).toEqual([target]);
    expect(f.store.learningProposals().some((entry) => entry.rule.includes("Spanish"))).toBe(false);
  });
  it("stops contradictory same-concept guidance when a relationship was omitted", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(1);
    expect(await f.learn("The policy changed to Spanish documentation.", { rule: "Write repository documentation in Spanish." })).toMatchObject({ status: "cancelled" });
    expect(f.store.knowledgeCandidates()).toHaveLength(1); expect(f.store.knowledgeCandidates()[0]?.state).toBe("disputed"); expect((await f.context()).items).toEqual([]);
  });
  it("merges reviewed equivalent wording into the existing identity and renews it", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); const original = f.store.knowledgeCandidates()[0]; assert(original); f.advance(2);
    await f.learn("English remains the language for repository documentation.", { rule: "Use English when writing repository documentation.", relation: "equivalent" });
    const current = f.store.knowledgeCandidates()[0]; expect(f.store.knowledgeCandidates()).toHaveLength(1);
    expect(current?.knowledgeId).toBe(original.knowledgeId); expect(current?.content).toBe("Use English when writing repository documentation.");
    expect((await f.context()).items).toHaveLength(1);
  });
  it("does not revive an explicit archive or override a user-confirmed target", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); const candidate = f.store.knowledgeCandidates()[0]; assert(candidate);
    f.store.upsertKnowledgeCandidates([{ ...candidate, state: "archived" }]); f.advance(31); await f.learn("Repository documentation must be English.");
    expect(f.store.knowledgeCandidates()[0]?.state).toBe("archived");
    f.store.upsertKnowledgeCandidates([{ ...candidate, state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"] }]); f.advance(1);
    expect(await f.learn("Spanish documentation replaces the old policy.", { rule: "Write repository documentation in Spanish.", relation: "supersedes" })).toMatchObject({ status: "cancelled" });
    expect(f.store.knowledgeCandidates()).toHaveLength(1); expect(f.store.knowledgeCandidates()[0]?.evidenceTier).toBe("user_confirmed");
  });
  it("renews exact independent support and old job expiry cannot archive the renewed lesson", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); const original = f.store.knowledgeCandidates()[0]; assert(original); f.advance(10);
    await f.learn("Reaffirming our convention: repository documentation must be English."); const renewed = f.store.knowledgeCandidates()[0]; assert(renewed);
    expect(renewed.createdAt).toBe(original.createdAt); expect(Date.parse(renewed.expiresAt ?? "") - Date.parse(original.expiresAt ?? "")).toBe(10 * day);
    expect(renewed.sourceEvidenceIds).not.toEqual(original.sourceEvidenceIds); f.advance(21);
    await new LearningCoordinator({ store: f.store, now: f.now, enabled: async () => true, lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity, infer: async () => ({ schemaVersion: 1, proposals: [] }) } }).run();
    expect(f.store.knowledgeCandidates()[0]?.state).toBe("candidate"); expect((await f.context()).items).toHaveLength(1);
  });
  it("allows new independent learning after automatic expiry but never revives an explicit revoke", async () => {
    const f = fixture(); await f.learn("Repository documentation must be English."); f.advance(31);
    await f.learn("We still require English repository documentation."); expect(f.store.knowledgeCandidates()[0]?.state).toBe("candidate"); expect((await f.context()).items).toHaveLength(1);
    const candidate = f.store.knowledgeCandidates()[0]; assert(candidate);
    f.store.recordKnowledgeFeedback({ event: { schemaVersion: 1, feedbackId: "revoke", evidenceRef: "user-feedback", kind: "revoke", source: "user", targetType: "knowledge", targetId: candidate.knowledgeId, timestamp: f.now().toISOString() }, updateCandidate: (current) => ({ ...current, state: "archived" }) });
    f.advance(1); await f.learn("Repository documentation must be English."); expect(f.store.knowledgeCandidates()[0]?.state).toBe("archived"); expect((await f.context()).items).toEqual([]);
  });
});

describe("independent convention discovery boundaries", () => {
  it("keeps a user requirement after a recovery chain exceeded the proof window", () => {
    const events = [event("s/start", "tool.started", "tool", initial, { toolArguments: { command: "npm test" } }, { operationId: "old", toolName: "powershell" }),
      ...Array.from({ length: 12 }, (_, index) => event("s/progress-" + index, "agent.message", "model", initial + index + 1, { message: "Progress." })),
      event("s/failure", "tool.failed", "tool", initial + 13, { safeError: "Failed." }, { operationId: "old", toolName: "powershell" }),
      event("s/user", "prompt.submitted", "user", initial + 14, { message: rule }), event("s/end", "agent.turn_completed", "model", initial + 15)];
    const windows = buildLearningWindows(events, new Date(initial + 10_000)); expect(windows).toHaveLength(1); expect(windows[0]?.events.some((item) => item.sourceEventId === "s/start")).toBe(false);
  });
  it.each(["read_file", "view"])("allows an unquoted native auxiliary %s but still rejects writes and cited external sources", (toolName) => {
    const user = event("s/user", "prompt.submitted", "user", initial, { message: rule });
    const closed = event("s/end", "agent.turn_completed", "model", initial + 2);
    const read = event("s/read", "tool.started", "tool", initial + 1, { toolArguments: { cwd: scope.worktree, path: "C:/shared/style-guide.md" } }, { toolName, operationId: "read" });
    const window = buildLearningWindows([user, read, closed], new Date(initial + 10_000))[0]; assert(window);
    const input = proposal(window); const bound = { ...input, distillation: createLearningDistillation(input, window.sources, assessment, identity, new Date(initial).toISOString()) };
    expect(assessLearningRetention(bound, window.events, scope).retain).toBe(true);
    const write = { ...read, event: { ...read.event, toolName: "edit" } }; const writeEvents = [user, write, closed];
    const writeProposal = { ...input, distillation: createLearningDistillation(input, writeEvents.map((entry) => ({ eventId: entry.event.eventId, digest: sha256(entry) })), assessment, identity, new Date(initial).toISOString()) };
    expect(assessLearningRetention(writeProposal, writeEvents, scope).reason).toBe("cross_repository_target");
    const cited = event("s/cited", "tool.completed", "tool", initial + 1, { toolArguments: { cwd: scope.worktree, path: "C:/shared/style-guide.md" }, toolResult: "Documentation must remain English." }, { toolName, operationId: "cited" });
    const citedEvents = [user, cited, closed]; const referenced = { ...input, supportingSources: [...input.supportingSources ?? [], { eventId: cited.event.eventId, quote: "Documentation must remain English." }] };
    const reviewed = { ...referenced, distillation: createLearningDistillation(referenced, citedEvents.map((entry) => ({ eventId: entry.event.eventId, digest: sha256(entry) })), assessment, identity, new Date(initial).toISOString()) };
    expect(assessLearningRetention(reviewed, citedEvents, scope).reason).toBe("cross_repository_target");
  });
  it.each([
    ["Get-Content C:/shared/style-guide.md", true],
    ["Get-Content -LiteralPath 'C:/shared/style-guide.md'", true],
    ["Get-Content C:/shared/style-guide.md; Set-Content C:/other/code.ts text", false],
    ["Get-Content C:/shared/style-guide.md > C:/other/copied.md", false],
    ["Set-Content C:/other/code.ts text", false],
  ])("classifies only the bounded auxiliary read command %s", (command, retain) => {
    const user = event("s/user", "prompt.submitted", "user", initial, { message: rule });
    const tool = event("s/tool", "tool.started", "tool", initial + 1, { toolArguments: { cwd: scope.worktree, command } }, { toolName: "powershell", operationId: "read" });
    const close = event("s/end", "agent.turn_completed", "model", initial + 2);
    const window = buildLearningWindows([user, tool, close], new Date(initial + 10_000))[0]; assert(window); const input = proposal(window);
    const bound = { ...input, distillation: createLearningDistillation(input, window.sources, assessment, identity, new Date(initial).toISOString()) };
    expect(assessLearningRetention(bound, window.events, scope).retain).toBe(retain);
  });
});
