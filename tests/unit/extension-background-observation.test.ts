import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const work = vi.hoisted(() => ({
  installed: vi.fn(),
  worker: vi.fn(),
  collect: vi.fn(),
  reconcile: vi.fn(),
  state: vi.fn(),
}));

vi.mock("@provenloop/copilot-adapter", async (original) => ({
  ...await original<typeof import("@provenloop/copilot-adapter")>(),
  runInstalledCopilotExtension: work.installed,
  readCopilotAdapterState: work.state,
}));
vi.mock("../../packages/cli/src/run-worker.js", () => ({
  runCaptureWorkerOnce: work.worker,
}));
vi.mock("../../packages/cli/src/collect-observations.js", () => ({
  collectLocalObservations: work.collect,
  invalidateLocalObservationProjection: vi.fn(),
}));
vi.mock("../../packages/cli/src/reconcile-capture.js", () => ({
  reconcileCurrentSessionCapture: work.reconcile,
}));

import { runProvenLoopCopilotExtension } from "@provenloop/cli";
import { runInstalledCopilotExtension } from "../../packages/cli/src/extension-entry.js";
import { LocalMcpToolHandlers } from "../../packages/cli/src/run-mcp-server.js";
import type { InstalledCopilotExtensionOptions } from "@provenloop/copilot-adapter";
import { estimateRenderedTokens, type ContextItem } from "@provenloop/retrieval";

let stop: (() => void) | undefined;
const options = {
  dataRoot: "C:\\provenloop-background-test",
  joinSession: async () => ({ on: () => undefined }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  stop = undefined;
  const once = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM") {
      stop = () => { listener(); };
      return process;
    }
    return once(event, listener);
  });
  work.installed.mockResolvedValue({ status: "started" });
  work.state.mockResolvedValue({ installed: false, capabilities: { capture: { enabled: false }, worker: { enabled: false },
    correction_learning: { enabled: false }, retrieval: { enabled: false } } });
  work.worker.mockResolvedValue({
    status: "completed",
    acknowledged: 0,
    deadLettered: 0,
    retried: 0,
  });
  work.collect.mockResolvedValue({
    status: "recorded",
    events: 0,
    contextUses: 0,
    pending: false,
  });
  work.reconcile.mockResolvedValue({ status: "skipped", reason: "capture_or_worker_disabled" });
});

