import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync, loadNodeSqlite } from "@provenloop/storage-sqlite";
import { searchableText } from "./search-text.js";
import { discoveryProfileSchema } from "@provenloop/contracts";
import { discoverySearchText, DISCOVERY_VOCABULARY_VERSION } from "@provenloop/domain";

import type {
  KnowledgeBackend,
  KnowledgeBackendHealth,
  KnowledgeProjection,
  KnowledgeProjectionSnapshot,
  KnowledgeQuery,
  KnowledgeRecord,
} from "./types.js";

const normalizedIds = (ids: readonly string[]): string[] =>
  [...new Set(
    ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )].sort();

const SEARCH_SQL = `SELECT records.projection_json,
  bm25(knowledge_fts, 0.0, 4.0, 2.0, 1.0, 0.25) AS rank
  FROM knowledge_fts JOIN knowledge_records AS records ON records.record_id = knowledge_fts.rowid
  WHERE knowledge_fts MATCH ? AND (? = 0 OR records.retrieval_eligible IS NULL OR (
    records.retrieval_eligible = 1 AND
    (records.retrieval_expires_at IS NULL OR records.retrieval_expires_at > ?) AND
    records.retrieval_scope IN (SELECT value FROM json_each(?))))
  ORDER BY rank, knowledge_fts.knowledge_id LIMIT ? OFFSET ?`;

const scopeKey = (scope: string, scopeId?: string): string =>
  JSON.stringify([scope, scope === "personal" ? null : scopeId ?? null]);
const validScope = (scope: string): boolean => ["personal", "workflow", "repository", "branch"].includes(scope);
const searchFilter = (query: KnowledgeQuery): readonly [number, number, string] => {
  if (query.filter === undefined) return [0, 0, "[]"];
  const { now, scopes } = query.filter;
  if (!Number.isFinite(Date.parse(now)) || !Array.isArray(scopes) || scopes.length > 64 ||
      scopes.some((entry) => !validScope(entry.scope) ||
        (entry.scopeId !== undefined && (typeof entry.scopeId !== "string" || entry.scopeId.trim().length === 0)) ||
        (entry.scope !== "personal" && (typeof entry.scopeId !== "string" || entry.scopeId.trim().length === 0)))) {
    throw new Error("Knowledge search filter is invalid.");
  }
  return [1, Date.parse(now), JSON.stringify([...new Set(scopes.map((entry) => scopeKey(entry.scope, entry.scopeId)))])];
};

const READ_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = (${loadNodeSqlite.toString()})(require);

