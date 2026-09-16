import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { KnowledgeControlService } from "@provenloop/host";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { isUpgradeMaintenanceActive, registerActiveExtension, recordsResetPendingPath, resolveWindowsProvenLoopPaths, WindowsCaptureQueue } from "@provenloop/platform-windows";
import { previewRecordsReset, resetAllRecords } from "../../packages/cli/src/reset-records.js";
import { runCli } from "../../packages/cli/src/run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { const tail = relative(process.cwd(), root); assert(tail && !isAbsolute(tail) && !tail.startsWith("..")); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
const input = { adapter: "copilot-cli", adapterVersion: "1.0.84-1", sessionId: "old-session", sourceEventId: "old-event",
  repoId: "repo", worktree: "C:/repo", eventType: "prompt.submitted", trust: "user" as const, timestamp: "2020-01-01T00:00:00.000Z", content: { message: "Old captured material" } };
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".reset-records-test-")); roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  for (const path of [paths.data, paths.integration, paths.evaluation, paths.logs, paths.artifacts, join(paths.data, "backups", "plugin-refresh")]) await mkdir(path, { recursive: true });
  const marker = JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root });
  const settings = JSON.stringify({ installed: true, automaticLearning: { enabled: false }, arbitrarySetting: "preserve exact bytes" });
  await writeFile(paths.rootMarker, marker); await writeFile(paths.adapterState, settings);
  await writeFile(join(paths.integration, "extension.mjs"), "installed plugin locator");
  await writeFile(join(paths.evaluation, "report.json"), "old evaluation");
  await writeFile(join(paths.logs, "old.log"), "old log");
  await writeFile(join(paths.artifacts, "old.md"), "old artifact");
  await writeFile(join(paths.data, "backups", "pre-upgrade-old.db"), "old database backup");
  await writeFile(join(paths.data, "backups", "plugin-refresh", "settings.json"), "plugin configuration backup");
  const queue = new WindowsCaptureQueue(paths.queue); await queue.initialize();
  const item = await queue.enqueue(input);
  const store = new CanonicalSqliteStore(paths.database);
  const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
  try {
    store.ingestQueueItem(item);
    await new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined } })
      .remember({ content: "Retained old rule", appliesWhen: ["Old work"], scope: "repository", scopeId: "repo" });
    await new KnowledgeProjectionManager({ store, backend }).rebuild();
  } finally { store.close(); await backend.closeAsync(); }
  return { root, paths, queue, marker, settings };
};

