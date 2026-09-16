import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import {
  CopilotLearningProvider, createDefaultCopilotAdapterState, readCopilotAdapterState,
  resolveAutomaticLearning, setPersistedCapability, writeCopilotAdapterState,
  type PersistedCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import { runCli } from "../../packages/cli/src/run-cli.js";
import { runLearningOnce } from "../../packages/cli/src/run-learning.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    assert(path && !isAbsolute(path) && !path.startsWith(".."));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
const readyState = (): PersistedCopilotAdapterState => {
  const initial = createDefaultCopilotAdapterState(new Date());
  return { ...initial, installed: true, capabilities: { ...initial.capabilities,
    capture: { enabled: true }, worker: { enabled: true }, correction_learning: { enabled: true },
  } };
};
const fixture = async (state = readyState()) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-learning-default-")); roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await writeFile(paths.rootMarker, JSON.stringify({ product: "ProvenLoop", schemaVersion: 1, root }));
  await writeCopilotAdapterState(paths.adapterState, state);
  new CanonicalSqliteStore(paths.database).close();
  return paths;
};
const command = async (root: string, action: string, flags: string[] = []) => {
  const logs: string[] = []; const errors: string[] = [];
  const code = await runCli(["learning", action, ...flags, "--data-root", root], { log: (value) => { logs.push(value); }, error: (value) => { errors.push(value); } });
  expect(errors).toEqual([]); expect(code).toBe(0);
  const body = logs.find((value) => value.startsWith("{")); assert(body);
  return { output: JSON.parse(body), logs };
};

