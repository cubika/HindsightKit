import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema, type ContextUseRecord, type KnowledgeCandidate, type LearningJob } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import { CanonicalSqliteStore, DatabaseSync, DEFAULT_SQLITE_MIGRATIONS, readInspection, StaleCanonicalStoreError } from "@provenloop/storage-sqlite";

const cutoff = "2026-09-11T00:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const file = async () => { const root = await mkdtemp(join(tmpdir(), "pl-record-reset-")); roots.push(root); return join(root, "provenloop.db"); };
const queued = (id: string, timestamp: string, adapterVersion = "1.0.84-1") => captureQueueItemSchema.parse({
  schemaVersion: 1, queueItemId: `queue-${id}`, state: "pending", attemptCount: 0, failureCount: 0,
  createdAt: "2026-09-11T01:00:00.000Z", updatedAt: "2026-09-11T01:00:00.000Z",
  envelope: createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion, sourceEventId: id, sessionId: "session",
    eventType: "prompt.submitted", trust: "user", timestamp, repoId: "repo", worktree: "C:/repo", repositoryState: "known_repo",
    content: { message: "Source to clear" } }),
});

describe("canonical record reset", () => {
  it("clears all record tables transactionally, preserves schema, and persists only replay protection", async () => {
    const path = await file();
    const store = new CanonicalSqliteStore(path);
    const db = new DatabaseSync(path);
    try {
      store.ingestQueueItem(queued("old", "2026-09-10T00:00:00Z"));
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','record_reset')").all().map((row) => String(row.name));
      // Seed every record table, including FK dependents, so newly added tables cannot silently survive.
      db.exec("PRAGMA foreign_keys=OFF;");
      for (const table of tables) {
        if (Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count) > 0) continue;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        const values = columns.map((column) => String(column.type) === "INTEGER" ? 1 : String(column.type) === "REAL" ? 1.5
          : String(column.name).endsWith("_json") ? "{}" : "fixture");
        db.prepare(`INSERT INTO ${table} (${columns.map((column) => String(column.name)).join(",")}) VALUES (${values.map(() => "?").join(",")})`).run(...values);
      }
      db.exec("PRAGMA foreign_keys=ON;");
      const before = store.previewRecordsReset();
      expect(before.events).toBe(1); expect(before.knowledge).toBe(1); expect(before.jobs).toBe(1);
      expect(before.records).toBeGreaterThanOrEqual(tables.length);
      expect(store.clearAllRecords(cutoff)).toEqual(before);
      expect(store.previewRecordsReset()).toEqual({ events: 0, knowledge: 0, episodes: 0, jobs: 0, usage: 0, records: 0 });
      for (const table of tables) expect(Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count)).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(Number(db.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count)).toBe(DEFAULT_SQLITE_MIGRATIONS.length);
      expect(store.getRecordsResetCutoff()).toBe(cutoff);
      expect(store.clearAllRecords(cutoff).records).toBe(0);
    } finally { db.close(); store.close(); }
    const reopened = new CanonicalSqliteStore(path);
    try { expect(reopened.getRecordsResetCutoff()).toBe(cutoff); expect(reopened.health().quickCheck).toBe("ok"); } finally { reopened.close(); }
  });

  it("blocks native timestamps through the cutoff across deliveries and adapter versions without processing records", () => {
    const store = new CanonicalSqliteStore(":memory:");
    try {
      store.clearAllRecords(cutoff);
      for (const version of ["1.0.84-1", "1.0.83-4"]) for (const time of ["2026-09-10T23:59:59Z", cutoff, "2026-09-11T08:00:00+08:00"]) {
        expect(store.ingestQueueItem(queued("replayed", time, version)).status).toBe("duplicate");
      }
      expect(store.previewRecordsReset().records).toBe(0);
      expect(store.ingestQueueItem(queued("new", "2026-09-11T00:00:00.001Z")).status).toBe("stored");
      expect(store.rawEvents()).toHaveLength(1);
      expect(() => store.clearAllRecords("2026-09-10T00:00:00Z")).toThrow("backwards");
      expect(store.rawEvents()).toHaveLength(1);
    } finally { store.close(); }
  });

  it("requires schema 16 and upgrades an older valid store explicitly", async () => {
    const path = await file();
    const previous = new CanonicalSqliteStore(path, { migrations: DEFAULT_SQLITE_MIGRATIONS.filter((migration) => migration.version < 16) });
    expect(previous.getRecordsResetCutoff()).toBeUndefined();
    expect(() => previous.clearAllRecords(cutoff)).toThrow("current database schema");
    previous.close();
    const upgraded = new CanonicalSqliteStore(path, { allowSchemaMigration: true });
    try { upgraded.clearAllRecords(cutoff); expect(upgraded.getRecordsResetCutoff()).toBe(cutoff); } finally { upgraded.close(); }
  });

  it("rejects a backup that would erase replay protection and resurrect cleared records", async () => {
    const path = await file();
    const snapshot = `${path}.before-reset`;
    const store = new CanonicalSqliteStore(path);
    try {
      store.ingestQueueItem(queued("old-backup", "2026-09-10T00:00:00Z"));
      await store.backupTo(snapshot);
      store.clearAllRecords(cutoff);
    } finally { store.close(); }
    await expect(CanonicalSqliteStore.restoreFromBackup(snapshot, path)).rejects.toThrow("predates the installed record reset");
    const reopened = new CanonicalSqliteStore(path);
    try { expect(reopened.previewRecordsReset().records).toBe(0); expect(reopened.getRecordsResetCutoff()).toBe(cutoff); } finally { reopened.close(); }
  });

  it("invalidates old handles while the reset instance remains usable", async () => {
    const path = await file();
    const reset = new CanonicalSqliteStore(path);
    const stale = new CanonicalSqliteStore(path);
    const later = "2026-09-11T00:00:01.000Z";
    const candidate: KnowledgeCandidate = { schemaVersion: 1, knowledgeId: "cached-knowledge", content: "Cached user convention", kind: "semantic",
      scope: "repository", scopeId: "repo", topicKey: "cached", state: "active", evidenceTier: "user_confirmed", evidenceMarks: ["user_confirmed"],
      appliesWhen: ["reviewing"], nonApplicability: [], conflictsWith: [], sourceEpisodeIds: [], sourceEvidenceIds: [], createdAt: later,
      importance: 0, utility: { applied: 0, helpful: 0, harmful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 } };
    const job: LearningJob = { schemaVersion: 1, jobId: "cached-job", windowId: "cached-window", revision: "a".repeat(64), state: "evaluated",
      attempts: 1, createdAt: later, updatedAt: later, expiresAt: "2026-10-11T00:00:00.000Z", extractorVersion: "test" };
    const context: ContextUseRecord = { schemaVersion: 1, requestId: "cached-request", sessionId: "session", createdAt: later,
      appliedKnowledgeIds: [], candidateKnowledgeIds: [], returnedKnowledgeIds: [], latencyMs: 1, renderedTokens: 1, retrievalStatus: "provided" };
    try {
      const key = await readFile(`${path}.deletion.key`, "utf8");
      reset.clearAllRecords(cutoff);
      expect(await readFile(`${path}.restore.generation`, "utf8")).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await readFile(`${path}.deletion.key`, "utf8")).toBe(key);
      expect(reset.previewRecordsReset().records).toBe(0);
      for (const write of [
        () => stale.upsertKnowledgeCandidates([candidate]),
        () => stale.ingestQueueItem(queued("post-cutoff-cached", later)),
        () => stale.commitLearningResult({ job, proposals: [], receipts: [], candidates: [candidate] }),
        () => stale.appendContextUseRecord(context),
        () => stale.reserveLearningAttempt(new Date(later), 200),
        () => stale.learningJobs(),
      ]) expect(write).toThrow(StaleCanonicalStoreError);
      expect(reset.previewRecordsReset().records).toBe(0);
      expect(reset.ingestQueueItem(queued("fresh-handle", later)).status).toBe("stored");
    } finally { stale.close(); reset.close(); }
  });

  it("rolls back clearing when the generation cannot be published", async () => {
    const path = await file();
    const store = new CanonicalSqliteStore(path, { faultInjector: (stage) => {
      if (stage === "before_reset_generation_publish") throw new Error("Generation publication failed.");
    } });
    try {
      store.ingestQueueItem(queued("keep-on-failure", "2026-09-10T00:00:00Z"));
      const before = store.previewRecordsReset();
      expect(() => store.clearAllRecords(cutoff)).toThrow("Generation publication failed");
      expect(store.previewRecordsReset()).toEqual(before);
      expect(store.getRecordsResetCutoff()).toBeUndefined();
    } finally { store.close(); }
  });

  it("fences pending resets before generation changes while allowing the owning coordinator to recover", async () => {
    const path = await file();
    const ordinary = new CanonicalSqliteStore(path);
    const owner = new CanonicalSqliteStore(path, { allowRecordsReset: true });
    const pending = join(dirname(path), "records-reset.pending.json");
    try {
      ordinary.ingestQueueItem(queued("before-pending", "2026-09-10T00:00:00Z"));
      await writeFile(pending, JSON.stringify({ cutoff }), "utf8");
      expect(() => new CanonicalSqliteStore(path)).toThrow("record reset is pending");
      expect(() => ordinary.ingestQueueItem(queued("during-pending", "2026-09-11T00:00:01Z"))).toThrow("record reset is pending");
      expect(() => ordinary.upsertKnowledgeCandidates([])).toThrow("record reset is pending");
      expect(() => ordinary.previewRecordsReset()).toThrow("record reset is pending");
      expect(() => readInspection(path, (reader) => reader.summary())).toThrow("record reset is pending");
      const recovering = new CanonicalSqliteStore(path, { allowRecordsReset: true });
      try { expect(recovering.previewRecordsReset().events).toBe(1); } finally { recovering.close(); }
      expect(owner.clearAllRecords(cutoff).events).toBe(1);
      expect(owner.previewRecordsReset().records).toBe(0);
      expect(() => readInspection(path, (reader) => reader.summary())).toThrow("record reset is pending");
      await rm(pending);
      expect(readInspection(path, (reader) => reader.summary()).counts.events).toBe(0);
    } finally { owner.close(); ordinary.close(); }
  });
});
