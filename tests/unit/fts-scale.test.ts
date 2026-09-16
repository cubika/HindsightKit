import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "@provenloop/storage-sqlite";
import { SqliteFtsKnowledgeBackend, type KnowledgeProjection, type KnowledgeQuery } from "@provenloop/retrieval";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const record = (id: string, extra: Partial<KnowledgeProjection> = {}): KnowledgeProjection => ({
  knowledgeId: id, topicKey: id, content: "Run the package validation.", appliesWhen: ["Changing packages"],
  nonApplicability: [], sourceDigest: "a".repeat(64), projectionVersion: 1, ...extra,
});
const fixture = async (maxPendingReads = 8) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-fts-scale-"));
  const path = join(root, "knowledge.db");
  const backend = new SqliteFtsKnowledgeBackend(path, { maxPendingReads });
  const database = new DatabaseSync(path);
  cleanups.push(async () => { await backend.closeAsync(); database.close(); await rm(root, { recursive: true, force: true }); });
  return { backend, database, path };
};

describe("FTS growth boundaries", () => {
  it("updates and removes one ID without reading unrelated projections or changing their row IDs", async () => {
    const { backend, database } = await fixture();
    await backend.index([record("first"), record("second"), record("third")]);
    const ids = database.prepare("SELECT rowid, knowledge_id FROM knowledge_fts ORDER BY rowid").all();
    // A corrupt unrelated body must not force an otherwise independent update to scan the entire projection.
    database.prepare("UPDATE knowledge_records SET projection_json = 'invalid' WHERE knowledge_id = 'second'").run();
    await backend.index([record("first", { content: "Run uniqueincremental validation." })]);
    expect(database.prepare("SELECT rowid, knowledge_id FROM knowledge_fts ORDER BY rowid").all()).toEqual(ids);
    expect((await backend.search({ text: "uniqueincremental", limit: 2 })).map((hit) => hit.knowledgeId)).toEqual(["first"]);
    await backend.remove(["third", "missing"]);
    expect(database.prepare("SELECT rowid, knowledge_id FROM knowledge_fts ORDER BY rowid").all()).toEqual(ids.slice(0, 2));
    expect(await backend.get("third")).toBeUndefined();
    database.prepare("UPDATE knowledge_records SET projection_json = ? WHERE knowledge_id = 'second'").run(JSON.stringify(record("second")));
    database.exec("VACUUM");
    expect((await backend.search({ text: "package", limit: 5 })).map((hit) => hit.knowledgeId)).toEqual(["second"]);
  });

  it("filters scope, eligibility, and expiry before LIMIT in synchronous and worker searches", async () => {
    const { backend } = await fixture();
    const metadata = { scope: "repository" as const, scopeId: "repo", eligible: true };
    await backend.index([
      ...Array.from({ length: 25 }, (_, index) => record(`a-other-${index}`, { retrievalMetadata: { ...metadata, scopeId: "other" } })),
      record("b-inactive", { retrievalMetadata: { ...metadata, eligible: false } }),
      record("c-expired", { retrievalMetadata: { ...metadata, expiresAt: "2026-01-01T00:00:00.000Z" } }),
      record("z-valid", { retrievalMetadata: metadata }),
      record("z-personal", { retrievalMetadata: { scope: "personal", eligible: true } }),
      record("z-legacy"),
    ]);
    const query: KnowledgeQuery = { text: "package", limit: 3, filter: { now: "2026-09-11T00:00:00.000Z",
      scopes: [{ scope: "repository", scopeId: "repo" }, { scope: "personal" }] } };
    const expected = ["z-legacy", "z-personal", "z-valid"];
    expect((await backend.search(query)).map((hit) => hit.knowledgeId)).toEqual(expected);
    expect((await backend.searchWithTimeout(query, 3_000)).map((hit) => hit.knowledgeId)).toEqual(expected);
    await expect(backend.index([record("invalid", { retrievalMetadata: { scope: "repository", eligible: true } })])).rejects.toThrow("invalid");
  });

  it("removes ineligible content from ranking while keeping its inspectable projection", async () => {
    const { backend, database } = await fixture();
    const active = record("retained", { retrievalMetadata: { scope: "personal", eligible: true } });
    await backend.index([active]);
    const id = database.prepare("SELECT record_id FROM knowledge_records WHERE knowledge_id = 'retained'").get()?.record_id;
    const inactive = { ...active, retrievalMetadata: { scope: "personal" as const, eligible: false } };
    await backend.index([inactive]);
    expect(await backend.search({ text: "package", limit: 1 })).toEqual([]);
    expect(await backend.get("retained")).toMatchObject({ retrievalMetadata: { eligible: false } });
    expect(database.prepare("SELECT count(*) AS count FROM knowledge_fts").get()?.count).toBe(0);
    await backend.index([active]);
    expect(database.prepare("SELECT rowid FROM knowledge_fts").get()?.rowid).toBe(id);
    expect((await backend.search({ text: "package", limit: 1 }))[0]?.knowledgeId).toBe("retained");
    await backend.rebuild({ records: [inactive] });
    expect(await backend.search({ text: "package", limit: 1 })).toEqual([]);
  });

  it("synchronizes only changed and missing IDs and rolls back failed snapshots", async () => {
    const { backend, database } = await fixture();
    const records = [record("keep"), record("change"), record("remove")];
    await backend.index(records);
    const originalIds = database.prepare("SELECT record_id, knowledge_id FROM knowledge_records ORDER BY knowledge_id").all();
    database.exec(`CREATE TABLE writes(kind TEXT, knowledge_id TEXT);
      CREATE TRIGGER track_insert AFTER INSERT ON knowledge_records BEGIN INSERT INTO writes VALUES ('insert', new.knowledge_id); END;
      CREATE TRIGGER track_update AFTER UPDATE ON knowledge_records BEGIN INSERT INTO writes VALUES ('update', new.knowledge_id); END;
      CREATE TRIGGER track_delete AFTER DELETE ON knowledge_records BEGIN INSERT INTO writes VALUES ('delete', old.knowledge_id); END;`);
    await backend.synchronize({ records });
    expect(database.prepare("SELECT * FROM writes").all()).toEqual([]);
    const changed = record("change", { content: "Run synchronizedunique validation." });
    await backend.synchronize({ records: [record("keep"), changed, record("new")] });
    expect(database.prepare("SELECT kind, knowledge_id FROM writes ORDER BY knowledge_id").all()).toEqual([
      { kind: "update", knowledge_id: "change" }, { kind: "insert", knowledge_id: "new" }, { kind: "delete", knowledge_id: "remove" },
    ]);
    expect(database.prepare("SELECT record_id, knowledge_id FROM knowledge_records WHERE knowledge_id IN ('keep', 'change') ORDER BY knowledge_id").all()).toEqual(originalIds.slice(0, 2));
    expect((await backend.search({ text: "synchronizedunique", limit: 1 }))[0]?.knowledgeId).toBe("change");
    database.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON knowledge_records BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    await expect(backend.synchronize({ records: [record("keep"), record("change")] })).rejects.toThrow("test rollback");
    expect(await backend.get("new")).toBeDefined();
    expect((await backend.search({ text: "synchronizedunique", limit: 1 }))[0]?.knowledgeId).toBe("change");
  });

  it("upgrades the old search format, preserves row IDs, and discards obsolete FTS rows", async () => {
    const { backend, database, path } = await fixture();
    await backend.closeAsync();
    database.exec(`DROP TABLE knowledge_records; DROP TABLE knowledge_fts;
      CREATE TABLE knowledge_records(knowledge_id TEXT PRIMARY KEY, projection_json TEXT NOT NULL, source_digest TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, topic_key, content, applies_when, non_applicability UNINDEXED);
      UPDATE knowledge_search_metadata SET value = '2' WHERE name = 'format';`);
    database.prepare("INSERT INTO knowledge_records(rowid, knowledge_id, projection_json, source_digest) VALUES (42, ?, ?, ?)")
      .run("old", JSON.stringify(record("old")), "a".repeat(64));
    database.exec("INSERT INTO knowledge_fts(knowledge_id, content) VALUES ('ghost', 'obsolete')");
    const upgraded = new SqliteFtsKnowledgeBackend(path);
    try {
      expect(database.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_id = 'old'").get()?.rowid).toBe(42);
      expect(database.prepare("SELECT value FROM knowledge_search_metadata WHERE name = 'format'").get()?.value).toBe("3");
      expect(await upgraded.search({ text: "obsolete", limit: 1 })).toEqual([]);
      await upgraded.index([record("old", { content: "Updated migrationrule." })]);
      expect((await upgraded.searchWithTimeout({ text: "migrationrule", limit: 1 }, 3_000))[0]?.knowledgeId).toBe("old");
      expect(database.prepare("SELECT rowid FROM knowledge_fts WHERE knowledge_id = 'old'").get()?.rowid).toBe(42);
    } finally { await upgraded.closeAsync(); }
  });

  it("bounds pending reads, isolates a timed-out worker, and accepts reads after recovery", async () => {
    const { backend } = await fixture(2);
    await backend.index([record("item")]);
    const postMessage = Worker.prototype.postMessage;
    const blocked = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, value: unknown) {
      if ((value as { operation?: string }).operation !== "search") Reflect.apply(postMessage, this, [value]);
    });
    const terminate = Worker.prototype.terminate;
    let termination: Promise<number> | undefined;
    vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      termination = Reflect.apply(terminate, this, []) as Promise<number>; return termination;
    });
    const query = { text: "package", limit: 1 };
    const reads = Promise.allSettled([backend.searchWithTimeout(query, 25), backend.searchWithTimeout(query, 25)]);
    await expect(backend.searchWithTimeout(query, 25)).rejects.toThrow("queue is full");
    const outcomes = await reads;
    expect(outcomes.every((result) => result.status === "rejected" && String(result.reason).includes("timed out"))).toBe(true);
    expect(termination).toBeDefined();
    blocked.mockRestore();
    await termination;
    expect((await backend.searchWithTimeout(query, 3_000))[0]?.knowledgeId).toBe("item");
  });

  it("isolates a real slow SQLite read until its native worker exits", async () => {
    const { backend, database } = await fixture();
    await backend.index([record("slow-item")]);
    const query = { text: "package", limit: 1 };
    await backend.searchWithTimeout(query, 3_000);
    database.exec(`ALTER TABLE knowledge_records RENAME TO knowledge_records_base;
      CREATE VIEW knowledge_records AS SELECT record_id, knowledge_id,
        CASE WHEN (WITH RECURSIVE counter(value) AS (VALUES(0) UNION ALL
          SELECT value + 1 FROM counter WHERE value < 2000000) SELECT sum(value) FROM counter) > 0
          THEN projection_json ELSE '' END AS projection_json,
        retrieval_scope, retrieval_eligible, retrieval_expires_at FROM knowledge_records_base;`);
    const terminate = Worker.prototype.terminate;
    let termination: Promise<number> | undefined;
    vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      termination = Reflect.apply(terminate, this, []) as Promise<number>; return termination;
    });
    await expect(backend.searchWithTimeout(query, 5)).rejects.toThrow("timed out");
    expect(termination).toBeDefined();
    await expect(backend.searchWithTimeout(query, 5)).rejects.toThrow("unavailable");
    // Native SQLite execution may finish before Worker.terminate can take effect. Do not spawn another worker meanwhile.
    await termination;
    database.exec("DROP VIEW knowledge_records; ALTER TABLE knowledge_records_base RENAME TO knowledge_records;");
    expect((await backend.searchWithTimeout(query, 3_000))[0]?.knowledgeId).toBe("slow-item");
  });
});
