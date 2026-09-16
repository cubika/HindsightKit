import {
  runInstalledCopilotExtension as startInstalledAdapter,
  type InstalledCopilotExtensionOptions,
  type InstalledCopilotExtensionResult,
} from "@provenloop/copilot-adapter";
import {
  sanitizeDiagnostic,
} from "@provenloop/domain";

import {
  runCaptureWorkerOnce,
} from "./run-worker.js";
import { collectLocalObservations } from "./collect-observations.js";
import { reconcileCurrentSessionCapture } from "./reconcile-capture.js";
import { LocalMcpToolHandlers } from "./run-mcp-server.js";
import { runLearningOnce, notifyLearningActivation } from "./run-learning.js";
import { readCopilotAdapterState, resolveAutomaticLearning } from "@provenloop/copilot-adapter";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";

export type {
  InstalledCopilotExtensionOptions,
  InstalledCopilotExtensionResult,
};

export const runProvenLoopCopilotExtension = async (
  options: InstalledCopilotExtensionOptions,
  dependencies: { readonly runWorker?: typeof runCaptureWorkerOnce; readonly runLearning?: typeof runLearningOnce } = {},
): Promise<InstalledCopilotExtensionResult> => {
  let workerRunning = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let nextObservationAt = 0;
  let deliveryNoticeSent = false;
  let deliveryNoticePending = false;
  let learningNoticeSent = false;
  let learningRunning = false;
  let learningTask: Promise<void> | undefined;
  let workerTask: Promise<void> | undefined;
  const learningShutdown = new AbortController();
  const host = { session: undefined as Extract<InstalledCopilotExtensionResult, { status: "started" }>["hostSession"] };
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const notificationsEnabled = async (): Promise<boolean> => {
    const state = await readCopilotAdapterState(paths.adapterState, new Date());
    const learning = resolveAutomaticLearning(state);
    return learning.enabled && learning.notificationsEnabled && state.capabilities.retrieval.enabled;
  };
  const stopScheduling = (): void => {
    stopped = true;
    learningShutdown.abort();
    clearTimeout(timer);
    process.removeListener("SIGTERM", stopScheduling);
  };
  const result = await startInstalledAdapter({
    ...options,
    onStopping: async () => {
      stopScheduling();
      await Promise.all([learningTask, workerTask]);
      await options.onStopping?.();
    },
    onAutomaticContext: options.onAutomaticContext ?? (async (input) => {
      if (stopped || input.workspace.repositoryState !== "known_repo" || !input.workspace.repoId) return undefined;
      const cwd = input.workspace.cwd ?? input.workspace.worktree;
      if (!cwd) return undefined;
      const response = await new LocalMcpToolHandlers({ cwd, dataRoot: options.dataRoot, now: () => new Date() }).context({
        cwd, sessionId: input.sessionId, tokenBudget: 600,
        prompt: input.prompt?.slice(0, 8192) ?? input.shellTool?.command ?? `${input.tool?.serverName ?? ""} ${input.tool?.toolName ?? ""}`,
        trustedWorkspace: { repositoryState: "known_repo", repositoryObservedAt: new Date().toISOString(),
          repositoryId: input.workspace.repoId, ...(input.workspace.branch === undefined ? {} : { branch: input.workspace.branch }),
          ...(input.workspace.commitSha === undefined ? {} : { commitSha: input.workspace.commitSha }) },
        ...(input.tool === undefined ? {} : { toolInvocation: { serverName: input.tool.serverName, toolName: input.tool.toolName, contractDigest: input.tool.digest } }),
        ...(input.shellTool === undefined || input.workspace.branch === undefined || input.workspace.commitSha === undefined ? {} : {
          shellInvocation: { ...input.shellTool, branch: input.workspace.branch, commitSha: input.workspace.commitSha },
        }),
      });
      if (stopped || response.items.length === 0) return undefined;
      if (!deliveryNoticeSent && !deliveryNoticePending && host.session?.log && await notificationsEnabled() &&
          !stopped && !deliveryNoticeSent && !deliveryNoticePending) {
        const first = response.items[0];
        if (first) {
          deliveryNoticePending = true;
          void host.session.log([
            "ProvenLoop supplied this guidance for the current task:",
            first.guidance,
            `When it applies: ${first.applicabilitySummary}`,
            "Open ProvenLoop Usage to inspect the source and compare what the agent does next.",
          ].join("\n"), { ephemeral: true })
            .then(() => { deliveryNoticeSent = true; })
            .catch(() => undefined)
            .finally(() => { deliveryNoticePending = false; });
        }
      }
      return response.items.map((item) => [
        item.guidance,
        `Applicability: ${item.applicabilitySummary}`,
        `Scope: ${item.scope}${item.scopeId === undefined ? "" : ` (${item.scopeId})`}`,
        `Source: ${item.explanationRef}`,
      ].join("\n")).join("\n\n");
    }),
    onStopped: () => {
      stopScheduling();
      options.onStopped?.();
    },
  });
  if (result.status !== "started" || stopped) {
    return result;
  }
  host.session = result.hostSession;
  (options.signalSource ?? process).once("SIGTERM", stopScheduling);
  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(drainWorker, delayMs);
    timer.unref();
  };
  const drainWorker = (): void => {
    if (workerRunning || stopped) {
      return;
    }
    workerRunning = true;
    workerTask = (dependencies.runWorker ?? runCaptureWorkerOnce)({
      dataRoot: options.dataRoot,
    })
      .then(async (workerResult) => {
        if (!stopped && !learningRunning && workerResult.status === "completed") {
          learningRunning = true;
          learningTask = (dependencies.runLearning ?? runLearningOnce)({ dataRoot: options.dataRoot, contracts: result.toolRegistry?.contracts() ?? [], signal: learningShutdown.signal }).then(async (learning) => {
            if (!stopped && "qualified" in learning && (learning.qualified ?? 0) > 0) await (dependencies.runWorker ?? runCaptureWorkerOnce)({ dataRoot: options.dataRoot });
            if (!stopped && !learningNoticeSent && "learned" in learning && learning.learned.length > 0 && host.session?.log && await notificationsEnabled()) {
              const log = host.session.log.bind(host.session);
              learningNoticeSent = await notifyLearningActivation(options.dataRoot, learning.learned, (message) => log(message, { ephemeral: true }));
            }
          }).catch((error: unknown) => { console.error(`ProvenLoop automatic learning paused: ${sanitizeDiagnostic(error)}`); })
            .finally(() => { learningRunning = false; });
        }
        let observationPending = false;
        if (
          !stopped &&
          workerResult.status === "completed" &&
          Date.now() >= nextObservationAt
        ) {
          nextObservationAt = Date.now() + 30_000;
          if (result.captureSession !== undefined) {
            try {
              const reconciliation = await reconcileCurrentSessionCapture({
                dataRoot: options.dataRoot,
                ...result.captureSession,
                ...(options.now === undefined ? {} : { now: options.now }),
              });
              if (reconciliation.status === "reconciled" || reconciliation.status === "budget_exhausted") {
                const detail = reconciliation.reconciliation;
                observationPending =
                  reconciliation.status === "budget_exhausted" ||
                  reconciliation.enrichedEvents > 0 ||
                  ("queuedEvents" in detail && detail.queuedEvents > 0);
                for (const message of reconciliation.diagnostics) {
                  console.error(`ProvenLoop capture reconciliation: ${sanitizeDiagnostic(message)}`);
                }
              } else if ("reason" in reconciliation && reconciliation.status !== "skipped") {
                console.error(
                  `ProvenLoop capture reconciliation ${reconciliation.status}: ${reconciliation.reason}`,
                );
              }
            } catch (error) {
              console.error(`ProvenLoop capture reconciliation failed: ${sanitizeDiagnostic(error)}`);
            }
          }
          if (stopped) return;
          try {
            const observation = await collectLocalObservations({
              dataRoot: options.dataRoot,
            });
            observationPending ||= observation.pending;
          } catch (error) {
            console.error(
              `ProvenLoop local observation failed: ${sanitizeDiagnostic(error)}`,
            );
          }
          if (observationPending) nextObservationAt = Date.now() + 2_000;
        }
        const active =
          observationPending ||
          (workerResult.status === "completed" &&
          (
            workerResult.acknowledged > 0 ||
            workerResult.deadLettered > 0 ||
            workerResult.retried > 0
          ));
        schedule(active ? 2_000 : 30_000);
      })
      .catch((error: unknown) => {
        console.error(
          `ProvenLoop background worker failed: ${
            sanitizeDiagnostic(error)
          }`,
        );
        schedule(30_000);
      })
      .finally(() => {
        workerRunning = false;
      });
  };
  drainWorker();
  return result;
};

export const runInstalledCopilotExtension = runProvenLoopCopilotExtension;
