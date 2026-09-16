import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type CaptureEnvelope, type LearningWindow, type RuleProposalInput } from "@provenloop/contracts";
import { buildLearningWindows, createCaptureEnvelope, learningSourceDigest, validateLearningResponse, type CaptureEventInput } from "@provenloop/domain";
import { CopilotLearningProvider } from "@provenloop/copilot-adapter";
import { LearningCoordinator } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { ContextRetrievalService, KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { prepareLearningInput } from "../../packages/copilot-adapter/src/learning-input.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const base = Date.parse("2026-09-11T01:00:00Z");
const revision = "a".repeat(40);
const quote = "src/cache.ts:17 return cache.get(workspaceId + ':' + revision);";
const conclusion = "The configuration cache key includes both workspaceId and revision.";
const event = (id: string, type: string, second: number, content?: CaptureEventInput["content"]): CaptureEnvelope => createCaptureEnvelope({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: id, sessionId: "long-research",
  repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", branch: "main", commitSha: revision,
  timestamp: new Date(base + second * 1000).toISOString(), eventType: type,
  trust: type === "prompt.submitted" ? "user" : type.startsWith("tool.") ? "tool" : "model",
  ...(content ? { content } : {}),
});
const fixture = (noise = 100) => {
  const task = event("task", "prompt.submitted", 0, { message: "Investigate how the configuration cache is keyed." });
  const evidence = event("early-code", "tool.completed", 1, { toolResult: quote });
  const middle = Array.from({ length: noise }, (_, index) => event("read-" + index, "tool.completed", index + 2, { toolResult: "Read unrelated module number " + index + "." }));
  const summary = event("final-summary", "agent.message", noise + 2, { message: conclusion });
  const closure = event("closed", "agent.turn_completed", noise + 3);
  const now = new Date(base + (noise + 10) * 1000);
  return { task, evidence, middle, summary, closure, now, events: [task, evidence, ...middle, summary, closure] };
};
const proposal = (window: LearningWindow): RuleProposalInput => {
  const summary = window.events.find((entry) => entry.event.eventId === window.anchorEventId);
  const evidence = window.events.find((entry) => entry.sourceEventId === "early-code");
  assert(summary?.content?.message && evidence);
  return { rule: conclusion, trigger: "Investigating configuration cache keys and invalidation",
    exclusions: ["Verify the cited implementation before relying on the finding."],
    agentSource: { kind: "research", eventId: summary.event.eventId, quote: summary.content.message,
      evidenceSources: [{ eventId: evidence.event.eventId, quote }] },
    supportingSources: [{ eventId: evidence.event.eventId, quote }], canonicalKey: "configuration cache keyed by workspace and revision",
    retention: { kind: "reference", lifetime: "durable", rationale: "The key composition explains how later configuration changes avoid cache collisions.",
      futureUse: "When investigating configuration cache keys or stale entries in this repository.", targetRepository: { status: "captured", repoId: "repo" } },
  };
};
const ingest = (store: CanonicalSqliteStore, envelope: CaptureEnvelope) => store.ingestQueueItem(captureQueueItemSchema.parse({
  schemaVersion: 1, queueItemId: "queue-" + envelope.event.eventId, state: "pending", attemptCount: 0, failureCount: 0,
  createdAt: envelope.event.timestamp, updatedAt: envelope.event.timestamp, envelope,
}));

describe("automatic long research memory", () => {
  it("selects evidence from an early file after hundreds of reads without changing source digests", () => {
    const f = fixture(600); const originals = new Map(f.events.map((entry) => [entry.event.eventId, learningSourceDigest(entry)]));
    const windows = buildLearningWindows(f.events, f.now).filter((window) => window.origin === "agent");
    expect(windows).toHaveLength(1);
    const window = windows[0]; assert(window);
    expect(window.events.length).toBeLessThanOrEqual(32);
    expect(window.events).toContainEqual(f.evidence);
    expect(window.events[0]).toEqual(f.task); expect(window.events.at(-1)).toEqual(f.closure);
    for (const source of window.sources) expect(source.digest).toBe(originals.get(source.eventId));
    const prepared = prepareLearningInput(window, "Extract grounded research from selected evidence.");
    expect(prepared.prompt).toContain(quote);
    expect(prepared.bytes).toBeLessThanOrEqual(32 * 1024);
    expect(validateLearningResponse(window, { schemaVersion: 1, proposals: [proposal(window)] }).proposals).toHaveLength(1);
  });

  it("does not hide a cross-repository operation when sampling the rest of a task", () => {
    const f = fixture();
    const outside = event("outside", "tool.started", 5.5);
    outside.event.redactedArguments = { path: "C:/other/private.ts" };
    expect(buildLearningWindows([...f.events, outside], f.now).filter((window) => window.origin === "agent")).toEqual([]);
  });

  it("does not treat a tool-request message as a final finding when its results have not arrived", () => {
    const f = fixture();
    const summary = { ...f.summary, event: { ...f.summary.event, completionStatus: "running" as const } };
    expect(buildLearningWindows([...f.events.filter((entry) => entry !== f.summary), summary], f.now)
      .filter((window) => window.origin === "agent")).toEqual([]);
  });

  it("reconsiders a final summary whose body arrives through capture enrichment", async () => {
    const f = fixture(40); const store = new CanonicalSqliteStore(":memory:");
    try {
      f.events.map((entry) => entry === f.summary ? { ...entry, content: {} } : entry).forEach((entry) => ingest(store, entry));
      const coordinator = new LearningCoordinator({ store, now: () => f.now, enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: { provider: "fixture", model: "fixture", version: "1" },
          infer: async (window) => ({ schemaVersion: 1, proposals: window.origin === "agent" ? [proposal(window)] : [] }) } });
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(store.learningProposals()).toEqual([]);
      expect(store.enrichRawEvent({ envelope: f.summary, sourceDigest: "e".repeat(64) }).status).toBe("enriched");
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(store.learningProposals()[0]?.agentSource?.eventId).toBe(f.summary.event.eventId);
    } finally { store.close(); }
  });

  it.each(["", "Inspecting the cache implementation."])("waits through tool-loop turn ends and blank chunks before retaining the final summary: %s", async (interimText) => {
    const f = fixture(); const store = new CanonicalSqliteStore(":memory:");
    try {
      const interim = event("interim", "agent.message", 0.2, { message: interimText });
      const loopStart = event("loop-start", "agent.turn_started", 0.1);
      const loopEnd = event("loop-end", "agent.turn_completed", 50.1);
      const nextStart = event("next-start", "agent.turn_started", 50.2);
      const blank = event("blank-chunk", "agent.message", 102.1, { message: "" });
      const child = event("child-close", "agent.turn_completed", 102.2);
      child.event.participantId = "child-agent";
      const running = [f.task, loopStart, interim, f.evidence, ...f.middle, loopEnd, nextStart];
      running.forEach((entry) => ingest(store, entry));
      const coordinator = new LearningCoordinator({ store, now: () => f.now, enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: { provider: "fixture", model: "fixture", version: "1" },
          infer: async (window) => ({ schemaVersion: 1, proposals: window.origin === "agent" ? [proposal(window)] : [] }) } });
      for (let pass = 0; pass < 3; pass += 1) await coordinator.run();
      expect(store.learningProposals()).toEqual([]);
      [f.summary, blank, child].forEach((entry) => ingest(store, entry));
      expect(buildLearningWindows([...running, f.summary, blank, child], f.now).filter((window) => window.origin === "agent")).toEqual([]);
      ingest(store, f.closure);
      const selected = buildLearningWindows([...running, f.summary, blank, child, f.closure], f.now).find((window) => window.origin === "agent");
      expect(selected?.anchorEventId).toBe(f.summary.event.eventId);
      for (let pass = 0; pass < 5; pass += 1) await coordinator.run();
      expect(store.learningProposals()).toHaveLength(1);
      expect(store.learningProposals()[0]?.agentSource?.eventId).toBe(f.summary.event.eventId);
    } finally { store.close(); }
  });

  it("persists a source-backed finding through the production provider and recalls it after reopening on a new commit", async () => {
    const root = await mkdtemp(join(process.cwd(), ".provenloop-research-memory-")); roots.push(root);
    const database = join(root, "canonical.db");
    const f = fixture(180);
    let store = new CanonicalSqliteStore(database);
    let backend: SqliteFtsKnowledgeBackend | undefined;
    try {
      f.events.forEach((entry) => ingest(store, entry));
      const after = event("next-task", "prompt.submitted", 190, { message: "Investigate another topic." });
      ingest(store, after);
      const work = store.learningPromptWork(f.now, 128).find((entry) => entry.origin === "agent");
      assert(work);
      expect(work.events.length).toBeLessThanOrEqual(32);
      expect(work.events.some((entry) => entry.event.eventId === after.event.eventId)).toBe(false);
      const window = buildLearningWindows(work.events, f.now).find((entry) => entry.origin === "agent"); assert(window);
      const finding = proposal(window);
      const runner = { run: vi.fn(async (_command: string, args: readonly string[]) => {
        const prompt = args[args.indexOf("--prompt") + 1] ?? "";
        if (!prompt.includes('"origin":"agent"')) return { exitCode: 0, stdout: '{"schemaVersion":1,"proposals":[]}', stderr: "" };
        expect(prompt).toContain(quote);
        expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32 * 1024);
        if (prompt.startsWith("Review proposed engineering lessons")) return { exitCode: 0, stdout: JSON.stringify({ reviews: [{
          index: 0, criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true },
          rationale: "The captured cache implementation supports the scoped key-composition finding.",
        }] }), stderr: "" };
        return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1, proposals: [finding] }), stderr: "" };
      }) };
      const provider = new CopilotLearningProvider({ temporaryRoot: join(root, "scratch"), enabled: async () => true, runner });
      const coordinator = new LearningCoordinator({ store, provider, enabled: async () => true, now: () => f.now,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) } });
      for (let pass = 0; pass < 6; pass += 1) await coordinator.run();
      expect(store.learningProposals()).toHaveLength(1);
      expect(store.knowledgeCandidates()[0]).toMatchObject({ content: conclusion, state: "candidate", evidenceTier: "inferred" });
      const calls = runner.run.mock.calls.length;
      await coordinator.run(); expect(runner.run).toHaveBeenCalledTimes(calls);
      store.close(); store = new CanonicalSqliteStore(database);
      backend = new SqliteFtsKnowledgeBackend(join(root, "knowledge.db"));
      await new KnowledgeProjectionManager({ store, backend }).rebuild();
      const service = new ContextRetrievalService({ store, backend, now: () => f.now, timeoutMs: 5000 });
      const response = await service.context({ cwd: "C:/repo", repoId: "repo", headSha: "b".repeat(40),
        sessionId: "new-session", prompt: "Investigate configuration cache keys and invalidation", tokenBudget: 600 });
      expect(response.status).toBe("ok"); expect(response.items).toHaveLength(1);
      expect(response.items[0]).toMatchObject({ deliveryMode: "reference", evidenceTier: "inferred" });
      expect(response.items[0]?.guidance).toContain("cache");
      expect(response.renderedTokens).toBeLessThanOrEqual(600);
      const explanation = service.explain({ sessionId: "new-session", explanationRef: response.items[0]?.explanationRef ?? "" });
      expect(JSON.stringify(explanation)).toContain(quote);
      expect(JSON.stringify(explanation)).toContain(conclusion);
    } finally { await backend?.closeAsync(); store.close(); }
  });
});
