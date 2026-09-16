import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeletionService } from "@provenloop/host";
import { WindowsCaptureQueue, CaptureQueueDeletionInProgressError } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const scoped = relative(process.cwd(), root);
    if (scoped.startsWith("..") || scoped.includes(sep)) throw new Error("Unexpected test cleanup directory.");
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".deletion-preflight-"));
  roots.push(root);
  const queue = new WindowsCaptureQueue(join(root, "queue"));
  await queue.initialize();
  const store = new CanonicalSqliteStore(":memory:");
  const service = new DeletionService({ store, queue, recordEvidence: async () => undefined });
  return { store, queue, service };
};
const input = (sourceEventId: string) => ({
  adapter: "copilot-cli", adapterVersion: "1.0.84-1", sessionId: "resumed-session",
  sourceEventId, eventType: "prompt.submitted", timestamp: "2026-09-10T08:00:00.000Z", trust: "user" as const,
  content: { message: "Continue the identity investigation." },
});

describe("deletion preflight under the capture barrier", () => {
  it("rejects queued session activity before creating any deletion operation", async () => {
    const f = await fixture();
    const deletionId = "retention-" + randomUUID();
    const queued = await f.queue.enqueue(input("recent"));
    const begin = vi.spyOn(f.store, "beginDeletion");
    try {
      await expect(f.service.delete({
        deletionId, targetType: "session", targetId: "resumed-session",
        preflight: async () => {
          expect(await f.queue.activeDeletionBarrier()).toBe(deletionId);
          expect(f.store.hasActiveDeletion()).toBe(false);
          const records = await f.queue.list();
          if (records.some((item) => item.state !== "acknowledged" && item.envelope.event.sessionId === "resumed-session")) {
            throw new Error("Session has unprocessed captured activity.");
          }
        },
      })).rejects.toThrow("unprocessed captured activity");
      expect(begin).not.toHaveBeenCalled();
      expect(f.store.deletionOperation(deletionId)).toBeUndefined();
      expect(f.store.hasActiveDeletion()).toBe(false);
      expect(await f.queue.activeDeletionBarrier()).toBeUndefined();
      expect(await f.queue.get(queued.queueItemId)).toEqual(queued);
      expect(f.store.ingestQueueItem(queued).status).toBe("stored");
      await expect(f.queue.enqueue(input("after-rejection"))).resolves.toMatchObject({ state: "pending" });
    } finally { f.store.close(); }
  });

  it("blocks new capture and competing deletion while the guard is pending", async () => {
    const f = await fixture();
    const deletionId = "retention-" + randomUUID();
    const competing = new DeletionService({ store: f.store, queue: f.queue, recordEvidence: async () => undefined });
    try {
      await expect(f.service.delete({
        deletionId, targetType: "session", targetId: "resumed-session",
        preflight: async () => {
          await expect(f.queue.enqueue(input("during-guard"))).rejects.toBeInstanceOf(CaptureQueueDeletionInProgressError);
          await expect(competing.delete({ targetType: "session", targetId: "other-session" })).rejects.toThrow("already executing");
          expect(await f.queue.activeDeletionBarrier()).toBe(deletionId);
          throw new Error("Cancel the reviewed cleanup.");
        },
      })).rejects.toThrow("Cancel the reviewed cleanup");
      expect(f.store.hasActiveDeletion()).toBe(false);
      expect(await f.queue.list()).toEqual([]);
      expect(await f.queue.activeDeletionBarrier()).toBeUndefined();
    } finally { f.store.close(); }
  });

  it("keeps the same generated barrier through successful deletion", async () => {
    const f = await fixture();
    let barrierId: string | undefined;
    const original = await f.queue.enqueue(input("original"));
    f.store.ingestQueueItem(original);
    try {
      const result = await f.service.delete({
        targetType: "session", targetId: "resumed-session",
        preflight: async () => {
          barrierId = await f.queue.activeDeletionBarrier();
          expect(barrierId).toBeDefined();
          expect(f.store.hasActiveDeletion()).toBe(false);
        },
      });
      expect(result.operation.deletionId).toBe(barrierId);
      expect(result.operation.status).toBe("completed");
      expect(f.store.rawEvents()).toEqual([]);
      expect(await f.queue.list()).toEqual([]);
      expect(await f.queue.activeDeletionBarrier()).toBeUndefined();
    } finally { f.store.close(); }
  });

  it("releases the preflight barrier if canonical validation rejects the target", async () => {
    const f = await fixture();
    const deletionId = "retention-" + randomUUID();
    try {
      await expect(f.service.delete({ deletionId, targetType: "session", targetId: "", preflight: async () => undefined })).rejects.toThrow();
      expect(f.store.deletionOperation(deletionId)).toBeUndefined();
      expect(await f.queue.activeDeletionBarrier()).toBeUndefined();
      await expect(f.queue.enqueue(input("valid-after-rejection"))).resolves.toMatchObject({ state: "pending" });
    } finally { f.store.close(); }
  });
});
