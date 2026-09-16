import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AsyncCaptureWriter,
  BoundedCaptureBuffer,
  CopilotEventMapper,
  CopilotExtensionCapture,
  startCopilotExtensionCapture,
  type CaptureQueueSink,
  type CaptureTerminationSignalSource,
  type CopilotSessionEvent,
  type CopilotSessionLike,
} from "@provenloop/copilot-adapter";
import type {
  CaptureEventInput,
} from "@provenloop/domain";
import {
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

const timestamp = "2026-08-29T00:00:00.000Z";
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-extension-capture-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

const captureEvent = (sourceEventId: string, message: string) => ({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  content: {
    message,
  },
  eventType: "prompt.submitted",
  sessionId: "session-1",
  sourceEventId,
  timestamp,
  trust: "user" as const,
});

const createMapper = (): CopilotEventMapper =>
  new CopilotEventMapper({
    adapterVersion: "1.0.82-0",
    copyLimits: {
      maxStringChars: 1_024,
    },
    sessionId: "session-1",
  });

class FakeSession implements CopilotSessionLike {
  readonly #allListeners: ((event: CopilotSessionEvent) => void)[] = [];
  readonly #shutdownListeners:
    ((event: CopilotSessionEvent) => void)[] = [];
  #disconnectCalls = 0;
  public disconnectResult: Promise<void> | undefined;

  public get disconnectCalls(): number {
    return this.#disconnectCalls;
  }

  public disconnect(): Promise<void> | void {
    this.#disconnectCalls += 1;
    return this.disconnectResult;
  }

  public on(
    eventTypeOrListener:
      | "session.shutdown"
      | ((event: CopilotSessionEvent) => void),
    listener?: (event: CopilotSessionEvent) => void,
  ): void {
    if (typeof eventTypeOrListener === "function") {
      this.#allListeners.push(eventTypeOrListener);
      return;
    }
    if (listener !== undefined) {
      this.#shutdownListeners.push(listener);
    }
  }

  public emit(event: CopilotSessionEvent): void {
    if (event.type === "session.shutdown") {
      for (const listener of this.#shutdownListeners) {
        listener(event);
      }
    }
    for (const listener of this.#allListeners) {
      listener(event);
    }
  }
}

class FakeSignalSource implements CaptureTerminationSignalSource {
  #listener: (() => void) | undefined;

  public once(
    signal: "SIGTERM",
    listener: () => void,
  ): void {
    expect(signal).toBe("SIGTERM");
    this.#listener = listener;
  }

  public emitSigterm(): void {
    this.#listener?.();
  }
}

describe("asynchronous capture writer", () => {
  it("persists submitted events without doing queue I/O inline", async () => {
    let releaseWrite: (() => void) | undefined;
    let enqueueCalls = 0;
    const queue: CaptureQueueSink = {
      enqueue: async () => {
        enqueueCalls += 1;
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      },
    };
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 10,
      }),
      queue,
      retryDelayMs: 10,
    });

    expect(writer.submit(captureEvent("event-1", "hello"))).toEqual({
      status: "accepted",
    });
    expect(enqueueCalls).toBe(0);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(enqueueCalls).toBe(1);
    releaseWrite?.();

    expect(await writer.flush(1_000)).toBe(true);
    expect(writer.status()).toMatchObject({
      bufferedItems: 0,
      persistedEvents: 1,
      state: "healthy",
    });
  });

  it("retries queue failures without losing the buffered item", async () => {
    let attempts = 0;
    const persisted: string[] = [];
    const queue: CaptureQueueSink = {
      enqueue: async (input) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error(
            "temporary token=ghp_1234567890abcdefghijklmnopqrst",
          );
        }
        persisted.push(input.sourceEventId);
      },
    };
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 10,
      }),
      queue,
      retryDelayMs: 1,
    });

    writer.submit(captureEvent("event-1", "hello"));

    expect(await writer.flush(1_000)).toBe(true);
    expect(persisted).toEqual([
      "event-1",
    ]);
    expect(writer.status()).toMatchObject({
      bufferedItems: 0,
      persistedEvents: 1,
      writeFailures: 1,
    });
    expect(writer.status().lastError).toBeUndefined();
  });

  it("rejects submissions once shutdown begins", async () => {
    const persisted: string[] = [];
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 10,
      }),
      queue: {
        enqueue: async (input) => {
          persisted.push(input.sourceEventId);
        },
      },
      retryDelayMs: 1,
    });

    const stopping = writer.stop(1_000);
    expect(writer.submit(captureEvent("late-event", "late"))).toEqual({
      status: "dropped",
    });

    expect(await stopping).toBe(true);
    expect(persisted).toEqual([]);
    expect(writer.status()).toMatchObject({
      bufferedItems: 0,
      droppedEvents: 1,
      state: "stopped",
    });
  });

  it("persists a capture gap after buffer overflow", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(root, {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 1,
      }),
      queue,
      retryDelayMs: 1,
    });

    expect(writer.submit(captureEvent("event-1", "first")).status).toBe(
      "accepted",
    );
    expect(writer.submit(captureEvent("event-2", "second")).status).toBe(
      "dropped",
    );

    expect(await writer.flush(1_000)).toBe(true);
    const items = await queue.list();
    expect(items.map((item) => item.envelope.event.eventType)).toEqual([
      "prompt.submitted",
      "capture_gap",
    ]);
    expect(items[1]?.envelope.event.redactedArguments).toMatchObject({
      droppedEventCount: 1,
      firstSourceEventId: "event-2",
      lastSourceEventId: "event-2",
    });
  });
});

