import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runMcpServer, type McpServerOptions, type McpToolHandlers } from "@provenloop/cli";
import { createDefaultCopilotAdapterState, registerInternalCopilotSession, unregisterInternalCopilotSession,
  writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import { KnowledgeControlService } from "@provenloop/host";
import { beginUpgradeMaintenance, resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend, type ContextSearchRequest } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { LocalMcpToolHandlers } from "../../packages/cli/src/run-mcp-server.js";

const roots: string[] = [];
const temporaryRoot = async () => {
  const root = await mkdtemp(join(process.cwd(), ".provenloop-mcp-search-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const trusted = () => ({
  cwd: "C:\\trusted-repository",
  sessionId: "trusted-session",
  workspaceVersion: "workspace-1",
  workflowScopeId: "workflow-1",
  repositoryState: "known_repo" as const,
  repositoryId: "repository-1",
  branch: "main",
  commitSha: "a".repeat(40),
  repositoryObservedAt: new Date().toISOString(),
});

const toolHandlers = () => ({
  context: vi.fn<McpToolHandlers["context"]>(async () => ({
    items: [], latencyMs: 0, renderedTokens: 0, requestId: "context-request", status: "ok",
  })),
  search: vi.fn<NonNullable<McpToolHandlers["search"]>>(async () => ({
    items: [], latencyMs: 0, renderedTokens: 0, requestId: "search-request", status: "ok",
  })),
  explain: vi.fn<McpToolHandlers["explain"]>(async (request) => ({
    explanationRef: request.explanationRef, status: "not_found",
  })),
  feedback: vi.fn<McpToolHandlers["feedback"]>(async () => ({ status: "recorded" })),
}) satisfies McpToolHandlers;

const request = async (method: string, params: unknown, options: McpServerOptions = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let body = "";
  output.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  const running = runMcpServer({ input, output }, {
    dataRoot: await temporaryRoot(), resolveTrustedContext: async () => trusted(), ...options,
  });
  input.end(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method, params })}\n`);
  await running;
  return JSON.parse(body).result;
};

const search = (args: Readonly<Record<string, unknown>>, options?: McpServerOptions) =>
  request("tools/call", { name: "provenloop_search", arguments: args }, options);

describe("generic MCP experience search", () => {
  it("publishes the versioned search bounds and general task guidance", async () => {
    const listing = await request("tools/list", {});
    expect(listing.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "provenloop_context", "provenloop_search", "provenloop_explain", "provenloop_feedback",
    ]);
    expect(listing.tools[1].inputSchema).toMatchObject({
      additionalProperties: false, required: ["protocolVersion", "prompt"],
      properties: {
        protocolVersion: { const: 1 },
        prompt: { maxLength: 12_000 },
        alternateQueries: { maxItems: 3 },
        conceptHints: { maxItems: 8 }, entityHints: { maxItems: 16 },
        limit: { default: 8, maximum: 12 }, tokenBudget: { default: 3_000, maximum: 3_000 },
      },
    });
    for (const key of ["cwd", "repoId", "scope", "sessionId", "trustedWorkspace"]) {
      expect(listing.tools[1].inputSchema.properties).not.toHaveProperty(key);
    }
    const initialized = await request("initialize", {});
    expect(initialized.instructions).toContain("provenloop_search with protocolVersion 1");
    expect(initialized.instructions).toContain("current task needs deeper past experience");
    expect(initialized.instructions).toContain("real user's exact approval");
  });

  it("defaults result budgets and uses the host workspace on every request", async () => {
    const handlers = toolHandlers();
    let workspace = trusted();
    const options = { handlers, resolveTrustedContext: async () => workspace };
    const args = { protocolVersion: 1, prompt: "  Retry an external write after an ambiguous timeout.  " };
    expect((await search(args, options)).structuredContent.requestId).toBe("search-request");
    expect(handlers.search).toHaveBeenLastCalledWith({
      protocolVersion: 1, prompt: args.prompt.trim(), cwd: workspace.cwd, sessionId: workspace.sessionId,
      limit: 8, tokenBudget: 3_000, workflowScopeId: workspace.workflowScopeId,
      trustedWorkspace: { repositoryState: "known_repo", repositoryId: workspace.repositoryId,
        repositoryObservedAt: workspace.repositoryObservedAt, branch: workspace.branch, commitSha: workspace.commitSha },
    });
    workspace = { ...trusted(), cwd: "C:\\second-repository", repositoryId: "repository-2" };
    await search({ ...args, alternateQueries: ["  Avoid duplicate effects without assuming exactly-once delivery.  "],
      conceptHints: ["idempotency"], entityHints: ["tool -X", "tool -x"], fileHints: ["src/write.ts"],
      purposes: ["lesson", "rationale"], topics: ["duplicate_effects"], limit: 12, tokenBudget: 2_000 }, options);
    expect(handlers.search).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: workspace.cwd, sessionId: workspace.sessionId, trustedWorkspace: expect.objectContaining({ repositoryId: "repository-2" }),
      alternateQueries: ["Avoid duplicate effects without assuming exactly-once delivery."],
      conceptHints: ["idempotency"], entityHints: ["tool -X", "tool -x"], fileHints: ["src/write.ts"],
      purposes: ["lesson", "rationale"], topics: ["duplicate_effects"], limit: 12, tokenBudget: 2_000,
    }));
    expect(handlers.context).not.toHaveBeenCalled();
  });

  it.each([
    { protocolVersion: undefined }, { protocolVersion: 2 }, { prompt: " " }, { prompt: "x".repeat(12_001) },
    { alternateQueries: Array(4).fill("retry") }, { alternateQueries: ["x".repeat(2_001)] },
    { alternateQueries: [" " ] }, { conceptHints: Array(9).fill("retry") }, { conceptHints: ["x".repeat(129)] },
    { entityHints: Array(17).fill("Writer") }, { entityHints: ["x".repeat(257)] },
    { topics: Array(9).fill("retry") }, { topics: [false] }, { purposes: ["design"] },
    { fileHints: Array(17).fill("src/write.ts") }, { fileHints: ["x".repeat(513)] },
    { limit: 13 }, { limit: 0 }, { limit: 1.5 }, { tokenBudget: 3_001 }, { tokenBudget: 0 }, { tokenBudget: "3000" },
    { cwd: "C:\\other" }, { sessionId: "other-session" }, { repoId: "other-repo" },
    { branch: "other" }, { headSha: "b".repeat(40) }, { workflowScopeId: "other-workflow" },
    { scope: "personal" }, { trustedWorkspace: { repositoryState: "known_outside_repo" } },
  ])("rejects invalid or caller-controlled fields: %j", async (invalid) => {
    const handlers = toolHandlers();
    const result = await search({ protocolVersion: 1, prompt: "Retry safely.", ...invalid }, { handlers });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid provenloop_search arguments");
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it("reports unavailable identity without searching and keeps prompts out of diagnostics", async () => {
    const handlers = toolHandlers();
    const dataRoot = await temporaryRoot();
    const result = await search({ protocolVersion: 1, prompt: "Private retry investigation." }, {
      dataRoot, handlers, resolveTrustedContext: async () => undefined,
    });
    expect(result.structuredContent).toMatchObject({ status: "degraded", items: [],
      statusDetail: expect.stringContaining("[resolver_unavailable]") });
    expect(handlers.search).not.toHaveBeenCalled();
    expect(await readFile(join(dataRoot, "logs", "mcp.jsonl"), "utf8")).not.toContain("Private retry");
  });

  it("passes host identity to Explain and still requires exact user approval for search feedback", async () => {
    const handlers = toolHandlers();
    await search({ protocolVersion: 1, prompt: "Retry safely." }, { handlers });
    await request("tools/call", { name: "provenloop_explain", arguments: { explanationRef: "knowledge:retry" } }, { handlers });
    expect(handlers.explain).toHaveBeenCalledWith(expect.objectContaining({
      explanationRef: "knowledge:retry", cwd: trusted().cwd, sessionId: "trusted-session",
      trustedWorkspace: expect.objectContaining({ repositoryId: "repository-1" }), workflowScopeId: "workflow-1",
    }));
    const feedback = await request("tools/call", { name: "provenloop_feedback", arguments: {
      action: "irrelevant", requestId: "search-request", targetId: "retry",
    } }, { handlers });
    expect(feedback.structuredContent.status).toBe("confirmation_required");
    expect(handlers.feedback).not.toHaveBeenCalled();
  });
});

const localFixture = async () => {
  const dataRoot = await temporaryRoot();
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.backends, { recursive: true });
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root: dataRoot }));
  const state = createDefaultCopilotAdapterState(new Date());
  await writeCopilotAdapterState(paths.adapterState, { ...state, installed: true,
    capabilities: { ...state.capabilities, retrieval: { enabled: true } } });
  const store = new CanonicalSqliteStore(paths.database);
  const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
  let knowledgeId: string;
  try {
    const projection = new KnowledgeProjectionManager({ backend, store });
    const control = new KnowledgeControlService({ store, projection: {
      acquireLease: async () => ({ release: async () => undefined }),
      rebuild: () => projection.rebuild().then(() => undefined),
    } });
    const remembered = await control.remember({
      content: "Use an idempotency key before retrying an external write after an ambiguous timeout.",
      appliesWhen: ["Retrying an external write after an ambiguous timeout."],
      scope: "repository", scopeId: "repository-1",
    });
    assert(remembered.candidate);
    knowledgeId = remembered.candidate.knowledgeId;
  } finally { await backend.closeAsync(); store.close(); }
  const handlers = new LocalMcpToolHandlers({ cwd: dataRoot, dataRoot, now: () => new Date() });
  const query = (): ContextSearchRequest => ({
    protocolVersion: 1, cwd: dataRoot, sessionId: "local-search-session",
    prompt: "Retrying an external write after an ambiguous timeout.", tokenBudget: 3_000,
    trustedWorkspace: { repositoryState: "known_repo", repositoryId: "repository-1",
      repositoryObservedAt: new Date().toISOString(), branch: "main", commitSha: "a".repeat(40) },
  });
  return { dataRoot, paths, handlers, query, knowledgeId };
};

describe("local MCP search admission and persistence", () => {
  it("uses the deeper deadline and lets a later Explain inspect an actually returned search item", async () => {
    const fixture = await localFixture();
    const original = SqliteFtsKnowledgeBackend.prototype.searchWithTimeout;
    const budgets: number[] = [];
    let delayed = false;
    vi.spyOn(SqliteFtsKnowledgeBackend.prototype, "searchWithTimeout").mockImplementation(async function (this: SqliteFtsKnowledgeBackend, query, timeoutMs) {
      budgets.push(timeoutMs);
      if (!delayed) { delayed = true; await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 200)); }
      return original.call(this, query, timeoutMs);
    });
    const result = await fixture.handlers.search(fixture.query());
    expect(result, JSON.stringify(result)).toMatchObject({ status: "ok",
      items: [expect.objectContaining({ id: fixture.knowledgeId })] });
    expect(budgets[0]).toBeGreaterThan(150);
    expect(budgets[0]).toBeLessThanOrEqual(1_000);
    assert(result.items[0]);
    const explanationRef = result.items[0].explanationRef;
    const laterHandler = new LocalMcpToolHandlers({ cwd: fixture.dataRoot, dataRoot: fixture.dataRoot, now: () => new Date() });
    await expect(laterHandler.explain({ ...fixture.query(), explanationRef })).resolves.toMatchObject({
      status: "available", id: fixture.knowledgeId,
    });
    await expect(laterHandler.explain({ ...fixture.query(), explanationRef, sessionId: "other-session" }))
      .resolves.toMatchObject({ status: "not_previously_retrieved" });
    await expect(laterHandler.explain({ ...fixture.query(), explanationRef, repoId: "repository-1",
      trustedWorkspace: { repositoryState: "known_outside_repo", repositoryObservedAt: new Date().toISOString() },
    })).resolves.toMatchObject({ status: "not_found" });
    const repeated = await fixture.handlers.search(fixture.query());
    expect(repeated.items.map((item) => item.id)).toContain(fixture.knowledgeId);
    const store = new CanonicalSqliteStore(fixture.paths.database);
    try {
      expect(store.contextUseRecords(fixture.query().sessionId).some((record) =>
        record.requestId === result.requestId && record.retrievalMode === "search" &&
        record.returnedKnowledgeIds.includes(explanationRef))).toBe(true);
      const candidate = store.knowledgeCandidates([fixture.knowledgeId])[0];
      assert(candidate);
      store.upsertKnowledgeCandidates([{ ...candidate, content: "An edited lesson must be retrieved before its sources are explained." }]);
    } finally { store.close(); }
    await expect(laterHandler.explain({ ...fixture.query(), explanationRef })).resolves.toMatchObject({ status: "not_found" });
  });

  it("preserves maintenance, internal-session, disabled, and trusted-scope restrictions", async () => {
    const fixture = await localFixture();
    const barrier = await beginUpgradeMaintenance(fixture.dataRoot);
    try {
      await expect(fixture.handlers.search(fixture.query())).resolves.toMatchObject({
        status: "degraded", items: [], statusDetail: expect.stringContaining("upgrade maintenance"),
      });
    } finally { await barrier.release(); }
    const outside = await fixture.handlers.search({ ...fixture.query(), repoId: "repository-1",
      trustedWorkspace: { repositoryState: "known_outside_repo", repositoryObservedAt: new Date().toISOString() } });
    expect(outside).toMatchObject({ status: "ok", items: [] });
    const stale = await fixture.handlers.search({ ...fixture.query(), trustedWorkspace: {
      repositoryState: "known_repo", repositoryId: "repository-1",
      repositoryObservedAt: new Date(Date.now() - 61_000).toISOString(),
    } });
    expect(stale).toMatchObject({ status: "degraded", items: [], statusDetail: expect.stringContaining("stale") });
    await registerInternalCopilotSession(fixture.dataRoot, fixture.query().sessionId);
    expect(await fixture.handlers.search(fixture.query())).toMatchObject({ status: "muted", items: [] });
    await unregisterInternalCopilotSession(fixture.dataRoot, fixture.query().sessionId);
    const state = createDefaultCopilotAdapterState(new Date());
    await writeCopilotAdapterState(fixture.paths.adapterState, { ...state, installed: true,
      capabilities: { ...state.capabilities, retrieval: { enabled: false } } });
    expect(await fixture.handlers.search(fixture.query())).toMatchObject({
      status: "degraded", items: [], statusDetail: "Retrieval capability is disabled.",
    });
  });
});
