import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { AUTOMATIC_LEARNING_DISCLOSURE } from "@provenloop/copilot-adapter";

import {
  runCli,
  runMcpServer,
  type CliDependencies,
  type CliIo,
  type McpToolHandlers,
} from "@provenloop/cli";
import type {
  AdapterHealth,
  AdapterOperationResult,
  AdapterStatus,
  AgentAdapter,
} from "@provenloop/contracts";

const adapterStatus = (): AdapterStatus => ({
  capabilities: {
    adapter: "copilot-cli",
    capabilities: [],
    compatibility: "supported",
    installedVersion: "1.0.82-0",
  },
  dataRoot: "C:\\data",
  installed: true,
  marketplaceRegistered: true,
  pluginEnabled: true,
  pluginInstalled: true,
});

const adapterHealth = (
  status: AdapterHealth["status"],
): AdapterHealth => ({
  adapter: "copilot-cli",
  checkedAt: "2026-08-30T00:00:00.000Z",
  checks: [],
  status,
});

const changed = (message: string): AdapterOperationResult => ({
  message,
  status: "changed",
});

const fakeAdapter = (
  health: AdapterHealth["status"] = "healthy",
): AgentAdapter => ({
  capabilities: vi.fn(async () => adapterStatus().capabilities),
  disable: vi.fn(async (capability) =>
    changed(`${capability} disabled`),
  ),
  doctor: vi.fn(async () => adapterHealth(health)),
  enable: vi.fn(async (capability) =>
    changed(`${capability} enabled`),
  ),
  install: vi.fn(async () => changed("installed")),
  normalizeEvent: vi.fn(() => ({
    status: "ignored",
  })),
  registerCaptureExtension: vi.fn(async () => changed("registered")),
  registerContextTools: vi.fn(async () => changed("registered")),
  resolveSession: vi.fn(async (context) => ({
    internalSession: false,
    sessionId: context.sessionId,
  })),
  status: vi.fn(async () => adapterStatus()),
  uninstall: vi.fn(async () => changed("uninstalled")),
  upgrade: vi.fn(async () => changed("upgraded")),
});

const cli = (
  adapter: AgentAdapter,
): {
  readonly dependencies: CliDependencies;
  readonly errors: string[];
  readonly io: CliIo;
  readonly logs: string[];
  readonly roots: string[];
} => {
  const errors: string[] = [];
  const logs: string[] = [];
  const roots: string[] = [];
  return {
    dependencies: {
      createAdapter: (root) => {
        roots.push(root);
        return adapter;
      },
      runMcpServer: vi.fn(async () => undefined),
    },
    errors,
    io: {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    },
    logs,
    roots,
  };
};

