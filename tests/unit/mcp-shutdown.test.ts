import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { beginExtensionShutdown, waitForActiveExtensionsToStop } from "@provenloop/platform-windows";
import { runMcpServer } from "../../packages/cli/src/run-mcp-server.js";

describe("owned MCP process shutdown", () => {
  it("closes its protocol loop on plugin shutdown after active requests settle", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-mcp-stop-"));
    const input = new PassThrough(); const output = new PassThrough();
    let response = ""; output.on("data", (chunk) => { response += String(chunk); });
    let finish: (() => void) | undefined; let entered = false;
    const running = runMcpServer({ input, output }, { dataRoot: root, lifecycle: true,
      resolveTrustedContext: async () => ({ cwd: root, sessionId: "test", repositoryState: "known_outside_repo", repositoryObservedAt: new Date().toISOString(), workspaceVersion: "fixture" }),
      handlers: { context: async () => { entered = true; await new Promise<void>((resolve) => { finish = resolve; }); return { items: [], latencyMs: 0, renderedTokens: 0, requestId: "request", status: "ok" }; },
        explain: async () => { throw new Error("unused"); }, feedback: async () => { throw new Error("unused"); } } });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "provenloop_context", arguments: { prompt: "test", tokenBudget: 50 } } }) + String.fromCharCode(10));
    let shutdown: Awaited<ReturnType<typeof beginExtensionShutdown>> | undefined;
    try {
      await expect.poll(() => entered).toBe(true);
      shutdown = await beginExtensionShutdown(root);
      await expect(waitForActiveExtensionsToStop(root, 50)).rejects.toThrow("ProvenLoop extension process");
      finish?.();
      await running;
      await expect(waitForActiveExtensionsToStop(root, 1000)).resolves.toBeUndefined();
      expect(response).toContain("request");
    } finally { finish?.(); input.end(); await running; await shutdown?.cancel(); await rm(root, { recursive: true, force: true }); }
  });

  it("reports shutdown inspection failures and releases its lifecycle registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-mcp-stop-error-"));
    const input = new PassThrough();
    const output = new PassThrough();
    let response = "";
    output.on("data", (chunk) => { response += String(chunk); });
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const running = runMcpServer({ input, output }, {
      dataRoot: root,
      lifecycle: true,
      handlers: { context: unused, explain: unused, feedback: unused },
    });
    const failed = expect(running).rejects.toThrow("MCP shutdown status could not be verified");
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      await expect.poll(() => response).toContain('"id":1');
      await mkdir(join(root, "data", "extension-shutdown-request.json"));
      await failed;
      expect(await readdir(join(root, "data", "extension-sessions"))).toEqual([]);
    } finally {
      input.end();
      await running.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
