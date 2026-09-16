import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  rename,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import {
  assertCopilotAdapterDataRoot,
  readCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import { sanitizeDiagnostic } from "@provenloop/domain";
import {
  BranchContextProjector,
  CaptureWorker,
  CaptureWorkerCircuitBreaker,
  CorrectionCaptureProjector,
  KnowledgeLifecycleProjector,
  WorkEpisodeProjector,
  type CaptureWorkerAdmission,
  type CaptureWorkerRunResult,
} from "@provenloop/host";
import {
  isUpgradeMaintenanceActive,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
  type ProcessLeaseProvider,
} from "@provenloop/platform-windows";
import {
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

export interface RunCaptureWorkerOnceOptions {
  readonly admission?: () =>
    | CaptureWorkerAdmission
    | Promise<CaptureWorkerAdmission>;
  readonly batchSize?: number;
  readonly dataRoot: string;
  readonly lease?: ProcessLeaseProvider;
  readonly now?: () => Date;
  readonly workerId?: string;
}

const defaultCircuitBreaker = (): CaptureWorkerCircuitBreaker =>
  new CaptureWorkerCircuitBreaker({
    maxConsecutiveProviderErrors: 3,
    maxCpuPercent: 80,
    maxMemoryBytes: 512 * 1024 * 1024,
    maxQueueDepth: 10_000,
    minFreeDiskBytes: 512 * 1024 * 1024,
  });

const KNOWLEDGE_PROJECTION_LEASE_TIMEOUT_MS = 5_000;
const LEASE_RETRY_DELAY_MS = 25;

const acquireRequiredLease = async (
  provider: ProcessLeaseProvider,
): Promise<ProcessLease> => {
  const deadline =
    Date.now() + KNOWLEDGE_PROJECTION_LEASE_TIMEOUT_MS;
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for the Knowledge projection lease.",
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LEASE_RETRY_DELAY_MS);
    });
    lease = await provider.tryAcquire();
  }
  return lease;
};

const writeHeartbeat = async (
  path: string,
  input: {
    readonly correctionCaptureIssueCount?: number;
    readonly correctionCaptureIssues?: readonly string[];
    readonly correctionProjectionError?: string;
    readonly knowledgeLifecycleProjectionError?: string;
    readonly knowledgeProjectionError?: string;
    readonly queueIssues?: readonly {
      readonly queueItemId: string;
      readonly error: string;
    }[];
    readonly result: CaptureWorkerRunResult;
    readonly timestamp: string;
    readonly workerId: string;
  },
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        ...input,
      })}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

