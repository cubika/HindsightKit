import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotSessionEvent } from "../../packages/copilot-adapter/src/event-mapper.js";
import { runInstalledCopilotExtension } from "../../packages/copilot-adapter/src/extension-entry.js";
import type { InstalledCopilotExtensionOptions } from "../../packages/copilot-adapter/src/extension-entry.js";

const fixtures = vi.hoisted(() => {
  const release = vi.fn(async () => undefined);
  const publisherStart = vi.fn(async () => undefined);
  const publishers: {
    options: { onError: (error: unknown) => void; [key: string]: unknown };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    updateWorkspace: ReturnType<typeof vi.fn>;
    beginWorkspaceRefresh: ReturnType<typeof vi.fn>;
    observeUserMessage: ReturnType<typeof vi.fn>;
  }[] = [];
  return {
    state: {
      installed: true,
      capabilities: { capture: { enabled: false }, retrieval: { enabled: true }, worker: { enabled: true }, correction_learning: { enabled: true } },
      automaticLearning: { enabled: true, notificationsEnabled: true },
    },
    version: "1.0.84-1",
    release,
    publisherStart,
    publishers,
    publisher: vi.fn((options: (typeof publishers)[number]["options"]) => {
      const publisher = {
        options,
        start: vi.fn(async () => publisherStart()),
        stop: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
        updateWorkspace: vi.fn(),
        beginWorkspaceRefresh: vi.fn(),
        observeUserMessage: vi.fn(),
      };
      publishers.push(publisher);
      return publisher;
    }),
    register: vi.fn(async () => ({ release })),
    shutdownRequested: vi.fn(async () => false),
    assertRoot: vi.fn(async () => undefined),
    readState: vi.fn(),
    resolveSession: vi.fn(),
    initialize: vi.fn(async () => undefined),
    enqueue: vi.fn(async () => undefined),
    enqueueIfSourceAbsent: vi.fn(async () => ({ status: "enqueued" })),
    writeFile: vi.fn(async () => undefined),
    hooksApproved: vi.fn(async () => false),
  };
});

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  mkdir: vi.fn(async () => undefined),
  appendFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  writeFile: fixtures.writeFile,
}));
vi.mock("@provenloop/platform-windows", async (original) => ({
  ...await original<typeof import("@provenloop/platform-windows")>(),
  registerActiveExtension: fixtures.register,
  isExtensionShutdownRequested: fixtures.shutdownRequested,
  WindowsCaptureQueue: class {
    initialize = fixtures.initialize;
    enqueue = fixtures.enqueue;
    enqueueIfSourceAbsent = fixtures.enqueueIfSourceAbsent;
  },
}));
vi.mock("../../packages/copilot-adapter/src/copilot-cli-adapter.js", () => ({
  assertCopilotAdapterDataRoot: fixtures.assertRoot,
  CopilotCliAdapter: class {
    capabilities = async () => ({ compatibility: "supported", installedVersion: fixtures.version });
    resolveSession = fixtures.resolveSession;
  },
}));
vi.mock("../../packages/copilot-adapter/src/operational-state.js", async (original) => ({
  ...await original<typeof import("../../packages/copilot-adapter/src/operational-state.js")>(),
  readCopilotAdapterState: fixtures.readState,
}));
vi.mock("../../packages/copilot-adapter/src/automatic-host-capability.js", async (original) => ({
  ...await original<typeof import("../../packages/copilot-adapter/src/automatic-host-capability.js")>(),
  hasCopilotLearningHookApproval: fixtures.hooksApproved,
}));
vi.mock("../../packages/copilot-adapter/src/trusted-session-context.js", () => ({
  TrustedSessionContextPublisher: function (options: (typeof fixtures.publishers)[number]["options"]) {
    return fixtures.publisher(options);
  },
}));

const currentPublisher = () => {
  const publisher = fixtures.publishers[0];
  if (publisher === undefined) throw new Error("Expected an active test publisher.");
  return publisher;
};

