import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryMetadata, KnowledgeCandidate } from "@provenloop/contracts";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import { CopilotLearningProvider } from "@provenloop/copilot-adapter";
import { DeletionService, DiscoveryEnrichmentCoordinator, type DiscoveryEnrichmentProvider } from "@provenloop/host";
import { CanonicalSqliteStore, DatabaseSync } from "@provenloop/storage-sqlite";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const root = async () => { const path = await mkdtemp(join(tmpdir(), "provenloop-discovery-enrichment-")); roots.push(path); return path; };
const time = new Date("2026-09-11T08:00:00.000Z");
const candidate = (): KnowledgeCandidate => ({ schemaVersion: 1, knowledgeId: "saved-lesson", content: "Keep an idempotency key when retrying external writes.",
  appliesWhen: ["Retrying external writes."], nonApplicability: ["Read-only health checks"], conflictsWith: [], scope: "repository", scopeId: "repo",
  topicKey: "saved-lesson", kind: "semantic", state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"],
  sourceEpisodeIds: [], sourceEvidenceIds: [], createdAt: time.toISOString(), expiresAt: "2026-10-11T08:00:00.000Z", importance: 1,
  utility: { applied: 0, helpful: 0, harmful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 } });
const discovery: DiscoveryMetadata = { purposes: [{ value: "constraint", basisIds: ["content:0"], polarity: "positive" }],
  paraphrases: [{ value: { language: "zh", text: "重试外部写入时保留同一个幂等键。不适用于只读健康检查。" }, basisIds: ["content:0", "appliesWhen:0"], polarity: "positive" }] };
const review = { criteria: { supported: true, scoped: true, reusable: true, actionable: true, concise: true, nonredundant: true }, rationale: "The metadata preserves the saved write condition and read-only exclusion." };
const provider = (callback?: () => void, accepted = true): DiscoveryEnrichmentProvider => ({
  identity: { provider: "fixture", model: "fixture", version: "1" },
  enrichDiscovery: async (_candidate, options) => { if (!await options.reserveReviewAttempt()) throw new Error("Budget paused"); callback?.();
    return { discovery, review: accepted ? review : { ...review, criteria: { ...review.criteria, supported: false } } }; },
});

