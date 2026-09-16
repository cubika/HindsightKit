import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureQueueItemSchema, type CaptureQueueItem } from "@provenloop/contracts";
import {
  captureEnvelopeCompleteness, CaptureReconciler, type ReconciliationQueue,
} from "@provenloop/copilot-adapter";
import { createCaptureEnvelope, type CaptureEventInput } from "@provenloop/domain";

const directories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
const header = {
  id: "header", parentId: null, type: "session.start", timestamp,
  data: {
    copilotVersion: "1.0.82-0", version: 1, sessionId: "session-1",
    context: { repository: "repo-1", cwd: "C:\\repo", gitRoot: "C:\\repo", branch: "main" },
  },
};
const event = (id: string, type: string, seconds: number, data: unknown, parentId = "header") =>
  ({ id, type, timestamp: at(seconds), data, parentId });
const source = async (events: readonly unknown[]) => {
  const root = await mkdtemp(join(process.cwd(), ".pl-reconciler-budget-"));
  directories.push(root);
  const path = join(root, "events.jsonl");
  await writeFile(path, `${events.map((value) => JSON.stringify(value)).join("\n")}\n`);
  return path;
};
const queueFixture = (): ReconciliationQueue & { readonly items: Map<string, CaptureQueueItem> } => {
  const items = new Map<string, CaptureQueueItem>();
  return {
    items,
    enqueue: async () => { throw new Error("Use source-idempotent enqueue."); },
    list: async () => { throw new Error("A bounded pass must not scan the queue."); },
    enqueueIfSourceAbsent: async (input) => {
      const envelope = createCaptureEnvelope(input);
      if (items.has(envelope.deduplicationKey)) return { status: "duplicate" };
      const item = captureQueueItemSchema.parse({
        schemaVersion: 1, queueItemId: `item-${items.size}`, state: "pending",
        attemptCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope,
      });
      items.set(envelope.deduplicationKey, item);
      return { status: "enqueued", item };
    },
  };
};
const reconcilerFor = (queue: ReconciliationQueue, present = false) => new CaptureReconciler({
  canonical: {
    deduplicationKeys: async () => { throw new Error("A bounded pass must not scan canonical identities."); },
    captureCompleteness: async (_adapter, _version, _session, identities) => {
      expect(identities).toHaveLength(1);
      return present ? new Map(identities?.map((identity) => [identity, "complete" as const])) : new Map();
    },
  },
  copyLimits: { maxStringChars: 32_768 }, maxLineChars: 1024 * 1024, queue,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded reconciliation", () => {
  it("continues beyond 500 source events without full canonical or queue scans", async () => {
    const path = await source([
      header, ...Array.from({ length: 700 }, (_, index) => event(`message-${index}`, "user.message", 1, { content: "hello" })),
    ]);
    const queue = queueFixture();
    const reconciler = reconcilerFor(queue);
    const first = await reconciler.reconcileSessionFile({ path, expectedSessionId: "session-1", maxEvents: 500 });
    expect(first).toMatchObject({ status: "budget_exhausted", scannedEvents: 500, queuedEvents: 500 });
    const second = await reconciler.reconcileSessionFile({ path, expectedSessionId: "session-1", maxEvents: 500 });
    expect(second).toMatchObject({ status: "reconciled", scannedEvents: 201, queuedEvents: 201 });
    expect(queue.items.size).toBe(701);
  });

  it("retains operation mapping while a proof's source spans parser passes", async () => {
    const path = await source([
      header,
      event("start", "tool.execution_start", 1, {
        toolName: "edit", toolType: "builtin", toolCallId: "op", arguments: { path: "C:\\repo\\src\\file.ts" },
      }),
      event("complete", "tool.execution_complete", 2, { success: true, toolCallId: "op", result: { content: "edited" } }, "start"),
    ]);
    const queue = queueFixture();
    const reconciler = reconcilerFor(queue);
    await reconciler.reconcileSessionFile({ path, maxEvents: 2, minimumTimestamp: timestamp, resume: true });
    expect(await reconciler.reconcileSessionFile({ path, maxEvents: 2, minimumTimestamp: timestamp, resume: true }))
      .toMatchObject({ status: "reconciled", queuedEvents: 2 });
    const events = [...queue.items.values()].map((item) => item.envelope.event);
    expect(events.find((value) => value.eventType === "tool.completed")?.toolName).toBe("edit");
    expect(events.find((value) => value.eventType === "file.changed")?.evidence?.sourceStartEventId).toBe("start");
  });

  it("uses old operations for positioning but does not import their derived changes as observed work", async () => {
    const path = await source([
      header,
      event("start", "tool.execution_start", 1, {
        toolName: "edit", toolType: "builtin", toolCallId: "op", arguments: { path: "C:\\repo\\src\\file.ts" },
      }),
      event("complete", "tool.execution_complete", 6, { success: true, toolCallId: "op", result: { content: "edited" } }, "start"),
    ]);
    const queue = queueFixture();
    const result = await reconcilerFor(queue).reconcileSessionFile({ path, minimumTimestamp: at(5) });
    expect(result).toMatchObject({ status: "reconciled", queuedEvents: 1, outsideObservationEvents: 3 });
    expect([...queue.items.values()].map((item) => item.envelope.event.eventType)).toEqual(["tool.completed"]);
  });

  it("does not let hundreds of unresolved queued duplicates block the file tail", async () => {
    const path = await source([
      header, ...Array.from({ length: 700 }, (_, index) => event(`message-${index}`, "user.message", 1, { content: "hello" })),
    ]);
    const reconciler = reconcilerFor({
      enqueue: async () => { throw new Error("Use source-idempotent enqueue."); },
      list: async () => { throw new Error("Unexpected scan."); },
      enqueueIfSourceAbsent: async () => ({ status: "duplicate" }),
    });
    await reconciler.reconcileSessionFile({ path, maxEvents: 500, resume: true });
    expect(await reconciler.reconcileSessionFile({ path, maxEvents: 500, resume: true })).toMatchObject({
      status: "reconciled", scannedEvents: 201, deferredRepairEvents: 201, queuedEvents: 0,
    });
  });

  it("bounds quality merged with redaction losses when queued repairs are retried", async () => {
    const text = "x".repeat(128);
    const arrays = Object.fromEntries(["paths", "files", "targets", "changedFiles"].map((key) => [
      key, Array.from({ length: 32 }, () => text),
    ]));
    const path = await source([header, event("complete", "tool.execution_complete", 1, {
      toolCallId: "quality-op", success: true,
      result: {
        ...arrays, content: text, structuredContent: arrays,
        contents: Array.from({ length: 32 }, () => ({
          type: "terminal", text, cwd: text, shellId: text, outputFilePath: text, outputPreview: text,
        })),
      },
    })]);
    let ingested = false;
    let retried = false;
    const reconciler = new CaptureReconciler({
      canonical: {
        deduplicationKeys: async () => { throw new Error("Unexpected canonical scan."); },
        captureCompleteness: async (_adapter, _version, _session, identities = []) =>
          ingested ? new Map(identities.map((identity) => [identity, "incomplete" as const])) : new Map(),
      },
      copyLimits: { maxStringChars: 64 }, maxLineChars: 1024 * 1024,
      queue: {
        enqueue: async () => { throw new Error("Unexpected non-idempotent enqueue."); },
        list: async () => { throw new Error("Unexpected queue scan."); },
        enqueueIfSourceAbsent: async () => ({ status: "duplicate" }),
      },
      repairCapture: async (input) => {
        const envelope = createCaptureEnvelope(input);
        if (input.eventType === "tool.completed") {
          retried = true;
          expect(envelope.event.captureQuality?.truncatedFields).toHaveLength(256);
          expect(envelope.event.captureQuality?.truncatedFields).toContain("captureQuality.truncatedFields");
          expect(captureEnvelopeCompleteness(envelope)).toBe("incomplete");
        }
        return "pending";
      },
    });
    expect(await reconciler.reconcileSessionFile({ path, resume: true })).toMatchObject({
      status: "reconciled", repairPendingEvents: 2,
    });
    ingested = true;
    expect(await reconciler.reconcileSessionFile({ path, resume: true })).toMatchObject({
      status: "reconciled", scannedEvents: 0, repairPendingEvents: 2,
    });
    expect(retried).toBe(true);
  });
});

