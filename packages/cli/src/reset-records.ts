import { randomUUID } from "node:crypto";
import { access, lstat, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertCopilotAdapterDataRoot, cancelLearningScratch } from "@provenloop/copilot-adapter";
import { beginExtensionShutdown, beginUpgradeMaintenance, recordsResetPendingPath, resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths, waitForActiveExtensionsToStop, waitForMaintenanceLease, WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider, type ProcessLease } from "@provenloop/platform-windows";
import { CanonicalSqliteStore, DatabaseSync } from "@provenloop/storage-sqlite";
import { SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

export interface RecordsResetCounts { events: number; knowledge: number; episodes: number; jobs: number; usage: number; records: number }
interface ResetJournal { schemaVersion: 1; operationId: string; cutoff: string; counts: RecordsResetCounts }
export interface ResetRecordsOptions {
  readonly dataRoot: string;
  readonly confirmed: boolean;
  readonly confirmationText?: string;
  readonly drainTimeoutMs?: number;
  /** Test-only fault injection at durable recovery boundaries. */
  readonly faultInjector?: (stage: "after_journal" | "after_database" | "after_queue") => void;
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const within = (root: string, path: string): boolean => { const tail = relative(root, path); return tail !== "" && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };

/** Reject links before traversing owned record directories, including nested junctions. */
const assertOwnedPath = async (root: string, path: string, recurse = false): Promise<void> => {
  const absolute = resolve(path);
  if (!within(root, absolute)) throw new Error("Record cleanup target escapes the owned data root.");
  const tail = relative(root, absolute).split(/[\\/]/u);
  let current = root;
  for (const part of tail) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !within(root, await realpath(current))) throw new Error("Record cleanup refuses linked paths.");
    } catch (error) { if (absent(error)) return; throw error; }
  }
  if (recurse && (await lstat(absolute)).isDirectory()) {
    for (const entry of await readdir(absolute)) await assertOwnedPath(root, join(absolute, entry), true);
  }
};

const safeRoot = async (dataRoot: string): Promise<ReturnType<typeof resolveWindowsProvenLoopPaths>> => {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  if ((await lstat(paths.root)).isSymbolicLink() || resolve(await realpath(paths.root)).toLowerCase() !== paths.root.toLowerCase()) {
    throw new Error("Record cleanup requires a direct, owned data root.");
  }
  await assertOwnedPath(paths.root, paths.rootMarker);
  await assertOwnedPath(paths.root, paths.database);
  await assertOwnedPath(paths.root, paths.adapterState);
  await access(paths.database);
  return paths;
};

const readJournal = async (path: string): Promise<ResetJournal | undefined> => {
  let value: unknown;
  try {
    const file = await open(path, "r");
    try { if ((await file.stat()).size > 8192) throw new Error("Invalid records reset journal."); value = JSON.parse(await file.readFile("utf8")); }
    finally { await file.close(); }
  } catch (error) { if (absent(error)) return undefined; throw error; }
  const journal = value as ResetJournal;
  if (!journal || journal.schemaVersion !== 1 || !/^records-reset-[a-f0-9-]+$/u.test(journal.operationId) ||
      !Number.isFinite(Date.parse(journal.cutoff)) || new Date(journal.cutoff).toISOString() !== journal.cutoff ||
      !journal.counts || ["events", "knowledge", "episodes", "jobs", "usage", "records"].some((key) =>
        !Number.isSafeInteger(journal.counts[key as keyof RecordsResetCounts]) || journal.counts[key as keyof RecordsResetCounts] < 0)) {
    throw new Error("Invalid records reset journal; no records were changed.");
  }
  return journal;
};

export const previewRecordsReset = async (dataRoot: string): Promise<{ dataRoot: string; counts: RecordsResetCounts; pending: boolean }> => {
  const paths = await safeRoot(dataRoot);
  const database = new DatabaseSync(paths.database, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','record_reset')").all().map((row) => String(row.name));
    const countsByTable = new Map(tables.map((table) => {
      if (!/^[a-z0-9_]+$/u.test(table)) throw new Error("Unexpected database table.");
      return [table, Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)] as const;
    }));
    return { dataRoot: paths.root, pending: (await readJournal(recordsResetPendingPath(paths.root))) !== undefined, counts: {
      events: countsByTable.get("raw_events") ?? 0, knowledge: countsByTable.get("knowledge_candidates") ?? 0,
      episodes: countsByTable.get("work_episodes") ?? 0, jobs: countsByTable.get("learning_jobs") ?? 0,
      usage: countsByTable.get("context_use_records") ?? 0, records: [...countsByTable.values()].reduce((sum, count) => sum + count, 0),
    } };
  } finally { database.close(); }
};

