import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultCopilotAdapterState, writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import { DeletionService } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths, WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { runCaptureWorkerOnce } from "../../packages/cli/src/run-worker.js";

const roots: string[] = [];
const timestamp = "2026-09-01T00:00:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-worker-scale-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await mkdir(paths.backends);
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root }));
  const initial = createDefaultCopilotAdapterState(new Date(timestamp));
  await writeCopilotAdapterState(paths.adapterState, {
    ...initial, installed: true, pluginEnabled: true, pluginInstalled: true, marketplaceRegistered: true,
    capabilities: {
      ...initial.capabilities, capture: { enabled: true }, worker: { enabled: true },
      correction_learning: { enabled: true }, retrieval: { enabled: true },
    },
  });
  new CanonicalSqliteStore(paths.database).close();
  const queue = new WindowsCaptureQueue(paths.queue);
  await queue.initialize();
  return { paths, queue };
};

const input = (sessionId: string, sourceEventId: string, repoId: string, message: string) => ({
  adapter: "copilot-cli", adapterVersion: "1.0.82-0", sessionId, sourceEventId, repoId,
  eventType: "prompt.submitted", trust: "user" as const, timestamp, content: { message },
});

const run = (dataRoot: string) => runCaptureWorkerOnce({
  dataRoot, admission: () => ({ allowed: true, reasons: [] }),
  lease: { tryAcquire: async () => ({ release: async () => undefined }) },
  now: () => new Date(timestamp),
});

describe("production capture worker scale", () => {
  it("shares one source read across enabled projectors and persists only useful associations", async () => {
    const { paths, queue } = await fixture();
    const sourceRead = vi.spyOn(CanonicalSqliteStore.prototype, "episodeSourceEnvelopes");
    const first = await queue.enqueue(input("work-a", "first", "repo-shared", "Resolve issue #42"));
    const continued = await queue.enqueue({
      ...input("work-b", "continued", "repo-shared", "Continue issue #42"),
      timestamp: "2026-12-01T00:00:00.000Z",
    });
    const independent = await queue.enqueue(input("separate", "separate", "repo-independent", "Inspect a separate project"));
    expect(await run(paths.root)).toMatchObject({ status: "completed", stored: 3, failed: 0 });
    expect(sourceRead).toHaveBeenCalledTimes(1);
    const store = new CanonicalSqliteStore(paths.database);
    try {
      expect(store.workEpisodes()).toHaveLength(2);
      expect(store.episodeAssociations()).toHaveLength(1);
      expect(store.episodeAssociations()[0]).toMatchObject({
        leftSessionId: "work-a", rightSessionId: "work-b", status: "associated",
      });
      for (const item of [first, continued, independent]) {
        expect(store.rawEvent(item.envelope.deduplicationKey)).toBeDefined();
      }
    } finally { store.close(); }
    await expect(access(paths.projectionDirty)).rejects.toMatchObject({ code: "ENOENT" });
    sourceRead.mockClear();
    expect(await run(paths.root)).toMatchObject({ status: "completed", stored: 0, failed: 0 });
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it("replaces a deleted association witness with surviving evidence and blocks replay", async () => {
    const { paths, queue } = await fixture();
    const first = await queue.enqueue(input("work-a", "first-witness", "repo-shared", "Resolve issue #42"));
    const fallback = await queue.enqueue({
      ...input("work-a", "fallback-witness", "repo-shared", "Finish issue #42"),
      timestamp: "2026-09-01T00:00:01.000Z",
    });
    await queue.enqueue(input("work-b", "other-witness", "repo-shared", "Review issue #42"));
    expect(await run(paths.root)).toMatchObject({ status: "completed", stored: 3, failed: 0 });
    const store = new CanonicalSqliteStore(paths.database);
    try {
      const association = store.episodeAssociations()[0];
      assert(association);
      expect(association.evidence.find((item) => item.signal === "issue")?.sourceEventIds)
        .toContain(first.envelope.event.eventId);
      const deleted = await new DeletionService({
        store, queue, recordEvidence: async () => undefined,
      }).delete({ targetType: "source", targetId: first.envelope.event.eventId });
      expect(deleted.gate.status).toBe("pass");
      expect(store.rawEvent(first.envelope.deduplicationKey)).toBeUndefined();
      expect(store.rawEvent(fallback.envelope.deduplicationKey)).toBeDefined();
      const rebuilt = store.episodeAssociations()[0];
      expect(rebuilt?.status).toBe("associated");
      expect(rebuilt?.evidence.find((item) => item.signal === "issue")?.sourceEventIds)
        .toContain(fallback.envelope.event.eventId);
      expect(rebuilt?.evidence.flatMap((item) => item.sourceEventIds)).not.toContain(first.envelope.event.eventId);
      expect(store.ingestQueueItem(first).status).toBe("duplicate");
      expect(store.rawEvent(first.envelope.deduplicationKey)).toBeUndefined();
    } finally { store.close(); }
  });
});