describe("Copilot extension capture runtime", () => {
  it("subscribes, maps events, reports unsupported events, and flushes", async () => {
    const persisted: string[] = [];
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      }),
      queue: {
        enqueue: async (input) => {
          persisted.push(input.eventType);
        },
      },
      retryDelayMs: 1,
    });
    const runtime = new CopilotExtensionCapture({
      internalSession: false,
      mapper: createMapper(),
      shutdownDeadlineMs: 1_000,
      writer,
    });
    const session = new FakeSession();
    runtime.attach(session);

    runtime.setEnabled(false);
    session.emit({
      data: {
        content: "disabled",
      },
      id: "disabled-user-event",
      parentId: null,
      timestamp,
      type: "user.message",
    });
    runtime.setEnabled(true);
    session.emit({
      data: {
        content: "hello",
      },
      id: "user-event-1",
      parentId: null,
      timestamp,
      type: "user.message",
    });
    session.emit({
      data: {},
      id: "future-event-1",
      parentId: "user-event-1",
      timestamp,
      type: "future.persisted_event",
    });
    session.emit({
      data: {
        codeChanges: {
          filesModified: [],
          linesAdded: 0,
          linesRemoved: 0,
        },
        shutdownType: "routine",
      },
      id: "shutdown-event-1",
      parentId: "future-event-1",
      timestamp,
      type: "session.shutdown",
    });

    expect(await runtime.shutdown()).toBe(true);
    expect(persisted).toEqual([
      "session.started",
      "prompt.submitted",
      "future.persisted_event",
      "session.ended",
    ]);
    expect(runtime.status()).toMatchObject({
      callbackCount: 4,
      disabledEventsSkipped: 1,
      malformedEvents: 0,
      runtimeErrors: 0,
      unsupportedEvents: 1,
      writer: {
        state: "stopped",
      },
    });
  });

  it("keeps malformed and internal events from failing Copilot", async () => {
    const persisted: string[] = [];
    const diagnostics: string[] = [];
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 10,
      }),
      queue: {
        enqueue: async (input) => {
          persisted.push(input.eventType);
        },
      },
      retryDelayMs: 1,
    });
    const runtime = new CopilotExtensionCapture({
      internalSession: true,
      mapper: createMapper(),
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
      shutdownDeadlineMs: 1_000,
      writer,
    });
    const session = new FakeSession();
    runtime.attach(session);

    expect(() =>
      session.emit({
        data: {},
        timestamp,
        type: "tool.execution_start",
      }),
    ).not.toThrow();
    expect(await runtime.shutdown()).toBe(true);
    expect(persisted).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(runtime.status()).toMatchObject({
      internalEventsSkipped: 1,
      writer: {
        receivedEvents: 0,
      },
    });
  });

  it("reports malformed callbacks without throwing", async () => {
    const diagnostics: string[] = [];
    const writer = new AsyncCaptureWriter({
      buffer: new BoundedCaptureBuffer({
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 10_000,
        maxItems: 10,
      }),
      queue: {
        enqueue: async () => undefined,
      },
      retryDelayMs: 1,
    });
    const runtime = new CopilotExtensionCapture({
      internalSession: false,
      mapper: createMapper(),
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
      shutdownDeadlineMs: 1_000,
      writer,
    });
    const session = new FakeSession();
    runtime.attach(session);

    expect(() =>
      session.emit({
        data: {},
        timestamp,
        type: "tool.execution_start",
      }),
    ).not.toThrow();
    expect(await runtime.shutdown()).toBe(true);
    expect(runtime.status().malformedEvents).toBe(1);
    expect(diagnostics).toEqual([
      expect.stringContaining("id must be a non-empty string"),
    ]);
  });

  it("joins the session and refreshes workspace outside callbacks", async () => {
    const session = new FakeSession();
    const persisted: {
      readonly branch: string | undefined;
      readonly eventType: string;
    }[] = [];
    let joinCalls = 0;
    let refreshCalls = 0;
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        joinCalls += 1;
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push({
            branch: input.branch,
            eventType: input.eventType,
          });
        },
      },
      refreshWorkspace: async () => {
        refreshCalls += 1;
        return {
          branch: "feature/refreshed",
        };
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/initial",
      },
    });

    session.emit({
      data: {
        result: {
          content: "done",
        },
        success: true,
        toolCallId: "tool-call-1",
      },
      id: "tool-complete-1",
      parentId: null,
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        content: "next",
      },
      id: "user-event-2",
      parentId: "tool-complete-1",
      timestamp,
      type: "user.message",
    });

    expect(await runtime.shutdown()).toBe(true);
    expect(joinCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(persisted).toEqual([
      {
        branch: "feature/initial",
        eventType: "session.started",
      },
      {
        branch: "feature/initial",
        eventType: "tool.completed",
      },
      {
        branch: "feature/refreshed",
        eventType: "prompt.submitted",
      },
    ]);
  });

  it("records observed HEAD changes without claiming a new commit", async () => {
    const session = new FakeSession();
    const persisted: CaptureEventInput[] = [];
    const parentCommit =
      "0123456789abcdef0123456789abcdef01234567";
    const childCommit =
      "89abcdef0123456789abcdef0123456789abcdef";
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input);
        },
      },
      refreshWorkspace: async () => ({
        branch: "feature/commit",
        commitParents: [
          parentCommit,
        ],
        commitSha: childCommit,
        repoId: "repo-1",
      }),
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/commit",
        commitParents: [],
        commitSha: parentCommit,
        repoId: "repo-1",
      },
    });

    session.emit({
      data: {
        branch: "feature/commit",
        cwd: "C:\\repo",
        gitRoot: "C:\\repo",
        headCommit: childCommit,
        repository: "repo-1",
      },
      id: "context-change-commit",
      parentId: null,
      timestamp,
      type: "session.context_changed",
    });
    session.emit({
      data: {
        result: {
          content: "committed",
        },
        success: true,
        toolCallId: "tool-call-commit",
      },
      id: "tool-complete-commit",
      parentId: null,
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await runtime.shutdown()).toBe(true);

    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commitSha: childCommit,
          content: {
            toolArguments: {
              parents: [
                parentCommit,
              ],
            },
          },
          eventType: "git.head_changed",
          repoId: "repo-1",
          sessionId: "session-1",
        }),
      ]),
    );
  });

  it("waits for an in-flight commit refresh before shutdown", async () => {
    const session = new FakeSession();
    const persisted: CaptureEventInput[] = [];
    const parentCommit =
      "0123456789abcdef0123456789abcdef01234567";
    const childCommit =
      "89abcdef0123456789abcdef0123456789abcdef";
    let resolveRefresh:
      ((snapshot: {
        readonly branch: string;
        readonly commitParents: readonly string[];
        readonly commitSha: string;
        readonly repoId: string;
      }) => void) | undefined;
    const refresh = new Promise<{
      readonly branch: string;
      readonly commitParents: readonly string[];
      readonly commitSha: string;
      readonly repoId: string;
    }>((resolve) => {
      resolveRefresh = resolve;
    });
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input);
        },
      },
      refreshWorkspace: async () => refresh,
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/commit",
        commitParents: [],
        commitSha: parentCommit,
        repoId: "repo-1",
      },
    });
    session.emit({
      data: {
        result: {
          content: "committed",
        },
        success: true,
        toolCallId: "tool-call-commit",
      },
      id: "tool-complete-commit",
      parentId: null,
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        branch: "feature/commit",
        cwd: "C:\\repo",
        gitRoot: "C:\\repo",
        headCommit: childCommit,
        repository: "repo-1",
      },
      id: "context-after-tool",
      parentId: "tool-complete-commit",
      timestamp,
      type: "session.context_changed",
    });

    const shutdown = runtime.shutdown();
    resolveRefresh?.({
      branch: "feature/commit",
      commitParents: [
        parentCommit,
      ],
      commitSha: childCommit,
      repoId: "repo-1",
    });
    await expect(shutdown).resolves.toBe(true);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commitSha: childCommit,
          eventType: "git.head_changed",
        }),
      ]),
    );
  });

  it("emits first commit metadata after a metadata-free context change", async () => {
    const session = new FakeSession();
    const persisted: CaptureEventInput[] = [];
    const firstCommit =
      "0123456789abcdef0123456789abcdef01234567";
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input);
        },
      },
      refreshWorkspace: async () => ({
        branch: "feature/first-commit",
        commitParents: [],
        commitSha: firstCommit,
        repoId: "repo-1",
      }),
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/first-commit",
        repoId: "repo-1",
      },
    });
    session.emit({
      data: {
        branch: "feature/first-commit",
        cwd: "C:\\repo",
        gitRoot: "C:\\repo",
        headCommit: firstCommit,
        repository: "repo-1",
      },
      id: "first-commit-context",
      parentId: null,
      timestamp,
      type: "session.context_changed",
    });
    session.emit({
      data: {
        result: {
          content: "committed",
        },
        success: true,
        toolCallId: "first-commit-tool",
      },
      id: "first-commit-tool-complete",
      parentId: "first-commit-context",
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(await runtime.shutdown()).toBe(true);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commitSha: firstCommit,
          eventType: "git.head_changed",
        }),
      ]),
    );
  });

  it("drains refresh work that was pending when shutdown began", async () => {
    const session = new FakeSession();
    const persisted: CaptureEventInput[] = [];
    const parentCommit =
      "0123456789abcdef0123456789abcdef01234567";
    const childCommit =
      "89abcdef0123456789abcdef0123456789abcdef";
    let refreshCalls = 0;
    let resolveFirstRefresh:
      ((snapshot: {
        readonly branch: string;
        readonly commitParents: readonly string[];
        readonly commitSha: string;
        readonly repoId: string;
      }) => void) | undefined;
    const firstRefresh = new Promise<{
      readonly branch: string;
      readonly commitParents: readonly string[];
      readonly commitSha: string;
      readonly repoId: string;
    }>((resolve) => {
      resolveFirstRefresh = resolve;
    });
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input);
        },
      },
      refreshWorkspace: async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? firstRefresh
          : {
              branch: "feature/commit",
              commitParents: [
                parentCommit,
              ],
              commitSha: childCommit,
              repoId: "repo-1",
            };
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/commit",
        commitParents: [],
        commitSha: parentCommit,
        repoId: "repo-1",
      },
    });
    for (const suffix of [
      "one",
      "two",
    ]) {
      session.emit({
        data: {
          result: {
            content: "committed",
          },
          success: true,
          toolCallId: `pending-tool-${suffix}`,
        },
        id: `pending-tool-complete-${suffix}`,
        parentId: null,
        timestamp,
        type: "tool.execution_complete",
      });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const shutdown = runtime.shutdown();
    resolveFirstRefresh?.({
      branch: "feature/commit",
      commitParents: [],
      commitSha: parentCommit,
      repoId: "repo-1",
    });
    await expect(shutdown).resolves.toBe(true);
    expect(refreshCalls).toBe(2);
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commitSha: childCommit,
          eventType: "git.head_changed",
        }),
      ]),
    );
  });

  it("captures events emitted during the join and resume handshake", async () => {
    const session = new FakeSession();
    const persisted: string[] = [];
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        onEvent({
          data: {
            content: "arrived during resume",
          },
          id: "early-user-event",
          parentId: null,
          timestamp,
          type: "user.message",
        });
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input.eventType);
        },
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
    });

    expect(await runtime.shutdown()).toBe(true);
    expect(persisted).toEqual([
      "session.started",
      "prompt.submitted",
    ]);
  });

  it("flushes buffered events when the extension receives SIGTERM", async () => {
    const session = new FakeSession();
    const signalSource = new FakeSignalSource();
    const persisted: string[] = [];
    const exitCodes: number[] = [];
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          persisted.push(input.eventType);
        },
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      signalSource,
      terminate: (exitCode) => {
        exitCodes.push(exitCode);
      },
    });
    session.emit({
      data: {
        content: "before termination",
      },
      id: "user-before-sigterm",
      parentId: null,
      timestamp,
      type: "user.message",
    });

    signalSource.emitSigterm();

    expect(await runtime.shutdown()).toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(persisted).toEqual([
      "session.started",
      "prompt.submitted",
    ]);
    expect(session.disconnectCalls).toBe(1);
    expect(exitCodes).toEqual([
      0,
    ]);
    expect(runtime.status().writer.state).toBe("stopped");
  });

  it("terminates on schedule when SDK disconnect stalls", async () => {
    const session = new FakeSession();
    session.disconnectResult = new Promise(() => undefined);
    const signalSource = new FakeSignalSource();
    const exitCodes: number[] = [];
    await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 20_000,
        maxItems: 20,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async () => undefined,
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 20,
      signalSource,
      terminate: (exitCode) => {
        exitCodes.push(exitCode);
      },
    });

    signalSource.emitSigterm();
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    expect(session.disconnectCalls).toBe(1);
    expect(exitCodes).toEqual([
      0,
    ]);
  });

  it("runs a follow-up workspace refresh after concurrent tool events", async () => {
    const session = new FakeSession();
    const refreshResolvers: (
      (snapshot: { readonly branch: string }) => void
    )[] = [];
    let refreshCalls = 0;
    const persistedBranches: (string | undefined)[] = [];
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 30_000,
        maxItems: 30,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          if (input.eventType === "prompt.submitted") {
            persistedBranches.push(input.branch);
          }
        },
      },
      refreshWorkspace: async () => {
        refreshCalls += 1;
        return new Promise((resolve) => {
          refreshResolvers.push(resolve);
        });
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/initial",
      },
    });

    session.emit({
      data: {
        success: true,
        toolCallId: "tool-call-1",
      },
      id: "tool-complete-1",
      parentId: null,
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        success: true,
        toolCallId: "tool-call-2",
      },
      id: "tool-complete-2",
      parentId: "tool-complete-1",
      timestamp,
      type: "tool.execution_complete",
    });

    expect(refreshCalls).toBe(1);
    refreshResolvers[0]?.({
      branch: "feature/first-refresh",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(refreshCalls).toBe(2);
    refreshResolvers[1]?.({
      branch: "feature/second-refresh",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        content: "continue",
      },
      id: "user-event-after-refresh",
      parentId: "tool-complete-2",
      timestamp,
      type: "user.message",
    });

    expect(await runtime.shutdown()).toBe(true);
    expect(persistedBranches).toEqual([
      "feature/second-refresh",
    ]);
  });

  it("does not let a stale refresh overwrite a newer context event", async () => {
    const session = new FakeSession();
    let refreshCalls = 0;
    let resolveRefresh:
      ((snapshot: { readonly branch: string }) => void) | undefined;
    const persistedBranches: (string | undefined)[] = [];
    const runtime = await startCopilotExtensionCapture({
      adapterVersion: "1.0.82-0",
      buffer: {
        maxGapBytes: 8_192,
        maxGapContexts: 4,
        maxBytes: 30_000,
        maxItems: 30,
      },
      copyLimits: {
        maxStringChars: 1_024,
      },
      joinSession: async ({ onEvent }) => {
        session.on(onEvent);
        return session;
      },
      queue: {
        enqueue: async (input) => {
          if (input.eventType === "prompt.submitted") {
            persistedBranches.push(input.branch);
          }
        },
      },
      refreshWorkspace: async (workspace) => {
        refreshCalls += 1;
        if (refreshCalls > 1) return workspace;
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
      retryDelayMs: 1,
      sessionId: "session-1",
      shutdownDeadlineMs: 1_000,
      workspace: {
        branch: "feature/initial",
      },
    });

    session.emit({
      data: {
        success: true,
        toolCallId: "tool-call-1",
      },
      id: "tool-complete-1",
      parentId: null,
      timestamp,
      type: "tool.execution_complete",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        branch: "feature/new-context",
        cwd: "C:\\repo",
        gitRoot: "C:\\repo",
        headCommit: "abcdef1234567890abcdef1234567890abcdef12",
        repository: "owner/repository",
      },
      id: "context-event-1",
      parentId: "tool-complete-1",
      timestamp,
      type: "session.context_changed",
    });
    resolveRefresh?.({
      branch: "feature/stale-refresh",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    session.emit({
      data: {
        content: "continue",
      },
      id: "user-event-after-context",
      parentId: "context-event-1",
      timestamp,
      type: "user.message",
    });

    expect(await runtime.shutdown()).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(persistedBranches).toEqual([
      "feature/new-context",
    ]);
  });
});
