import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type CaptureEnvelope, type LearningWindow } from "@provenloop/contracts";
import { createCaptureEnvelope, sha256, type CaptureEventInput } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore, DEFAULT_SQLITE_MIGRATIONS } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const base = Date.parse("2026-09-08T00:00:00Z");
const now = new Date(base + 60_000);
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const needed = <T>(value: T | undefined): T => { if (!value) throw new Error("Missing fixture source."); return value; };
const event = (id: string, type: string, seconds: number, parent?: CaptureEnvelope, content?: CaptureEventInput["content"]) => createCaptureEnvelope({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id, sessionId: "research-session", repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo",
  eventType: type, timestamp: new Date(base + seconds * 1000).toISOString(), trust: type === "prompt.submitted" ? "user" : type.startsWith("agent.") || type === "session.idle" ? "model" : "tool",
  ...(parent ? { parentEventId: parent.event.eventId } : {}), ...(content ? { content } : {}),
});
const add = (store: CanonicalSqliteStore, envelope: CaptureEnvelope) => store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `queue-${envelope.event.eventId}`,
  state: "pending", attemptCount: 0, failureCount: 0, createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope }));
const fixture = () => {
  const prompt = event("task", "prompt.submitted", 0, undefined, { message: "Investigate the project requirements." });
  const tool = event("docs", "tool.completed", 1, prompt, { toolResult: "Project v2 documentation requires a workspace-scoped cache. https://example.test/v2/cache" });
  const summary = event("summary", "agent.message", 2, tool, { message: "The project v2 documentation requires a workspace-scoped cache." });
  const closed = event("closed", "agent.turn_completed", 3, summary);
  return { prompt, tool, summary, closed, events: [prompt, tool, summary, closed] };
};
const options = (store: CanonicalSqliteStore, infer: (window: LearningWindow) => Promise<unknown>) => ({ store, now: () => now, enabled: async () => true,
  lease: { tryAcquire: async () => ({ release: async () => undefined }) }, provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer } });
const research = (window: LearningWindow) => {
  if (window.origin !== "agent") return { schemaVersion: 1, proposals: [] };
  const summary = needed(window.events.find((entry) => entry.event.eventId === window.anchorEventId));
  const tool = needed(window.events.find((entry) => entry.sourceEventId === "docs"));
  return { schemaVersion: 1, proposals: [{ rule: "Use a workspace-scoped cache for project v2.", trigger: "Configure this project cache", exclusions: ["Other project versions"],
    agentSource: { kind: "research", eventId: summary.event.eventId, quote: summary.content?.message, evidenceSources: [{ eventId: tool.event.eventId, quote: "Project v2 documentation requires a workspace-scoped cache." }] } }] };
};

