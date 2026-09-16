import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginUpgradeMaintenance, CaptureQueueDeletionInProgressError, DeletedCaptureSourceError,
  isExtensionShutdownRequested, isRecordsResetPending, isUpgradeMaintenanceActive,
  recordsResetPendingPath, registerActiveExtension, WindowsCaptureQueue,
} from "@provenloop/platform-windows";

const roots: string[] = [];
const cutoff = "2026-09-10T08:00:00.000Z";
const now = () => new Date("2026-09-10T09:00:00.000Z");
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const scoped = relative(process.cwd(), root);
    if (scoped.startsWith("..") || scoped.includes(sep)) throw new Error("Unexpected reset test root.");
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".records-reset-queue-")); roots.push(root);
  const queueRoot = join(root, "queue");
  const queue = new WindowsCaptureQueue(queueRoot, { now });
  await queue.initialize();
  return { root, queueRoot, queue };
};
const event = (sourceEventId: string, timestamp = cutoff) => ({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sessionId: "session", sourceEventId,
  eventType: "prompt.submitted", trust: "user" as const, timestamp,
  content: { message: "Inspect current task state." },
});

describe("record reset queue boundary", () => {
  it("requires a capture barrier before changing queue data", async () => {
    const f = await fixture();
    await f.queue.enqueue(event("old"));
    await expect(f.queue.clearAllRecords(cutoff)).rejects.toThrow("active capture barrier");
    expect(await f.queue.list()).toHaveLength(1);
  });

  it("clears corrupt queue artifacts and tombstones while preserving the active barrier", async () => {
    const f = await fixture();
    await f.queue.enqueue(event("old"));
    await writeFile(join(f.queueRoot, "corrupt.json"), "{broken");
    await mkdir(join(f.queueRoot, ".quarantine"));
    await writeFile(join(f.queueRoot, ".quarantine", "bad.json"), "malformed source text");
    await f.queue.blockIdentities([{ identifier: "session", identityType: "session" }]);
    await f.queue.beginDeletionBarrier("reset-1");

    expect(await f.queue.clearAllRecords(cutoff)).toEqual({ clearedItems: 2 });
    expect(await f.queue.activeDeletionBarrier()).toBe("reset-1");
    expect(await f.queue.list()).toEqual([]);
    expect(await readdir(join(f.queueRoot, ".deletion"))).toEqual(["active"]);
    expect(await readFile(join(f.queueRoot, ".records-reset-cutoff"), "utf8")).toBe(cutoff + "\n");
    await expect(f.queue.enqueue(event("blocked", "2026-09-10T08:30:00.000Z"))).rejects.toBeInstanceOf(CaptureQueueDeletionInProgressError);
    await f.queue.endDeletionBarrier("reset-1");
    await expect(f.queue.enqueue(event("new", "2026-09-10T08:30:00.000Z"))).resolves.toMatchObject({ state: "pending" });
  });

  it("prevents timestamp replay across old instances and process restart", async () => {
    const f = await fixture();
    const stale = new WindowsCaptureQueue(f.queueRoot, { now }); await stale.initialize();
    await f.queue.beginDeletionBarrier("reset-2");
    await f.queue.clearAllRecords(cutoff);
    await f.queue.endDeletionBarrier("reset-2");
    const restarted = new WindowsCaptureQueue(f.queueRoot, { now }); await restarted.initialize();
    for (const queue of [f.queue, stale, restarted]) {
      await expect(queue.enqueue(event("old"))).rejects.toBeInstanceOf(DeletedCaptureSourceError);
      expect(await queue.enqueueIfSourceAbsent(event("old"))).toEqual({ status: "duplicate" });
    }
    await expect(restarted.enqueue(event("after", "2026-09-10T08:00:00.001Z"))).resolves.toMatchObject({ state: "pending" });
  });

  it("clears acknowledged, retry, dead-letter and claimed items without restoring stale claims", async () => {
    const f = await fixture();
    for (const state of ["acknowledged", "retry", "dead-letter", "claimed"]) {
      const item = await f.queue.enqueue(event(state));
      const fields = state === "acknowledged" ? { acknowledgedAt: now().toISOString() }
        : state === "retry" ? { lastError: "retry", nextAttemptAt: "2026-09-10T10:00:00Z" }
          : state === "dead-letter" ? { lastError: "unprocessed" }
            : { claimedAt: now().toISOString(), claimExpiresAt: "2026-09-10T10:00:00Z", claimOwnerId: "worker" };
      await writeFile(join(f.queueRoot, item.queueItemId + ".json"), JSON.stringify({ ...item, state, ...fields }));
      if (state === "claimed") {
        const claim = { queueItemId: item.queueItemId, attemptCount: item.attemptCount, claimOwnerId: "worker" };
        await f.queue.beginDeletionBarrier("reset-claims");
        expect(await f.queue.clearAllRecords(cutoff)).toEqual({ clearedItems: 4 });
        await expect(f.queue.acknowledge(claim)).rejects.toThrow();
        expect(await f.queue.list()).toEqual([]);
        await f.queue.endDeletionBarrier("reset-claims");
        expect(await f.queue.claimNext("new-worker")).toBeUndefined();
      }
    }
  });

  it("resumes the same reset and refuses to reduce its durable cutoff", async () => {
    const f = await fixture(); await f.queue.beginDeletionBarrier("reset-3");
    await f.queue.clearAllRecords(cutoff);
    await writeFile(join(f.queueRoot, ".source-stale.idx"), "crash remnant");
    expect(await f.queue.clearAllRecords(cutoff)).toEqual({ clearedItems: 0 });
    await expect(f.queue.clearAllRecords("2026-09-10T07:00:00Z")).rejects.toThrow("backwards");
    expect(await f.queue.activeDeletionBarrier()).toBe("reset-3");
    await f.queue.endDeletionBarrier("reset-3");
  });

  it("refuses linked child directories before touching outside data", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "unchanged");
    const linked = join(f.queueRoot, "linked");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await f.queue.beginDeletionBarrier("reset-4");
    try {
      await expect(f.queue.clearAllRecords(cutoff)).rejects.toThrow("indirect child paths");
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("unchanged");
    } finally { await unlink(linked); await f.queue.endDeletionBarrier("reset-4"); }
  });

  it("keeps malformed cutoff markers fail-closed", async () => {
    const f = await fixture();
    await writeFile(join(f.queueRoot, ".records-reset-cutoff"), "not-a-time");
    await expect(f.queue.enqueue(event("new", "2026-09-10T08:30:00Z"))).rejects.toThrow("Invalid queue reset cutoff");
  });
});

