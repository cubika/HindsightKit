import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  CopilotEventMapper, createDefaultCopilotAdapterState, writeCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import {
  resolveWindowsCaptureWorkerLeaseName, resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue, WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { reconcileCurrentSessionCapture } from "../../packages/cli/src/reconcile-capture.js";

const directories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";
const instant = (seconds: number): string => new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
const now = () => new Date(instant(30));
const sessionId = "session-1";
const header = () => ({
  id: "session-start", type: "session.start", parentId: null, timestamp,
  data: {
    sessionId, copilotVersion: "1.0.82-0", version: 1, producer: "copilot-agent",
    context: { repository: "repo-1", branch: "main", cwd: "C:\\repo", gitRoot: "C:\\repo" },
  },
});
const message = (id: string, seconds: number) => ({
  id, type: "user.message", parentId: "session-start", timestamp: instant(seconds),
  data: { content: id },
});
const tool = (command = "npm test") => ({
  id: "operation-start", type: "tool.execution_start", parentId: "request",
  timestamp: instant(2),
  data: { toolCallId: "operation-1", toolName: "powershell", toolType: "builtin", arguments: { command } },
});

const fixture = async (events: readonly unknown[] = [header(), message("request", 1), tool()]) => {
  const root = await mkdtemp(join(process.cwd(), ".pl-current-reconcile-"));
  directories.push(root);
  const dataRoot = join(root, "owned");
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  const sessionStateRoot = join(root, "sessions");
  await mkdir(dirname(paths.database), { recursive: true });
  await mkdir(join(sessionStateRoot, sessionId), { recursive: true });
  await writeFile(paths.rootMarker, JSON.stringify({ schemaVersion: 1, product: "ProvenLoop", root: paths.root }));
  const defaults = createDefaultCopilotAdapterState(new Date(timestamp));
  const state = {
    ...defaults, installed: true, pluginInstalled: true, pluginEnabled: true,
    capabilities: { ...defaults.capabilities, capture: { enabled: true }, worker: { enabled: true } },
  };
  await writeCopilotAdapterState(paths.adapterState, state);
  const store = new CanonicalSqliteStore(paths.database);
  store.close();
  const path = join(sessionStateRoot, sessionId, "events.jsonl");
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { root, dataRoot, paths, sessionStateRoot, path, state, options: {
    dataRoot, sessionId, sessionStateRoot, minimumTimestamp: timestamp, now,
  } };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("current trusted Session reconciliation", () => {
  it("starts strictly after a records-reset cutoff without changing capture preferences", async () => {
    const environment = await fixture([header(), message("old", 1), message("after-reset", 7)]);
    const before = await readFile(environment.paths.adapterState, "utf8");
    const store = new CanonicalSqliteStore(environment.paths.database);
    try { store.clearAllRecords(instant(5)); } finally { store.close(); }
    const result = await reconcileCurrentSessionCapture(environment.options);
    expect(result).toMatchObject({ status: "reconciled", minimumTimestamp: new Date(Date.parse(instant(5)) + 1).toISOString(),
      reconciliation: { queuedEvents: 1, outsideObservationEvents: 2 } });
    const queue = new WindowsCaptureQueue(environment.paths.queue); await queue.initialize();
    expect((await queue.list()).map((item) => item.envelope.sourceEventId)).toEqual(["after-reset"]);
    expect(await readFile(environment.paths.adapterState, "utf8")).toBe(before);
  });
  it("queues only the requested Session inside its observed interval", async () => {
    const environment = await fixture([header(), message("old", 1), message("current", 7)]);
    await mkdir(join(environment.sessionStateRoot, "another-session"));
    await writeFile(join(environment.sessionStateRoot, "another-session", "events.jsonl"), "untrusted history");
    const result = await reconcileCurrentSessionCapture({
      ...environment.options, minimumTimestamp: instant(5),
    });
    expect(result).toMatchObject({
      status: "reconciled", reconciliation: { queuedEvents: 1, outsideObservationEvents: 2 },
    });
    const queue = new WindowsCaptureQueue(environment.paths.queue);
    await queue.initialize();
    expect((await queue.list()).map((item) => item.envelope.sourceEventId)).toEqual(["current"]);
  });

  it("persists the first observed instant rather than importing pre-existing history", async () => {
    const environment = await fixture([header(), message("old", 1)]);
    const { minimumTimestamp: _minimum, ...options } = environment.options;
    void _minimum;
    expect(await reconcileCurrentSessionCapture(options)).toMatchObject({
      status: "reconciled", minimumTimestamp: instant(30), reconciliation: { queuedEvents: 0 },
    });
    await appendFile(environment.path, `${JSON.stringify(message("later", 31))}\n`);
    expect(await reconcileCurrentSessionCapture({ ...options, now: () => new Date(instant(60)) })).toMatchObject({
      status: "reconciled", minimumTimestamp: instant(30), reconciliation: { queuedEvents: 1 },
    });
  });

  it("repairs omitted arguments append-only and requests projection rebuilding", async () => {
    const environment = await fixture();
    const mapper = new CopilotEventMapper({ adapterVersion: "1.0.82-0", sessionId, copyLimits: { maxStringChars: 32_768 } });
    mapper.map(header());
    mapper.map(message("request", 1));
    const mapped = mapper.map(tool());
    if (mapped.status !== "mapped") throw new Error("Expected a mapped operation.");
    const queue = new WindowsCaptureQueue(environment.paths.queue);
    await queue.initialize();
    const item = await queue.enqueue({
      ...mapped.value,
      content: { toolArguments: { kind: "object", status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    }, { environment: {} });
    const store = new CanonicalSqliteStore(environment.paths.database);
    try {
      store.ingestQueueItem(item);
      const original = store.rawEvent(item.envelope.deduplicationKey);
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({
        status: "reconciled", enrichedEvents: 1, reconciliation: { repairedEvents: 1, repairRejectedEvents: 0 },
      });
      expect(store.rawEvent(item.envelope.deduplicationKey)).toMatchObject({ envelope: original?.envelope });
      expect(store.effectiveRawEvent(item.envelope.deduplicationKey)?.envelope.event.redactedArguments).toEqual({ command: "npm test" });
      expect(JSON.parse(await readFile(environment.paths.projectionDirty, "utf8"))).toMatchObject({ schemaVersion: 1 });
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({ enrichedEvents: 0 });
    } finally {
      store.close();
    }
  });

  it("defers queued duplicates and repairs them after canonical ingestion without replaying the prefix", async () => {
    const environment = await fixture();
    const mapper = new CopilotEventMapper({ adapterVersion: "1.0.82-0", sessionId, copyLimits: { maxStringChars: 32_768 } });
    mapper.map(header()); mapper.map(message("request", 1));
    const mapped = mapper.map(tool());
    if (mapped.status !== "mapped") throw new Error("Expected a mapped operation.");
    const queue = new WindowsCaptureQueue(environment.paths.queue);
    await queue.initialize();
    const item = await queue.enqueue({
      ...mapped.value, content: { toolArguments: { status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    }, { environment: {} });
    expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({
      enrichedEvents: 0, reconciliation: { repairPendingEvents: 1 },
    });
    const store = new CanonicalSqliteStore(environment.paths.database);
    try {
      store.ingestQueueItem(item);
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({
        status: "reconciled", enrichedEvents: 1, reconciliation: { scannedEvents: 0, repairedEvents: 1 },
      });
    } finally { store.close(); }
  });

  it("rejects conflicting immutable workspace facts rather than relabelling the source", async () => {
    const environment = await fixture();
    const mapper = new CopilotEventMapper({ adapterVersion: "1.0.82-0", sessionId, copyLimits: { maxStringChars: 32_768 } });
    mapper.map(header()); mapper.map(message("request", 1));
    const mapped = mapper.map(tool());
    if (mapped.status !== "mapped") throw new Error("Expected a mapped operation.");
    const queue = new WindowsCaptureQueue(environment.paths.queue); await queue.initialize();
    const item = await queue.enqueue({
      ...mapped.value, repoId: "another-repository",
      content: { toolArguments: { status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    }, { environment: {} });
    const store = new CanonicalSqliteStore(environment.paths.database);
    try {
      store.ingestQueueItem(item);
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({
        enrichedEvents: 0, reconciliation: { repairRejectedEvents: 1 },
      });

      expect(store.effectiveRawEvent(item.envelope.deduplicationKey)?.envelope.event.repoId).toBe("another-repository");
    } finally { store.close(); }
  });

  it("preserves source redaction losses while a queued repair waits for canonical ingestion", async () => {
    const command = "x".repeat(20_000);
    const environment = await fixture([header(), message("request", 1), tool(command)]);
    const mapper = new CopilotEventMapper({ adapterVersion: "1.0.82-0", sessionId, copyLimits: { maxStringChars: 32_768 } });
    mapper.map(header()); mapper.map(message("request", 1));
    const mapped = mapper.map(tool(command));
    if (mapped.status !== "mapped") throw new Error("Expected a mapped operation.");
    const queue = new WindowsCaptureQueue(environment.paths.queue); await queue.initialize();
    const item = await queue.enqueue({
      ...mapped.value, content: { toolArguments: { status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    }, { environment: {} });
    await reconcileCurrentSessionCapture(environment.options);
    const store = new CanonicalSqliteStore(environment.paths.database);
    try {
      store.ingestQueueItem(item);
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({
        enrichedEvents: 0, reconciliation: { repairPendingEvents: 1, repairedEvents: 0 },
      });
      expect(store.effectiveRawEvent(item.envelope.deduplicationKey)?.envelope.event.redactedArguments)
        .toEqual({ status: "omitted_in_callback" });
    } finally { store.close(); }
  });

  it("honours capture state, internal markers, and the worker maintenance lease", async () => {
    const environment = await fixture();
    await writeCopilotAdapterState(environment.paths.adapterState, {
      ...environment.state, capabilities: { ...environment.state.capabilities, capture: { enabled: false } },
    });
    expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({ status: "skipped", reason: "capture_or_worker_disabled" });
    await writeCopilotAdapterState(environment.paths.adapterState, environment.state);
    const lease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsCaptureWorkerLeaseName(environment.paths.root),
    ).tryAcquire();
    expect(lease).toBeDefined();
    try {
      expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({ status: "skipped", reason: "lease_unavailable" });
    } finally { await lease?.release(); }
    await mkdir(environment.paths.internalSessions, { recursive: true });
    await writeFile(join(environment.paths.internalSessions, `${createHash("sha256").update(sessionId).digest("hex")}.json`), JSON.stringify({ sessionId }));
    expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({ status: "skipped", reason: "internal_session" });
  });

  it.each(["..", "..\\other", "../other", "CON", "name:stream", "space ", "session."])("rejects unsafe directory identity %s", async (unsafe) => {
    expect(await reconcileCurrentSessionCapture({
      dataRoot: process.cwd(), sessionStateRoot: process.cwd(), sessionId: unsafe,
    })).toMatchObject({ status: "rejected", reason: "invalid_session_path" });
  });

  it("rejects a Session directory junction escaping the SDK state root", async () => {
    const environment = await fixture();
    const outside = join(environment.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "events.jsonl"), `${JSON.stringify(header())}\n`);
    await rm(join(environment.sessionStateRoot, sessionId), { recursive: true });
    await symlink(outside, join(environment.sessionStateRoot, sessionId), "junction");
    expect(await reconcileCurrentSessionCapture(environment.options)).toMatchObject({ status: "rejected", reason: "session_source_escape" });
  });
});