describe("clear records while preserving installation", () => {
  it("previews without mutation and requires explicit confirmation", async () => {
    const f = await fixture();
    const before = await previewRecordsReset(f.root);
    expect(before.counts).toMatchObject({ events: 1, knowledge: 1 });
    await expect(resetAllRecords({ dataRoot: f.root, confirmed: false })).rejects.toThrow("confirmation");
    await expect(resetAllRecords({ dataRoot: f.root, confirmed: true, confirmationText: "wrong" })).rejects.toThrow("confirmation");
    expect(await previewRecordsReset(f.root)).toEqual(before);
    expect(await f.queue.list()).toHaveLength(1);
  });

  it("clears database, queue and artifacts, preserves configuration, and rejects old replay", async () => {
    const f = await fixture();
    const result = await resetAllRecords({ dataRoot: f.root, confirmed: true, confirmationText: "CLEAR" });
    expect(result).toMatchObject({ status: "cleared", counts: { events: 1, knowledge: 1 }, queueItems: 1 });
    expect((await previewRecordsReset(f.root)).counts.records).toBe(0);
    expect(await f.queue.list()).toEqual([]);
    expect(await readFile(f.paths.adapterState, "utf8")).toBe(f.settings);
    expect(await readFile(f.paths.rootMarker, "utf8")).toBe(f.marker);
    expect(await readFile(join(f.paths.integration, "extension.mjs"), "utf8")).toBe("installed plugin locator");
    expect(await readFile(join(f.paths.data, "backups", "plugin-refresh", "settings.json"), "utf8")).toBe("plugin configuration backup");
    expect(await readdir(join(f.paths.data, "backups"))).toEqual(["plugin-refresh"]);
    for (const path of [f.paths.evaluation, f.paths.logs, f.paths.artifacts]) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.queue.enqueue(input)).rejects.toThrow();
    const store = new CanonicalSqliteStore(f.paths.database);
    const backend = new SqliteFtsKnowledgeBackend(f.paths.knowledgeDatabase);
    try {
      const envelope = createCaptureEnvelope(input);
      expect(store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "replay", state: "pending", attemptCount: 0, failureCount: 0,
        createdAt: result.cutoff, updatedAt: result.cutoff, envelope }))).toMatchObject({ status: "duplicate" });
      expect(store.previewRecordsReset().records).toBe(0);
      expect((await backend.health()).recordCount).toBe(0);
      const fresh = await f.queue.enqueue({ ...input, sourceEventId: "fresh", sessionId: "new-session", timestamp: new Date(Date.parse(result.cutoff) + 1000).toISOString() });
      expect(store.ingestQueueItem(fresh)).toMatchObject({ status: "stored" });
    } finally { store.close(); await backend.closeAsync(); }
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(false);
  });

  it.each(["after_journal", "after_database", "after_queue"] as const)("recovers a partial reset at %s without reopening capture", async (stage) => {
    const f = await fixture();
    await expect(resetAllRecords({ dataRoot: f.root, confirmed: true, faultInjector: (current) => { if (stage === current) throw new Error("interrupted"); } })).rejects.toThrow("cleanup is paused");
    const pending = JSON.parse(await readFile(recordsResetPendingPath(f.root), "utf8"));
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(true);
    await expect(registerActiveExtension(f.root, "new-during-reset")).rejects.toThrow("shutdown");
    await expect(f.queue.enqueue({ ...input, sourceEventId: "new-during-reset", timestamp: new Date().toISOString() })).rejects.toThrow();
    expect(await readFile(f.paths.adapterState, "utf8")).toBe(f.settings);
    expect(await resetAllRecords({ dataRoot: f.root, confirmed: true })).toMatchObject({ status: "cleared", cutoff: pending.cutoff });
    expect((await previewRecordsReset(f.root)).counts.records).toBe(0);
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(false);
  });

  it("leaves all records intact if an active extension does not stop", async () => {
    const f = await fixture();
    const extension = await registerActiveExtension(f.root, "busy-session");
    try { await expect(resetAllRecords({ dataRoot: f.root, confirmed: true, drainTimeoutMs: 150 })).rejects.toThrow("has not stopped"); }
    finally { await extension.release(); }
    expect((await previewRecordsReset(f.root)).counts.events).toBe(1);
    expect(await f.queue.list()).toHaveLength(1);
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(false);
  });

  it("refuses linked record directories before deleting any data", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(process.cwd(), ".reset-outside-test-")); roots.push(outside);
    await writeFile(join(outside, "keep.txt"), "untouched");
    await symlink(outside, join(f.paths.logs, "linked"), "junction");
    await expect(resetAllRecords({ dataRoot: f.root, confirmed: true })).rejects.toThrow("linked");
    expect((await previewRecordsReset(f.root)).counts.events).toBe(1);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("untouched");
  });

  it("rejects an unowned root without touching its database or configuration", async () => {
    const f = await fixture();
    const before = await readFile(f.paths.database);
    await writeFile(f.paths.rootMarker, JSON.stringify({ product: "Unrelated", schemaVersion: 1, root: f.root }));
    await expect(resetAllRecords({ dataRoot: f.root, confirmed: true })).rejects.toThrow("ownership marker");
    expect(await readFile(f.paths.database)).toEqual(before);
    expect(await readFile(f.paths.adapterState, "utf8")).toBe(f.settings);
    expect(await f.queue.list()).toHaveLength(1);
  });

  it("exposes a preview and confirmed CLI action for the selected root", async () => {
    const f = await fixture(); const logs: string[] = []; const errors: string[] = [];
    const io = { log: (value: string) => { logs.push(value); }, error: (value: string) => { errors.push(value); } };
    expect(await runCli(["records", "clear", "--data-root", f.root], io)).toBe(0);
    expect((await previewRecordsReset(f.root)).counts.events).toBe(1);
    expect(await runCli(["records", "clear", "--confirm", "--data-root", f.root], io)).toBe(0);
    expect(errors).toEqual([]); expect(logs.join("\n")).toContain("configuration were preserved");
    expect((await previewRecordsReset(f.root)).counts.records).toBe(0);
  });
});
