import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileCurrentSessionCapture, runCaptureWorkerOnce, runProvenLoopCopilotExtension } from "@provenloop/cli";
import {
  CopilotEventMapper, createDefaultCopilotAdapterState, writeCopilotAdapterState,
  type CopilotSessionEvent,
} from "@provenloop/copilot-adapter";
import { resolveWindowsProvenLoopPaths, WindowsCaptureQueue } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installed current-session capture backfill", () => {
  it("automatically repairs callback omissions from the joined SDK workspace without an acceptance command", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pl-auto-reconcile-"));
    directories.push(root);
    const paths = resolveWindowsProvenLoopPaths(join(root, "owned"));
    const sessionId = "active-session";
    const sessionWorkspace = join(root, "sdk-state", sessionId);
    const timestamp = "2026-09-05T00:00:00.000Z";
    const before = "2026-09-04T23:59:00.000Z";
    await mkdir(paths.data, { recursive: true });
    await mkdir(sessionWorkspace, { recursive: true });
    await writeFile(paths.rootMarker, JSON.stringify({ schemaVersion: 1, product: "ProvenLoop", root: paths.root }));
    const state = createDefaultCopilotAdapterState(new Date(before));
    await writeCopilotAdapterState(paths.adapterState, {
      ...state, installed: true, pluginInstalled: true, pluginEnabled: true,
      capabilities: { ...state.capabilities, capture: { enabled: true }, worker: { enabled: true } },
    });
    const start = {
      id: "start", parentId: null, type: "session.start", timestamp: before,
      data: {
        sessionId, copilotVersion: "1.0.82-0", version: 1,
        context: { repository: "repo-1", gitRoot: root, cwd: root, branch: "main" },
      },
    };
    const request = {
      id: "request", parentId: "start", type: "user.message", timestamp: before,
      data: { content: "Run focused tests." },
    };
    const operation = {
      id: "operation-start", parentId: "request", type: "tool.execution_start", timestamp,
      data: { toolCallId: "operation-1", toolName: "powershell", arguments: { command: "npm test" } },
    };
    await writeFile(join(sessionWorkspace, "events.jsonl"),
      `${[start, request, operation].map((event) => JSON.stringify(event)).join("\n")}\n`);
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0", sessionId, copyLimits: { maxStringChars: 32_768 },
    });
    mapper.map(start);
    mapper.map(request);
    const mapped = mapper.map(operation);
    if (mapped.status !== "mapped") throw new Error("Expected a mapped source operation.");
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    const item = await queue.enqueue({
      ...mapped.value,
      content: { toolArguments: { status: "omitted_in_callback" } },
      captureQuality: { schemaVersion: 1, omittedFields: ["data.arguments"], truncatedFields: [], originalLengths: {} },
    });
    const store = new CanonicalSqliteStore(paths.database);
    store.ingestQueueItem(item);
    const original = store.rawEvent(item.envelope.deduplicationKey)?.envelope;
    let receive: ((event: CopilotSessionEvent) => void) | undefined;
    let stopped = false;
    const joinSession = vi.fn(async () => ({
      sessionId,
      workspacePath: sessionWorkspace,
      on: (listener: (event: CopilotSessionEvent) => void) => { receive = listener; },
      disconnect: async () => undefined,
    }));
    try {
      const result = await runProvenLoopCopilotExtension({
        dataRoot: paths.root,
        copilotHome: join(root, "copilot-home"),
        environment: { SESSION_ID: sessionId },
        now: () => new Date(timestamp),
        joinSession,
        onStopped: () => { stopped = true; },
        signalSource: { once: () => undefined },
        terminate: () => undefined,
        commandRunner: {
          run: async (executable, args) => executable === "git"
            ? { exitCode: 1, stdout: "", stderr: "fatal: not a git repository" }
            : { exitCode: 0, stderr: "", stdout: args[0] === "--version" ? "GitHub Copilot CLI 1.0.82-0.\n" : "[]\n" },
        },
      }, {
        runWorker: (options) => runCaptureWorkerOnce({
          ...options,
          admission: () => ({ allowed: true, reasons: [] }),
        }),
      });
      expect(result).toMatchObject({
        status: "started",
        captureSession: { sessionId, sessionStateRoot: dirname(sessionWorkspace), minimumTimestamp: timestamp },
      });
      await vi.waitFor(() => {
        expect(store.effectiveRawEvent(item.envelope.deduplicationKey)?.envelope.event.redactedArguments)
          .toEqual({ command: "npm test" });
      }, { timeout: 10_000, interval: 25 });
      expect(store.rawEvent(item.envelope.deduplicationKey)?.envelope).toEqual(original);
      const sourceIds = store.rawEvents().map((record) => record.envelope.sourceEventId);
      expect(sourceIds).toContain("operation-start");
      expect(sourceIds).not.toContain("start");
      expect(sourceIds).not.toContain("request");
      expect(joinSession).toHaveBeenCalledTimes(1);
    } finally {
      try {
        if (receive !== undefined) {
          receive({
            id: "shutdown", parentId: null, type: "session.shutdown", timestamp,
            data: { sessionId },
          });
          await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 10_000 });
        }
      } finally {
        store.close();
      }
    }
  });

  it("feeds only its trusted Session through the existing queue and worker into canonical storage", async () => {
    const root = await mkdtemp(join(process.cwd(), ".pl-reconcile-integration-"));
    directories.push(root);
    const paths = resolveWindowsProvenLoopPaths(join(root, "owned"));
    const sessionStateRoot = join(root, "session-state");
    const sessionId = "active-session";
    const timestamp = new Date().toISOString();
    await mkdir(dirname(paths.database), { recursive: true });
    await mkdir(join(sessionStateRoot, sessionId), { recursive: true });
    await mkdir(join(sessionStateRoot, "unobserved-history"));
    await writeFile(paths.rootMarker, JSON.stringify({ schemaVersion: 1, product: "ProvenLoop", root: paths.root }));
    const state = createDefaultCopilotAdapterState(new Date(timestamp));
    await writeCopilotAdapterState(paths.adapterState, {
      ...state, installed: true, pluginInstalled: true, pluginEnabled: true,
      capabilities: { ...state.capabilities, capture: { enabled: true }, worker: { enabled: true } },
    });
    new CanonicalSqliteStore(paths.database).close();
    await writeFile(join(sessionStateRoot, "unobserved-history", "events.jsonl"), "must not be read");
    await writeFile(join(sessionStateRoot, sessionId, "events.jsonl"), `${[
      {
        id: "start", parentId: null, type: "session.start", timestamp,
        data: {
          sessionId, copilotVersion: "1.0.82-0", version: 1,
          context: { repository: "repo-1", gitRoot: "C:\\repo", cwd: "C:\\repo", branch: "main" },
        },
      },
      { id: "request", parentId: "start", type: "user.message", timestamp, data: { content: "Resume this work." } },
    ].map((event) => JSON.stringify(event)).join("\n")}\n`);
    const options = { dataRoot: paths.root, sessionStateRoot, sessionId, minimumTimestamp: timestamp };
    expect(await reconcileCurrentSessionCapture(options)).toMatchObject({
      status: "reconciled", reconciliation: { queuedEvents: 2 },
    });
    const worker = await runCaptureWorkerOnce({
      dataRoot: paths.root,
      admission: () => ({ allowed: true, reasons: [] }),
    });
    expect(worker).toMatchObject({
      status: "completed", stored: 2, acknowledged: 2, failed: 0, circuitOpenReasons: [],
    });
    const store = new CanonicalSqliteStore(paths.database);
    try {
      expect(store.rawEvents().map((record) => record.envelope.sourceEventId).sort()).toEqual(["request", "start"]);
      expect(await reconcileCurrentSessionCapture(options)).toMatchObject({
        status: "reconciled", reconciliation: { scannedEvents: 0, queuedEvents: 0 }, enrichedEvents: 0,
      });
    } finally {
      store.close();
    }
  });
});