describe("operational CLI", () => {
  it("routes install and capability commands to the adapter", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "install",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "upgrade",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "disable",
          "capture",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.roots).toEqual([
      "C:\\custom-data",
      "C:\\custom-data",
      "C:\\custom-data",
    ]);
    expect(adapter.install).toHaveBeenCalledOnce();
    expect(adapter.install).toHaveBeenCalledWith(undefined);
    expect(adapter.upgrade).toHaveBeenCalledOnce();
    expect(adapter.disable).toHaveBeenCalledWith("capture");
    expect(harness.logs).toEqual([
      AUTOMATIC_LEARNING_DISCLOSURE,
      "installed",
      expect.stringContaining("Check automatic reuse in your repository: provenloop learning status"),
      AUTOMATIC_LEARNING_DISCLOSURE,
      "upgraded",
      "capture disabled",
    ]);
  });

  it("supports install-time opt-out and collection controls", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "install",
          "--no-auto-collect",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(adapter.install).toHaveBeenCalledWith({
      autoCollect: false,
    });

    await expect(
      runCli(
        [
          "collection",
          "disable",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(adapter.disable).toHaveBeenCalledWith("capture");
    expect(adapter.disable).toHaveBeenCalledWith("worker");
  });

  it("passes the configured data root to the MCP server", async () => {
    const harness = cli(fakeAdapter());

    await expect(
      runCli(
        [
          "mcp",
          "serve",
          "--data-root",
          "C:\\custom-data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.dependencies.runMcpServer)
      .toHaveBeenCalledWith({
        dataRoot: "C:\\custom-data",
      });
  });

  it("reports the installed Extension runtime path", async () => {
    const harness = cli(fakeAdapter());

    await expect(
      runCli(
        [
          "runtime",
          "extension-path",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.logs[0]).toMatch(/extension-entry\.js$/u);
  });

  it("uses stable exit codes for invalid input and doctor failures", async () => {
    const adapter = fakeAdapter("unhealthy");
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "enable",
          "unknown",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    await expect(
      runCli(
        [
          "doctor",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(3);
    expect(harness.errors).toHaveLength(1);
    expect(JSON.parse(harness.logs[0] ?? "{}")).toMatchObject({
      status: "unhealthy",
    });
  });

  it("passes purge explicitly to uninstall", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "uninstall",
          "--purge",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(adapter.uninstall).toHaveBeenCalledWith({
      purge: true,
    });
  });

  it("exposes purge as a dedicated command", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "purge",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(adapter.uninstall).toHaveBeenCalledWith({
      purge: true,
    });
  });

  it("rejects unknown arguments for destructive commands", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "purge",
          "--help",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    await expect(
      runCli(
        [
          "uninstall",
          "--purge",
          "--data-rooot",
          "C:\\wrong",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    await expect(
      runCli(
        [
          "forget",
          "knowledge-1",
          "--data-rooot",
          "C:\\wrong",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(adapter.uninstall).not.toHaveBeenCalled();
  });

  it("runs one worker batch with stable exit codes", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);
    const runWorker = vi.fn(async () => ({
      status: "completed" as const,
      acknowledged: 1,
      circuitOpenReasons: [],
      deadLettered: 0,
      duplicates: 0,
      failed: 0,
      recoveredClaims: 0,
      retried: 0,
      stored: 1,
      unsupported: 0,
    }));

    await expect(
      runCli(
        [
          "worker",
          "run",
          "--batch-size",
          "25",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        {
          ...harness.dependencies,
          runWorker,
        },
      ),
    ).resolves.toBe(0);
    expect(runWorker).toHaveBeenCalledWith({
      batchSize: 25,
      dataRoot: "C:\\data",
    });
    expect(JSON.parse(harness.logs[0] ?? "{}")).toMatchObject({
      status: "completed",
      stored: 1,
    });
  });

  it("rejects an invalid worker batch size", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);
    const runWorker = vi.fn();

    await expect(
      runCli(
        [
          "worker",
          "run",
          "--batch-size",
          "0",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        {
          ...harness.dependencies,
          runWorker,
        },
      ),
    ).resolves.toBe(2);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("returns a non-zero code when a worker batch is circuit-limited", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "worker",
          "run",
          "--data-root",
          "C:\\data",
        ],
        harness.io,
        {
          ...harness.dependencies,
          runWorker: vi.fn(async () => ({
            acknowledged: 1,
            circuitOpenReasons: [
              "memory" as const,
            ],
            deadLettered: 0,
            duplicates: 0,
            failed: 0,
            recoveredClaims: 0,
            retried: 0,
            status: "completed" as const,
            stored: 1,
            unsupported: 0,
          })),
        },
      ),
    ).resolves.toBe(1);
  });

  it("runs the built-in Episode association quality report", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "eval",
          "episodes",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.logs[0]).toContain(
      "Work Episode Association Evaluation",
    );
  });

  it("rejects a missing Episode dataset option value", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "eval",
          "episodes",
          "--dataset",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  it("rejects unknown M2 gate options", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "eval",
          "m2",
          "--out",
          "C:\\unused",
          "--stabel",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  it("rejects unknown MVP gate options", async () => {
    const adapter = fakeAdapter();
    const harness = cli(adapter);

    await expect(
      runCli(
        [
          "eval",
          "mvp",
          "--out",
          "C:\\unused",
          "--evidnce",
          "review.json",
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(harness.logs).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });
});

describe("local MCP registration target", () => {
  it("initializes and exposes the M1 retrieval tools", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let content = "";
    output.on("data", (chunk: Buffer) => {
      content += chunk.toString("utf8");
    });
    const running = runMcpServer({
      input,
      output,
    });
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "9999-01-01",
        },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
      })}\n`,
    );
    input.end();
    await running;

    const messages = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 1,
      result: {
        instructions: expect.stringContaining("new coding task"),
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "provenloop",
        },
      },
    });
    expect(messages[1]).toMatchObject({
      id: 2,
      result: {
        tools: [
          {
            name: "provenloop_context",
          },
          {
            name: "provenloop_search",
          },
          {
            name: "provenloop_explain",
          },
          {
            name: "provenloop_feedback",
          },
        ],
      },
    });
  });

  it("dispatches validated MCP tool calls", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let content = "";
    output.on("data", (chunk: Buffer) => {
      content += chunk.toString("utf8");
    });
    const handlers = {
      context: vi.fn(async () => ({
        items: [],
        latencyMs: 1,
        renderedTokens: 0,
        requestId: "context-1",
        status: "ok" as const,
      })),
      explain: vi.fn(async (request) => ({
        explanationRef: request.explanationRef,
        status: "not_found" as const,
      })),
      feedback: vi.fn(async () => ({
        status: "not_found" as const,
      })),
    } satisfies McpToolHandlers;
    const running = runMcpServer(
      {
        input,
        output,
      },
      {
        cwd: "C:\\repo",
        handlers,
        sessionId: "session-1",
        resolveTrustedContext: async () => ({
          cwd: "C:\\repo",
          sessionId: "session-1",
          workspaceVersion: "unit-workspace",
          repositoryState: "known_outside_repo",
          repositoryObservedAt: new Date().toISOString(),
        }),
      },
    );
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            prompt: "Run package validation.",
            tokenBudget: 200,
          },
          name: "provenloop_context",
        },
      })}\n`,
    );
    input.end();
    await running;

    expect(handlers.context).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "C:\\repo",
      prompt: "Run package validation.",
      sessionId: "session-1",
      tokenBudget: 200,
      trustedWorkspace: expect.objectContaining({ repositoryState: "known_outside_repo" }),
    }));
    expect(JSON.parse(content)).toMatchObject({
      id: 1,
      result: {
        structuredContent: {
          requestId: "context-1",
          status: "ok",
        },
      },
    });
  });

  it("rejects caller-controlled MCP workspace and Session identity", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let content = "";
    output.on("data", (chunk: Buffer) => {
      content += chunk.toString("utf8");
    });
    const handlers = {
      context: vi.fn(async () => ({
        items: [],
        latencyMs: 0,
        renderedTokens: 0,
        requestId: "unused",
        status: "ok" as const,
      })),
      explain: vi.fn(async (request) => ({
        explanationRef: request.explanationRef,
        status: "not_found" as const,
      })),
      feedback: vi.fn(async () => ({
        status: "not_found" as const,
      })),
    } satisfies McpToolHandlers;
    const running = runMcpServer(
      {
        input,
        output,
      },
      {
        cwd: "C:\\trusted",
        handlers,
        sessionId: "trusted-session",
        resolveTrustedContext: async () => ({
          cwd: "C:\\trusted",
          sessionId: "trusted-session",
          workspaceVersion: "unit-workspace",
          repositoryState: "known_outside_repo",
          repositoryObservedAt: new Date().toISOString(),
        }),
      },
    );
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            cwd: "C:\\other-repository",
            prompt: "Retrieve context.",
            sessionId: "other-session",
            tokenBudget: 200,
          },
          name: "provenloop_context",
        },
      })}\n`,
    );
    input.end();
    await running;

    expect(handlers.context).not.toHaveBeenCalled();
    expect(JSON.parse(content)).toMatchObject({
      id: 1,
      result: {
        isError: true,
      },
    });
  });

  it("rejects non-object JSON without terminating the server", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let content = "";
    output.on("data", (chunk: Buffer) => {
      content += chunk.toString("utf8");
    });
    const running = runMcpServer({
      input,
      output,
    });
    input.write("null\n");
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "ping",
      })}\n`,
    );
    input.end();
    await running;

    const messages = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
    expect(messages).toEqual([
      expect.objectContaining({
        error: {
          code: -32600,
          message: "Invalid Request",
        },
      }),
      expect.objectContaining({
        id: 1,
        result: {},
      }),
    ]);
  });
});
