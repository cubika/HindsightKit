import { describe, expect, it } from "vitest";

import { CopilotEventMapper } from "@provenloop/copilot-adapter";
import {
  boundVerificationOperation,
  createCaptureDeduplicationKey,
  createCaptureEnvelope,
} from "@provenloop/domain";

const timestamp = "2026-09-05T00:00:00.000Z";
const mapper = (maximum = 32_768) => new CopilotEventMapper({
  adapterVersion: "1.0.82-0",
  sessionId: "session-bridge",
  copyLimits: { maxStringChars: maximum },
  workspace: {
    repoId: "repo-1",
    branch: "main",
    commitSha: "a".repeat(40),
    worktree: "C:\\repo",
  },
});
const event = (type: string, id: string, data: Record<string, unknown>) => ({
  type, id, timestamp, parentId: "parent-1", data,
});
// SDK contract: github/copilot-sdk@d3755535869e97d2bcf5aa6a5b8c35de79f5a7d8,
// nodejs/src/generated/session-events.ts: ToolExecutionCompleteContentTerminal.
const terminalResult = (exitCode: number, cwd?: string, text = "finished") => ({
  content: text,
  contents: [{ type: "terminal", text, exitCode, ...(cwd === undefined ? {} : { cwd }) }],
});
const run = (
  command: string,
  result: Record<string, unknown>,
  success = true,
  cwd?: string,
  extraArguments: Record<string, unknown> = {},
) => {
  const capture = mapper();
  capture.map(event("tool.execution_start", "start-1", {
    toolName: "powershell", toolCallId: "call-1",
    arguments: { command, ...(cwd === undefined ? {} : { cwd }), ...extraArguments },
  }));
  return capture.map(event("tool.execution_complete", "complete-1", {
    toolCallId: "call-1", success, result,
  }));
};

