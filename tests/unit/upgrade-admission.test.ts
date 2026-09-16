import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCopilotAdapterState, writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import {
  beginUpgradeMaintenance, isUpgradeMaintenanceActive, resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths, waitForMaintenanceLease, WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

import { LocalMcpToolHandlers } from "../../packages/cli/src/run-mcp-server.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fixture = async (retrieval = false) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-upgrade-admission-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root }));
  const now = new Date();
  const state = createDefaultCopilotAdapterState(now);
  await writeCopilotAdapterState(paths.adapterState, {
    ...state, installed: true, capabilities: { ...state.capabilities, retrieval: { enabled: retrieval } },
  });
  new CanonicalSqliteStore(paths.database).close();
  const handlers = new LocalMcpToolHandlers({ cwd: root, dataRoot: root, now: () => new Date() });
  const request = { cwd: root, prompt: "Continue the current task.", sessionId: "admission-session", tokenBudget: 200 };
  return { paths, handlers, request };
};

describe("MCP admission during upgrade maintenance", () => {
  it.each(["disabled_context", "unavailable_context"] as const)(
    "holds off %s observations during maintenance and resumes the same handler afterwards",
    async (kind) => {
      const { paths, handlers, request } = await fixture();
      const call = () => kind === "disabled_context"
        ? handlers.context(request)
        : handlers.unavailableContext(request, "Repository identity is temporarily unavailable.");
      const barrier = await beginUpgradeMaintenance(paths.root);
      try {
        expect(await isUpgradeMaintenanceActive(paths.root)).toBe(true);
        await expect(call()).resolves.toMatchObject({
          status: "degraded", items: [], statusDetail: expect.stringContaining("upgrade maintenance"),
        });
        const store = new CanonicalSqliteStore(paths.database);
        try { expect(store.contextUseRecords(request.sessionId)).toEqual([]); }
        finally { store.close(); }
      } finally { await barrier.release(); }
      expect(await isUpgradeMaintenanceActive(paths.root)).toBe(false);
      await expect(call()).resolves.toMatchObject({
        status: "degraded",
        statusDetail: kind === "disabled_context"
          ? "Retrieval capability is disabled."
          : "Repository identity is temporarily unavailable.",
      });
      const store = new CanonicalSqliteStore(paths.database);
      try { expect(store.contextUseRecords(request.sessionId)).toHaveLength(1); }
      finally { store.close(); }
    },
  );

  it("holds off retrieval, Explain and Feedback before opening the database", async () => {
    const { paths, handlers, request } = await fixture(true);
    await writeFile(paths.database, "A database open must not occur during maintenance.", "utf8");
    const barrier = await beginUpgradeMaintenance(paths.root);
    try {
      await expect(handlers.context({ ...request, trustedWorkspace: {
        repositoryState: "known_outside_repo", repositoryObservedAt: new Date().toISOString(),
      } })).resolves.toMatchObject({ status: "degraded", statusDetail: expect.stringContaining("upgrade maintenance") });
      await expect(handlers.explain({ sessionId: request.sessionId, explanationRef: "knowledge:unknown" }))
        .rejects.toThrow(/upgrade maintenance/iu);
      await expect(handlers.feedback({ action: "helpful", requestId: "request-admission", sessionId: request.sessionId, targetId: "knowledge-unknown" }))
        .rejects.toThrow(/upgrade maintenance/iu);
    } finally { await barrier.release(); }
  });

  it("drains an active MCP request only after its database cleanup finishes", async () => {
    const { paths, handlers, request } = await fixture(true);
    await mkdir(paths.backends, { recursive: true });
    const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
    await backend.closeAsync();
    const close = SqliteFtsKnowledgeBackend.prototype.closeAsync;
    let finishCleanup: (() => void) | undefined;
    let cleanupStarted = false;
    const cleanup = new Promise<void>((resolveCleanup) => { finishCleanup = resolveCleanup; });
    vi.spyOn(SqliteFtsKnowledgeBackend.prototype, "closeAsync").mockImplementation(async function (this: SqliteFtsKnowledgeBackend) {
      cleanupStarted = true;
      await cleanup;
      await close.call(this);
    });
    const active = handlers.explain({ sessionId: request.sessionId, explanationRef: "knowledge:unknown" });
    void active.catch(() => undefined);
    let barrier: Awaited<ReturnType<typeof beginUpgradeMaintenance>> | undefined;
    let draining: ReturnType<typeof waitForMaintenanceLease> | undefined;
    try {
      await expect.poll(() => cleanupStarted).toBe(true);
      barrier = await beginUpgradeMaintenance(paths.root);
      let drained = false;
      draining = waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection"),
      ), Date.now() + 2_000, "active MCP request").then((lease) => { drained = true; return lease; });
      void draining.catch(() => undefined);
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 50); });
      expect(drained).toBe(false);
      finishCleanup?.();
      await expect(active).resolves.toMatchObject({ status: "not_previously_retrieved" });
      const drainedLease = await draining;
      expect(drained).toBe(true);
      await drainedLease.release();
    } finally {
      finishCleanup?.();
      await active.catch(() => undefined);
      await draining?.then((lease) => lease.release(), () => undefined);
      await barrier?.release();
    }
  });
});
