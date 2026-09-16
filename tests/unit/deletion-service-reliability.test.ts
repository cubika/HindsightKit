import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { DeletionService } from "@provenloop/host";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { WindowsNamedPipeLeaseProvider } from "@provenloop/platform-windows";

const queue = () => ({
  activeDeletionBarrier: async () => undefined,
  beginDeletionBarrier: async () => undefined,
  endDeletionBarrier: async () => undefined,
  blockIdentities: async () => undefined,
  deleteByIdentifiers: async () => ({
    identities: [],
    queueItemIds: [],
  }),
  remainingIdentifiers: async () => [],
  remainingIdentities: async () => [],
});

describe("deletion service resource safety", () => {
  it("keeps deletion pending until transient inference copies are removed", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    const captureQueue = queue();
    let barrier = false;
    let blocked = true;
    captureQueue.beginDeletionBarrier = async () => { barrier = true; };
    const request = { deletionId: `scratch-${randomUUID()}`, targetId: "scratch-session", targetType: "session" as const };
    const mutation = vi.spyOn(store, "deleteCanonicalTarget");
    const service = new DeletionService({ store, queue: captureQueue, recordEvidence: async () => undefined,
      transientCleanup: async () => {
        expect(barrier).toBe(true);
        expect(store.hasActiveDeletion()).toBe(true);
        if (blocked) throw new Error("Inference cleanup pending.");
      },
    });
    try {
      await expect(service.delete(request)).rejects.toThrow("Inference cleanup pending");
      expect(mutation).not.toHaveBeenCalled();
      expect(store.deletionOperation(request.deletionId)?.status).toBe("failed");
      blocked = false;
      await expect(service.delete(request)).resolves.toMatchObject({ operation: { status: "completed", attemptCount: 2 } });
    } finally { store.close(); }
  });
  it("marks an operation retryable if acquiring its first lease throws", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    const request = {
      deletionId: `first-lease-${randomUUID()}`,
      targetId: "first-lease-session",
      targetType: "session" as const,
    };
    const service = new DeletionService({
      store, queue: queue(), recordEvidence: async () => undefined,
    });
    const spy = vi.spyOn(WindowsNamedPipeLeaseProvider.prototype, "tryAcquire")
      .mockRejectedValueOnce(new Error("lease acquisition failed"));
    try {
      await expect(service.delete(request)).rejects.toThrow("lease acquisition failed");
      expect(store.deletionOperation(request.deletionId)?.status).toBe("failed");
      spy.mockRestore();
      await expect(service.delete(request)).resolves.toMatchObject({
        operation: { status: "completed", attemptCount: 2 },
      });
    } finally {
      spy.mockRestore();
      store.close();
    }
  });

  it("releases the operation lease and retries after projection lease acquisition fails", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    let fail = true;
    const service = new DeletionService({
      store,
      queue: queue(),
      recordEvidence: async () => undefined,
      knowledgeProjection: {
        acquireLease: async () => {
          if (fail) {
            fail = false;
            throw new Error("projection lease unavailable");
          }
          return { release: async () => undefined };
        },
        rebuild: async () => undefined,
        remainingIdentifiers: async () => [],
      },
    });
    const request = {
      deletionId: `resource-${randomUUID()}`,
      targetId: "resource-session",
      targetType: "session" as const,
    };
    try {
      await expect(service.delete(request)).rejects.toThrow(
        "projection lease unavailable",
      );
      expect(store.deletionOperation(request.deletionId)?.status).toBe("failed");
      await expect(service.delete(request)).resolves.toMatchObject({
        operation: { status: "completed", attemptCount: 2 },
      });
    } finally {
      store.close();
    }
  });

  it("releases the operation lease even when projection release fails", async () => {
    const store = new CanonicalSqliteStore(":memory:");
    let fail = true;
    const service = new DeletionService({
      store,
      queue: queue(),
      recordEvidence: async () => undefined,
      knowledgeProjection: {
        acquireLease: async () => ({
          release: async () => {
            if (fail) {
              fail = false;
              throw new Error("projection release failed");
            }
          },
        }),
        rebuild: async () => undefined,
        remainingIdentifiers: async () => [],
      },
    });
    const request = {
      deletionId: `release-${randomUUID()}`,
      targetId: "release-session",
      targetType: "session" as const,
    };
    try {
      await expect(service.delete(request)).rejects.toThrow("projection release failed");
      await expect(service.delete(request)).resolves.toMatchObject({
        operation: { status: "completed" },
      });
    } finally {
      store.close();
    }
  });
});