describe("background discovery enrichment", () => {
  it("persists accepted metadata separately and charges extraction plus independent review", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time }); const backend = new SqliteFtsKnowledgeBackend(":memory:");
    try {
      const saved = candidate(); store.upsertKnowledgeCandidates([saved]);
      const reserve = vi.spyOn(store, "reserveLearningAttempt");
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "accepted" });
      expect(reserve).toHaveBeenCalledTimes(2);
      expect(store.knowledgeCandidates()[0]).toEqual(saved);
      expect(store.learningJobs()).toEqual([]); expect(store.learningProposals()).toEqual([]);
      expect(store.discoveryProfiles([saved]).get(saved.knowledgeId)).toMatchObject({ producer: "model_reviewed", paraphrases: discovery.paraphrases });
      await new KnowledgeProjectionManager({ store, backend }).rebuild();
      expect((await backend.get(saved.knowledgeId))?.discoveryProfile?.paraphrases).toEqual(discovery.paraphrases);
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "idle" });
    } finally { await backend.closeAsync(); store.close(); }
  });

  it("persists the scan cursor and bounded retries across restarts", async () => {
    const path = join(await root(), "canonical.db"); let store = new CanonicalSqliteStore(path, { now: () => time });
    store.upsertKnowledgeCandidates([candidate(), { ...candidate(), knowledgeId: "second" }]);
    expect(store.scheduleDiscoveryEnrichment(time, 1)).toBe(1); store.close();
    store = new CanonicalSqliteStore(path, { now: () => time });
    try {
      expect(store.scheduleDiscoveryEnrichment(time, 1)).toBe(1);
      const failing = provider(); failing.enrichDiscovery = async () => { throw new Error("unavailable"); };
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: failing, enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "failed" });
      const retry = store.discoveryEnrichmentJob(new Date(time.getTime() + 300_000));
      expect(retry).toBeDefined();
    } finally { store.close(); }
  });

  it("does not dispatch when disabled and pauses before review when the shared budget is exhausted", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]); const implementation = provider(); const request = vi.spyOn(implementation, "enrichDiscovery");
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: implementation, enabled: async () => false, now: () => time }).run()).toEqual({ status: "disabled" });
      expect(request).not.toHaveBeenCalled();
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: implementation, enabled: async () => true, now: () => time, dailyLimit: 1 }).run()).toMatchObject({ status: "paused" });
      expect(store.discoveryProfiles([candidate()]).size).toBe(0);
      expect(store.discoveryEnrichmentJob(time)).toBeUndefined();
      expect(store.discoveryEnrichmentJob(new Date("2026-09-12T00:00:00.000Z"))?.attempts).toBe(0);
    } finally { store.close(); }
  });

  it.each(["content", "user_override", "withdrawal"])("rejects in-flight %s changes without editing the saved lesson", async (change) => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      const edited = change === "content" ? { ...candidate(), content: "A changed lesson." } : change === "withdrawal" ? { ...candidate(), state: "archived" as const } :
        { ...candidate(), discovery: { producer: "user" as const, purposes: [{ value: "fact" as const, basisIds: ["content:0"], polarity: "positive" as const }] } };
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(() => store.upsertKnowledgeCandidates([edited])), enabled: async () => true, now: () => time }).run())
        .toMatchObject({ status: "superseded" });
      expect(store.discoveryProfiles([edited]).size).toBe(0); expect(store.knowledgeCandidates()[0]).toEqual(edited);
    } finally { store.close(); }
  });

  it("never publishes a rejected independent review or overwrites explicit user facets", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(undefined, false), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "rejected" });
      expect(store.discoveryProfiles([candidate()]).size).toBe(0);
      const user = { ...candidate(), discovery: { producer: "user" as const } }; store.upsertKnowledgeCandidates([user]);
      expect(store.scheduleDiscoveryEnrichment(time)).toBe(0);
    } finally { store.close(); }
  });

  it("enforces its deadline even when an injected provider ignores cancellation", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      const hanging: DiscoveryEnrichmentProvider = { ...provider(), timeoutMs: 10, enrichDiscovery: async () => new Promise(() => undefined) };
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: hanging, enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "failed" });
      expect(() => new DiscoveryEnrichmentCoordinator({ store, provider: { ...provider(), timeoutMs: 0 }, enabled: async () => true })).toThrow("deadline");
      expect(() => new DiscoveryEnrichmentCoordinator({ store, provider: provider(), dailyLimit: -1, enabled: async () => true })).toThrow("budget");
    } finally { store.close(); }
  });

  it("does not spend review budget after the saved content changes during extraction", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]); const reserve = vi.spyOn(store, "reserveLearningAttempt");
      const implementation: DiscoveryEnrichmentProvider = { ...provider(), enrichDiscovery: async (_candidate, options) => {
        store.upsertKnowledgeCandidates([{ ...candidate(), content: "The lesson changed during extraction." }]);
        expect(await options.reserveReviewAttempt()).toBe(false); throw new Error("Stale input");
      } };
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: implementation, enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "superseded" });
      expect(reserve).toHaveBeenCalledOnce();
    } finally { store.close(); }
  });

  it("invalidates accepted profiles when supporting source content changes and preserves recorded navigation", async () => {
    const path = join(await root(), "canonical.db"); const store = new CanonicalSqliteStore(path, { now: () => time });
    try {
      const source = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "source", sessionId: "source-session",
        repoId: "repo", worktree: "C:/repo", eventType: "prompt.submitted", trust: "user", timestamp: time.toISOString(),
        content: { message: "External write policy: docs/retry-policy.md" } });
      store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "source", state: "pending", attemptCount: 0, failureCount: 0,
        createdAt: time.toISOString(), updatedAt: time.toISOString(), envelope: source }));
      const saved: KnowledgeCandidate = { ...candidate(), sourceEvidenceIds: [source.event.eventId], discovery: { sourceReferences: [{
        sourceRefId: "policy", kind: "file", locator: "docs/retry-policy.md", repositoryId: "repo", evidenceIds: [source.event.eventId],
        availability: "pointer_only", relationship: "background" }] } };
      store.upsertKnowledgeCandidates([saved]);
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "accepted" });
      expect(store.discoveryProfiles([saved]).get(saved.knowledgeId)?.sourceReferences).toEqual(saved.discovery?.sourceReferences);
      const database = new DatabaseSync(path);
      try { database.prepare("UPDATE raw_events SET safe_envelope_json=json_set(safe_envelope_json,'$.content.message',?) WHERE event_id=?")
        .run("Changed recorded source content", source.event.eventId); } finally { database.close(); }
      expect(store.discoveryProfiles([saved]).size).toBe(0);
      expect(store.scheduleDiscoveryEnrichment(time)).toBe(1);
    } finally { store.close(); }
  });

  it("cascades accepted jobs and profile copies through Forget and reset", async () => {
    const path = join(await root(), "canonical.db"); const store = new CanonicalSqliteStore(path, { now: () => time });
    const queue = { activeDeletionBarrier: async () => undefined, beginDeletionBarrier: async () => undefined, endDeletionBarrier: async () => undefined,
      blockIdentities: async () => undefined, deleteByIdentifiers: async () => ({ identities: [], queueItemIds: [] }), remainingIdentifiers: async () => [], remainingIdentities: async () => [] };
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "accepted" });
      expect((await new DeletionService({ store, queue, recordEvidence: async () => undefined }).delete({ targetType: "knowledge", targetId: candidate().knowledgeId })).gate.status).toBe("pass");
      const database = new DatabaseSync(path);
      try { expect(database.prepare("SELECT count(*) AS count FROM discovery_enrichment").get()?.count).toBe(0); } finally { database.close(); }
      expect(store.discoveryProfiles([candidate()]).size).toBe(0);
      store.clearAllRecords(new Date(time.getTime() + 1).toISOString());
      expect(store.previewRecordsReset().records).toBe(0);
    } finally { store.close(); }
  });

  it("does not let restoring an older profile erase a user metadata correction", async () => {
    const path = join(await root(), "canonical.db"); const snapshot = path + ".backup";
    const store = new CanonicalSqliteStore(path, { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: provider(), enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "accepted" });
      await store.backupTo(snapshot);
      store.upsertKnowledgeCandidates([{ ...candidate(), discovery: { producer: "user", purposes: [{ value: "fact", basisIds: ["content:0"], polarity: "positive" }] } }]);
      expect(store.discoveryProfiles(store.knowledgeCandidates()).size).toBe(0);
    } finally { store.close(); }
    await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path)).rejects.toThrow("user discovery correction");
  });

  it("cannot publish a provider response that skipped the independently budgeted review", async () => {
    const store = new CanonicalSqliteStore(":memory:", { now: () => time });
    try {
      store.upsertKnowledgeCandidates([candidate()]);
      const skipped = { ...provider(), enrichDiscovery: async () => ({ discovery, review }) };
      expect(await new DiscoveryEnrichmentCoordinator({ store, provider: skipped, enabled: async () => true, now: () => time }).run()).toMatchObject({ status: "rejected" });
      expect(store.discoveryProfiles([candidate()]).size).toBe(0);
    } finally { store.close(); }
  });

  it("uses two real provider calls through an injected runner without creating captured windows", async () => {
    const temporaryRoot = await root(); const prompts: string[] = []; let attempts = 0;
    const learning = new CopilotLearningProvider({ temporaryRoot, enabled: async () => true, runner: { run: async (_executable, args) => {
      const prompt = args[args.indexOf("--prompt") + 1]; assert(prompt); prompts.push(prompt);
      return { exitCode: 0, stdout: JSON.stringify(prompts.length === 1 ? discovery : review), stderr: "" };
    } } });
    expect(await learning.enrichDiscovery(candidate(), { signal: new AbortController().signal, reserveReviewAttempt: () => { attempts += 1; return true; } }))
      .toEqual({ discovery, review });
    expect(prompts).toHaveLength(2); expect(attempts).toBe(1);
    expect(prompts[0]).toContain(candidate().content); expect(prompts[1]).toContain("Independently review");
    expect(prompts.join(" ")).not.toContain("learning-window-"); expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
