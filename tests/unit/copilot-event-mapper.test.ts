import { describe, expect, it } from "vitest";

import { captureQualitySchema } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import {
  BoundedCaptureBuffer,
  captureGapEvent,
  CopilotEventMapper,
} from "@provenloop/copilot-adapter";

const timestamp = "2026-08-29T00:00:00.000Z";

const createMapper = (): CopilotEventMapper =>
  new CopilotEventMapper({
    adapterVersion: "1.0.82-0",
    copyLimits: {
      maxStringChars: 64,
    },
    sessionId: "session-1",
    workspace: {
      branch: "feat/batch3-extension-capture",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      repoId: "repo-1",
      worktree: "worktree-1",
    },
  });

const event = (
  type: string,
  data: Readonly<Record<string, unknown>>,
) => ({
  data,
  id: `event-${type}`,
  parentId: null,
  timestamp,
  type,
});

describe("Copilot event mapping", () => {
  it("maps a Session file header into session.started", () => {
    const mapper = createMapper();
    const result = mapper.map({
      data: {
        context: {
          branch: "feature/from-header",
          gitRoot: "C:\\repo",
          headCommit: "abcdef1234567890abcdef1234567890abcdef12",
        },
        copilotVersion: "1.0.82-0",
        sessionId: "session-1",
        version: 1,
      },
      id: "session-start-1",
      parentId: null,
      timestamp,
      type: "session.start",
    });

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        branch: "feature/from-header",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        eventType: "session.started",
        protocol: "copilot-session-file",
        protocolVersion: "1",
        worktree: "C:\\repo",
      },
    });
  });

  it.each([
    [
      "user.message",
      {
        content: "Implement the queue.",
      },
      "prompt.submitted",
    ],
    [
      "assistant.message",
      {
        content: "Implemented.",
        messageId: "message-1",
      },
      "agent.message",
    ],
    [
      "assistant.turn_start",
      {
        turnId: "turn-1",
        interactionId: "interaction-1",
        model: "gpt-5.6-sol",
      },
      "agent.turn_started",
    ],
    [
      "assistant.turn_end",
      {
        turnId: "turn-1",
      },
      "agent.turn_completed",
    ],
    [
      "session.idle",
      {
        aborted: false,
      },
      "session.idle",
    ],
    [
      "session.error",
      {
        errorType: "rate_limit",
        message: "Retry later.",
      },
      "session.error",
    ],
    [
      "session.shutdown",
      {
        codeChanges: {
          filesModified: [
            "src/index.ts",
          ],
          linesAdded: 10,
          linesRemoved: 2,
        },
        shutdownType: "routine",
      },
      "session.ended",
    ],
    [
      "subagent.started",
      {
        agentDisplayName: "Reviewer",
        agentName: "reviewer",
        toolCallId: "subagent-call-1",
      },
      "subagent.started",
    ],
    [
      "subagent.completed",
      {
        agentDisplayName: "Reviewer",
        agentName: "reviewer",
        toolCallId: "subagent-call-1",
      },
      "subagent.completed",
    ],
    [
      "subagent.failed",
      {
        agentDisplayName: "Reviewer",
        agentName: "reviewer",
        error: "Agent failed.",
        toolCallId: "subagent-call-1",
      },
      "subagent.failed",
    ],
  ])("maps %s to %s", (sourceType, data, canonicalType) => {
    const result = createMapper().map(event(sourceType, data));

    expect(result.status).toBe("mapped");
    if (result.status === "mapped") {
      expect(result.value).toMatchObject({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/batch3-extension-capture",
        eventType: canonicalType,
        repoId: "repo-1",
        sessionId: "session-1",
        sourceEventId: `event-${sourceType}`,
      });
    }
  });

  it("correlates tool completion with its start event", () => {
    const mapper = createMapper();
    const started = mapper.map(
      event("tool.execution_start", {
        arguments: {
          command: "npm test",
        },
        toolCallId: "tool-call-1",
        toolName: "powershell",
        model: "gpt-5.6-sol",
      }),
    );
    const completed = mapper.map(
      event("tool.execution_complete", {
        error: {
          message: "Tests failed.",
        },
        success: false,
        toolCallId: "tool-call-1",
        model: "gpt-5.6-sol",
      }),
    );

    expect(started).toMatchObject({
      status: "mapped",
      value: {
        completionStatus: "running",
        content: {
          toolArguments: {
            command: "npm test",
          },
        },
        eventType: "tool.started",
        operationId: "tool-call-1",
        resolvedModel: "gpt-5.6-sol",
        toolName: "powershell",
      },
    });
    expect(completed).toMatchObject({
      status: "mapped",
      value: {
        completionStatus: "failed",
        eventType: "tool.failed",
        operationId: "tool-call-1",
        resolvedModel: "gpt-5.6-sol",
        toolName: "powershell",
      },
    });
  });

  it("preserves assistant model attribution", () => {
    const result = createMapper().map(
      event("assistant.message", {
        content: "done",
        messageId: "message-1",
        model: "gpt-5.6-sol",
      }),
    );

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        resolvedModel: "gpt-5.6-sol",
      },
    });
  });

  it.each([
    "user.message",
    "assistant.message",
  ])("accepts empty content for %s", (eventType) => {
    const result = createMapper().map(
      event(
        eventType,
        eventType === "user.message"
          ? {
              content: "",
            }
          : {
              content: "",
              messageId: "message-1",
              toolRequests: [
                {
                  name: "powershell",
                  toolCallId: "tool-call-1",
                },
              ],
            },
      ),
    );

    expect(result.status).toBe("mapped");
    if (result.status === "mapped") {
      expect(result.value.content).toBeUndefined();
    }
  });

  it("preserves known content blocks and marks unknown structured fields as omitted", () => {
    const result = createMapper().map(
      event("tool.execution_complete", {
        result: {
          content: "ok",
          contents: [
            {
              type: "text",
              text: "displayed output",
            },
          ],
          structuredContent: {
            secret: "not inspected in callback",
          },
        },
        success: true,
        toolCallId: "tool-call-1",
      }),
    );

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        content: {
          toolResult: {
            content: "ok",
            contents: [{ type: "text", text: "displayed output" }],
            structuredContent: {
              kind: "object",
              status: "omitted_in_callback",
            },
          },
        },
      },
    });
  });

  it("records cancelled subagents without fabricating success", () => {
    const result = createMapper().map(
      event("subagent.completed", {
        agentDisplayName: "Reviewer",
        agentName: "reviewer",
        cancelled: true,
        toolCallId: "subagent-call-1",
      }),
    );

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        completionStatus: "cancelled",
      },
    });
  });

  it.each(["truncated", "omitted"] as const)("bounds %s quality fields before envelope validation", (kind) => {
    const text = "x".repeat(128);
    const arrays = Object.fromEntries(["paths", "files", "targets", "changedFiles"].map((key) => [
      key, Array.from({ length: 32 }, () => kind === "truncated" ? text : {}),
    ]));
    const mapped = createMapper().map(event("tool.execution_complete", {
      success: true,
      toolCallId: "quality-limit",
      result: {
        ...arrays, content: text, detailedContent: text,
        structuredContent: { ...arrays, command: text },
        contents: Array.from({ length: 32 }, () => ({
          type: "terminal", text, cwd: text, shellId: text, outputFilePath: text, outputPreview: text,
          ...(kind === "omitted" ? { exitCode: "invalid" } : {}),
        })),
      },
    }));
    if (mapped.status !== "mapped") throw new Error("Expected a mapped completion.");
    const quality = captureQualitySchema.parse(mapped.value.captureQuality);
    const field = kind === "truncated" ? "truncatedFields" : "omittedFields";
    expect(quality[field]).toHaveLength(256);
    expect(quality[field]).toContain(`captureQuality.${field}`);
    expect(quality.originalLengths[`captureQuality.${field}`]).toBeGreaterThan(256);
    expect(Object.keys(quality.originalLengths).length).toBeLessThanOrEqual(256);
    const envelope = createCaptureEnvelope(mapped.value);
    expect(envelope.event.captureQuality?.[field]).toContain(`captureQuality.${field}`);
    const buffer = new BoundedCaptureBuffer({
      maxBytes: Buffer.byteLength(JSON.stringify(mapped.value)) - 1,
      maxItems: 10, maxGapContexts: 1, maxGapBytes: 4_096,
    });
    expect(buffer.offer(mapped.value).status).toBe("degraded");
    const degraded = buffer.shift();
    if (degraded === undefined) throw new Error("Expected a metadata-only event.");
    expect(createCaptureEnvelope(degraded).event.captureQuality?.omittedFields).toContain("content");
  });

  it.each([
    [
      {
        content: "human",
      },
      "user",
      undefined,
    ],
    [
      {
        content: "autopilot",
        isAutopilotContinuation: true,
      },
      "system",
      "copilot-autopilot-continuation",
    ],
    [
      {
        content: "agent prompt",
        source: "agent-reviewer",
      },
      "model",
      "agent-reviewer",
    ],
    [
      {
        content: "skill injection",
        source: "skill-pdf",
      },
      "system",
      "skill-pdf",
    ],
  ])(
    "classifies user.message provenance",
    (data, trust, actorId) => {
      const result = createMapper().map(event("user.message", data));

      expect(result).toMatchObject({
        status: "mapped",
        value: {
          trust,
          ...(actorId === undefined ? {} : { actorId }),
        },
      });
    },
  );

  it("maps an explicitly structured user correction", () => {
    const result = createMapper().map(
      event("user.message", {
        content: [
          "Violated: wrong runner",
          "Expected: use Vitest",
          "Trigger: package tests",
        ].join("\n"),
      }),
    );

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        eventType: "user.corrected",
        trust: "user",
      },
    });
  });

  it("retains unknown persisted events through an unsupported path", () => {
    const result = createMapper().map(
      event("future.persisted_event", {
        sensitiveContent: "not copied",
      }),
    );

    expect(result).toMatchObject({
      status: "unsupported",
      value: {
        eventType: "future.persisted_event",
        sourceEventId: "event-future.persisted_event",
      },
    });
    if (result.status === "unsupported") {
      expect(result.value.content).toBeUndefined();
    }
  });

  it("updates the workspace snapshot from context change events", () => {
    const mapper = createMapper();
    const contextChanged = mapper.map(
      event("session.context_changed", {
        branch: "feature/new-context",
        cwd: "C:\\repo\\worktree",
        gitRoot: "C:\\repo",
        headCommit: "abcdef1234567890abcdef1234567890abcdef12",
        repository: "owner/repository",
      }),
    );
    const next = mapper.map(
      event("user.message", {
        content: "continue",
      }),
    );

    expect(contextChanged).toMatchObject({
      status: "unsupported",
      value: {
        branch: "feature/new-context",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        repoId: "owner/repository",
        worktree: "C:\\repo",
      },
    });
    expect(next).toMatchObject({
      status: "mapped",
      value: {
        branch: "feature/new-context",
        commitSha: "abcdef1234567890abcdef1234567890abcdef12",
        repoId: "owner/repository",
        worktree: "C:\\repo",
      },
    });
  });

  it("does not attribute a pending workspace switch to the old repository", () => {
    const mapper = createMapper();
    const pending = mapper.map(
      event("session.context_changed", {
        branch: "feature/not-settled",
        cwd: "C:\\repo\\other",
        pendingGitContext: true,
      }),
    );
    const next = mapper.map(
      event("user.message", {
        content: "continue",
      }),
    );

    expect(pending.status).toBe("unsupported");
    expect(next).toMatchObject({
      status: "mapped",
      value: {
        repositoryState: "unknown",
        worktree: "C:\\repo\\other",
      },
    });
  });

  it("retains a canonical Git identity when host context names the same worktree", () => {
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0",
      copyLimits: { maxStringChars: 1024 },
      sessionId: "session-1",
      workspace: {
        repoId: "C:/repos/DirExchangeMgmtApi/.git",
        repositoryState: "known_repo",
        worktree: "C:/repos/DirExchangeMgmtApi",
      },
    });
    mapper.map(event("session.context_changed", {
      cwd: "C:/repos/DirExchangeMgmtApi/src",
      gitRoot: "c:/repos/DirExchangeMgmtApi/",
      repository: "DefaultCollection/O365 Core/DirExchangeMgmtApi",
    }));
    const next = mapper.map(event("user.message", { content: "Inspect the review configuration." }));

    expect(next).toMatchObject({
      status: "mapped",
      value: { repoId: "C:/repos/DirExchangeMgmtApi/.git", repositoryState: "known_repo" },
    });
  });

  it("clears canonical identity when host context explicitly leaves the repository", () => {
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0",
      copyLimits: { maxStringChars: 1024 },
      sessionId: "session-1",
      workspace: { repoId: "C:/repo/.git", worktree: "C:/repo", repositoryState: "known_repo" },
    });
    mapper.map(event("session.context_changed", { cwd: "C:/repo", gitRoot: null, repository: null }));
    const next = mapper.map(event("user.message", { content: "Inspect tenant access." }));

    expect(next).toMatchObject({ status: "mapped", value: { repositoryState: "known_outside_repo" } });
    if (next.status === "mapped") expect(next.value.repoId).toBeUndefined();
  });

  it("ignores ephemeral streaming content", () => {
    const result = createMapper().map({
      ...event("assistant.message_delta", {
        deltaContent: "partial",
      }),
      ephemeral: true,
    });

    expect(result).toEqual({
      status: "ignored",
      eventType: "assistant.message_delta",
      reason: "ephemeral",
      sourceEventId: "event-assistant.message_delta",
    });
  });

  it("reports missing required fields as malformed", () => {
    const result = createMapper().map(
      event("tool.execution_start", {
        toolName: "powershell",
      }),
    );

    expect(result).toMatchObject({
      status: "malformed",
      issues: [
        "toolCallId must be a non-empty string.",
      ],
    });
  });

  it.each([undefined, "", 42])("requires the native assistant turn-start turnId (%s)", (turnId) => {
    expect(createMapper().map(event("assistant.turn_start", { turnId }))).toMatchObject({
      status: "malformed", issues: ["turnId must be a non-empty string."],
    });
  });

  it("rejects non-ISO timestamps before queueing", () => {
    const result = createMapper().map({
      data: {
        content: "hello",
      },
      id: "event-1",
      parentId: null,
      timestamp: "August 29, 2026",
      type: "user.message",
    });

    expect(result).toMatchObject({
      status: "malformed",
      issues: [
        "timestamp must be an ISO-8601 string.",
      ],
    });
  });

  it("requires the complete SDK event envelope", () => {
    const result = createMapper().map({
      id: "event-1",
      timestamp,
      type: "future.persisted_event",
    });

    expect(result).toMatchObject({
      status: "malformed",
      issues: [
        "parentId is required.",
        "data must be an object.",
      ],
    });
  });

  it("bounds copied content before it enters the buffer", () => {
    const result = createMapper().map(
      event("user.message", {
        content: "x".repeat(1_000),
      }),
    );

    expect(result).toMatchObject({
      status: "mapped",
      value: {
        content: {
          message: "x".repeat(64),
        },
      },
    });
  });

  it("does not enumerate arbitrary objects in the callback", () => {
    const mapper = new CopilotEventMapper({
      adapterVersion: "1.0.82-0",
      copyLimits: {
        maxStringChars: 64,
      },
      sessionId: "session-1",
    });
    const argumentsWithDangerousTail = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("Argument keys must not be enumerated.");
        },
      },
    );

    expect(() =>
      mapper.map(
        event("tool.execution_start", {
          arguments: argumentsWithDangerousTail,
          toolCallId: "tool-call-1",
          toolName: "powershell",
        }),
      ),
    ).not.toThrow();
  });
});