describe("persistent reset maintenance", () => {
  it("blocks runtime after owner exit and still permits explicit recovery ownership", async () => {
    const f = await fixture(); await mkdir(join(f.root, "data"));
    expect(await isRecordsResetPending(f.root)).toBe(false);
    await writeFile(recordsResetPendingPath(f.root), "incomplete journal");
    expect(await isRecordsResetPending(f.root)).toBe(true);
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(true);
    expect(await isExtensionShutdownRequested(f.root)).toBe(true);
    await expect(registerActiveExtension(f.root, "during-reset")).rejects.toThrow("shutdown is in progress");
    await expect(f.queue.enqueue(event("during-reset", "2026-09-10T08:30:00Z"))).rejects.toBeInstanceOf(CaptureQueueDeletionInProgressError);
    await expect(f.queue.enqueueIfSourceAbsent(event("replay-during-reset"))).rejects.toBeInstanceOf(CaptureQueueDeletionInProgressError);
    const maintenance = await beginUpgradeMaintenance(f.root);
    await maintenance.release();
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(true);
    await f.queue.beginDeletionBarrier("recover-after-journal");
    await f.queue.clearAllRecords(cutoff);
    await f.queue.endDeletionBarrier("recover-after-journal");
    await unlink(recordsResetPendingPath(f.root));
    expect(await isUpgradeMaintenanceActive(f.root)).toBe(false);
    expect(await isExtensionShutdownRequested(f.root)).toBe(false);
    const extension = await registerActiveExtension(f.root, "after-reset"); await extension.release();
    await expect(f.queue.enqueue(event("after-reset", "2026-09-10T08:30:00Z"))).resolves.toMatchObject({ state: "pending" });
    expect(await f.queue.enqueueIfSourceAbsent(event("pre-reset"))).toEqual({ status: "duplicate" });
  });
});