/** Clear this installation's records while leaving settings, registration and host history intact. */
export const resetAllRecords = async (options: ResetRecordsOptions): Promise<{ status: "cleared"; cutoff: string; counts: RecordsResetCounts; queueItems: number; restartRequired: true }> => {
  if (!options.confirmed || (options.confirmationText !== undefined && options.confirmationText !== "CLEAR")) throw new Error("Clearing all records requires explicit confirmation.");
  const timeout = options.drainTimeoutMs ?? 15_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Invalid records reset drain timeout.");
  const paths = await safeRoot(options.dataRoot);
  const leases: ProcessLease[] = [];
  let shutdown: Awaited<ReturnType<typeof beginExtensionShutdown>> | undefined;
  let journal: ResetJournal | undefined;
  let committed = false;
  let store: CanonicalSqliteStore | undefined;
  let backend: SqliteFtsKnowledgeBackend | undefined;
  const pendingPath = recordsResetPendingPath(paths.root);
  try {
    const acquire = async (root: string, purpose: string) => {
      const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(root, purpose)).tryAcquire();
      if (!lease) throw new Error(`Records cannot be cleared while ${purpose} is busy. Retry when it finishes.`);
      leases.push(lease);
    };
    await acquire(paths.root, "adapter-state");
    leases.push(await beginUpgradeMaintenance(paths.root));
    const deadline = Date.now() + timeout;
    for (const purpose of ["learning-inference", "capture-worker", "observations", "knowledge-projection"]) {
      leases.push(await waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, purpose)), deadline, purpose));
    }
    await acquire(dirname(paths.database), "canonical-restore");
    await assertOwnedPath(paths.root, join(paths.data, "extension-sessions"), true);
    await assertOwnedPath(paths.root, join(paths.data, "extension-shutdown-request.json"));
    shutdown = await beginExtensionShutdown(paths.root);
    await waitForActiveExtensionsToStop(paths.root, Math.max(1, deadline - Date.now()));
    const cleanup = [paths.artifacts, paths.evaluation, paths.logs, paths.temporary, paths.internalSessions,
      join(paths.data, "capture-observations"), join(paths.data, "session-context"), join(paths.data, "observation-cursor.json"),
      paths.heartbeat, paths.projectionDirty];
    // Canonical backup snapshots contain records; plugin/configuration backups are retained.
    const backups = join(paths.data, "backups");
    await assertOwnedPath(paths.root, backups);
    try { for (const entry of await readdir(backups)) if (/^pre-upgrade-.*\.db(?:\..*)?$/u.test(entry)) cleanup.push(join(backups, entry)); }
    catch (error) { if (!absent(error)) throw error; }
    for (const target of [...cleanup, paths.queue, paths.knowledgeDatabase, `${paths.knowledgeDatabase}-wal`, `${paths.knowledgeDatabase}-shm`, `${paths.database}-wal`, `${paths.database}-shm`,
      `${paths.database}.deletion.key`, `${paths.database}.restore.generation`, pendingPath]) await assertOwnedPath(paths.root, target, true);
    journal = await readJournal(pendingPath);
    store = new CanonicalSqliteStore(paths.database, { allowSchemaMigration: true, allowRecordsReset: true });
    if (!journal && store.hasActiveDeletion()) throw new Error("Complete the pending deletion before clearing all records.");
    if (!journal) {
      journal = { schemaVersion: 1, operationId: `records-reset-${randomUUID()}`, cutoff: new Date().toISOString(), counts: store.previewRecordsReset() };
      const temporary = `${pendingPath}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx");
      try {
        try { await handle.writeFile(JSON.stringify(journal) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, pendingPath);
      } finally { await unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; }); }
    }
    options.faultInjector?.("after_journal");
    const queue = new WindowsCaptureQueue(paths.queue); await queue.initialize();
    await queue.beginDeletionBarrier(journal.operationId);
    await cancelLearningScratch(paths.temporary);
    store.clearAllRecords(journal.cutoff);
    options.faultInjector?.("after_database");
    const queueResult = await queue.clearAllRecords(journal.cutoff);
    options.faultInjector?.("after_queue");
    backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
    await backend.rebuild({ records: [] });
    const backendHealth = await backend.health();
    if (backendHealth.recordCount !== 0 || store.previewRecordsReset().records !== 0 || (await queue.list()).length !== 0) throw new Error("Record cleanup verification failed.");
    await backend.closeAsync(); backend = undefined;
    for (const target of cleanup) { await assertOwnedPath(paths.root, target, true); await rm(target, { recursive: true, force: true }); }
    await queue.endDeletionBarrier(journal.operationId);
    await unlink(pendingPath);
    committed = true;
    return { status: "cleared", cutoff: journal.cutoff, counts: journal.counts, queueItems: queueResult.clearedItems, restartRequired: true };
  } catch (error) {
    if (journal && !committed) throw new Error("Record cleanup is paused. Run the same clear action again to finish; capture remains blocked. " + (error instanceof Error ? error.message : String(error)), { cause: error });
    throw error;
  } finally {
    try { await backend?.closeAsync(); store?.close(); } finally {
      try { await shutdown?.cancel(); } finally { for (const lease of leases.reverse()) await lease.release(); }
    }
  }
};