describe("bounded capture buffer", () => {
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

  it("degrades content when only metadata fits", () => {
    const buffer = new BoundedCaptureBuffer({
      maxGapBytes: 8_192,
      maxGapContexts: 4,
      maxBytes: 500,
      maxItems: 10,
    });

    expect(
      buffer.offer(captureEvent("event-1", "x".repeat(1_000))),
    ).toEqual({
      status: "degraded",
    });
    expect(buffer.peek()).toMatchObject({
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceEventId: "event-1",
    });
    expect(buffer.peek()?.content).toBeUndefined();
    expect(buffer.pendingGap).toMatchObject({
      contentOmittedCount: 1,
      droppedEventCount: 0,
      firstSourceEventId: "event-1",
    });
  });

  it("records a gap when the item limit drops an event", () => {
    const buffer = new BoundedCaptureBuffer({
      maxGapBytes: 8_192,
      maxGapContexts: 4,
      maxBytes: 10_000,
      maxItems: 1,
    });

    expect(buffer.offer(captureEvent("event-1", "first"))).toEqual({
      status: "accepted",
    });
    expect(buffer.offer(captureEvent("event-2", "second"))).toEqual({
      status: "dropped",
    });
    expect(buffer.pendingGap).toMatchObject({
      contentOmittedCount: 1,
      droppedEventCount: 1,
      firstSourceEventId: "event-2",
      lastSourceEventId: "event-2",
      reasons: [
        "buffer_item_limit",
      ],
    });
  });

  it("converts a gap into a canonical capture event", () => {
    const buffer = new BoundedCaptureBuffer({
      maxGapBytes: 8_192,
      maxGapContexts: 4,
      maxBytes: 10_000,
      maxItems: 1,
    });
    buffer.offer(captureEvent("event-1", "first"));
    buffer.offer(captureEvent("event-2", "second"));
    const gap = buffer.takeGap();

    expect(gap).toBeDefined();
    if (gap === undefined) {
      throw new Error("Expected a capture gap.");
    }
    expect(captureGapEvent(gap)).toMatchObject({
      eventType: "capture_gap",
      sessionId: "session-1",
      sourceEventId: expect.stringMatching(/^capture-gap-/u),
    });
  });

  it("splits gaps when repository context changes", () => {
    const buffer = new BoundedCaptureBuffer({
      maxGapBytes: 8_192,
      maxGapContexts: 4,
      maxBytes: 10_000,
      maxItems: 1,
    });
    buffer.offer(captureEvent("event-1", "first"));
    buffer.offer({
      ...captureEvent("event-2", "second"),
      branch: "feature/a",
      repoId: "repo-a",
    });
    buffer.offer({
      ...captureEvent("event-3", "third"),
      branch: "feature/b",
      repoId: "repo-b",
    });

    expect(buffer.takeGap()).toMatchObject({
      branch: "feature/a",
      firstSourceEventId: "event-2",
      lastSourceEventId: "event-2",
      repoId: "repo-a",
    });
    expect(buffer.takeGap()).toMatchObject({
      branch: "feature/b",
      firstSourceEventId: "event-3",
      lastSourceEventId: "event-3",
      repoId: "repo-b",
    });
  });

  it("bounds gap contexts and marks mixed attribution", () => {
    const buffer = new BoundedCaptureBuffer({
      maxGapBytes: 4_096,
      maxGapContexts: 1,
      maxBytes: 10_000,
      maxItems: 1,
    });
    buffer.offer(captureEvent("event-1", "first"));
    for (let index = 2; index <= 100; index += 1) {
      buffer.offer({
        ...captureEvent(`event-${index}`, "dropped"),
        branch: `feature/${index}`,
        repoId: `repo-${index}`,
      });
    }

    expect(buffer.byteCount).toBeLessThanOrEqual(14_096);
    expect(buffer.takeGap()).toMatchObject({
      contentOmittedCount: 99,
      contextMixed: true,
      droppedEventCount: 99,
      firstSourceEventId: "event-2",
      lastSourceEventId: "event-100",
    });
    expect(buffer.takeGap()).toBeUndefined();
  });
});