describe("capture completeness", () => {
  const input: CaptureEventInput = {
    adapter: "copilot-cli", adapterVersion: "1.0.82-0", sessionId: "session-1",
    sourceEventId: "operation", eventType: "tool.started", timestamp,
    trust: "tool", repoId: "repo-1", worktree: "C:\\repo",
    content: { toolArguments: { command: "npm test" } },
  };

  it("recognizes actual arguments as content and accepts a safely recovered omission", () => {
    const complete = createCaptureEnvelope(input);
    expect(captureEnvelopeCompleteness(complete)).toBe("complete");
    const original = createCaptureEnvelope({
      ...input, content: { toolArguments: { status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    });
    expect(captureEnvelopeCompleteness(original)).toBe("incomplete");
    if (original.event.captureQuality === undefined) throw new Error("Expected original quality metadata.");
    const effective = {
      ...complete, event: { ...complete.event, captureQuality: original.event.captureQuality },
    };
    expect(captureEnvelopeCompleteness(effective, original)).toBe("complete");
  });

  it("does not wash original truncation or dropped metadata flags through an enrichment", () => {
    const complete = createCaptureEnvelope(input);
    const original = {
      ...complete, redaction: {
        ...complete.redaction, truncatedPaths: ["event.redactedArguments.command"], droppedPaths: ["event.repoId"],
      },
    };
    expect(captureEnvelopeCompleteness(complete, original)).toBe("incomplete");
    expect(captureEnvelopeCompleteness(createCaptureEnvelope({
      ...input, content: { toolArguments: { status: "truncated", digest: "a".repeat(64) } },
    }))).toBe("incomplete");
  });
});