export const runCaptureWorkerOnce = async (
  options: RunCaptureWorkerOnceOptions,
): Promise<CaptureWorkerRunResult> => {
  const now = options.now ?? (() => new Date());
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  if (await isUpgradeMaintenanceActive(paths.root)) return { status: "lease_unavailable" };
  await assertCopilotAdapterDataRoot(paths);
  await access(paths.database);
  const workerId =
    options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const leaseProvider =
    options.lease ??
    new WindowsNamedPipeLeaseProvider(
      await resolveWindowsCaptureWorkerLeaseName(paths.root),
    );
  const workerLease = await leaseProvider.tryAcquire();
  if (workerLease === undefined) {
    return {
      status: "lease_unavailable",
    };
  }
  try {
    if (await isUpgradeMaintenanceActive(paths.root)) {
      await workerLease.release();
      return { status: "lease_unavailable" };
    }
  } catch (error) {
    await workerLease.release();
    throw error;
  }
  let store: CanonicalSqliteStore | undefined;
  let knowledgeBackend: SqliteFtsKnowledgeBackend | undefined;
  const queueDiagnostics: string[] = [];
  const queue = new WindowsCaptureQueue(paths.queue, {
    onDiagnostic: (message) => {
      if (queueDiagnostics.length < 100) queueDiagnostics.push(message);
    },
  });
  const breaker = defaultCircuitBreaker();
  let previousCpu = process.cpuUsage();
  let previousCpuAt = process.hrtime.bigint();
  try {
    await queue.initialize();
    await queue.pruneAcknowledged();
    store = new CanonicalSqliteStore(paths.database);
    let projectionMarked = await access(
      paths.projectionDirty,
    ).then(
      () => true,
      () => false,
    );
    const markProjectionDirty = async (): Promise<void> => {
      if (projectionMarked) {
        return;
      }
      await writeFile(
        paths.projectionDirty,
        `${JSON.stringify({
          markedAt: now().toISOString(),
          schemaVersion: 1,
        })}\n`,
        "utf8",
      );
      projectionMarked = true;
    };
    const result = await new CaptureWorker({
      admission:
        options.admission ??
        (async () => {
          const currentCpuAt = process.hrtime.bigint();
          const elapsedMicroseconds =
            Number(currentCpuAt - previousCpuAt) / 1_000;
          const currentCpu = process.cpuUsage();
          const usedMicroseconds =
            currentCpu.user - previousCpu.user +
            currentCpu.system - previousCpu.system;
          previousCpu = currentCpu;
          previousCpuAt = currentCpuAt;
          const filesystem = await statfs(paths.root);
          const queueDepth = await queue.depth();
          return breaker.evaluate({
            consecutiveProviderErrors: 0,
            cpuPercent:
              elapsedMicroseconds <= 0
                ? 0
                : usedMicroseconds /
                  elapsedMicroseconds /
                  availableParallelism() *
                  100,
            freeDiskBytes:
              Number(filesystem.bavail) *
              Number(filesystem.bsize),
            memoryBytes: process.memoryUsage().rss,
            queueDepth,
          });
        }),
      batchSize: options.batchSize ?? 100,
      enabled: async () =>
        (
          await readCopilotAdapterState(
            paths.adapterState,
            now(),
          )
        ).capabilities.worker.enabled,
      lease: {
        tryAcquire: async () => ({
          release: async () => undefined,
        }),
      },
      onCanonicalMutationPending: markProjectionDirty,
      queue,
      store,
      workerId,
    }).runOnce();
    const adapterState =
      result.status === "completed"
        ? await readCopilotAdapterState(
            paths.adapterState,
            now(),
          )
        : undefined;
    const projectionRequired =
      result.status === "completed" &&
      (result.stored > 0 || projectionMarked);
    let correctionCaptureIssueCount: number | undefined;
    let correctionCaptureIssues: readonly string[] | undefined;
    let correctionProjectionError: string | undefined;
    let knowledgeLifecycleProjectionError: string | undefined;
    if (projectionRequired) {
      const envelopes = store.episodeSourceEnvelopes();
      new WorkEpisodeProjector({
        store,
      }).rebuild(undefined, { envelopes, associationMode: "connected" });
      if (
        adapterState?.capabilities.correction_learning.enabled === true
      ) {
        try {
          const correctionProjection =
            new CorrectionCaptureProjector({
              store,
            }).rebuild({ envelopes });
          correctionCaptureIssueCount =
            correctionProjection.issues.length;
          correctionCaptureIssues = correctionProjection.issues
            .slice(0, 20)
            .map((item) =>
              sanitizeDiagnostic(
                `${item.eventId}: ${item.message}`,
              ),
            );
        } catch (error) {
          correctionProjectionError = sanitizeDiagnostic(error);
        }
        if (correctionProjectionError === undefined) {
          try {
            new KnowledgeLifecycleProjector({
              store,
            }).rebuild({ envelopes });
          } catch (error) {
            knowledgeLifecycleProjectionError =
              sanitizeDiagnostic(error);
          }
        }
      }
      new BranchContextProjector({
        store,
      }).rebuild({ envelopes });
    }
    let knowledgeProjectionError: string | undefined;
    if (
      result.status === "completed" &&
      adapterState?.capabilities.retrieval.enabled === true
    ) {
      try {
        knowledgeBackend = new SqliteFtsKnowledgeBackend(
          paths.knowledgeDatabase,
        );
        const knowledgeLease = await acquireRequiredLease(
          new WindowsNamedPipeLeaseProvider(
            await resolveWindowsProvenLoopLeaseName(
              paths.root,
              "knowledge-projection",
            ),
          ),
        );
        try {
          if (projectionRequired || knowledgeBackend.needsDiscoveryRefresh()) {
            await new KnowledgeProjectionManager({
              backend: knowledgeBackend,
              store,
            }).synchronize();
          }
        } finally {
          try {
            await knowledgeBackend.closeAsync();
            knowledgeBackend = undefined;
          } finally {
            await knowledgeLease.release();
          }
        }
      } catch (error) {
        knowledgeProjectionError = sanitizeDiagnostic(error);
      } finally {
        await knowledgeBackend?.closeAsync();
        knowledgeBackend = undefined;
      }
    }
    if (
      projectionRequired &&
      correctionProjectionError === undefined &&
      knowledgeLifecycleProjectionError === undefined &&
      knowledgeProjectionError === undefined
    ) {
      await unlink(paths.projectionDirty).catch((error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      });
    }
    store.close();
    store = undefined;
    const queueIssues = await queue.quarantineIssues();
    const reportedResult: CaptureWorkerRunResult =
      result.status === "completed" && queueIssues.length > 0
        ? { ...result, quarantinedItems: queueIssues.length }
        : result;
    if (queueDiagnostics.length > 0) {
      await mkdir(paths.logs, { recursive: true }).then(() =>
        appendFile(join(paths.logs, "worker.jsonl"), `${JSON.stringify({
          timestamp: now().toISOString(),
          message: "Capture queue has quarantined items; healthy items remain processable.",
          reportedItems: queueIssues.length,
          diagnostics: queueDiagnostics,
        })}\n`, "utf8"),
      ).catch(() => undefined);
    }
    await writeHeartbeat(paths.heartbeat, {
      queueIssues: queueIssues.slice(0, 100),
      ...(correctionCaptureIssueCount === undefined
        ? {}
        : {
            correctionCaptureIssueCount,
          }),
      ...(correctionCaptureIssues === undefined
        ? {}
        : {
            correctionCaptureIssues,
          }),
      ...(correctionProjectionError === undefined
        ? {}
        : {
            correctionProjectionError,
          }),
      ...(knowledgeProjectionError === undefined
        ? {}
        : {
            knowledgeProjectionError,
          }),
      ...(knowledgeLifecycleProjectionError === undefined
        ? {}
        : {
            knowledgeLifecycleProjectionError,
          }),
      result: reportedResult,
      timestamp: now().toISOString(),
      workerId,
    });
    if (knowledgeProjectionError !== undefined) {
      throw new Error(
        `Knowledge projection failed: ${knowledgeProjectionError}`,
      );
    }
    if (knowledgeLifecycleProjectionError !== undefined) {
      throw new Error(
        "Knowledge lifecycle projection failed: " +
        knowledgeLifecycleProjectionError,
      );
    }
    if (correctionProjectionError !== undefined) {
      throw new Error(
        `Correction projection failed: ${correctionProjectionError}`,
      );
    }
    return reportedResult;
  } finally {
    try {
      await knowledgeBackend?.closeAsync();
    } finally {
      try {
        store?.close();
      } finally {
        await workerLease.release();
      }
    }
  }
};