afterEach(() => {
  stop?.();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("automatic Extension observation scheduling", () => {
  it("shows the actual delivered lesson once and keeps muted retrieval working", async () => {
    const log = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const state = { installed: true, automaticLearning: { enabled: true, notificationsEnabled: false }, capabilities: {
      capture: { enabled: true }, worker: { enabled: true }, correction_learning: { enabled: true }, retrieval: { enabled: true },
    } };
    work.state.mockResolvedValue(state);
    work.installed.mockResolvedValue({ status: "started", hostSession: { log, on: () => undefined } });
    const item: ContextItem = { id: "docs", kind: "knowledge", rank: 20, evidenceTier: "inferred",
      guidance: "Lesson: Write repository documentation in English.", applicabilitySummary: "Writing documentation; preserve identifiers.",
      scope: "repository", scopeId: "repo", explanationRef: "knowledge:docs" };
    vi.spyOn(LocalMcpToolHandlers.prototype, "context").mockResolvedValue({ items: [item], latencyMs: 1,
      renderedTokens: 50, requestId: "request", status: "ok" });
    await runProvenLoopCopilotExtension(options, { runLearning: async () => ({ status: "disabled" }) });
    const installed = work.installed.mock.calls[0]?.[0] as InstalledCopilotExtensionOptions;
    const input = { sessionId: "current-session", prompt: "Write documentation",
      workspace: { repositoryState: "known_repo" as const, repoId: "repo", cwd: "C:/repo" } };
    expect(await installed.onAutomaticContext?.(input)).toContain(item.guidance);
    expect(log).not.toHaveBeenCalled();
    state.automaticLearning.notificationsEnabled = true;
    log.mockRejectedValueOnce(new Error("Host log unavailable"));
    await installed.onAutomaticContext?.(input);
    await vi.advanceTimersByTimeAsync(0);
    await installed.onAutomaticContext?.(input);
    await vi.advanceTimersByTimeAsync(0);
    await installed.onAutomaticContext?.(input);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.lastCall?.[0]).toContain(item.guidance);
    expect(log.mock.lastCall?.[0]).toContain(item.applicabilitySummary);
    expect(log.mock.lastCall?.[0]).not.toContain(item.explanationRef);
    expect(log.mock.lastCall?.[0]).toContain("supplied this guidance");
  });

  it("preserves complete applicability and scope in the native hook context", async () => {
    const item: ContextItem = {
      id: "docs-language", kind: "knowledge", rank: 20, evidenceTier: "inferred", deliveryMode: "convention", sources: [],
      guidance: "Lesson distilled from prior user guidance. Model-reviewed, not user-confirmed; current instructions take precedence.\nLesson: Write repository documentation in English.",
      applicabilitySummary: "Writing or editing repository documentation; Not when: Preserve original quotations and identifiers without translation.; Not when: The task concerns another repository or executable code.",
      scope: "repository", scopeId: "repo-docs", explanationRef: "knowledge:docs-language",
    };
    const context = vi.spyOn(LocalMcpToolHandlers.prototype, "context").mockResolvedValue({ items: [item], latencyMs: 1,
      renderedTokens: estimateRenderedTokens(JSON.stringify([item])), requestId: "request-docs", status: "ok" });
    await runProvenLoopCopilotExtension(options, { runLearning: async () => ({ status: "disabled" }) });
    const installedOptions = work.installed.mock.calls[0]?.[0] as InstalledCopilotExtensionOptions;
    const additionalContext = await installedOptions.onAutomaticContext?.({ sessionId: "current-session", prompt: "Write documentation",
      workspace: { repositoryState: "known_repo", repoId: "repo-docs", cwd: "C:/repo-docs" } });
    expect(context).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 600 }));
    expect(additionalContext).toContain(item.guidance);
    expect(additionalContext).toContain("Applicability: " + item.applicabilitySummary);
    expect(additionalContext).toContain("Preserve original quotations and identifiers without translation.");
    expect(additionalContext).toContain("The task concerns another repository or executable code.");
    expect(additionalContext).toContain("Scope: repository (repo-docs)");
    expect(additionalContext).toContain("Source: knowledge:docs-language");
    expect(estimateRenderedTokens(additionalContext ?? "")).toBeLessThanOrEqual(estimateRenderedTokens(JSON.stringify([item])));
    expect(estimateRenderedTokens(additionalContext ?? "")).toBeLessThanOrEqual(600);
  });

  it("exports the complete scheduler under the entry name used by installed plugins", () => {
    expect(runInstalledCopilotExtension).toBe(runProvenLoopCopilotExtension);
  });
  it("continues capture and observation while background inference is unresolved", async () => {
    let finish: ((result: { status: "disabled" }) => void) | undefined;
    const runLearning = vi.fn(() => new Promise<{ status: "disabled" }>((resolve) => { finish = resolve; }));
    await runProvenLoopCopilotExtension(options, { runLearning });
    await vi.advanceTimersByTimeAsync(0);
    expect(runLearning).toHaveBeenCalledTimes(1);
    expect(work.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
    expect(runLearning).toHaveBeenCalledTimes(1);
    stop?.();
    finish?.({ status: "disabled" });
    await vi.advanceTimersByTimeAsync(0);
    expect(work.worker).toHaveBeenCalledTimes(2);
  });
  it("waits for learning cleanup before completing the installed stopping hook", async () => {
    let finish: ((result: { status: "disabled" }) => void) | undefined;
    let signal: AbortSignal | undefined;
    const runLearning = vi.fn((input) => {
      signal = input.signal;
      return new Promise<{ status: "disabled" }>((resolve) => { finish = resolve; });
    });
    await runProvenLoopCopilotExtension(options, { runLearning });
    await vi.advanceTimersByTimeAsync(0);
    const installedOptions = work.installed.mock.calls[0]?.[0] as { onStopping: () => Promise<void> };
    let settled = false;
    const stopping = installedOptions.onStopping().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    const previousWorkers = work.worker.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(previousWorkers);
    finish?.({ status: "disabled" });
    await stopping;
    expect(settled).toBe(true);
  });
  it("waits for an already-running observation drain before reporting stopped", async () => {
    let finish: (() => void) | undefined;
    work.collect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await runProvenLoopCopilotExtension(options, { runLearning: async () => ({ status: "disabled" }) });
    await vi.advanceTimersByTimeAsync(0);
    const installedOptions = work.installed.mock.calls[0]?.[0] as { onStopping: () => Promise<void> };
    let stopped = false;
    const stopping = installedOptions.onStopping().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("collects without an acceptance command and throttles idle work", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.worker).toHaveBeenCalledTimes(1);
    expect(work.collect).toHaveBeenCalledWith({ dataRoot: options.dataRoot });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(work.collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.collect).toHaveBeenCalledTimes(2);
    stop?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("catches up bounded observation pages without starting another service", async () => {
    work.collect.mockResolvedValueOnce({
      status: "recorded",
      events: 500,
      contextUses: 500,
      pending: true,
    });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("does not schedule side effects for a disabled integration", async () => {
    work.installed.mockResolvedValue({ status: "disabled" });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.worker).not.toHaveBeenCalled();
    expect(work.collect).not.toHaveBeenCalled();
    expect(work.reconcile).not.toHaveBeenCalled();
  });

  it("leaves observations pending when resource admission blocks the worker", async () => {
    work.worker.mockResolvedValue({ status: "circuit_open", reasons: ["memory"] });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.collect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
  });

  it("surfaces observation failure and retries without breaking the worker", async () => {
    work.collect.mockRejectedValueOnce(new Error("Observation storage is busy."));
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringContaining("ProvenLoop local observation failed"),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.collect).toHaveBeenCalledTimes(2);
  });

  it("reconciles only the SDK-bound Session after worker admission and drains new events promptly", async () => {
    const captureSession = {
      sessionId: "sdk-session",
      sessionStateRoot: "C:\\sdk-state",
      minimumTimestamp: "2026-09-01T00:00:00.000Z",
    };
    work.installed.mockResolvedValue({ status: "started", captureSession });
    work.reconcile.mockResolvedValueOnce({
      status: "reconciled",
      enrichedEvents: 1,
      diagnostics: [],
      reconciliation: { status: "reconciled", queuedEvents: 2 },
    });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).toHaveBeenCalledWith({ dataRoot: options.dataRoot, ...captureSession });
    expect(work.worker.mock.invocationCallOrder[0]).toBeLessThan(work.reconcile.mock.invocationCallOrder[0] ?? 0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(work.worker).toHaveBeenCalledTimes(2);
    expect(work.reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not reconcile without SDK workspace metadata or while the worker is blocked", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).not.toHaveBeenCalled();
    stop?.();
    work.installed.mockResolvedValue({
      status: "started",
      captureSession: { sessionId: "sdk-session", sessionStateRoot: "C:\\sdk-state", minimumTimestamp: new Date().toISOString() },
    });
    work.worker.mockResolvedValue({ status: "circuit_open", reasons: ["memory"] });
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.reconcile).not.toHaveBeenCalled();
  });

  it("stops background reconciliation when the installed SDK runtime stops", async () => {
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    const installedOptions = work.installed.mock.calls[0]?.[0] as { onStopped: () => void };
    installedOptions.onStopped();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work.worker).toHaveBeenCalledTimes(1);
  });

  it("reports rejected reconciliation without failing normal background observations", async () => {
    work.installed.mockResolvedValue({
      status: "started",
      captureSession: { sessionId: "sdk-session", sessionStateRoot: "C:\\sdk-state", minimumTimestamp: new Date().toISOString() },
    });
    work.reconcile.mockResolvedValue({ status: "rejected", reason: "session_source_escape" });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runProvenLoopCopilotExtension(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("session_source_escape"));
    expect(work.collect).toHaveBeenCalledTimes(1);
  });
});