describe("capture semantic bridge", () => {
  it("emits a persisted binding accepted by the domain proof contract", () => {
    const capture = mapper();
    const sources = [
      {
        ...event("user.message", "causal-correction", {
          content: "violated: skipped tests\nexpected: run tests\ntrigger: validation",
        }),
        parentId: null,
      },
      {
        ...event("assistant.turn_start", "causal-turn", { turnId: "turn-1" }),
        parentId: "causal-correction",
        timestamp: "2026-09-05T00:00:01.000Z",
      },
      {
        ...event("assistant.message", "causal-assistant", { messageId: "answer", content: "Checking" }),
        parentId: "causal-turn",
        timestamp: "2026-09-05T00:00:02.000Z",
      },
      {
        ...event("tool.execution_start", "causal-start", {
          toolCallId: "causal-call", toolName: "powershell", arguments: { command: "npm test" },
        }),
        parentId: "causal-assistant",
        timestamp: "2026-09-05T00:00:03.000Z",
      },
      {
        ...event("tool.execution_complete", "causal-complete", {
          toolCallId: "causal-call", success: true, result: terminalResult(0),
        }),
        parentId: "causal-start",
        timestamp: "2026-09-05T00:00:04.000Z",
      },
    ];
    const envelopes: ReturnType<typeof createCaptureEnvelope>[] = [];
    for (const source of sources) {
      const mapped = capture.map(source);
      if (mapped.status !== "mapped") throw new Error("Expected a mapped source event");
      for (const input of [mapped.value, ...(mapped.additionalEvents ?? [])]) {
        envelopes.push(createCaptureEnvelope(input));
      }
    }
    const correction = envelopes.find((item) => item.event.eventType === "user.corrected");
    const operation = envelopes.find((item) => item.event.eventType === "tool.started");
    const verification = envelopes.find((item) => item.event.eventType === "test.completed");
    if (correction === undefined || operation === undefined || verification === undefined) {
      throw new Error("Expected the complete capture evidence chain");
    }
    expect(boundVerificationOperation(
      correction, verification, new Map(envelopes.map((item) => [item.event.eventId, item])),
    )).toBe(operation);
  });

  it.each(["git.commit", "verification.completed", "file.changed"])(
    "does not turn an unknown SDK %s event into a trusted canonical fact",
    (type) => {
      expect(mapper().map(event(type, "unrecognized", { exitCode: 0 }))).toMatchObject({
        status: "unsupported",
        value: { eventType: `copilot.unmapped.${type}` },
      });
    },
  );
  it.each([
    ["npm test", "test.completed"],
    ["dotnet test", "test.completed"],
    ["python -m pytest", "test.completed"],
    ["npx --no-install vitest run", "test.completed"],
    ["cargo build", "build.completed"],
    ["npm run build", "build.completed"],
    ["git diff --check", "verification.completed"],
  ])("records structured verification for %s without replacing tool evidence", (command, type) => {
    expect(run(command, terminalResult(0))).toMatchObject({
      status: "mapped",
      value: { eventType: "tool.completed", operationId: "call-1", exitCode: 0 },
      additionalEvents: [{
        eventType: type,
        completionStatus: "succeeded",
        exitCode: 0,
        repoId: "repo-1",
        parentEventId: expect.stringMatching(/^event-/u),
        evidence: {
          kind: "command_verification",
          sourceStartEventId: "start-1",
          sourceCompleteEventId: "complete-1",
          operationId: "call-1",
          repositoryState: "known_repo",
        },
      }],
    });
  });

  it("does not equate a successful tool response with a successful test", () => {
    expect(run("npm test", terminalResult(1), true)).toMatchObject({
      value: { eventType: "tool.completed" },
      additionalEvents: [{ eventType: "test.completed", completionStatus: "failed", exitCode: 1 }],
    });
  });

  it("preserves the actual terminal exit block through the capture envelope", () => {
    const mapped = run("npm test", terminalResult(1, "C:\\repo", "command output"));
    if (mapped.status !== "mapped") throw new Error("Expected tool completion");
    const envelope = createCaptureEnvelope(mapped.value);
    expect(envelope.content?.toolResult).toMatchObject({
      content: "command output",
      contents: [{ type: "terminal", text: "command output", cwd: "C:\\repo", exitCode: 1 }],
    });
  });

  it.each(["powershell", "bash"])("supports %s shell_exit blocks without parsing their preview", (toolName) => {
    const capture = mapper();
    capture.map(event("tool.execution_start", "shell-start", {
      toolCallId: "shell-call", toolName, arguments: { command: "npm test" },
    }));
    expect(capture.map(event("tool.execution_complete", "shell-complete", {
      toolCallId: "shell-call",
      success: true,
      result: {
        content: "preview",
        contents: [{
          type: "shell_exit", shellId: "shell-7", exitCode: 1, cwd: "C:\\repo",
          outputPreview: "all tests passed", outputTruncated: true,
        }],
      },
    }))).toMatchObject({
      additionalEvents: [{ eventType: "test.completed", completionStatus: "failed", exitCode: 1 }],
    });
  });

  it.each([
    { content: "finished", contents: [{ type: "terminal", text: "exit code 0" }] },
    { content: "finished", contents: [{ type: "terminal", text: "", exitCode: "0" }] },
    { content: "finished", contents: [{ type: "terminal", text: "", exitCode: 0.5 }] },
    { content: "finished", contents: [{ type: "shell_exit", exitCode: 0 }] },
    { content: "finished", contents: [{ type: "text", text: '{"exitCode":0}' }] },
    { content: "finished", contents: [{ type: "text", text: "<exited with exit code 0>" }] },
    { content: "finished", contents: [...terminalResult(0).contents, { type: "unknown_completion" }] },
  ])("does not authenticate unknown or malformed shell output %#", (result) => {
    const mapped = run("npm test", result);
    expect(mapped).toMatchObject({
      additionalEvents: [],
      value: { captureQuality: { omittedFields: expect.arrayContaining(["verification.exitCode"]) } },
    });
  });

  it.each(["shell", "terminal", "mcp-powershell"])("does not authenticate a non-native tool %s", (toolName) => {
    const capture = mapper();
    capture.map(event("tool.execution_start", "other-start", {
      toolCallId: "other-call", toolName, arguments: { command: "npm test" },
    }));
    expect(capture.map(event("tool.execution_complete", "other-complete", {
      toolCallId: "other-call", success: true, result: terminalResult(0),
    }))).toMatchObject({ additionalEvents: [] });
  });

  it("does not trust a same-named MCP tool's terminal block", () => {
    const capture = mapper();
    capture.map(event("tool.execution_start", "mcp-start", {
      toolCallId: "mcp-call", toolName: "powershell", mcpServerName: "external", mcpToolName: "powershell",
      arguments: { command: "npm test" },
    }));
    expect(capture.map(event("tool.execution_complete", "mcp-complete", {
      toolCallId: "mcp-call", success: true, result: terminalResult(0),
    }))).toMatchObject({
      additionalEvents: [],
      value: { captureQuality: { omittedFields: expect.arrayContaining(["verification.toolProvenance"]) } },
    });
  });

  it("keeps structured exit metadata even when bounded terminal text is truncated", () => {
    const capture = mapper(8);
    capture.map(event("tool.execution_start", "long-start", {
      toolCallId: "long-call", toolName: "powershell", arguments: { command: "npm test" },
    }));
    expect(capture.map(event("tool.execution_complete", "long-complete", {
      toolCallId: "long-call", success: true, result: terminalResult(0, undefined, "x".repeat(100)),
    }))).toMatchObject({
      additionalEvents: [{ eventType: "test.completed", exitCode: 0 }],
      value: {
        content: { toolResult: { contents: [{ type: "terminal", exitCode: 0, text: "xxxxxxxx" }] } },
        captureQuality: { truncatedFields: expect.arrayContaining(["toolResult.contents[0].text"]) },
      },
    });
  });

  it("does not hide a conflicting exit block beyond the bounded array", () => {
    const result = {
      content: "finished",
      contents: [
        ...terminalResult(0).contents,
        ...Array.from({ length: 31 }, () => ({ type: "text", text: "" })),
        ...terminalResult(1).contents,
      ],
    };
    expect(run("npm test", result)).toMatchObject({
      additionalEvents: [],
      value: { captureQuality: { truncatedFields: ["toolResult.contents"] } },
    });
  });

  it.each([
    ["npm test", { content: "all tests passed" }, true],
    ["npm test", terminalResult(0), false],
    ["npm test", { content: "finished", contents: [...terminalResult(0).contents, ...terminalResult(1).contents] }, true],
    ["npm test", { content: "finished", exitCode: 0 }, true],
    ["npm test", { content: "finished", structuredContent: { exitCode: 0 } }, true],
    ["npm test; echo done", terminalResult(0), true],
    ["npm test --if-present", terminalResult(0), true],
    ["npm test -- --help", terminalResult(0), true],
    ["pytest --co", terminalResult(0), true],
    ["cargo test --no-run", terminalResult(0), true],
    ["npx vitest run --passWithNoTests", terminalResult(0), true],
    ["echo npm test", terminalResult(0), true],
  ])("does not invent verified success for %s", (command, result, success) => {
    expect(run(command, result, success)).toMatchObject({ additionalEvents: [] });
  });

  it("rejects cross-repository working directories and test targets", () => {
    expect(run("npm test", terminalResult(0), true, "C:\\other")).toMatchObject({ additionalEvents: [] });
    expect(run("dotnet test C:\\other\\test.csproj", terminalResult(0))).toMatchObject({ additionalEvents: [] });
    expect(run("npm test", terminalResult(0, "C:\\other"))).toMatchObject({ additionalEvents: [] });
  });

  it.each(["unknown", "known_outside_repo"] as const)("does not override explicit %s with a stale repository id", (repositoryState) => {
    const capture = mapper();
    capture.updateWorkspace({ ...capture.currentWorkspace(), repositoryState });
    expect(capture.currentWorkspace().repositoryState).toBe(repositoryState);
    capture.map(event("tool.execution_start", "uncertain-start", {
      toolName: "powershell", toolCallId: "uncertain-call", arguments: { command: "npm test" },
    }));
    expect(capture.map(event("tool.execution_complete", "uncertain-complete", {
      toolCallId: "uncertain-call", success: true, result: terminalResult(0),
    }))).toMatchObject({ additionalEvents: [] });
  });

  it("does not verify a launch acknowledgement or a reused shell with unknown cwd", () => {
    expect(run("npm test", terminalResult(0), true, undefined, { mode: "async" }))
      .toMatchObject({ additionalEvents: [] });
    expect(run("npm test", terminalResult(0), true, undefined, { shellId: "old-shell" }))
      .toMatchObject({ additionalEvents: [] });
  });

  it("keeps bounded arguments and reports truncation without inspecting arbitrary fields", () => {
    const capture = mapper(8);
    const input = new Proxy({ command: "npm test --long", path: "file.ts" }, {
      ownKeys: () => { throw new Error("Unbounded input enumeration"); },
    });
    expect(capture.map(event("tool.execution_start", "s", {
      toolCallId: "call-1", toolName: "powershell", arguments: input,
    }))).toMatchObject({
      value: {
        content: { toolArguments: { command: "npm test", path: "file.ts" } },
        captureQuality: {
          truncatedFields: ["toolArguments.command"],
          originalLengths: { "toolArguments.command": 15 },
        },
      },
    });
    expect(capture.map(event("tool.execution_complete", "c", {
      toolCallId: "call-1", success: true, result: terminalResult(0),
    }))).toMatchObject({ additionalEvents: [] });
  });

  it.each([
    ["edit", { path: "src\\index.ts" }],
    ["apply_patch", { input: "*** Begin Patch\n*** Update File: src\\index.ts\n@@\n-old\n+new\n*** End Patch" }],
  ])("derives file changes from successful %s operations", (toolName, args) => {
    const capture = mapper();
    capture.map(event("tool.execution_start", "s", {
      toolCallId: "c", toolName, arguments: args,
    }));
    expect(capture.map(event("tool.execution_complete", "e", {
      toolCallId: "c", success: true, result: { content: "updated" },
    }))).toMatchObject({
      value: { eventType: "tool.completed" },
      additionalEvents: [{
        eventType: "file.changed",
        content: { toolArguments: { changedFiles: ["C:\\repo\\src\\index.ts"] } },
        evidence: { kind: "file_change", sourceStartEventId: "s", sourceCompleteEventId: "e" },
      }],
    });
  });

  it("preserves repository identity only across a proven same-worktree context", () => {
    const capture = mapper();
    capture.map(event("session.context_changed", "ctx", { cwd: "C:\\repo", gitRoot: "C:\\repo", branch: "main" }));
    expect(capture.currentWorkspace()).toMatchObject({ repoId: "repo-1", repositoryState: "known_repo" });
    capture.map(event("session.context_changed", "other", { cwd: "C:\\other", branch: "main" }));
    expect(capture.currentWorkspace()).toMatchObject({ repositoryState: "unknown" });
    expect(capture.currentWorkspace().repoId).toBeUndefined();
  });

  it("resolves native edit paths against session cwd even when file text was truncated", () => {
    const capture = mapper(8);
    capture.updateWorkspace({ ...capture.currentWorkspace(), cwd: "C:\\repo\\sub" });
    capture.map(event("tool.execution_start", "s", {
      toolCallId: "c", toolName: "create",
      arguments: { path: "new.ts", file_text: "x".repeat(100) },
    }));
    expect(capture.map(event("tool.execution_complete", "e", {
      toolCallId: "c", success: true, result: { content: "written" },
    }))).toMatchObject({
      additionalEvents: [{
        eventType: "file.changed",
        content: { toolArguments: { changedFiles: ["C:\\repo\\sub\\new.ts"] } },
      }],
    });
  });

  it("records observed HEAD changes without claiming a new commit", () => {
    expect(mapper().updateWorkspace({
      repoId: "repo-1", worktree: "C:\\repo", commitSha: "b".repeat(40), commitParents: ["a".repeat(40)],
    })).toMatchObject({
      eventType: "git.head_changed",
      evidence: { kind: "head_observation" },
    });
  });

  it("binds verification only to a captured correction ancestor, using canonical identities", () => {
      const capture = mapper();
      const correction = capture.map({
        ...event("user.message", "correction", {
          content: "violated: skipped tests\nexpected: run tests\ntrigger: validation",
        }),
        parentId: null,
      });
      if (correction.status !== "mapped") throw new Error("Expected correction");
      capture.map({
        ...event("assistant.message", "assistant", { messageId: "answer", content: "Checking" }),
        parentId: "correction",
      });
      const start = capture.map({
        ...event("tool.execution_start", "bound-start", {
          toolCallId: "bound-call", toolName: "powershell", arguments: { command: "npm test" },
        }),
        parentId: "assistant",
      });
      if (start.status !== "mapped") throw new Error("Expected operation");
      const result = capture.map({
        ...event("tool.execution_complete", "bound-complete", {
          toolCallId: "bound-call", success: true, result: terminalResult(0),
        }),
        parentId: "bound-start",
      });
      expect(result).toMatchObject({
        additionalEvents: [{
          verificationBinding: {
            correctionEventId: `event-${createCaptureDeduplicationKey(correction.value)}`,
            operationEventId: `event-${createCaptureDeduplicationKey(start.value)}`,
          },
        }],
      });
      capture.map({
        ...event("user.message", "unrelated", { content: "Now do something unrelated" }),
        parentId: "correction",
      });
      capture.map({
        ...event("tool.execution_start", "unrelated-start", {
          toolCallId: "unrelated-call", toolName: "powershell", arguments: { command: "npm test" },
        }),
        parentId: "unrelated",
      });
      const unrelated = capture.map({
        ...event("tool.execution_complete", "unrelated-complete", {
          toolCallId: "unrelated-call", success: true, result: terminalResult(0),
        }),
        parentId: "unrelated-start",
      });
      expect(unrelated.status === "mapped" && unrelated.additionalEvents?.[0]?.verificationBinding).toBeUndefined();
  });
});
