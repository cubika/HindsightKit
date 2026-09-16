import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { createDefaultCopilotAdapterState, setPersistedCapability, writeCopilotAdapterState } from "../../packages/copilot-adapter/src/operational-state.js";
import { notifyLearningActivation } from "../../packages/cli/src/run-learning.js";
import assert from "node:assert/strict";
import { captureQueueItemSchema, type RuleProposalInput } from "@provenloop/contracts";
import { createCaptureEnvelope, createLearningDistillation, redactCaptureEnvelopeForPersistence } from "@provenloop/domain";
import { LearningCoordinator } from "@provenloop/host";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (enabled = true, notificationsEnabled = true) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-activation-notice-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  const now = new Date();
  const state = setPersistedCapability(createDefaultCopilotAdapterState(now), "correction_learning", { enabled: true }, now);
  await writeCopilotAdapterState(paths.adapterState, { ...state, installed: true,
    capabilities: { ...state.capabilities, capture: { enabled: true }, worker: { enabled: true } }, automaticLearning: {
    consentedAt: now.toISOString(), disclosureVersion: 1, enabled, notificationsEnabled,
  } });
  return { root, paths };
};

describe("activation notice delivery boundary", () => {
  it.each(["convention", "reference"] as const)("announces a reviewed %s through the canonical notice queue without calling it verified", async (kind) => {
    const { root, paths } = await fixture();
    const store = new CanonicalSqliteStore(paths.database);
    const time = new Date();
    const userText = kind === "convention" ? "Repository documentation must be written in English. Preserve executable syntax and identifiers." : "Investigate configuration cache isolation.";
    const toolText = "Configuration entries require workspace and revision keys because both affect invalidation.";
    try {
      for (const [index, input] of [
        { type: "prompt.submitted", trust: "user" as const, content: { message: userText } },
        { type: "tool.completed", trust: "tool" as const, content: { toolResult: toolText } },
        { type: "agent.turn_completed", trust: "model" as const, content: {} },
      ].entries()) {
        const timestamp = new Date(time.getTime() - 10_000 + index * 1_000).toISOString();
        const envelope = redactCaptureEnvelopeForPersistence(createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1",
          sourceEventId: `notice-${index}`, sessionId: "notice-source", repoId: "repo", worktree: "C:/repo",
          repositoryState: "known_repo", branch: "main", commitSha: "a".repeat(40), timestamp, eventType: input.type, trust: input.trust, content: input.content })).envelope;
        store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `q-${index}`, state: "pending",
          attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
      }
      const events = store.episodeSourceEnvelopes();
      const user = events.find((entry) => entry.event.trust === "user");
      const tool = events.find((entry) => entry.event.trust === "tool"); assert(user && tool);
      const proposal: RuleProposalInput = {
        rule: kind === "convention" ? "Write repository documentation in English; preserve executable syntax and identifiers." : "Key configuration cache entries by workspace and revision to prevent stale configuration reuse.",
        trigger: kind === "convention" ? "Writing repository documentation" : "Implementing configuration cache invalidation",
        exclusions: ["Unrelated repositories"], canonicalKey: kind === "convention" ? "English repository documentation" : "configuration cache workspace revision keys",
        userSource: { eventId: user.event.eventId, quote: userText },
        supportingSources: [{ eventId: kind === "convention" ? user.event.eventId : tool.event.eventId, quote: kind === "convention" ? userText : toolText }],
        retention: { kind, lifetime: "durable", rationale: "This constraint changes future implementation and review choices.",
          futureUse: kind === "convention" ? "When documenting another repository feature." : "When implementing another configuration cache consumer.", targetRepository: { status: "captured", repoId: "repo" } },
      };
      const coordinator = new LearningCoordinator({ store, now: () => time, enabled: async () => true,
        lease: { tryAcquire: async () => ({ release: async () => undefined }) },
        provider: { identity: { provider: "fixture", model: "fixture", version: "1" }, infer: async (window) => ({ schemaVersion: 1, proposals: [{ ...proposal,
          distillation: createLearningDistillation(proposal, window.sources, { criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true },
            rationale: "The captured source supports the stated reusable constraint." }, { provider: "fixture", model: "fixture", version: "1" }, time.toISOString()) }] }) } });
      expect(await coordinator.run()).toMatchObject({ status: "evaluated", proposals: 1, qualified: 0 });
      const candidate = store.knowledgeCandidates()[0]; assert(candidate);
      expect(candidate).toMatchObject({ state: "candidate", evidenceTier: "inferred" });
      const ids = store.pendingLearningActivationIds();
      expect(ids).toContain(candidate.knowledgeId);
      const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
      log.mockRejectedValueOnce(new Error("Host log unavailable"));
      await expect(notifyLearningActivation(root, ids, log)).rejects.toThrow("Host log unavailable");
      expect(await notifyLearningActivation(root, ids, log)).toBe(true);
      expect(await notifyLearningActivation(root, ids, log)).toBe(false);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.lastCall?.[0]).toContain(proposal.rule);
      expect(log.mock.lastCall?.[0]).toContain(proposal.trigger);
      expect(log.mock.lastCall?.[0]).toContain("Exceptions: Unrelated repositories");
      expect(log.mock.lastCall?.[0]).toContain("Model-reviewed lesson");
      expect(log.mock.lastCall?.[0]).not.toContain("Externally verified");
      expect(store.knowledgeCandidates([candidate.knowledgeId])[0]).toMatchObject({ state: "candidate", evidenceTier: "inferred" });
    } finally { store.close(); }
  });

  it("releases a durable claim when logging fails, then delivers it once on retry", async () => {
    const { root } = await fixture();
    // Model the canonical claim boundary; domain proof admission is tested separately.
    const claims = new Set<string>();
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice").mockImplementation((id) => {
      if (claims.has(id)) return false;
      claims.add(id); return true;
    });
    const release = vi.spyOn(CanonicalSqliteStore.prototype, "releaseLearningActivationNotice").mockImplementation((id) => { claims.delete(id); });
    const id = "learning-knowledge-notice-fixture";
    await expect(notifyLearningActivation(root, [id], async () => { throw new Error("Host log unavailable."); })).rejects.toThrow("Host log unavailable");
    expect(release).toHaveBeenCalledWith(id);
    expect(claims.size).toBe(0);
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    expect(await notifyLearningActivation(root, [id], log)).toBe(true);
    expect(await notifyLearningActivation(root, [id], log)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(3);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("knowledge show " + id);
    expect(message).toContain('--data-root "' + root + '"');
    expect(message).toContain("knowledge revoke");
    expect(message).toContain("provenloop forget");
    expect(message).not.toContain("SOURCE_SNIPPET");
  });
  it.each([[false, true], [true, false]])("suppresses disabled learning or muted notifications before claiming (%s, %s)", async (enabled, notificationsEnabled) => {
    const { root } = await fixture(enabled, notificationsEnabled);
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice");
    const log = vi.fn(async () => undefined);
    expect(await notifyLearningActivation(root, ["learning-knowledge-fixture"], log)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("does not log deleted or unknown canonical rules and blocks active deletion", async () => {
    const { root, paths } = await fixture();
    const log = vi.fn(async () => undefined);
    expect(await notifyLearningActivation(root, ["learning-knowledge-deleted"], log)).toBe(false);
    const store = new CanonicalSqliteStore(paths.database);
    try { store.beginDeletion({ targetType: "source", targetId: "event-" + "a".repeat(64) }); }
    finally { store.close(); }
    const claim = vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice");
    expect(await notifyLearningActivation(root, ["learning-knowledge-fixture"], log)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
  it("never looks up raw source bodies and bounds the summary to three admitted claims", async () => {
    const { root } = await fixture();
    vi.spyOn(CanonicalSqliteStore.prototype, "claimLearningActivationNotice").mockReturnValue(true);
    const raw = vi.spyOn(CanonicalSqliteStore.prototype, "rawEvents").mockImplementation(() => { throw new Error("SOURCE_SNIPPET"); });
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const ids = Array.from({ length: 5 }, (_, index) => "learning-knowledge-" + index);
    expect(await notifyLearningActivation(root, ids, log)).toBe(true);
    const message = log.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("learned 3");
    expect(message).not.toContain("learning-knowledge-3");
    expect(message).not.toContain("SOURCE_SNIPPET");
    expect(raw).not.toHaveBeenCalled();
  });
});