try {
  const database = new DatabaseSync(workerData.path, {
    readOnly: true,
  });
  parentPort.on("message", (request) => {
    if (request.operation === "close") {
      database.close();
      process.exit(0);
      return;
    }
    try {
      database.exec(
        "PRAGMA busy_timeout = " + request.timeoutMs + ";",
      );
      let result;
      if (request.operation === "health") {
        const quickCheck = database.prepare("PRAGMA quick_check;").get();
        const count = database.prepare(
          "SELECT COUNT(*) AS count FROM knowledge_records",
        ).get();
        const fts5 = database.prepare(
          "SELECT COUNT(*) AS count " +
          "FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'knowledge_fts'",
        ).get();
        result = {
          fts5Available: Number(fts5.count) === 1,
          quickCheck: String(Object.values(quickCheck)[0]),
          recordCount: Number(count.count),
        };
      } else if (request.operation === "search") {
        const rows = database.prepare(${JSON.stringify(SEARCH_SQL)}).all(
          request.match,
          ...request.filter,
          request.limit,
          request.offset,
        );
        result = rows.map((row) => ({
          projectionJson: String(row.projection_json),
          rank: Number(row.rank),
        }));
      } else {
        throw new Error("Unknown Knowledge backend read operation.");
      }
      parentPort.postMessage({
        ok: true,
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        requestId: request.requestId,
      });
    }
  });
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
    fatal: true,
    ok: false,
  });
}
`;

interface ReadWorkerResponse<T> {
  readonly error?: string;
  readonly fatal?: boolean;
  readonly ok: boolean;
  readonly requestId?: number;
  readonly result?: T;
}

interface PendingReadRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

const validateProjection = (
  record: KnowledgeProjection,
): KnowledgeProjection => {
  if (
    record.projectionVersion !== 1 ||
    record.knowledgeId.trim().length === 0 ||
    record.topicKey.trim().length === 0 ||
    record.content.trim().length === 0 ||
    !/^[a-f0-9]{64}$/u.test(record.sourceDigest) ||
    (record.searchAliases !== undefined && (!Array.isArray(record.searchAliases) ||
      record.searchAliases.some((alias) => typeof alias !== "string" || alias.trim().length === 0 || alias.length > 256))) ||
    (record.searchExclusions !== undefined && (!Array.isArray(record.searchExclusions) ||
      record.searchExclusions.some((term) => typeof term !== "string" || term.trim().length < 2 || term.length > 64))) ||
    (record.retrievalMetadata !== undefined && (
      !validScope(record.retrievalMetadata.scope) || typeof record.retrievalMetadata.eligible !== "boolean" ||
      (record.retrievalMetadata.scopeId !== undefined && (typeof record.retrievalMetadata.scopeId !== "string" || record.retrievalMetadata.scopeId.trim().length === 0)) ||
      (record.retrievalMetadata.eligible && record.retrievalMetadata.scope !== "personal" && (typeof record.retrievalMetadata.scopeId !== "string" || record.retrievalMetadata.scopeId.trim().length === 0)) ||
      (record.retrievalMetadata.expiresAt !== undefined && (typeof record.retrievalMetadata.expiresAt !== "string" || !Number.isFinite(Date.parse(record.retrievalMetadata.expiresAt))))))
  ) {
    throw new Error("Knowledge projection is invalid.");
  }
  return {
    ...(record.discoveryProfile === undefined ? {} : { discoveryProfile: discoveryProfileSchema.parse(record.discoveryProfile) }),
    appliesWhen: [...record.appliesWhen],
    content: record.content.trim(),
    knowledgeId: record.knowledgeId.trim(),
    nonApplicability: [...record.nonApplicability],
    projectionVersion: 1,
    sourceDigest: record.sourceDigest,
    ...(record.searchAliases === undefined ? {} : { searchAliases: [...record.searchAliases] }),
    ...(record.searchExclusions === undefined ? {} : { searchExclusions: [...record.searchExclusions] }),
    ...(record.retrievalMetadata === undefined ? {} : { retrievalMetadata: { ...record.retrievalMetadata } }),
    topicKey: record.topicKey.trim(),
  };
};

const ftsQuery = (query: KnowledgeQuery): string | undefined => {
  const tokens = query.text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}_-]+/gu);
  if (tokens === null || tokens.length === 0) {
    return undefined;
  }
  return [...new Set(tokens)]
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(query.match === "any" ? " OR " : " AND ");
};

export interface SqliteFtsKnowledgeBackendOptions {
  readonly busyTimeoutMs?: number;
  readonly maxPendingReads?: number;
}

export class SqliteFtsKnowledgeBackend
implements KnowledgeBackend {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #maxPendingReads: number;
  readonly #pendingReadRequests =
    new Map<number, PendingReadRequest>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #nextReadRequestId = 0;
  #readWorker: Worker | undefined;
  #readWorkerError: Error | undefined;
  #readWorkerRecovery: Promise<void> | undefined;

  public constructor(
    path: string,
    options: SqliteFtsKnowledgeBackendOptions = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.#maxPendingReads = options.maxPendingReads ?? 8;
    if (!Number.isInteger(this.#maxPendingReads) || this.#maxPendingReads <= 0 || this.#maxPendingReads > 64) {
      throw new RangeError("Knowledge backend pending read limit must be between 1 and 64.");
    }
    if (
      !Number.isInteger(busyTimeoutMs) ||
      busyTimeoutMs <= 0
    ) {
      throw new RangeError(
        "Knowledge backend busy timeout must be positive.",
      );
    }
    if (path !== ":memory:") {
      mkdirSync(dirname(path), {
        recursive: true,
      });
    }
    this.#path = path;
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = ${busyTimeoutMs};

      CREATE TABLE IF NOT EXISTS knowledge_records (
        record_id INTEGER PRIMARY KEY,
        knowledge_id TEXT NOT NULL UNIQUE,
        projection_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        retrieval_scope TEXT,
        retrieval_eligible INTEGER,
        retrieval_expires_at INTEGER
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        knowledge_id UNINDEXED,
        topic_key,
        content,
        applies_when,
        non_applicability UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS knowledge_search_metadata (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    const searchVersion = this.#database.prepare(
      "SELECT value FROM knowledge_search_metadata WHERE name = 'format'",
    ).get();
    if (searchVersion?.value !== "3") {
      if (searchVersion !== undefined && !["1", "2"].includes(String(searchVersion.value))) {
        this.#database.close();
        throw new Error("Knowledge search format is unsupported.");
      }
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        const columns = this.#database.prepare("PRAGMA table_info(knowledge_records)").all();
        if (!columns.some((column) => column.name === "record_id")) {
          this.#database.exec(`
            CREATE TABLE knowledge_records_v3 (
              record_id INTEGER PRIMARY KEY, knowledge_id TEXT NOT NULL UNIQUE,
              projection_json TEXT NOT NULL, source_digest TEXT NOT NULL,
              retrieval_scope TEXT, retrieval_eligible INTEGER, retrieval_expires_at INTEGER
            ) STRICT;
            INSERT INTO knowledge_records_v3(record_id, knowledge_id, projection_json, source_digest)
              SELECT rowid, knowledge_id, projection_json, source_digest FROM knowledge_records;
            DROP TABLE knowledge_records;
            ALTER TABLE knowledge_records_v3 RENAME TO knowledge_records;
          `);
        }
        this.#database.exec(`
          DROP TABLE knowledge_fts;
          CREATE VIRTUAL TABLE knowledge_fts USING fts5(
            knowledge_id UNINDEXED, topic_key, content, applies_when, non_applicability UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
          );
        `);
        this.#rebuildFts();
        this.#database.prepare(
          "INSERT OR REPLACE INTO knowledge_search_metadata (name, value) VALUES ('format', '3')",
        ).run();
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        this.#database.close();
        throw error;
      }
    }
    this.#startReadWorker();
  }

  public close(): void {
    if (this.#closePromise !== undefined) {
      return;
    }
    this.#closed = true;
    const worker = this.#readWorker;
    this.#readWorker = undefined;
    this.#failPendingReads(
      new Error("Knowledge backend is closed."),
    );
    this.#database.close();
    this.#closePromise =
      Promise.all([worker?.terminate(), this.#readWorkerRecovery]).then(() => undefined);
  }

  public closeAsync(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    const worker = this.#readWorker;
    this.#readWorker = undefined;
    this.#failPendingReads(
      new Error("Knowledge backend is closed."),
    );
    this.#closePromise = (async () => {
      if (worker !== undefined) {
        await worker.terminate();
      }
      await this.#readWorkerRecovery;
      this.#database.close();
    })();
    return this.#closePromise;
  }

  #startReadWorker(): void {
    if (
      this.#closed ||
      this.#path === ":memory:" ||
      this.#readWorkerRecovery !== undefined ||
      this.#readWorker !== undefined
    ) {
      return;
    }
    this.#readWorkerError = undefined;
    const worker = new Worker(READ_WORKER_SOURCE, {
      eval: true,
      workerData: {
        path: this.#path,
      },
    });
    this.#readWorker = worker;
    worker.on(
      "message",
      (message: ReadWorkerResponse<unknown>) => {
        if (this.#readWorker !== worker) {
          return;
        }
        if (message.fatal === true) {
          this.#failPendingReads(
            new Error(
              message.error ??
              "Knowledge backend read worker failed.",
            ),
          );
          return;
        }
        if (message.requestId === undefined) {
          return;
        }
        const pending = this.#pendingReadRequests.get(
          message.requestId,
        );
        if (pending === undefined) {
          return;
        }
        this.#pendingReadRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (!message.ok || message.result === undefined) {
          pending.reject(
            new Error(
              message.error ??
              "Knowledge backend read failed.",
            ),
          );
          return;
        }
        pending.resolve(message.result);
      },
    );
    worker.on("error", (error) => {
      if (this.#readWorker !== worker) {
        return;
      }
      this.#failPendingReads(error);
    });
    worker.on("exit", (code) => {
      if (
        this.#readWorker === worker &&
        code !== 0 &&
        this.#readWorkerError === undefined
      ) {
        this.#failPendingReads(
          new Error(
            `Knowledge backend read worker exited with code ${code}.`,
          ),
        );
      }
    });
  }

  async #stopReadWorker(): Promise<void> {
    await this.#readWorkerRecovery;
    const worker = this.#readWorker;
    if (worker === undefined) {
      return;
    }
    if (this.#pendingReadRequests.size > 0) {
      throw new Error(
        "Knowledge backend write attempted during an active read.",
      );
    }
    this.#readWorker = undefined;
    await worker.terminate();
    this.#readWorkerError = undefined;
  }

  #cancelReadWorker(error: Error): void {
    const worker = this.#readWorker;
    this.#readWorker = undefined;
    this.#failPendingReads(error);
    if (worker === undefined) return;
    // Do not leave timed-out work ahead of later requests or accumulate replacement workers.
    this.#readWorkerRecovery = worker.terminate().then(() => {
      this.#readWorkerRecovery = undefined;
      this.#startReadWorker();
    }, (failure: unknown) => {
      this.#readWorkerRecovery = undefined;
      this.#readWorkerError = failure instanceof Error ? failure : new Error(String(failure));
    });
  }

  public get(id: string): Promise<KnowledgeRecord | undefined> {
    const row = this.#database
      .prepare(
        `SELECT projection_json
           FROM knowledge_records
          WHERE knowledge_id = ?`,
      )
      .get(id.trim()) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      ...validateProjection(
        JSON.parse(String(row.projection_json)) as KnowledgeProjection,
      ),
      score: 0,
    });
  }

  public health(): Promise<KnowledgeBackendHealth> {
    try {
      const quickCheck = this.#database
        .prepare("PRAGMA quick_check;")
        .get() as Readonly<Record<string, unknown>>;
      const count = this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM knowledge_records",
        )
        .get() as Readonly<Record<string, unknown>>;
      const fts5 = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_master
            WHERE type = 'table'
              AND name = 'knowledge_fts'`,
        )
        .get() as Readonly<Record<string, unknown>>;
      const result = {
        fts5Available: Number(fts5.count) === 1,
        quickCheck: String(Object.values(quickCheck)[0]),
        recordCount: Number(count.count),
      };
      return Promise.resolve({
        ...result,
        status:
          result.fts5Available && result.quickCheck === "ok"
            ? "healthy"
            : "unhealthy",
      });
    } catch {
      return Promise.resolve({
        fts5Available: false,
        quickCheck: "failed",
        recordCount: 0,
        status: "unhealthy",
      });
    }
  }

  public async healthWithTimeout(
    timeoutMs: number,
  ): Promise<KnowledgeBackendHealth> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "Knowledge backend timeout must be positive.",
      );
    }
    if (this.#path === ":memory:") {
      return this.health();
    }
    const result = await this.#runReadWorker<{
      readonly fts5Available: boolean;
      readonly quickCheck: string;
      readonly recordCount: number;
    }>({
      operation: "health",
      path: this.#path,
    }, timeoutMs);
    return {
      ...result,
      status:
        result.fts5Available && result.quickCheck === "ok"
          ? "healthy"
          : "unhealthy",
    };
  }

  public async index(
    records: readonly KnowledgeProjection[],
  ): Promise<void> {
    const parsed = records.map(validateProjection);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#upsertRecords(parsed);
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public async rebuild(
    snapshot: KnowledgeProjectionSnapshot,
  ): Promise<void> {
    const parsed = snapshot.records.map(validateProjection);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(`
          DELETE FROM knowledge_fts;
          DELETE FROM knowledge_records;
        `);
        this.#upsertRecords(parsed);
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public async remove(ids: readonly string[]): Promise<void> {
    const selected = normalizedIds(ids);
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        const removeRecord = this.#database.prepare(
          "DELETE FROM knowledge_records WHERE knowledge_id = ?",
        );
        const removeFts = this.#database.prepare(
          "DELETE FROM knowledge_fts WHERE rowid = (SELECT record_id FROM knowledge_records WHERE knowledge_id = ?)",
        );
        for (const id of selected) {
          removeFts.run(id);
          removeRecord.run(id);
        }
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public async synchronize(snapshot: KnowledgeProjectionSnapshot): Promise<void> {
    const parsed = snapshot.records.map(validateProjection);
    const retained = new Set(parsed.map((record) => record.knowledgeId));
    await this.#stopReadWorker();
    try {
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        const staleIds: string[] = [];
        for (const row of this.#database.prepare("SELECT knowledge_id FROM knowledge_records").iterate()) {
          if (!retained.has(String(row.knowledge_id))) staleIds.push(String(row.knowledge_id));
        }
        const removeFts = this.#database.prepare(
          "DELETE FROM knowledge_fts WHERE rowid = (SELECT record_id FROM knowledge_records WHERE knowledge_id = ?)",
        );
        const removeRecord = this.#database.prepare("DELETE FROM knowledge_records WHERE knowledge_id = ?");
        for (const id of staleIds) { removeFts.run(id); removeRecord.run(id); }
        this.#upsertRecords(parsed);
        this.#database.exec("COMMIT;");
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    } finally {
      this.#startReadWorker();
    }
  }

  public needsDiscoveryRefresh(): boolean {
    return this.#database.prepare(`SELECT 1 FROM knowledge_records WHERE
      coalesce(json_extract(projection_json, '$.discoveryProfile.vocabularyVersion'), json_extract(projection_json, '$.retrievalMetadata.discoveryVersion'),'') != ? LIMIT 1`)
      .get(DISCOVERY_VOCABULARY_VERSION) !== undefined;
  }

  public search(
    query: KnowledgeQuery,
  ): Promise<readonly KnowledgeRecord[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      return Promise.reject(
        new RangeError("Knowledge search limit must be positive."),
      );
    }
    const match = ftsQuery(query);
    if (match === undefined) {
      return Promise.resolve([]);
    }
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      return Promise.reject(
        new RangeError("Knowledge search offset must be non-negative."),
      );
    }
    const rows = this.#database
      .prepare(SEARCH_SQL)
      .all(match, ...searchFilter(query), query.limit, offset) as readonly Readonly<
      Record<string, unknown>
    >[];
    return Promise.resolve(
      rows.map((row) => ({
        ...validateProjection(
          JSON.parse(String(row.projection_json)) as KnowledgeProjection,
        ),
        score: -Number(row.rank),
      })),
    );
  }

  public async searchWithTimeout(
    query: KnowledgeQuery,
    timeoutMs: number,
  ): Promise<readonly KnowledgeRecord[]> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "Knowledge backend timeout must be positive.",
      );
    }
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new RangeError(
        "Knowledge search limit must be positive.",
      );
    }
    const match = ftsQuery(query);
    if (match === undefined) {
      return [];
    }
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(
        "Knowledge search offset must be non-negative.",
      );
    }
    if (this.#path === ":memory:") {
      return this.search(query);
    }
    const rows = await this.#runReadWorker<readonly {
      readonly projectionJson: string;
      readonly rank: number;
    }[]>({
      limit: query.limit,
      match,
      filter: searchFilter(query),
      offset,
      operation: "search",
      path: this.#path,
    }, timeoutMs);
    return rows.map((row) => ({
      ...validateProjection(
        JSON.parse(row.projectionJson) as KnowledgeProjection,
      ),
      score: -row.rank,
    }));
  }

  #failPendingReads(error: Error): void {
    this.#readWorkerError = error;
    for (const pending of this.#pendingReadRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingReadRequests.clear();
  }

  #runReadWorker<T>(
    input: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<T> {
    if (this.#pendingReadRequests.size >= this.#maxPendingReads) {
      return Promise.reject(new Error("Knowledge backend read queue is full."));
    }
    if (this.#readWorker === undefined) {
      return Promise.reject(
        new Error(
          "Knowledge backend read worker is unavailable.",
        ),
      );
    }
    if (this.#readWorkerError !== undefined) {
      return Promise.reject(this.#readWorkerError);
    }
    const requestId = this.#nextReadRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cancelReadWorker(new Error("Knowledge backend read timed out."));
      }, timeoutMs);
      this.#pendingReadRequests.set(requestId, {
        reject,
        resolve: (result) => resolve(result as T),
        timer,
      });
      this.#readWorker?.postMessage({
        ...input,
        requestId,
        timeoutMs,
      });
    });
  }

  #upsertRecords(records: readonly KnowledgeProjection[]): void {
    const existing = this.#database.prepare(
      "SELECT record_id, projection_json FROM knowledge_records WHERE knowledge_id = ?",
    );
    const upsert = this.#database.prepare(
      `INSERT INTO knowledge_records (
         knowledge_id,
         projection_json,
         source_digest, retrieval_scope, retrieval_eligible, retrieval_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(knowledge_id) DO UPDATE SET
         projection_json = excluded.projection_json,
         source_digest = excluded.source_digest,
         retrieval_scope = excluded.retrieval_scope,
         retrieval_eligible = excluded.retrieval_eligible,
         retrieval_expires_at = excluded.retrieval_expires_at
       RETURNING record_id`,
    );
    const remove = this.#database.prepare("DELETE FROM knowledge_fts WHERE rowid = ?");
    const insert = this.#database.prepare(
      `INSERT INTO knowledge_fts (rowid, knowledge_id, topic_key, content, applies_when, non_applicability)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const record of records) {
      const serialized = JSON.stringify(record);
      const current = existing.get(record.knowledgeId);
      if (current?.projection_json === serialized) continue;
      const metadata = record.retrievalMetadata;
      const row = upsert.get(
        record.knowledgeId, serialized, record.sourceDigest,
        metadata === undefined ? null : scopeKey(metadata.scope, metadata.scopeId),
        metadata === undefined ? null : Number(metadata.eligible),
        metadata?.expiresAt === undefined ? null : Date.parse(metadata.expiresAt),
      );
      if (row === undefined) throw new Error("Knowledge projection update returned no row.");
      if (current !== undefined) remove.run(row.record_id as number);
      if (metadata?.eligible === false) continue;
      insert.run(
        row.record_id as number, record.knowledgeId,
        searchableText([record.topicKey, ...(record.searchAliases ?? []), ...(record.discoveryProfile ? [discoverySearchText(record.discoveryProfile)] : [])].join("\n")),
        searchableText(record.content), searchableText(record.appliesWhen.join("\n")),
        record.nonApplicability.join("\n"),
      );
    }
  }

  #rebuildFts(): void {
    const insert = this.#database.prepare(
      `INSERT INTO knowledge_fts (
         rowid,
         knowledge_id,
         topic_key,
         content,
         applies_when,
         non_applicability
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const metadataUpdate = this.#database.prepare(
      "UPDATE knowledge_records SET retrieval_scope = ?, retrieval_eligible = ?, retrieval_expires_at = ? WHERE record_id = ?",
    );
    this.#database.exec("DELETE FROM knowledge_fts;");
    for (const row of this.#database.prepare("SELECT record_id, projection_json FROM knowledge_records ORDER BY record_id").iterate()) {
      const record = validateProjection(JSON.parse(String(row.projection_json)) as KnowledgeProjection);
      const metadata = record.retrievalMetadata;
      metadataUpdate.run(
        metadata === undefined ? null : scopeKey(metadata.scope, metadata.scopeId),
        metadata === undefined ? null : Number(metadata.eligible),
        metadata?.expiresAt === undefined ? null : Date.parse(metadata.expiresAt), row.record_id as number,
      );
      if (metadata?.eligible === false) continue;
      insert.run(
        row.record_id as number,
        record.knowledgeId,
        searchableText([record.topicKey, ...(record.searchAliases ?? []), ...(record.discoveryProfile ? [discoverySearchText(record.discoveryProfile)] : [])].join("\n")),
        searchableText(record.content),
        searchableText(record.appliesWhen.join("\n")),
        record.nonApplicability.join("\n"),
      );
    }
  }
}
