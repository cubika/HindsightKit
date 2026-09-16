import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema, type ContextUseRecord, type KnowledgeCandidate } from "@provenloop/contracts";
import { createCaptureEnvelope, discoveryConceptToken, knowledgeDiscoveryDigest, sha256 } from "@provenloop/domain";
import { createDefaultCopilotAdapterState, writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import { DeletionService } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths, WindowsCaptureQueue } from "@provenloop/platform-windows";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend, knowledgeProjectionFromCandidate, type KnowledgeProjection } from "@provenloop/retrieval";
import { CanonicalMigrationRequiredError, CanonicalSqliteStore, DatabaseSync, DEFAULT_SQLITE_MIGRATIONS, UnsupportedDatabaseVersionError } from "@provenloop/storage-sqlite";
import { runCaptureWorkerOnce } from "../../packages/cli/src/run-worker.js";

const roots: string[] = [];
const timestamp = "2026-09-11T08:00:00.000Z";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const directory = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), "provenloop-discovery-migration-")); roots.push(root); return root; };
const candidate = (): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: "retry-knowledge", topicKey: "retry-guidance", content: "Use an idempotency key when retrying external writes.",
  appliesWhen: ["Retrying external writes."], nonApplicability: ["Read-only health checks"], conflictsWith: [],
  kind: "semantic", scope: "repository", scopeId: "repo", createdAt: timestamp, sourceEpisodeIds: [], sourceEvidenceIds: [],
  state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"], importance: 1,
  coverage: { applicableOpportunities: 0, observedOutcomes: 0 }, utility: { applied: 0, helpful: 0, harmful: 0 },
});
const context = (value = candidate()): ContextUseRecord => ({
  schemaVersion: 1, requestId: "retrieval-request", sessionId: "retrieval-session", repoId: "repo", createdAt: timestamp,
  candidateKnowledgeIds: [value.knowledgeId], returnedKnowledgeIds: [value.knowledgeId], appliedKnowledgeIds: [],
  latencyMs: 1, renderedTokens: 100, retrievalStatus: "provided",
});
const legacyProjection = (value = candidate()): KnowledgeProjection => {
  const { discoveryProfile: _discovery, ...projection } = knowledgeProjectionFromCandidate(value); void _discovery;
  const metadata = projection.retrievalMetadata;
  if (!metadata) return projection;
  const { discoveryVersion: _version, ...legacy } = metadata; void _version;
  return { ...projection, retrievalMetadata: legacy };
};
const enriched = (): KnowledgeCandidate => ({ ...candidate(), discovery: { producer: "user",
  sourceReferences: [{ sourceRefId: "policy", kind: "file", locator: "docs/retries.md", repositoryId: "repo", evidenceIds: [],
    availability: "pointer_only", relationship: "background" }] } });
const queueStub = () => ({
  activeDeletionBarrier: async () => undefined, beginDeletionBarrier: async () => undefined, endDeletionBarrier: async () => undefined,
  blockIdentities: async () => undefined, deleteByIdentifiers: async () => ({ identities: [], queueItemIds: [] }),
  remainingIdentifiers: async () => [], remainingIdentities: async () => [],
});