describe("automatic learning defaults", () => {
  it("enables a legacy installation only when all prerequisites are met, without inventing consent", () => {
    const state = readyState();
    expect(resolveAutomaticLearning(state)).toMatchObject({ enabled: true, mode: "automatic", blockedBy: [], consentRequired: false, notificationsEnabled: true });
    expect(resolveAutomaticLearning(state)).not.toHaveProperty("consentedAt");
    expect(state.automaticLearning).toBeUndefined();
    for (const capability of ["capture", "worker", "correction_learning"] as const) {
      const paused = setPersistedCapability(state, capability, { enabled: false }, new Date());
      expect(resolveAutomaticLearning(paused).enabled).toBe(false);
      expect(resolveAutomaticLearning({ ...paused, automaticLearning: { enabled: true, notificationsEnabled: true } }).enabled).toBe(false);
    }
    expect(resolveAutomaticLearning({ ...state, installed: false })).toMatchObject({ enabled: false, blockedBy: ["installed"] });
    // Retrieval controls delivery and is not an extraction prerequisite.
    expect(resolveAutomaticLearning(state).prerequisites).toEqual({ installed: true, capture: true, worker: true, correctionLearning: true });
  });

  it("reports effective automatic state without modifying stored preferences", async () => {
    const paths = await fixture(); const before = await readFile(paths.adapterState, "utf8");
    const { output } = await command(paths.root, "status");
    expect(output.automaticLearning).toMatchObject({ enabled: true, mode: "automatic", consentRequired: false });
    expect(output.jobs).toEqual([]);
    expect(await readFile(paths.adapterState, "utf8")).toBe(before);
  });

  it("persists disable before any default or notification preference exists and preserves it across capability toggles", async () => {
    const paths = await fixture();
    expect((await command(paths.root, "disable")).output.automaticLearning).toMatchObject({ enabled: false, mode: "disabled", blockedBy: ["explicitly_disabled"] });
    let state = await readCopilotAdapterState(paths.adapterState, new Date());
    state = setPersistedCapability(state, "worker", { enabled: false }, new Date());
    state = setPersistedCapability(state, "worker", { enabled: true }, new Date());
    await writeCopilotAdapterState(paths.adapterState, state);
    expect((await command(paths.root, "status")).output.automaticLearning.enabled).toBe(false);
    expect(await runLearningOnce({ dataRoot: paths.root, contracts: [] })).toMatchObject({ status: "disabled" });
    for (const flags of [[], ["--confirm"]]) {
      const result = await command(paths.root, "enable", flags);
      expect(result.output.automaticLearning).toMatchObject({ enabled: true, mode: "enabled" });
      expect(result.logs.join(" " )).toContain("service quota");
    }
  });

  it("mutes notifications without freezing automatic eligibility or overriding explicit disable", async () => {
    const paths = await fixture();
    await command(paths.root, "mute");
    let state = await readCopilotAdapterState(paths.adapterState, new Date());
    expect(state.automaticLearning).toEqual({ notificationsEnabled: false });
    expect(resolveAutomaticLearning(state)).toMatchObject({ enabled: true, notificationsEnabled: false, mode: "automatic" });
    await writeCopilotAdapterState(paths.adapterState, setPersistedCapability(state, "capture", { enabled: false }, new Date()));
    const paused = await command(paths.root, "unmute");
    expect(paused.output.automaticLearning).toMatchObject({ enabled: false, mode: "automatic", blockedBy: ["capture"], notificationsEnabled: true });
    await command(paths.root, "disable"); await command(paths.root, "mute"); await command(paths.root, "unmute");
    state = await readCopilotAdapterState(paths.adapterState, new Date());
    expect(state.automaticLearning?.enabled).toBe(false);
  });

  it("rejects partial legacy acknowledgements and preserves valid historical metadata", async () => {
    const paths = await fixture(); const state = readyState();
    for (const automaticLearning of [{ consentedAt: new Date().toISOString(), notificationsEnabled: true }, { disclosureVersion: 1, notificationsEnabled: true }, { enabled: "false", notificationsEnabled: true }]) {
      await writeFile(paths.adapterState, JSON.stringify({ ...state, automaticLearning }));
      await expect(readCopilotAdapterState(paths.adapterState, new Date())).rejects.toThrow("malformed");
    }
    const metadata = { consentedAt: "2026-09-08T00:00:00.000Z", disclosureVersion: 1 as const, enabled: false, notificationsEnabled: false };
    await writeCopilotAdapterState(paths.adapterState, { ...state, automaticLearning: metadata });
    await command(paths.root, "enable");
    expect((await readCopilotAdapterState(paths.adapterState, new Date())).automaticLearning).toEqual({ ...metadata, enabled: true });
  });

  it.each(["no_rule", "candidate", "disabled_during_inference"] as const)("processes captured work with automatic defaults: %s", async (outcome) => {
    const paths = await fixture(); const store = new CanonicalSqliteStore(paths.database);
    const base = Date.now() - 10_000;
    try {
      for (const [index, eventType, trust, content] of [[0, "prompt.submitted", "user", "Use the repository package scripts for tests."], [1, "agent.turn_completed", "model", undefined]] as const) {
        const timestamp = new Date(base + index * 1000).toISOString();
        const envelope = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `default-source-${index}`,
          eventType, trust, sessionId: "default-session", repoId: "default-repo", worktree: paths.root, repositoryState: "known_repo", timestamp,
          ...(content ? { content: { message: content } } : {}),
        });
        const result = store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: `default-queue-${index}`, state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
        expect(result.status).toBe("stored");
      }
    } finally { store.close(); }
    const infer = vi.spyOn(CopilotLearningProvider.prototype, "infer").mockImplementation(async (window) => {
      if (outcome === "disabled_during_inference") await command(paths.root, "disable");
      const user = window.events.find((event) => event.event.trust === "user"); assert(user);
      return { schemaVersion: 1, proposals: outcome === "no_rule" ? [] : [{
        rule: "Use the repository package scripts for tests.", trigger: "Running repository tests", exclusions: ["Other repositories"],
        userSource: { eventId: user.event.eventId, quote: "Use the repository package scripts for tests." },
      }] };
    });
    expect(await runLearningOnce({ dataRoot: paths.root, contracts: [] })).toMatchObject(outcome === "disabled_during_inference"
      ? { status: "disabled" } : { status: "evaluated", proposals: outcome === "candidate" ? 1 : 0, qualified: 0 });
    expect(infer).toHaveBeenCalledOnce();
    const result = new CanonicalSqliteStore(paths.database);
    try {
      expect(result.learningJobs()).toEqual([expect.objectContaining(outcome === "disabled_during_inference"
        ? { state: "paused", pauseReason: "learning_disabled" }
        : { state: "evaluated", result: outcome })]);
      expect(result.knowledgeCandidates()).toEqual(outcome === "candidate" ? [expect.objectContaining({ state: "candidate", evidenceTier: "inferred" })] : []);
      if (outcome === "candidate") {
        const candidate = result.knowledgeCandidates()[0]; assert(candidate);
        const backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
        try { expect(await backend.get(candidate.knowledgeId)).toBeDefined(); } finally { await backend.closeAsync(); }
        expect(JSON.parse(await readFile(paths.projectionDirty, "utf8"))).toMatchObject({ schemaVersion: 1 });
      }
    } finally { result.close(); }
    const preferences = (await readCopilotAdapterState(paths.adapterState, new Date())).automaticLearning;
    if (outcome === "disabled_during_inference") expect(preferences?.enabled).toBe(false);
    else expect(preferences).toBeUndefined();
  });
});
