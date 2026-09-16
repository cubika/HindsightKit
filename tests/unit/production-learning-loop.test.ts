import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runCaptureWorkerOnce, runMcpServer } from "@provenloop/cli";
import {
  CopilotEventMapper,
  createDefaultCopilotAdapterState,
  TrustedSessionContextPublisher,
  writeCopilotAdapterState,
  type CopilotSessionEvent,
} from "@provenloop/copilot-adapter";
import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

import { contextWithDeadlineRetries } from "../fixtures/context-with-deadline-retries.js";

const roots: string[] = [];
const repoId = "repo-production-loop";
const head = "a".repeat(40);

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const seed = async (resultKind: "passed" | "failed" | "text_only" | "outside") => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-production-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await mkdir(paths.backends);
  await writeFile(paths.rootMarker, JSON.stringify({
    product: "ProvenLoop",
    schemaVersion: 1,
    root,
  }));
  const initial = createDefaultCopilotAdapterState(new Date());
  await writeCopilotAdapterState(paths.adapterState, {
    ...initial,
    installed: true,
    pluginEnabled: true,
    pluginInstalled: true,
    marketplaceRegistered: true,
    capabilities: {
      ...initial.capabilities,
      capture: { enabled: true },
      worker: { enabled: true },
      retrieval: { enabled: true },
      correction_learning: { enabled: true },
    },
  });
  new CanonicalSqliteStore(paths.database).close();
  const queue = new WindowsCaptureQueue(paths.queue);
  await queue.initialize();
  const mapper = new CopilotEventMapper({
    adapterVersion: "1.0.81-0",
    sessionId: "work-session",
    copyLimits: { maxStringChars: 16_384 },
    workspace: {
      cwd: root,
      worktree: root,
      repoId,
      repositoryState: "known_repo",
      branch: "main",
      commitSha: head,
    },
  });
  const base = Date.now() - 8_000;
  const events: CopilotSessionEvent[] = [
    {
      id: "user-correction",
      parentId: null,
      timestamp: new Date(base).toISOString(),
      type: "user.message",
      data: {
        content: [
          "Violated Constraint: Used the wrong repository test command",
          "Expected Behavior: Run npm test for package validation",
          "Trigger: package validation",
          "Task Family: testing",
          "Subsystem: test-runner",
          "Scope: repository",
        ].join("\n"),
      },
    },
    {
      // Copilot SDK d3755535869e97d2bcf5aa6a5b8c35de79f5a7d8: AssistantTurnStartData requires turnId.
      id: "assistant-turn",
      parentId: "user-correction",
      timestamp: new Date(base + 1_000).toISOString(),
      type: "assistant.turn_start",
      data: { turnId: "turn-1" },
    },
    {
      id: "assistant-message",
      parentId: "assistant-turn",
      timestamp: new Date(base + 2_000).toISOString(),
      type: "assistant.message",
      data: {
        messageId: "message-1",
        content: "Running the requested test command.",
      },
    },
    {
      id: "test-operation",
      parentId: "assistant-message",
      timestamp: new Date(base + 3_000).toISOString(),
      type: "tool.execution_start",
      data: {
        toolCallId: "test-call",
        toolName: "powershell",
        arguments: { command: "npm test", cwd: root },
      },
    },
    {
      id: "test-completion",
      parentId: "test-operation",
      timestamp: new Date(base + 4_000).toISOString(),
      type: "tool.execution_complete",
      data: {
        toolCallId: "test-call",
        success: true,
        result: {
          content: "Tool output preview: tests passed.",
          ...(resultKind === "text_only" ? {} : {
            contents: [{
              type: "shell_exit",
              shellId: "test-shell",
              cwd: resultKind === "outside" ? tmpdir() : root,
              exitCode: resultKind === "failed" ? 1 : 0,
              outputPreview: "Tool output preview.",
              outputTruncated: true,
            }],
          }),
        },
      },
    },
  ];
  for (const event of events) {
    const mapped = mapper.map(event);
    if (mapped.status !== "mapped") {
      throw new Error(
        `Expected SDK event to map: ${String(event.type)} (${
          mapped.status === "malformed" ? mapped.issues.join("; ") : mapped.status
        })`,
      );
    }
    for (const value of [mapped.value, ...(mapped.additionalEvents ?? [])]) {
      await queue.enqueue(value, { environment: {} });
    }
  }
  const result = await runCaptureWorkerOnce({
    dataRoot: root,
    admission: () => ({ allowed: true, reasons: [] }),
  });
  expect(result).toMatchObject({ status: "completed", failed: 0, unsupported: 0 });
  return paths;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const callMcp = async (
  dataRoot: string,
  sessionId: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  const running = runMcpServer({ input, output }, { dataRoot, sessionId });
  input.end(`${JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
  })}\n`);
  await running;
  const message: unknown = JSON.parse(text);
  if (!isRecord(message) || !isRecord(message.result) ||
      !isRecord(message.result.structuredContent)) {
    throw new Error(`Unexpected MCP response: ${text}`);
  }
  return message.result.structuredContent;
};