describe("discovery migration and lifecycle", () => {
  it("upgrades the 0.15 schema 16 store to schema 23 without changing legacy records or reset protection", async () => {
    const path = join(await directory(), "canonical.db");
    const migrations16 = DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 16);
    const cutoff = "2026-09-11T00:00:00.000Z";
    const saved = candidate(); const usage = context(saved);
    const old = new CanonicalSqliteStore(path, { migrations: migrations16 });
    try { old.upsertKnowledgeCandidates([saved]); old.appendContextUseRecord(usage); } finally { old.close(); }
    const fixture = new DatabaseSync(path);
    try { fixture.prepare("INSERT INTO record_reset(singleton,cutoff) VALUES (1,?)").run(cutoff); } finally { fixture.close(); }
    const storedJson = () => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          knowledge: database.prepare("SELECT body_json FROM knowledge_candidates WHERE knowledge_id=?").get(saved.knowledgeId)?.body_json,
          usage: database.prepare("SELECT body_json FROM context_use_records WHERE request_id=?").get(usage.requestId)?.body_json,
        };
      } finally { database.close(); }
    };
    const before = storedJson();
    expect(CanonicalSqliteStore.databaseVersion(path)).toBe(16);
    expect(() => new CanonicalSqliteStore(path)).toThrow(CanonicalMigrationRequiredError);
    expect(CanonicalSqliteStore.databaseVersion(path)).toBe(16);
    const current = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try {
      expect(current.health()).toMatchObject({ userVersion: 23, quickCheck: "ok" });
      expect(current.knowledgeCandidates()).toEqual([saved]);
      expect(current.contextUseRecord(usage.requestId)).toMatchObject(usage);
      expect(current.getRecordsResetCutoff()).toBe(cutoff);
      expect(current.discoveryEnrichmentStatus()).toEqual({});
      expect(storedJson()).toEqual(before);
      const replay = captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "pre-upgrade-replay", state: "pending", attemptCount: 0,
        failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope: createCaptureEnvelope({
          adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "pre-upgrade-source", sessionId: "old-session",
          repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", eventType: "prompt.submitted",
          timestamp: cutoff, trust: "user", content: { message: "Previously cleared experience." },
        }) });
      expect(current.ingestQueueItem(replay).status).toBe("duplicate");
      expect(current.rawEvents()).toEqual([]);
    } finally { current.close(); }
    expect(() => new CanonicalSqliteStore(path, { migrations: migrations16 })).toThrow(UnsupportedDatabaseVersionError);
    const reopened = new CanonicalSqliteStore(path);
    try {
      expect(reopened.knowledgeCandidates()).toEqual([saved]);
      expect(reopened.contextUseRecord(usage.requestId)).toMatchObject(usage);
      expect(reopened.getRecordsResetCutoff()).toBe(cutoff);
      expect(storedJson()).toEqual(before);
    } finally { reopened.close(); }
  });

  it("upgrades schema 21 explicitly, preserves old JSON, and refuses a 21-reader on schema 22", async () => {
    const path = join(await directory(), "canonical.db");
    const migrations21 = DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 21);
    const old = new CanonicalSqliteStore(path, { migrations: migrations21 });
    old.upsertKnowledgeCandidates([candidate()]); old.appendContextUseRecord(context()); old.close();
    expect(CanonicalSqliteStore.databaseVersion(path)).toBe(21);
    expect(() => new CanonicalSqliteStore(path)).toThrow(CanonicalMigrationRequiredError);
    const migrations22 = DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 22);
    const current = new CanonicalSqliteStore(path, { allowSchemaMigration: true, migrations: migrations22 });
    try {
      expect(CanonicalSqliteStore.databaseVersion(path)).toBe(22);
      expect(current.knowledgeCandidates()).toEqual([candidate()]);
      expect(current.contextUseRecord("retrieval-request")).toMatchObject(context());
      current.upsertKnowledgeCandidates([enriched()]);
      current.appendContextUseRecord({ ...context(), requestId: "enriched-request", retrievalMode: "search", relevance: [{
        knowledgeId: candidate().knowledgeId, knowledgeDigest: knowledgeDiscoveryDigest(candidate()), querySignature: sha256("retry"),
        policyVersion: "discovery-relevance-1", matchedConcepts: ["retries"], matchedEntities: [], unresolvedConditions: [],
      }] });
      expect(current.knowledgeCandidates()[0]?.discovery).toEqual(enriched().discovery);
      expect(current.contextUseRecord("enriched-request")).toMatchObject({ retrievalMode: "search", relevance: [{ matchedConcepts: ["retries"] }] });
    } finally { current.close(); }
    expect(() => new CanonicalSqliteStore(path, { migrations: migrations21 })).toThrow();
    const reopened = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try { expect(reopened.knowledgeCandidates()[0]?.discovery).toEqual(enriched().discovery); } finally { reopened.close(); }
  });

  it("keeps legacy FTS projections lexical-readable and incrementally refreshes concept discovery", async () => {
    const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(join(await directory(), "knowledge.db"));
    try {
      store.upsertKnowledgeCandidates([candidate()]); await backend.rebuild({ records: [legacyProjection()] });
      expect((await backend.search({ text: "idempotency", limit: 3 })).map((entry) => entry.knowledgeId)).toEqual([candidate().knowledgeId]);
      expect(await backend.search({ text: discoveryConceptToken("idempotency"), limit: 3 })).toEqual([]);
      expect(backend.needsDiscoveryRefresh()).toBe(true);
      await new KnowledgeProjectionManager({ store, backend }).synchronize();
      expect(backend.needsDiscoveryRefresh()).toBe(false);
      expect((await backend.search({ text: discoveryConceptToken("idempotency"), limit: 3 })).map((entry) => entry.knowledgeId)).toEqual([candidate().knowledgeId]);
      expect((await backend.get(candidate().knowledgeId))?.discoveryProfile?.producer).toBe("deterministic");
    } finally { await backend.closeAsync(); store.close(); }
  });

  it("refreshes a legacy discovery projection on a worker run with no new captured events", async () => {
    const root = await directory(); const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data); await mkdir(paths.backends);
    await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root }));
    const initial = createDefaultCopilotAdapterState(new Date(timestamp));
    await writeCopilotAdapterState(paths.adapterState, { ...initial, installed: true, pluginEnabled: true, pluginInstalled: true, marketplaceRegistered: true,
      capabilities: { ...initial.capabilities, capture: { enabled: true }, worker: { enabled: true },
        correction_learning: { enabled: true }, retrieval: { enabled: true } } });
    const store = new CanonicalSqliteStore(paths.database); store.upsertKnowledgeCandidates([candidate()]); store.close();
    const queue = new WindowsCaptureQueue(paths.queue); await queue.initialize();
    const before = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
    await before.rebuild({ records: [legacyProjection()] }); await before.closeAsync();
    const sourceRead = vi.spyOn(CanonicalSqliteStore.prototype, "episodeSourceEnvelopes");
    expect(await runCaptureWorkerOnce({ dataRoot: root, admission: () => ({ allowed: true, reasons: [] }),
      lease: { tryAcquire: async () => ({ release: async () => undefined }) }, now: () => new Date(timestamp) })).toMatchObject({ status: "completed", stored: 0, failed: 0 });
    expect(sourceRead).not.toHaveBeenCalled();
    const after = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
    try {
      expect(after.needsDiscoveryRefresh()).toBe(false);
      expect((await after.search({ text: discoveryConceptToken("idempotency"), limit: 3 })).map((entry) => entry.knowledgeId)).toEqual([candidate().knowledgeId]);
    } finally { await after.closeAsync(); }
  });

  it.each(["knowledge", "source"] as const)("deleting %s removes navigation, derived profiles, and query relevance observations", async (targetType) => {
    const store = new CanonicalSqliteStore(":memory:"); const backend = new SqliteFtsKnowledgeBackend(":memory:");
    try {
      const source = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "retry-policy-source",
        sessionId: "policy-source-session", repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo", eventType: "prompt.submitted",
        timestamp, trust: "user", content: { message: "Always keep an idempotency key for retrying external writes. Policy: docs/retries.md." } });
      store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "source-queue", state: "pending", attemptCount: 0,
        failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope: source }));
      const value = { ...enriched(), sourceEvidenceIds: [source.event.eventId] };
      store.upsertKnowledgeCandidates([value]);
      store.appendContextUseRecord({ ...context(value), retrievalMode: "context", relevance: [{ knowledgeId: value.knowledgeId,
        knowledgeDigest: knowledgeDiscoveryDigest(value), querySignature: sha256("retry-query"), policyVersion: "discovery-relevance-1",
        matchedConcepts: ["retries", "idempotency"], matchedEntities: [], unresolvedConditions: [] }] });
      const projection = new KnowledgeProjectionManager({ store, backend }); await projection.rebuild();
      expect((await backend.get(value.knowledgeId))?.discoveryProfile?.sourceReferences[0]?.locator).toBe("docs/retries.md");
      const result = await new DeletionService({ store, queue: queueStub(), recordEvidence: async () => undefined, knowledgeProjection: {
        acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => { await projection.rebuild(); },
        remainingIdentifiers: async (identifiers) => { const ids: string[] = []; for (const identifier of identifiers) if (await backend.get(identifier)) ids.push(identifier); return ids; },
      } }).delete({ targetType, targetId: targetType === "source" ? source.event.eventId : value.knowledgeId });
      expect(result.gate.status).toBe("pass");
      expect(store.knowledgeCandidates([value.knowledgeId])).toEqual([]);
      expect(await backend.get(value.knowledgeId)).toBeUndefined();
      expect(await backend.search({ text: discoveryConceptToken("idempotency"), limit: 3 })).toEqual([]);
      const record = store.contextUseRecord("retrieval-request");
      expect(record?.relevance?.some((entry) => entry.knowledgeId === value.knowledgeId) ?? false).toBe(false);
      expect(JSON.stringify(store.contextUseRecords())).not.toContain("docs/retries.md");
      if (targetType === "source") expect(store.rawEvent(source.deduplicationKey)).toBeUndefined();
      else assert(store.rawEvent(source.deduplicationKey));
    } finally { await backend.closeAsync(); store.close(); }
  });
});
