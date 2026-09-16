import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runMcpServer,
  type McpToolHandlers,
} from "@provenloop/cli";
import { TrustedSessionContextPublisher } from "@provenloop/copilot-adapter";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, appendFile: vi.fn(original.appendFile) };
});

const roots: string[] = [];
const temporaryRoot = async () => {
  const root = await mkdtemp(join(process.cwd(), ".provenloop-mcp-diagnostic-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const readLog = async (root: string) => {
  const body = await readFile(join(root, "logs", "mcp.jsonl"), "utf8");
  return { body, entries: body.trim().split("\n").map((line) => JSON.parse(line)) };
};

const handlers = (): McpToolHandlers => ({
  context: vi.fn<McpToolHandlers["context"]>(async () => ({
    items: [],
    latencyMs: 0,
    renderedTokens: 0,
    requestId: "request-1",
    status: "ok",
  })),
  explain: vi.fn<McpToolHandlers["explain"]>(async (request) => ({
    explanationRef: request.explanationRef,
    status: "not_found",
  })),
  feedback: vi.fn<McpToolHandlers["feedback"]>(async () => ({ status: "recorded" })),
});

const call = async (
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: NonNullable<Parameters<typeof runMcpServer>[1]>,
) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let content = "";
  output.on("data", (chunk: Buffer) => {
    content += chunk.toString("utf8");
  });
  const dataRoot = options.dataRoot ?? await temporaryRoot();
  const running = runMcpServer({ input, output }, { ...options, dataRoot });
  input.end(`${JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name, arguments: args },
  })}\n`);
  await running;
  return JSON.parse(content).result;
};

describe("trusted MCP session and write intent", () => {
  it("degrades rather than inventing a session identity", async () => {
    const tools = handlers();
    const dataRoot = await temporaryRoot();
    const sessionId = "private-session-identity";
    const result = await call("provenloop_context", {
      prompt: "Private prompt with confirm PL-abcdef012345",
      tokenBudget: 600,
    }, {
      handlers: tools,
      dataRoot, sessionId,
      resolveTrustedContext: async () => undefined,
    });
    expect(result.structuredContent).toMatchObject({
      status: "degraded",
      items: [],
      statusDetail: expect.stringContaining("[resolver_unavailable]"),
    });
    expect(tools.context).not.toHaveBeenCalled();
    const { body, entries } = await readLog(dataRoot);
    expect(entries).toEqual([expect.objectContaining({
      event: "trusted_identity_unavailable", reason: "resolver_unavailable",
      requestId: result.structuredContent.requestId, sessionIdSource: "resolver",
      sessionHash: createHash("sha256").update(sessionId).digest("hex"),
      timestamp: expect.any(String), elapsedMs: expect.any(Number), pid: process.pid,
    })]);
    for (const value of [sessionId, dataRoot, "Private prompt", "PL-abcdef012345"]) {
      expect(body).not.toContain(value);
    }
  });

  it("reports a missing Session ID without accepting identity supplied by the model", async () => {
    vi.stubEnv("SESSION_ID", "");
    const dataRoot = await temporaryRoot();
    const tools = handlers();
    const result = await call("provenloop_context", {
      prompt: "Run tests", sessionId: "model-invented", cwd: "C:\\private-repo",
    }, { dataRoot, handlers: tools });
    expect(result.structuredContent).toMatchObject({
      status: "degraded", statusDetail: expect.stringContaining("[session_id_missing]"),
    });
    const { entries, body } = await readLog(dataRoot);
    expect(entries[0]).toMatchObject({ reason: "session_id_missing", sessionIdSource: "missing" });
    expect(entries[0]).not.toHaveProperty("sessionHash");
    expect(body).not.toContain("model-invented");
    expect(body).not.toContain("private-repo");
    expect(tools.context).not.toHaveBeenCalled();
  });

  it("correlates resolver errors without copying raw exception content into logs or replies", async () => {
    const dataRoot = await temporaryRoot();
    const tools = handlers();
    const result = await call("provenloop_context", { prompt: "Run tests" }, {
      dataRoot, handlers: tools, resolveTrustedContext: async () => {
        throw new Error("Cannot read C:\\private-project\\record.json; confirm PL-abcdef012345");
      },
    });
    expect(result.isError).toBe(true);
    const { body, entries } = await readLog(dataRoot);
    expect(entries[0]).toMatchObject({ reason: "resolver_failed" });
    expect(result.content[0].text).toContain(entries[0].requestId);
    expect(result.content[0].text).toContain("[resolver_failed]");
    for (const value of ["private-project", "PL-abcdef012345", "Cannot read"]) {
      expect(body).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(tools.context).not.toHaveBeenCalled();
  });

  it("returns the same degraded result when the diagnostic destination is unwritable", async () => {
    const dataRoot = await temporaryRoot();
    await writeFile(join(dataRoot, "logs"), "A file blocks creation of the log directory.");
    const result = await call("provenloop_context", { prompt: "Run tests" }, {
      dataRoot, handlers: handlers(), resolveTrustedContext: async () => undefined,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: "degraded", items: [], statusDetail: expect.stringContaining("[resolver_unavailable]"),
    });
  });

  it("logs an unavailable identity even when its observation handler rejects", async () => {
    const dataRoot = await temporaryRoot();
    const tools = handlers();
    tools.unavailableContext = async () => { throw new Error("Observation cleanup failed."); };
    const result = await call("provenloop_context", { prompt: "Run tests", tokenBudget: 600 }, {
      dataRoot, handlers: tools, resolveTrustedContext: async () => ({
        cwd: dataRoot, sessionId: "sdk-session", workspaceVersion: "workspace-1",
        repositoryState: "unknown", repositoryObservedAt: new Date().toISOString(),
      }),
    });
    expect(result.isError).toBe(true);
    const { entries } = await readLog(dataRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: "repository_unknown" });
    expect(result.content[0].text).toContain("Observation cleanup failed");
    expect(result.content[0].text).toContain(entries[0].requestId);
    expect(tools.context).not.toHaveBeenCalled();
  });

  it("finishes the MCP request and shutdown when a diagnostic append is stalled", async () => {
    const dataRoot = await temporaryRoot();
    let finishAppend: (() => void) | undefined;
    const append = vi.mocked(fs.appendFile).mockImplementationOnce(() => new Promise<void>((resolve) => { finishAppend = resolve; }));
    const result = await call("provenloop_context", { prompt: "Run tests" }, {
      dataRoot, handlers: handlers(), resolveTrustedContext: async () => undefined,
    });
    try {
      expect(append).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({ status: "degraded", items: [] });
    } finally { finishAppend?.(); }
  });

  it("preserves observation order when a slow unavailable request overlaps recovery", async () => {
    const dataRoot = await temporaryRoot();
    const input = new PassThrough();
    const output = new PassThrough();
    const replies: { id: number; result: { structuredContent: { requestId: string; status: string } } }[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) replies.push(JSON.parse(line));
    });
    let releaseObservation: (() => void) | undefined;
    let observationStarted = false;
    const waitForObservation = new Promise<void>((resolve) => { releaseObservation = resolve; });
    const tools = handlers();
    tools.unavailableContext = async (_request, statusDetail) => {
      observationStarted = true;
      await waitForObservation;
      return { items: [], latencyMs: 0, renderedTokens: 0, status: "degraded", statusDetail, requestId: "slow-observation" };
    };
    let resolved = 0;
    const running = runMcpServer({ input, output }, {
      dataRoot, handlers: tools, resolveTrustedContext: async () => ({
        cwd: dataRoot, sessionId: "sdk-session", workspaceVersion: "workspace-1",
        repositoryState: resolved++ === 0 ? "unknown" : "known_outside_repo",
        repositoryObservedAt: new Date().toISOString(),
      }),
    });
    const send = (id: number) => input.write(`${JSON.stringify({
      id, jsonrpc: "2.0", method: "tools/call",
      params: { name: "provenloop_context", arguments: { prompt: "Run tests", tokenBudget: 600 } },
    })}\n`);
    try {
      send(1);
      await vi.waitFor(() => expect(observationStarted).toBe(true));
      send(2);
      await vi.waitFor(() => expect(replies.find((reply) => reply.id === 2)?.result.structuredContent.status).toBe("ok"));
      releaseObservation?.();
      input.end();
      await running;
      const { entries } = await readLog(dataRoot);
      const chronological = entries.toSorted((a, b) => a.observationSequence - b.observationSequence);
      expect(chronological).toEqual([
        expect.objectContaining({ event: "trusted_identity_unavailable", requestId: "slow-observation", observationSequence: 1 }),
        expect.objectContaining({ event: "trusted_identity_recovered", observationSequence: 2 }),
      ]);
      expect(chronological[1].previousIdentityCheckId).toBe(chronological[0].identityCheckId);
    } finally {
      releaseObservation?.();
      input.end();
      await running;
    }
  });

  it("records stale snapshot timing and malformed JSON through the production resolver", async () => {
    const dataRoot = await temporaryRoot();
    const sessionId = "diagnostic-publisher";
    const publishedAt = new Date("2026-09-11T01:00:00.000Z");
    const publisher = new TrustedSessionContextPublisher({
      dataRoot, cwd: dataRoot, sessionId, repositoryId: "private-repo",
      now: () => publishedAt, onError: (error) => { throw error; },
    });
    try {
      await publisher.start();
      const tools = handlers();
      const result = await call("provenloop_context", { prompt: "Run tests" }, {
        dataRoot, sessionId, handlers: tools, now: () => new Date(publishedAt.getTime() + 61_000),
      });
      expect(result.structuredContent.statusDetail).toContain("[record_expired]");
      expect((await readLog(dataRoot)).entries[0]).toMatchObject({
        reason: "record_expired", recordAgeMs: 61_000, maxAgeMs: 60_000,
        requestId: result.structuredContent.requestId, sessionIdSource: "options",
      });
      const path = join(dataRoot, "data", "session-context", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
      const original = await readFile(path, "utf8");
      try {
        await writeFile(path, '{"private-content":');
        const invalid = await call("provenloop_context", { prompt: "Run tests" }, {
          dataRoot, sessionId, handlers: tools, now: () => publishedAt,
        });
        expect(invalid.isError).toBe(true);
        const { body, entries } = await readLog(dataRoot);
        expect(entries[1]).toMatchObject({ reason: "record_invalid" });
        expect(invalid.content[0].text).toContain(entries[1].requestId);
        expect(body).not.toContain("private-content");
        expect(body).not.toContain("private-repo");
        expect(tools.context).not.toHaveBeenCalled();
      } finally { await writeFile(path, original); }
    } finally { await publisher.stop(); }
  });

  it("resolves the current workspace for each request", async () => {
    const tools = handlers();
    let cwd = "C:\\repo-one";
    const options = {
      handlers: tools,
      resolveTrustedContext: async () => ({
        cwd,
        sessionId: "sdk-session",
        workspaceVersion: cwd,
        repositoryState: "known_outside_repo" as const,
        repositoryObservedAt: new Date().toISOString(),
      }),
    };
    await call("provenloop_context", {
      prompt: "Run tests",
      tokenBudget: 600,
    }, options);
    cwd = "C:\\repo-two";
    await call("provenloop_context", {
      prompt: "Run tests",
      tokenBudget: 600,
    }, options);
    expect(tools.context).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: "C:\\repo-one",
      sessionId: "sdk-session",
    }));
    expect(tools.context).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cwd: "C:\\repo-two",
      sessionId: "sdk-session",
    }));
  });

  it("requires a real user message approving the exact feedback operation", async () => {
    const tools = handlers();
    const args = {
      action: "helpful",
      requestId: "request-1",
      targetRef: { kind: "branch_context", id: "branch-1" },
      userReportedApplied: true,
    };
    const context = {
      cwd: "C:\\repo-one",
      sessionId: "sdk-session",
      workspaceVersion: "workspace-1",
      repositoryState: "known_outside_repo" as const,
      repositoryObservedAt: new Date().toISOString(),
    };
    const proposed = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => context,
    });
    expect(proposed.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    const confirmationCode = proposed.structuredContent.confirmationCode;
    const approvedContext = {
      ...context,
      latestUserMessage: {
        eventId: "real-user-event",
        text: `确认 ${confirmationCode}`,
        timestamp: new Date().toISOString(),
      },
    };
    const stale = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        ...approvedContext,
        latestUserMessage: {
          ...approvedContext.latestUserMessage,
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      }),
    });
    expect(stale.structuredContent.status).toBe("confirmation_required");
    const moved = await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        ...approvedContext,
        cwd: "C:\\repo-two",
        workspaceVersion: "workspace-2",
      }),
    });
    expect(moved.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    const changed = await call("provenloop_feedback", {
      ...args,
      action: "wrong",
    }, {
      handlers: tools,
      resolveTrustedContext: async () => approvedContext,
    });
    expect(changed.structuredContent.status).toBe("confirmation_required");
    expect(tools.feedback).not.toHaveBeenCalled();
    await call("provenloop_feedback", args, {
      handlers: tools,
      resolveTrustedContext: async () => approvedContext,
    });
    expect(tools.feedback).toHaveBeenCalledWith(expect.objectContaining({
      targetKind: "branch_context",
      targetId: "branch-1",
      source: "user",
      evidenceRef: "real-user-event",
      userReportedApplied: true,
    }));
  });

  it("rejects model-supplied approval provenance", async () => {
    const tools = handlers();
    const result = await call("provenloop_feedback", {
      action: "helpful",
      requestId: "request-1",
      targetId: "knowledge-1",
      source: "user",
      evidenceRef: "invented",
    }, {
      handlers: tools,
      resolveTrustedContext: async () => ({
        cwd: "C:\\repo",
        sessionId: "sdk-session",
        workspaceVersion: "workspace-1",
        repositoryState: "known_outside_repo" as const,
        repositoryObservedAt: new Date().toISOString(),
      }),
    });
    expect(result.isError).toBe(true);
    expect(tools.feedback).not.toHaveBeenCalled();
  });
});