describe("agent learning incremental lifecycle", () => {
  it("anchors the updated summary after ignoring another actor closing its own turn", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const f = fixture();
    const owned = (entry: CaptureEnvelope, actorId: string): CaptureEnvelope => ({ ...entry, event: { ...entry.event, actorId } });
    try {
      const tool = owned(f.tool, "researcher"); const summary = owned(f.summary, "researcher");
      [f.prompt, tool, summary, owned(f.closed, "other-agent")].forEach((entry) => add(store, entry));
      const infer = vi.fn(async (window: LearningWindow) => research(window));
      const coordinator = new LearningCoordinator(options(store, infer));
      await coordinator.run();
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toEqual([]);
      const updated = owned(event("updated-summary", "agent.message", 4, tool, { message: "The project v2 documentation requires a workspace-scoped cache, as checked above." }), "researcher");
      add(store, updated); add(store, owned(event("own-close", "agent.turn_completed", 5, updated), "researcher"));
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      const calls = infer.mock.calls.filter(([window]) => window.origin === "agent");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0].anchorEventId).toBe(updated.event.eventId);
      expect(store.learningProposals()[0]?.agentSource?.eventId).toBe(updated.event.eventId);
    } finally { store.close(); }
  });
  it("waits for turn closure, survives reopen, and never rereads unchanged history", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-learning-work-")); roots.push(root);
    const path = join(root, "canonical.db"); let store = new CanonicalSqliteStore(path); const f = fixture();
    try {
      [f.prompt, f.tool, f.summary].forEach((entry) => add(store, entry));
      const work = needed(store.learningPromptWork(now, 128).find((entry) => entry.origin === "agent"));
      store.close(); store = new CanonicalSqliteStore(path);
      expect(store.learningPromptWork(now, 128).some((entry) => entry.eventId === work.eventId)).toBe(true);
      const infer = vi.fn(async (window: LearningWindow) => research(window));
      const coordinator = new LearningCoordinator(options(store, infer));
      await coordinator.run();
      expect(infer.mock.calls.some(([window]) => window.origin === "agent")).toBe(false);
      add(store, f.closed);
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toHaveLength(1);
      const laterSummary = event("later-summary", "agent.message", 4, f.closed, { message: "The same finding remains useful." });
      add(store, laterSummary); add(store, event("later-close", "session.idle", 5, laterSummary));
      await coordinator.run();
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toHaveLength(1);
      expect(store.knowledgeCandidates()).toHaveLength(1);
      expect(store.knowledgeCandidates()[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred" });
      f.events.forEach((entry) => add(store, entry));
      const allHistory = vi.spyOn(store, "episodeSourceEnvelopes").mockImplementation(() => { throw new Error("History scan."); });
      await coordinator.run();
      expect(allHistory).not.toHaveBeenCalled();
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("preserves role and exact evidence quotations in Explain while keeping research out of Context", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(":memory:");
    try {
      fixture().events.forEach((entry) => add(store, entry));
      const coordinator = new LearningCoordinator(options(store, async (window) => research(window)));
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      const candidate = needed(store.knowledgeCandidates()[0]);
      const service = new ContextRetrievalService({ store, backend, now: () => now, timeoutMs: 5000 });
      // Isolate provenance rendering behind its existing delivery guard; research is not eligible for actual Context.
      store.appendContextUseRecord({ schemaVersion: 1, requestId: "explain-format-fixture", sessionId: "explain-fixture", createdAt: now.toISOString(),
        appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [`knowledge:${candidate.knowledgeId}`], latencyMs: 1, renderedTokens: 10, retrievalStatus: "provided" });
      const explanation = service.explain({ explanationRef: `knowledge:${candidate.knowledgeId}`, sessionId: "explain-fixture" });
      const body = JSON.stringify(explanation);
      expect(body).toContain('"agentSource"'); expect(body).toContain('"evidenceSources"'); expect(body).not.toContain('"userSource"');
      expect(body).toContain("Project v2 documentation requires a workspace-scoped cache.");
      expect((await service.context({ cwd: "C:/repo", repoId: "repo", prompt: "Configure workspace cache", sessionId: "new-session", tokenBudget: 600 })).items).toEqual([]);
    } finally { store.close(); await backend.closeAsync(); }
  });

  it("reuses the task expiry and attempts when the final summary anchor changes", () => {
    const store = new CanonicalSqliteStore(":memory:"); const f = fixture();
    try {
      f.events.forEach((entry) => add(store, entry));
      const captured = store.episodeSourceEnvelopes();
      const window = (summary: CaptureEnvelope): LearningWindow => {
        const events = [needed(captured.find((entry) => entry.sourceEventId === "task")), needed(captured.find((entry) => entry.sourceEventId === "docs")), summary];
        const sources = events.map((entry) => ({ eventId: entry.event.eventId, digest: sha256(entry) }));
        return { schemaVersion: 1, origin: "agent", anchorEventId: summary.event.eventId, windowId: `learning-agent-window-${sha256(summary.event.eventId).slice(0, 24)}`,
          revision: sha256(sources), sessionId: "research-session", repoId: "repo", worktree: "C:/repo", createdAt: summary.event.timestamp, events, sources };
      };
      const original = needed(store.scheduleLearningWindow(window(needed(captured.find((entry) => entry.sourceEventId === "summary"))), new Date(base + 86_400_000).toISOString()));
      store.transitionLearningJob({ ...original, state: "failed", attempts: 3 }, "pending");
      const later = event("revised-summary", "agent.message", 4, f.tool, { message: "The same workspace-scoped cache requirement." }); add(store, later);
      const revised = needed(store.scheduleLearningWindow(window(needed(store.episodeSourceEnvelopes().find((entry) => entry.sourceEventId === "revised-summary"))), new Date(base + 10 * 86_400_000).toISOString()));
      expect(revised).toMatchObject({ attempts: 3, expiresAt: original.expiresAt });
      expect(store.learningJobsDue(now, "inference")).toEqual([]);
    } finally { store.close(); }
  });

  it("requires an explicit schema 14 upgrade before backfilling agent anchors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-learning-upgrade-")); roots.push(root); const path = join(root, "canonical.db");
    const old = new CanonicalSqliteStore(path, { migrations: DEFAULT_SQLITE_MIGRATIONS.filter((entry) => entry.version < 14) }); fixture().events.forEach((entry) => add(old, entry)); old.close();
    expect(() => new CanonicalSqliteStore(path)).toThrow("maintenance upgrade");
    const store = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try { expect(store.health().userVersion).toBe(DEFAULT_SQLITE_MIGRATIONS.at(-1)?.version); expect(store.learningPromptWork(now, 128).some((entry) => entry.origin === "agent")).toBe(true); } finally { store.close(); }
  });

  it("retains no independent proposal for exact recalled agent guidance", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const f = fixture();
    try {
      f.events.forEach((entry) => add(store, entry));
      const knowledgeId = `learning-knowledge-${sha256(["repo", ["Use a workspace-scoped cache for project v2.", "Configure this project cache"]]).slice(0, 24)}`;
      store.appendContextUseRecord({ schemaVersion: 1, requestId: "research-assisted", sessionId: "research-session", createdAt: new Date(base + 1500).toISOString(),
        appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [`knowledge:${knowledgeId}`], latencyMs: 1, renderedTokens: 10, retrievalStatus: "provided" });
      const coordinator = new LearningCoordinator(options(store, async (window) => research(window)));
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(store.learningProposals()).toEqual([]);
      expect(store.knowledgeCandidates()).toEqual([]);
      expect(store.learningJobs().find((job) => job.windowId.startsWith("learning-agent-window-"))?.result).toBe("no_rule");
      expect(store.rawEvents()).toHaveLength(4);
    } finally { store.close(); }
  });

  it("learns from an early source in a long task while preserving the task boundary and bounded input", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const f = fixture();
    try {
      add(store, f.prompt); add(store, f.tool);
      for (let index = 0; index < 80; index += 1) add(store, event(`noise-${index}`, "tool.completed", index + 2, f.tool, { toolResult: "Unrelated captured output." }));
      const summary = event("long-summary", "agent.message", 90, f.tool, { message: f.summary.content?.message ?? "" }); add(store, summary); add(store, event("long-close", "agent.turn_completed", 91, summary));
      const time = new Date(base + 100_000);
      const work = needed(store.learningPromptWork(time, 128).find((entry) => entry.origin === "agent"));
      expect(work.events.length).toBeLessThanOrEqual(32);
      expect(work.events[0]?.event.eventId).toBe(f.prompt.event.eventId);
      expect(work.events.some((entry) => entry.event.eventId === f.tool.event.eventId)).toBe(true);
      expect(work.events.some((entry) => entry.event.eventId === summary.event.eventId)).toBe(true);
      const infer = vi.fn(async (window: LearningWindow) => research(window));
      const coordinator = new LearningCoordinator({ ...options(store, infer), now: () => time });
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toHaveLength(1);
      expect(store.learningProposals()[0]?.agentSource).toMatchObject({ kind: "research", eventId: summary.event.eventId });
      expect(store.knowledgeCandidates()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("reevaluates enriched agent provenance without another inference and keeps deletion authoritative", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const f = fixture();
    try {
      f.events.forEach((entry) => add(store, entry));
      const infer = vi.fn(async (window: LearningWindow) => research(window));
      const coordinator = new LearningCoordinator(options(store, infer));
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      const candidate = needed(store.knowledgeCandidates()[0]);
      const originalJob = needed(store.learningJobs().find((job) => job.windowId.startsWith("learning-agent-window-")));
      const before = infer.mock.calls.length;
      expect(store.enrichRawEvent({ envelope: { ...f.tool, content: { ...f.tool.content, message: "Observed documentation result." } }, sourceDigest: "e".repeat(64) }).status).toBe("enriched");
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(infer.mock.calls.length).toBe(before + 1); // The user window can reconsider its changed source; the agent proposal is retained.
      expect(infer.mock.calls.filter(([window]) => window.origin === "agent")).toHaveLength(1);
      expect(store.learningJobs().filter((job) => job.windowId === originalJob.windowId).every((job) => job.expiresAt === originalJob.expiresAt)).toBe(true);
      const target = { targetType: "source" as const, targetId: f.summary.event.eventId }; const deletion = store.beginDeletion(target); store.deleteCanonicalTarget(deletion.deletionId, target);
      expect(store.knowledgeCandidates([candidate.knowledgeId])).toEqual([]);
      expect(await coordinator.run()).toMatchObject({ status: "disabled" });
    } finally { store.close(); }
  });
});