describe("production learning and reuse path", () => {
  it("uses native SDK shell-exit evidence through the queue, worker, MCP and user feedback", async () => {
    const paths = await seed("passed");
    const store = new CanonicalSqliteStore(paths.database);
    const publisher = new TrustedSessionContextPublisher({
      dataRoot: paths.root,
      cwd: paths.root,
      sessionId: "next-session",
      repositoryId: repoId,
      branch: "main",
      commitSha: head,
      onError: (error) => { throw error; },
    });
    const otherPublisher = new TrustedSessionContextPublisher({
      dataRoot: paths.root,
      cwd: tmpdir(),
      sessionId: "other-repository-session",
      repositoryId: "different-repository",
      branch: "main",
      commitSha: head,
      onError: (error) => { throw error; },
    });
    try {
      const captured = store.rawEvents();
      const correction = captured.find((event) => event.eventType === "user.corrected");
      if (correction === undefined) throw new Error("Expected the captured human correction.");
      expect(captured.find((event) => event.eventType === "agent.turn_started")?.envelope.event)
        .toMatchObject({
          completionStatus: "running", operationId: "turn-1", trust: "model",
          parentEventId: correction.envelope.event.eventId,
        });
      const learned = store.knowledgeCandidates().filter((item) => item.state === "active");
      expect(learned).toHaveLength(1);
      const candidate = learned[0];
      if (candidate === undefined) {
        throw new Error("The real SDK completion did not produce verified Knowledge.");
      }
      expect(candidate.evidenceTier).toBe("externally_verified");
      expect(candidate.sourceEvidenceIds.length).toBeGreaterThanOrEqual(3);
      await publisher.start();
      const context = await contextWithDeadlineRetries(() =>
        callMcp(paths.root, "next-session", "provenloop_context", {
          prompt: "\u8bf7\u7528 npm test \u505a package validation",
          tokenBudget: 600,
        }),
      );
      expect(context, JSON.stringify(context)).toMatchObject({ status: "ok" });
      expect(context.items, JSON.stringify(context)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: candidate.knowledgeId, kind: "knowledge" }),
      ]));
      if (typeof context.requestId !== "string") {
        throw new Error(`Context did not contain a stable request ID: ${JSON.stringify(context)}`);
      }
      const feedback = {
        action: "helpful",
        requestId: context.requestId,
        targetRef: { id: candidate.knowledgeId, kind: "knowledge" },
        userReportedApplied: true,
      };
      const proposed = await callMcp(paths.root, "next-session", "provenloop_feedback", feedback);
      expect(proposed.status).toBe("confirmation_required");
      if (typeof proposed.confirmationCode !== "string") {
        throw new Error("Feedback did not request real user confirmation.");
      }
      publisher.observeUserMessage({
        eventId: "real-user-approval",
        text: `confirm ${proposed.confirmationCode}`,
        timestamp: new Date().toISOString(),
      });
      await publisher.flush();
      expect(await callMcp(
        paths.root, "next-session", "provenloop_feedback", feedback,
      )).toMatchObject({
        status: "recorded",
        adoption: "user_reported",
        outcome: "unknown",
      });
      expect(store.contextUseRecords("next-session").find((record) =>
        record.requestId === context.requestId,
      ), JSON.stringify(context)).toMatchObject({
        requestId: context.requestId,
        sessionId: "next-session",
        repoId,
        retrievalStatus: "provided",
        feedback: "helpful",
      });
      await otherPublisher.start();
      const otherRepository = await contextWithDeadlineRetries(() =>
        callMcp(
          paths.root, "other-repository-session", "provenloop_context",
          { prompt: "npm test package validation", tokenBudget: 600 },
        ),
      );
      expect(otherRepository, JSON.stringify(otherRepository)).toMatchObject({ status: "ok" });
      expect(otherRepository.items, JSON.stringify(otherRepository)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: candidate.knowledgeId }),
      ]));
    } finally {
      await otherPublisher.stop();
      await publisher.stop();
      store.close();
    }
  });

  it.each(["failed", "text_only", "outside"] as const)(
    "does not certify a correction from %s completion evidence",
    async (kind) => {
      const paths = await seed(kind);
      const store = new CanonicalSqliteStore(paths.database);
      try {
        expect(store.knowledgeCandidates().filter((item) =>
          item.state === "active" &&
          item.evidenceTier === "externally_verified")).toEqual([]);
        if (kind === "failed") {
          expect(store.rawEvents()).toEqual(expect.arrayContaining([
            expect.objectContaining({
              eventType: "test.completed",
              envelope: expect.objectContaining({
                event: expect.objectContaining({
                  completionStatus: "failed",
                  exitCode: 1,
                }),
              }),
            }),
          ]));
        }
        if (kind === "text_only") {
          expect(store.rawEvents().some((event) =>
            event.eventType === "test.completed")).toBe(false);
        }
      } finally {
        store.close();
      }
    },
  );
});
