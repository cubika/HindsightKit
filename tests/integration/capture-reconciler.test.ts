import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CaptureReconciler,
  CopilotEventMapper,
  type CanonicalCaptureWatermark,
} from "@provenloop/copilot-adapter";
import { createCaptureDeduplicationKey } from "@provenloop/domain";
import {
  discoverCopilotSessionFiles,
  resolveCopilotSessionStateRoot,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-29T00:00:00.000Z";
const emptyCanonical: CanonicalCaptureWatermark = {
  deduplicationKeys: async () => new Set(),
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(process.cwd(), ".provenloop-reconciler-test-"),
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

const header = (
  sessionId = "session-1",
  copilotVersion = "1.0.82-0",
) => ({
  data: {
    context: {
      branch: "feature/recovery",
      cwd: "C:\\repo",
      gitRoot: "C:\\repo",
      headCommit: "abcdef1234567890abcdef1234567890abcdef12",
    },
    copilotVersion,
    producer: "copilot-agent",
    sessionId,
    version: 1,
  },
  id: `${sessionId}-start`,
  parentId: null,
  timestamp,
  type: "session.start",
});

const createEvent = (
  id: string,
  type: string,
  data: Readonly<Record<string, unknown>>,
  parentId: string | null,
) => ({
  data,
  id,
  parentId,
  timestamp,
  type,
});

const writeSession = async (
  root: string,
  sessionId: string,
  lines: readonly string[],
): Promise<string> => {
  const directory = join(root, sessionId);
  await mkdir(directory, {
    recursive: true,
  });
  const path = join(directory, "events.jsonl");
  await writeFile(path, lines.join("\n"), "utf8");
  return path;
};

describe("capture reconciliation", () => {
  it("replays only events absent from queue and canonical watermarks", async () => {
    const root = await createTemporaryDirectory();
    const queueRoot = join(root, "queue");
    const sessionRoot = join(root, "session-state");
    let queueSequence = 0;
    const queue = new WindowsCaptureQueue(queueRoot, {
      idGenerator: () => `queue-${queueSequence += 1}`,
    });
    await queue.initialize();
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0",
      copyLimits: {
        maxStringChars: 1_024,
      },
      sessionId: "session-1",
    });
    mapper.map(header());
    const existing = mapper.map(
      createEvent(
        "user-existing",
        "user.message",
        {
          content: "already queued",
        },
        "session-1-start",
      ),
    );
    if (existing.status !== "mapped") {
      throw new Error("Expected a mapped fixture event.");
    }
    await queue.enqueue(existing.value, {
      environment: {},
    });
    const canonicalTool = mapper.map(
      createEvent(
        "tool-start-existing",
        "tool.execution_start",
        {
          arguments: {
            command: "npm test",
          },
          toolCallId: "tool-call-1",
          toolName: "powershell",
        },
        "user-existing",
      ),
    );
    if (canonicalTool.status !== "mapped") {
      throw new Error("Expected a mapped canonical fixture event.");
    }
    const canonical: CanonicalCaptureWatermark = {
      deduplicationKeys: async () =>
        new Set([
          createCaptureDeduplicationKey(canonicalTool.value),
        ]),
    };
    const path = await writeSession(
      sessionRoot,
      "session-1",
      [
        JSON.stringify(header()),
        JSON.stringify(
          createEvent(
            "user-existing",
            "user.message",
            {
              content: "already queued",
            },
            "session-1-start",
          ),
        ),
        JSON.stringify(
          createEvent(
            "tool-start-existing",
            "tool.execution_start",
            {
              arguments: {
                command: "npm test",
              },
              toolCallId: "tool-call-1",
              toolName: "powershell",
            },
            "user-existing",
          ),
        ),
        "{not-json}",
        JSON.stringify(
          createEvent(
            "tool-complete-missing",
            "tool.execution_complete",
            {
              result: {
                content: "passed",
              },
              success: true,
              toolCallId: "tool-call-1",
            },
            "tool-start-existing",
          ),
        ),
        JSON.stringify(
          createEvent(
            "future-missing",
            "future.persisted_event",
            {},
            "tool-complete-missing",
          ),
        ),
        "{\"id\":",
      ],
    );
    const diagnostics: string[] = [];
    const reconciler = new CaptureReconciler({
      canonical,
      copyLimits: {
        maxStringChars: 1_024,
      },
      maxLineChars: 10_000,
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
      queue,
    });

    const first = await reconciler.reconcileSessionFile({
      expectedSessionId: "session-1",
      path,
    });

    expect(first).toMatchObject({
      status: "reconciled",
      adapterVersion: "1.0.82-0",
      duplicateEvents: 2,
      ignoredEvents: 0,
      malformedEvents: 0,
      parserIssues: 1,
      partialTail: true,
      queuedEvents: 3,
      scannedEvents: 5,
      sessionId: "session-1",
      unsupportedEvents: 1,
      incompleteEvents: 1,
      repairedEvents: 0,
      repairPendingEvents: 0,
      unverifiedExistingEvents: 1,
    });
    expect(diagnostics).toEqual([
      expect.stringContaining("malformed_json at line 4"),
    ]);
    const queued = await queue.list();
    expect(queued.find((item) => item.envelope.sourceEventId === "tool-complete-missing")
      ?.envelope.event.captureQuality?.omittedFields).toContain("verification.exitCode");
    expect(queued.some((item) => item.envelope.event.eventType === "test.completed")).toBe(false);
    expect(
      queued.map(
        (item) => item.envelope.sourceEventId,
      ),
    ).toEqual([
      "user-existing",
      "session-1-start",
      "tool-complete-missing",
      "future-missing",
    ]);

    const second = await reconciler.reconcileSessionFile({
      expectedSessionId: "session-1",
      path,
    });
    expect(second).toMatchObject({
      status: "reconciled",
      duplicateEvents: 5,
      queuedEvents: 0,
    });
  });

  it("skips internal sessions before reading their event bodies", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const path = await writeSession(
      join(root, "session-state"),
      "internal-session",
      [
        JSON.stringify(header("internal-session")),
        "x".repeat(20_000),
      ],
    );
    const reconciler = new CaptureReconciler({
      canonical: emptyCanonical,
      copyLimits: {
        maxStringChars: 1_024,
      },
      internalSessionIds: new Set([
        "internal-session",
      ]),
      maxLineChars: 1_000,
      queue,
    });

    expect(
      await reconciler.reconcileSessionFile({
        expectedSessionId: "internal-session",
        path,
      }),
    ).toEqual({
      status: "skipped_internal",
      adapterVersion: "1.0.82-0",
      sessionId: "internal-session",
    });
    expect(await queue.list()).toEqual([]);
  });

  it("reports metadata-only capture as repair pending instead of silently complete", async () => {
      const root = await createTemporaryDirectory();
      const queue = new WindowsCaptureQueue(join(root, "queue"));
      await queue.initialize();
      await queue.enqueue({
        adapter: "copilot-cli", adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted", sessionId: "session-1",
        sourceEventId: "partial-user", timestamp, trust: "user",
        contentDigest: "a".repeat(64),
      }, { environment: {} });
      const path = await writeSession(root, "session-1", [
        JSON.stringify(header()),
        JSON.stringify(createEvent("partial-user", "user.message", { content: "full source message" }, null)),
      ]);
      const reconciler = new CaptureReconciler({
        canonical: emptyCanonical, queue, copyLimits: { maxStringChars: 1_024 }, maxLineChars: 10_000,
      });
      expect(await reconciler.reconcileSessionFile({ path })).toMatchObject({
        status: "reconciled", incompleteEvents: 1, repairPendingEvents: 1, repairedEvents: 0,
      });
      const partial = (await queue.list()).find((item) => item.envelope.sourceEventId === "partial-user");
      expect(partial?.envelope.content).toBeUndefined();
    });

  it("uses an explicit canonical repair hook and honors deleted results", async () => {
      const root = await createTemporaryDirectory();
      const queue = new WindowsCaptureQueue(join(root, "queue"));
      await queue.initialize();
      const input = {
        adapter: "copilot-cli", adapterVersion: "1.0.82-0", eventType: "prompt.submitted",
        sessionId: "session-1", sourceEventId: "deleted-user",
      };
      const identity = createCaptureDeduplicationKey(input);
      const path = await writeSession(root, "session-1", [
        JSON.stringify(header()),
        JSON.stringify(createEvent("deleted-user", "user.message", { content: "do not resurrect" }, null)),
      ]);
      let repairs = 0;
      const reconciler = new CaptureReconciler({
        canonical: {
          deduplicationKeys: async () => new Set([identity]),
          captureCompleteness: async () => new Map([[identity, "incomplete" as const]]),
        },
        queue, copyLimits: { maxStringChars: 1_024 }, maxLineChars: 10_000,
        repairCapture: async () => { repairs += 1; return "deleted"; },
      });
      expect(await reconciler.reconcileSessionFile({ path })).toMatchObject({
        incompleteEvents: 1, repairPendingEvents: 0, repairedEvents: 0,
      });
      expect(repairs).toBe(1);
      expect((await queue.list()).some((item) => item.envelope.sourceEventId === "deleted-user")).toBe(false);
    });

  it("reports incompatible and mismatched Session files explicitly", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const sessionRoot = join(root, "session-state");
    const incompatiblePath = await writeSession(
      sessionRoot,
      "old-session",
      [
        `${JSON.stringify(header("old-session", "1.0.70-0"))}\n`,
      ],
    );
    const mismatchPath = await writeSession(
      sessionRoot,
      "directory-session",
      [
        `${JSON.stringify(header("header-session"))}\n`,
      ],
    );
    const reconciler = new CaptureReconciler({
      canonical: emptyCanonical,
      copyLimits: {
        maxStringChars: 1_024,
      },
      maxLineChars: 10_000,
      queue,
    });

    expect(
      await reconciler.reconcileSessionFile({
        expectedSessionId: "old-session",
        path: incompatiblePath,
      }),
    ).toEqual({
      status: "incompatible",
      adapterVersion: "1.0.70-0",
      fileVersion: 1,
      reason: "unsupported_adapter_version",
    });
    expect(
      await reconciler.reconcileSessionFile({
        expectedSessionId: "directory-session",
        path: mismatchPath,
      }),
    ).toEqual({
      status: "malformed",
      lineNumber: 1,
      reason: "Session directory identity does not match session.start.",
    });
  });
});

describe("Windows Copilot Session discovery", () => {
  it("resolves COPILOT_HOME and returns recent event files", async () => {
    const root = await createTemporaryDirectory();
    const copilotHome = join(root, "custom-copilot");
    const sessionRoot = join(copilotHome, "session-state");
    await writeSession(sessionRoot, "session-a", [
      JSON.stringify(header("session-a")),
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await writeSession(sessionRoot, "session-b", [
      JSON.stringify(header("session-b")),
    ]);
    await mkdir(join(sessionRoot, "session-without-events"));

    expect(
      resolveCopilotSessionStateRoot({
        COPILOT_HOME: copilotHome,
      }),
    ).toBe(sessionRoot);
    const discovered = await discoverCopilotSessionFiles(
      sessionRoot,
      {
        maxSessions: 1,
      },
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      sessionId: "session-b",
      path: join(sessionRoot, "session-b", "events.jsonl"),
    });
  });
});