interface TestSession {
  readonly sessionId: string;
  readonly on: (listener: (event: CopilotSessionEvent) => void) => void;
  readonly disconnect: () => Promise<void>;
  readonly emit: (type: string, data?: Record<string, unknown>, extra?: Record<string, unknown>) => void;
}

const sessions: TestSession[] = [];
const session = (sessionId = "sdk-session"): TestSession => {
  let receive: ((event: CopilotSessionEvent) => void) | undefined;
  const value = {
    sessionId,
    on: vi.fn((listener: (event: CopilotSessionEvent) => void) => { receive = listener; }),
    disconnect: vi.fn(async () => undefined),
    emit: (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      receive?.({
        type, data, id: `source-${type}`, timestamp: new Date().toISOString(), parentId: null, ...extra,
      } as CopilotSessionEvent),
  };
  sessions.push(value);
  return value;
};
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const start = (sdk = session()) => {
  const joinSession = vi.fn(async () => sdk);
  const signalSource = { once: vi.fn() };
  return {
    sdk,
    joinSession,
    signalSource,
    result: runInstalledCopilotExtension({
      dataRoot: `${process.cwd()}\\.entry-context-unit`,
      environment: { SESSION_ID: "sdk-session" },
      joinSession,
      signalSource,
      terminate: vi.fn(),
      workflowScopeId: "workflow-1",
    }),
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  vi.clearAllMocks();
  fixtures.publishers.length = 0;
  sessions.length = 0;
  fixtures.state.installed = true;
  fixtures.state.automaticLearning = { enabled: true, notificationsEnabled: true };
  fixtures.version = "1.0.84-1";
  fixtures.state.capabilities.capture.enabled = false;
  fixtures.state.capabilities.retrieval.enabled = true;
  fixtures.hooksApproved.mockReset().mockResolvedValue(false);
  fixtures.publisherStart.mockReset().mockResolvedValue(undefined);
  fixtures.readState.mockReset().mockImplementation(async () => fixtures.state);
  fixtures.shutdownRequested.mockReset().mockResolvedValue(false);
  fixtures.resolveSession.mockReset().mockImplementation(async ({ cwd }: { cwd: string }) => ({
    internalSession: false,
    repositoryId: cwd === "C:\\other" ? "repo-other" : "repo-1",
    worktreePath: cwd,
    branch: "main",
    commitSha: "a".repeat(40),
    commitParents: [],
  }));
});

afterEach(async () => {
  for (const sdk of sessions) sdk.emit("session.shutdown");
  await settle();
  await vi.waitFor(() => {
    expect(fixtures.release).toHaveBeenCalledTimes(fixtures.register.mock.calls.length);
  });
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("installed extension trusted context wiring", () => {
  it("delivers prompt guidance without tool metadata and keeps the pre-tool deadline", async () => {
    fixtures.state.capabilities.capture.enabled = true;
    fixtures.hooksApproved.mockResolvedValue(true);
    const metadata = [{ name: "read", mcpServerName: "files", mcpToolName: "read", input_schema: { type: "object", required: ["path"] } }];
    const getCurrentMetadata = vi.fn(async () => ({ tools: metadata }));
    const sdk = { ...session(), rpc: { tools: { getCurrentMetadata } } };
    let hooks: NonNullable<Parameters<InstalledCopilotExtensionOptions["joinSession"]>[0]>["hooks"];
    const onAutomaticContext = vi.fn<NonNullable<InstalledCopilotExtensionOptions["onAutomaticContext"]>>(async () => "Write repository documentation in English.");
    await runInstalledCopilotExtension({
      dataRoot: `${process.cwd()}\\.entry-context-unit`, environment: { SESSION_ID: "sdk-session" },
      joinSession: async (config) => { hooks = config?.hooks; return sdk; },
      signalSource: { once: vi.fn() }, terminate: vi.fn(), onAutomaticContext,
    });
    const input = { sessionId: "sdk-session", workingDirectory: process.cwd() };
    await expect(hooks?.onPreToolUse?.({ ...input, toolName: "read", toolArgs: { path: "README.md" } }))
      .resolves.toEqual({ additionalContext: "Write repository documentation in English." });
    expect(onAutomaticContext).toHaveBeenLastCalledWith(expect.objectContaining({ tool: expect.objectContaining({ serverName: "files", toolName: "read" }) }));
    getCurrentMetadata.mockImplementation(() => new Promise(() => undefined));
    onAutomaticContext.mockClear();
    await expect(hooks?.onUserPromptSubmitted?.({ ...input, prompt: "Write repository documentation" }))
      .resolves.toEqual({ additionalContext: "Write repository documentation in English." });
    expect(getCurrentMetadata).toHaveBeenCalledTimes(1);
    onAutomaticContext.mockClear();
    await expect(hooks?.onPreToolUse?.({ ...input, toolName: "read", toolArgs: { path: "README.md" } })).resolves.toBeUndefined();
    expect(onAutomaticContext).not.toHaveBeenCalled();
  });

  it.each(["missing", "unsupported", "muted"] as const)("shows a setup blocker only when notices are enabled: %s", async (reason) => {
    fixtures.state.capabilities.capture.enabled = true;
    fixtures.state.automaticLearning.notificationsEnabled = reason !== "muted";
    if (reason === "unsupported") fixtures.version = "1.0.85-1";
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const sdk = { ...session(), log };
    const running = start(sdk);
    expect(await running.result).toMatchObject({ status: "started" });
    expect(running.joinSession).toHaveBeenCalledWith(undefined);
    if (reason === "muted") { expect(log).not.toHaveBeenCalled(); return; }
    expect(log).toHaveBeenCalledOnce();
    const message = log.mock.calls[0]?.[0];
    expect(message).toContain("Automatic reuse");
    expect(message).toContain("learning status");
    if (reason === "missing") { expect(message).toContain("approve-hooks"); expect(message).toContain("restart Copilot"); }
    else { expect(message).toContain("1.0.85-1"); expect(message).not.toContain("approve-hooks"); }
  });

  it.each([false, true])("automatic default registers hooks only with repository approval: %s", async (approved) => {
    fixtures.state.capabilities.capture.enabled = true;
    fixtures.hooksApproved.mockResolvedValue(approved);
    const runtime = start();
    expect(await runtime.result).toMatchObject({ status: "started" });
    expect(fixtures.hooksApproved).toHaveBeenCalledOnce();
    expect(runtime.joinSession.mock.calls[0]).toEqual([approved ? { hooks: {
      onUserPromptSubmitted: expect.any(Function), onPreToolUse: expect.any(Function),
      onPostToolUse: expect.any(Function), onPostToolUseFailure: expect.any(Function),
    } } : undefined]);
  });
  it("passes only the joined SDK Session workspace and observation boundary to background reconciliation", async () => {
    const sdk = { ...session(), workspacePath: "C:\\sdk-state\\sdk-session" };
    const running = start(sdk);
    expect(await running.result).toMatchObject({
      status: "started",
      hostSession: sdk,
      captureSession: {
        sessionId: "sdk-session",
        sessionStateRoot: "C:\\sdk-state",
        minimumTimestamp: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(running.joinSession).toHaveBeenCalledTimes(1);
    expect(sdk.on).toHaveBeenCalledTimes(1);
  });

  it.each(["relative\\sdk-session", "C:\\sdk-state\\another-session"])(
    "does not authorize reconciliation from an unrelated SDK workspace %s",
    async (workspacePath) => {
      const sdk = { ...session(), workspacePath };
      const result = await start(sdk).result;
      expect(result).toMatchObject({ status: "started", hostSession: sdk });
      expect(result).not.toHaveProperty("captureSession");
    },
  );

  it("publishes with capture disabled, joins/subscribes once, and never touches the queue", async () => {
    const runtime = start();
    expect(await runtime.result).toMatchObject({ status: "started", hostSession: runtime.sdk });
    await settle();
    expect(runtime.joinSession).toHaveBeenCalledOnce();
    expect(runtime.joinSession.mock.calls[0]).toEqual([undefined]);
    expect(runtime.sdk.on).toHaveBeenCalledOnce();
    expect(fixtures.publishers[0]?.start).toHaveBeenCalledOnce();
    expect(fixtures.publishers[0]?.options).toMatchObject({
      sessionId: "sdk-session", repositoryId: "repo-1", workflowScopeId: "workflow-1",
    });
    runtime.sdk.emit("user.message", { content: "ordinary private prompt" });
    runtime.sdk.emit("tool.execution_complete", { toolCallId: "tool-1", success: true });
    await settle();
    expect(fixtures.initialize).not.toHaveBeenCalled();
    expect(fixtures.enqueueIfSourceAbsent).not.toHaveBeenCalled();
    expect(fixtures.writeFile).not.toHaveBeenCalled();
  });

  it("observes every real user message to invalidate stale approval, excluding agents and autopilot", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    const priorWorkspace = publisher.updateWorkspace.mock.lastCall?.[0];
    const priorResolutions = fixtures.resolveSession.mock.calls.length;
    publisher.updateWorkspace.mockClear();
    publisher.beginWorkspaceRefresh.mockClear();
    runtime.sdk.emit("user.message", { content: "确认 PL-123456abcdef", source: "user" }, { id: "approval" });
    runtime.sdk.emit("user.message", { content: "do something else" }, { id: "ordinary" });
    runtime.sdk.emit("user.message", { content: "x".repeat(10_000) }, { id: "long" });
    runtime.sdk.emit("user.message", {}, { id: "malformed", data: null });
    const userRefreshes = publisher.beginWorkspaceRefresh.mock.calls.length;
    runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef", source: "agent" });
    runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef", isAutopilotContinuation: true });
    runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef" }, { agentId: "agent-1" });
    expect(userRefreshes).toBeGreaterThanOrEqual(4);
    expect(publisher.beginWorkspaceRefresh).toHaveBeenCalledTimes(userRefreshes);
    expect(fixtures.resolveSession).toHaveBeenCalledTimes(priorResolutions);
    expect(publisher.updateWorkspace).not.toHaveBeenCalled();
    await settle();
    expect(publisher.observeUserMessage.mock.calls.map(([message]) => message)).toMatchObject([
      { eventId: "approval", text: "确认 PL-123456abcdef" },
      { eventId: "ordinary", text: "do something else" },
      { eventId: "long", text: "" },
      { eventId: "malformed", text: "" },
    ]);
    expect(publisher.updateWorkspace).toHaveBeenCalled();
    for (const [workspace] of publisher.updateWorkspace.mock.calls) expect(workspace).toEqual(priorWorkspace);
  });

  it("invalidates repository freshness synchronously on a real prompt and resolves Git asynchronously", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    const priorWorkspace = publisher.updateWorkspace.mock.lastCall?.[0];
    publisher.beginWorkspaceRefresh.mockClear();
    publisher.updateWorkspace.mockClear();
    const resolutionCount = fixtures.resolveSession.mock.calls.length;
    let finishResolution!: (value: Record<string, unknown>) => void;
    fixtures.resolveSession.mockImplementationOnce(() =>
      new Promise((resolve) => { finishResolution = resolve; }));
    runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef" });
    expect(publisher.beginWorkspaceRefresh).toHaveBeenCalled();
    expect(fixtures.resolveSession).toHaveBeenCalledTimes(resolutionCount);
    await settle();
    expect(publisher.updateWorkspace).not.toHaveBeenCalled();
    finishResolution({
      repositoryId: "repo-1", repositoryState: "known_repo", branch: "main",
      commitSha: "a".repeat(40), commitParents: [], worktreePath: process.cwd(),
    });
    await settle();
    expect(publisher.updateWorkspace).toHaveBeenLastCalledWith(priorWorkspace);
    expect(publisher.observeUserMessage).toHaveBeenCalledOnce();
    expect(fixtures.initialize).not.toHaveBeenCalled();
  });

  it.each(["unknown", "known_outside_repo"] as const)("honors explicit %s without publishing stale repository fields", async (repositoryState) => {
    fixtures.resolveSession.mockImplementation(async () => ({
      repositoryState, repositoryId: "stale-repo", branch: "stale-branch",
      commitSha: "b".repeat(40), worktreePath: process.cwd(),
    }));
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    expect(publisher.options.repositoryState).toBe(repositoryState);
    expect(publisher.options.repositoryId).toBeUndefined();
    for (const [workspace] of publisher.updateWorkspace.mock.calls) {
      expect(workspace.repositoryState).toBe(repositoryState);
      expect(workspace.repositoryId).toBeUndefined();
      expect(workspace.branch).toBeUndefined();
      expect(workspace.commitSha).toBeUndefined();
    }
  });

  it("does not treat an inconclusive Git refresh as an identity change or invalidate confirmation", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    const priorWorkspace = publisher.updateWorkspace.mock.lastCall?.[0];
    publisher.updateWorkspace.mockClear();
    fixtures.resolveSession.mockResolvedValueOnce({
      repositoryState: "unknown", worktreePath: process.cwd(),
    });
    runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef" });
    await settle();
    expect(publisher.updateWorkspace).not.toHaveBeenCalled();
    expect(publisher.beginWorkspaceRefresh).toHaveBeenCalled();
    expect(publisher.observeUserMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(publisher.updateWorkspace).toHaveBeenLastCalledWith(priorWorkspace);
    expect(fixtures.publishers).toHaveLength(1);
  });

  it("refreshes the actual changed SDK cwd and periodically renews repository observations", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    runtime.sdk.emit("session.context_changed", {
      cwd: "C:\\other", branch: "feature", headCommit: "b".repeat(40),
    });
    await settle();
    expect(fixtures.resolveSession).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "C:\\other" }));
    expect(publisher.updateWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: "C:\\other", repositoryId: "repo-other", branch: "main", workflowScopeId: "workflow-1",
    }));
    const refreshCount = fixtures.resolveSession.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(fixtures.resolveSession.mock.calls.length).toBeGreaterThan(refreshCount);
    expect(publisher.beginWorkspaceRefresh).toHaveBeenCalled();
  });

  it("changes capture capability without reconnecting and initializes the queue only when enabled", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    fixtures.state.capabilities.capture.enabled = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fixtures.initialize).toHaveBeenCalledOnce();
    expect(fixtures.enqueueIfSourceAbsent).toHaveBeenCalled();
    fixtures.state.capabilities.capture.enabled = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    const captureCount = fixtures.enqueueIfSourceAbsent.mock.calls.length;
    runtime.sdk.emit("user.message", { content: "not captured" });
    await settle();
    expect(fixtures.enqueueIfSourceAbsent).toHaveBeenCalledTimes(captureCount);
    expect(fixtures.publishers[0]?.stop).not.toHaveBeenCalled();
    expect(runtime.joinSession).toHaveBeenCalledOnce();
    expect(runtime.sdk.on).toHaveBeenCalledOnce();
  });

  it.each(["all_disabled", "uninstalled", "shutdown_request", "sdk_shutdown"] as const)(
    "awaits publisher cleanup and disconnects once on %s",
    async (reason) => {
      const runtime = start();
      await runtime.result;
      await settle();
      const publisher = currentPublisher();
      let finishStop!: () => void;
      publisher.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStop = resolve; }));
      if (reason === "all_disabled") fixtures.state.capabilities.retrieval.enabled = false;
      if (reason === "uninstalled") fixtures.state.installed = false;
      if (reason === "shutdown_request") fixtures.shutdownRequested.mockResolvedValue(true);
      if (reason === "sdk_shutdown") runtime.sdk.emit("session.shutdown");
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();
      try {
        expect(publisher.stop).toHaveBeenCalledOnce();
        expect(runtime.sdk.disconnect).not.toHaveBeenCalled();
        expect(fixtures.release).not.toHaveBeenCalled();
      } finally {
        finishStop?.();
      }
      await vi.waitFor(() => expect(fixtures.release).toHaveBeenCalledOnce());
      expect(runtime.sdk.disconnect).toHaveBeenCalledOnce();
      runtime.sdk.emit("user.message", { content: "confirm PL-123456abcdef" });
      expect(publisher.observeUserMessage).not.toHaveBeenCalled();
    },
  );

  it("fails closed for an SDK/environment session mismatch", async () => {
    const runtime = start(session("different-sdk-session"));
    expect(await runtime.result).toMatchObject({ status: "failed", error: expect.stringContaining("SESSION_ID") });
    expect(fixtures.publisher).not.toHaveBeenCalled();
    expect(runtime.sdk.disconnect).toHaveBeenCalledOnce();
  });

  it("does not replace a missing session identity with a random one", async () => {
    const joinSession = vi.fn(async () => session());
    expect(await runInstalledCopilotExtension({
      dataRoot: `${process.cwd()}\\.entry-context-unit`, environment: {}, joinSession,
    })).toMatchObject({ status: "failed", error: expect.stringContaining("SESSION_ID") });
    expect(joinSession).not.toHaveBeenCalled();
    expect(fixtures.publisher).not.toHaveBeenCalled();
  });

  it.each(["all_disabled", "uninstalled"] as const)("does not join or publish when initially %s", async (reason) => {
    if (reason === "all_disabled") fixtures.state.capabilities.retrieval.enabled = false;
    if (reason === "uninstalled") fixtures.state.installed = false;
    const runtime = start();
    expect(await runtime.result).toEqual({ status: "disabled" });
    expect(runtime.joinSession).not.toHaveBeenCalled();
    expect(fixtures.publisher).not.toHaveBeenCalled();
  });

  it("disconnects a late SDK join after SIGTERM without subscribing or publishing", async () => {
    const sdk = session();
    let finishJoin!: (value: typeof sdk) => void;
    let terminate!: () => void;
    const result = runInstalledCopilotExtension({
      dataRoot: `${process.cwd()}\\.entry-context-unit`,
      environment: { SESSION_ID: "sdk-session" },
      joinSession: () => new Promise((resolve) => { finishJoin = resolve; }),
      signalSource: { once: (_signal, listener) => { terminate = listener; } },
      terminate: vi.fn(),
    });
    await settle();
    terminate();
    await settle();
    await vi.waitFor(() => expect(fixtures.release).toHaveBeenCalledOnce());
    finishJoin(sdk);
    expect(await result).toEqual({ status: "disabled" });
    expect(sdk.on).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(fixtures.publisher).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous relative SDK workspace rather than resolving it into a trusted identity", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const publisher = currentPublisher();
    runtime.sdk.emit("session.context_changed", { cwd: "relative-workspace" });
    await settle();
    expect(publisher.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fixtures.publishers).toHaveLength(1);
  });

  it("still disconnects and releases the extension if publisher shutdown fails", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    currentPublisher().stop.mockRejectedValueOnce(new Error("cleanup failed"));
    runtime.sdk.emit("session.shutdown");
    await vi.waitFor(() => expect(fixtures.release).toHaveBeenCalledOnce());
    expect(runtime.sdk.disconnect).toHaveBeenCalledOnce();
  });

  it("does not leave a connected SDK session when retrieval-only publisher startup fails", async () => {
    fixtures.publisherStart.mockRejectedValueOnce(new Error("publication unavailable"));
    const runtime = start();
    expect(await runtime.result).toMatchObject({ status: "failed" });
    expect(fixtures.publishers[0]?.stop).toHaveBeenCalledOnce();
    expect(runtime.sdk.disconnect).toHaveBeenCalledOnce();
    expect(fixtures.release).toHaveBeenCalledOnce();
  });

  it("retires a failed publisher and retries using the same SDK connection", async () => {
    const runtime = start();
    await runtime.result;
    await settle();
    const first = currentPublisher();
    first.options.onError(new Error("write failed"));
    await settle();
    expect(first.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fixtures.publishers).toHaveLength(2);
    expect(fixtures.publishers[1]?.start).toHaveBeenCalledOnce();
    expect(fixtures.publishers[1]?.observeUserMessage).not.toHaveBeenCalled();
    expect(runtime.joinSession).toHaveBeenCalledOnce();
    expect(runtime.sdk.on).toHaveBeenCalledOnce();
  });
});
