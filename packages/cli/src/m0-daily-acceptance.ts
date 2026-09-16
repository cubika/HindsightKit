import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  homedir,
  platform,
  release,
  version as operatingSystemVersion,
} from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";

import {
  assertCopilotAdapterDataRoot,
  CaptureReconciler,
  CopilotCliAdapter,
  readInternalSessionIds,
  type CaptureReconciliationResult,
} from "@provenloop/copilot-adapter";
import {
  PROVENLOOP_VERSION,
  type AdapterHealth,
  type AdapterStatus,
  type CaptureQueueState,
} from "@provenloop/contracts";
import {
  containsKnownSecret,
} from "@provenloop/domain";
import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

import {
  PROVENLOOP_CODE_VERSION,
} from "./release-metadata.js";
import {
  runCaptureWorkerOnce,
} from "./run-worker.js";

const queueStates: readonly CaptureQueueState[] = [
  "acknowledged",
  "claimed",
  "dead-letter",
  "pending",
  "retry",
];

interface DailyRunState {
  readonly dataRoot: string;
  readonly initialCanonicalEventCount: number;
  readonly initialQueueCounts: Readonly<Record<CaptureQueueState, number>>;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly sessionRoot: string;
  readonly startedAt: string;
  readonly status: "active" | "completed";
}

const retainedRunState = (
  state: DailyRunState,
): Omit<DailyRunState, "dataRoot" | "sessionRoot"> & {
  readonly sessionRootDigest: string;
} => ({
  initialCanonicalEventCount: state.initialCanonicalEventCount,
  initialQueueCounts: state.initialQueueCounts,
  runId: state.runId,
  schemaVersion: state.schemaVersion,
  sessionRootDigest: createHash("sha256")
    .update(state.sessionRoot.toLocaleLowerCase("en-US"))
    .digest("hex"),
  startedAt: state.startedAt,
  status: state.status,
});

export interface StartM0DailyAcceptanceOptions {
  readonly adapter?: {
    doctor(): Promise<AdapterHealth>;
    status(): Promise<AdapterStatus>;
  };
  readonly copilotHome?: string;
  readonly dataRoot: string;
  readonly now?: () => Date;
  readonly sessionRoot?: string;
}

export interface CompleteM0DailyAcceptanceOptions {
  readonly adapter?: {
    doctor(): Promise<AdapterHealth>;
    status(): Promise<AdapterStatus>;
  };
  readonly dataRoot: string;
  readonly drainTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface M0DailyAcceptanceResult {
  readonly reportPath: string;
  readonly runDirectory: string;
  readonly runId: string;
  readonly status: "fail" | "incomplete" | "pass";
}

const writeJsonAtomic = async (
  path: string,
  value: unknown,
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), {
    recursive: true,
  });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const queueCounts = (
  items: readonly {
    readonly state: CaptureQueueState;
  }[],
): Readonly<Record<CaptureQueueState, number>> =>
  Object.fromEntries(
    queueStates.map((state) => [
      state,
      items.filter((item) => item.state === state).length,
    ]),
  ) as Readonly<Record<CaptureQueueState, number>>;

const runtimeDigest = async (): Promise<string> => {
  const entryPath = process.argv[1];
  if (entryPath === undefined || !await pathExists(entryPath)) {
    return createHash("sha256")
      .update("provenloop-source-typescript-v1", "utf8")
      .digest("hex");
  }
  return createHash("sha256")
    .update(await readFile(entryPath))
    .digest("hex");
};

const percentile = (
  samples: readonly number[],
  value: number,
): number | undefined => {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [
    ...samples,
  ].sort((left, right) => left - right);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * value) - 1,
    )
  ];
};

const readRunState = async (
  path: string,
): Promise<DailyRunState> => {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== 1 ||
    !("runId" in parsed) ||
    typeof parsed.runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parsed.runId) ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "string" ||
    !("sessionRoot" in parsed) ||
    typeof parsed.sessionRoot !== "string" ||
    !("dataRoot" in parsed) ||
    typeof parsed.dataRoot !== "string" ||
    !("status" in parsed) ||
    (parsed.status !== "active" && parsed.status !== "completed") ||
    !("initialCanonicalEventCount" in parsed) ||
    typeof parsed.initialCanonicalEventCount !== "number" ||
    !("initialQueueCounts" in parsed) ||
    parsed.initialQueueCounts === null ||
    typeof parsed.initialQueueCounts !== "object"
  ) {
    throw new Error("The active M0 daily acceptance state is invalid.");
  }
  return parsed as DailyRunState;
};

const findFiles = async (
  root: string,
  fileName: string,
  modifiedSince: number,
): Promise<readonly string[]> => {
  if (!await pathExists(root)) {
    return [];
  }
  const found: string[] = [];
  const pending = [
    root,
  ];
  while (pending.length > 0 && found.length < 2_000) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of await readdir(current, {
      withFileTypes: true,
    })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (
        entry.isFile() &&
        entry.name === fileName &&
        (await stat(path)).mtimeMs >= modifiedSince
      ) {
        found.push(path);
      }
    }
  }
  return found.sort();
};

const drainWorker = async (
  dataRoot: string,
  timeoutMs: number,
  runWorker: typeof runCaptureWorkerOnce,
): Promise<{
  readonly completed: boolean;
  readonly iterations: number;
}> => {
  const deadline = Date.now() + timeoutMs;
  let iterations = 0;
  while (Date.now() < deadline) {
    const result = await runWorker({
      batchSize: 100,
      dataRoot,
    });
    iterations += 1;
    if (result.status !== "completed") {
      return {
        completed: false,
        iterations,
      };
    }
    if (
      result.failed === 0 &&
      result.acknowledged + result.deadLettered === 0
    ) {
      return {
        completed: true,
        iterations,
      };
    }
  }
  return {
    completed: false,
    iterations,
  };
};

const eventCounts = (
  records: readonly {
    readonly eventType: string;
  }[],
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(
      record.eventType,
      (counts.get(record.eventType) ?? 0) + 1,
    );
  }
  return Object.fromEntries(
    [
      ...counts,
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
};

export const startM0DailyAcceptance = async (
  options: StartM0DailyAcceptanceOptions,
): Promise<M0DailyAcceptanceResult> => {
  const now = options.now ?? (() => new Date());
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  const dailyRoot = join(paths.evaluation, "m0-daily");
  const activePath = join(dailyRoot, "active.json");
  await mkdir(dailyRoot, {
    recursive: true,
  });
  if (await pathExists(activePath)) {
    throw new Error("Another M0 daily acceptance run is active.");
  }
  const startedAt = now();
  const runId =
    `daily-${startedAt.toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const runDirectory = join(dailyRoot, runId);
  const sessionRoot = resolve(
    options.sessionRoot ??
      join(
        process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot"),
        "session-state",
      ),
  );
  const queue = new WindowsCaptureQueue(paths.queue);
  await queue.initialize();
  const store = new CanonicalSqliteStore(paths.database);
  let activeClaimed = false;
  try {
    const adapter =
      options.adapter ??
      new CopilotCliAdapter({
        ...(options.copilotHome === undefined
          ? {}
          : {
              copilotHome: options.copilotHome,
            }),
        dataRoot: paths.root,
      });
    const [
      items,
      status,
      doctor,
      digest,
    ] = await Promise.all([
      queue.list(),
      adapter.status(),
      adapter.doctor(),
      runtimeDigest(),
    ]);
    const state: DailyRunState = {
      dataRoot: paths.root,
      initialCanonicalEventCount: store.rawEvents().length,
      initialQueueCounts: queueCounts(items),
      runId,
      schemaVersion: 1,
      sessionRoot,
      startedAt: startedAt.toISOString(),
      status: "active",
    };
    await writeFile(
      activePath,
      `${JSON.stringify(state, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    activeClaimed = true;
    await mkdir(runDirectory);
    await Promise.all([
      writeJsonAtomic(
        join(runDirectory, "run.json"),
        retainedRunState(state),
      ),
      writeJsonAtomic(
        join(runDirectory, "environment.json"),
        {
          codeVersion: PROVENLOOP_CODE_VERSION,
          copilotCliVersion:
            status.capabilities.installedVersion ?? "unavailable",
          nodeVersion: process.versions.node,
          operatingSystem: {
            platform: platform(),
            release: release(),
            version: operatingSystemVersion(),
          },
          pluginVersion: PROVENLOOP_VERSION,
          runtimeDigest: digest,
          schemaVersion: 1,
        },
      ),
      writeJsonAtomic(
        join(runDirectory, "initial-health.json"),
        {
          capabilities: status.capabilities.capabilities.map(
            (capability) => ({
              availability: capability.availability,
              capability: capability.capability,
              enabled: capability.enabled,
            }),
          ),
          doctor: {
            checks: doctor.checks.map((check) => ({
              id: check.id,
              status: check.status,
            })),
            status: doctor.status,
          },
          schemaVersion: 1,
        },
      ),
    ]);
    return {
      reportPath: join(runDirectory, "run.json"),
      runDirectory,
      runId,
      status: "incomplete",
    };
  } catch (error) {
    if (activeClaimed) {
      await unlink(activePath).catch(() => undefined);
    }
    throw error;
  } finally {
    store.close();
  }
};

export const completeM0DailyAcceptance = async (
  options: CompleteM0DailyAcceptanceOptions,
  dependencies: { readonly runWorker?: typeof runCaptureWorkerOnce } = {},
): Promise<M0DailyAcceptanceResult> => {
  const now = options.now ?? (() => new Date());
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  const dailyRoot = join(paths.evaluation, "m0-daily");
  const activePath = join(dailyRoot, "active.json");
  const state = await readRunState(activePath);
  if (resolve(state.dataRoot) !== paths.root) {
    throw new Error(
      "The active M0 daily acceptance run belongs to another data root.",
    );
  }
  const runDirectory = join(dailyRoot, state.runId);
  const startedAtMs = Date.parse(state.startedAt);
  const drain = await drainWorker(
    paths.root,
    options.drainTimeoutMs ?? 30_000,
    dependencies.runWorker ?? runCaptureWorkerOnce,
  );
  const queue = new WindowsCaptureQueue(paths.queue);
  await queue.initialize();
  const store = new CanonicalSqliteStore(paths.database);
  try {
    const internalSessionIds = await readInternalSessionIds(
      paths.internalSessions,
    );
    const reconciler = new CaptureReconciler({
      canonical: store,
      copyLimits: {
        maxStringChars: 32_768,
      },
      internalSessionIds,
      maxLineChars: 1024 * 1024,
      queue,
    });
    const sessionFiles = await findFiles(
      state.sessionRoot,
      "events.jsonl",
      startedAtMs,
    );
    const reconciliation: CaptureReconciliationResult[] = [];
    for (const path of sessionFiles) {
      reconciliation.push(
        await reconciler.reconcileSessionFile({
          path,
        }),
      );
    }
    const postReconciliationDrain = await drainWorker(
      paths.root,
      options.drainTimeoutMs ?? 30_000,
      dependencies.runWorker ?? runCaptureWorkerOnce,
    );
    const items = await queue.list();
    const callbackSamples: number[] = [];
    if (await pathExists(join(paths.evaluation, "capture-metrics"))) {
      for (
        const entry of await readdir(
          join(paths.evaluation, "capture-metrics"),
          {
            withFileTypes: true,
          },
        )
      ) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const path = join(
          paths.evaluation,
          "capture-metrics",
          entry.name,
        );
        if ((await stat(path)).mtimeMs < startedAtMs) {
          continue;
        }
        const parsed = JSON.parse(
          await readFile(path, "utf8"),
        ) as {
          readonly status?: {
            readonly callbackDurationSamplesMs?: readonly number[];
          };
        };
        for (
          const sample of
            parsed.status?.callbackDurationSamplesMs ?? []
        ) {
          if (Number.isFinite(sample) && sample >= 0) {
            callbackSamples.push(sample);
          }
        }
      }
    }
    const records = store.rawEvents().filter(
      (record) =>
        Date.parse(record.envelope.capturedAt) >= startedAtMs,
    );
    const duplicateEventIds =
      records.length -
      new Set(records.map((record) => record.eventId)).size;
    const secretPersistenceCount = records.filter((record) =>
      containsKnownSecret(JSON.stringify(record.envelope)),
    ).length;
    const internalSessionPersistenceCount = records.filter(
      (record) =>
        record.sessionId !== undefined &&
        internalSessionIds.has(record.sessionId),
    ).length;
    const reconciliationFailureCount = reconciliation.filter(
      (result) =>
        result.status === "failed" ||
        result.status === "incompatible" ||
        result.status === "malformed",
    ).length;
    const malformedEventCount = reconciliation.reduce(
      (total, result) =>
        total +
        (
          result.status === "reconciled"
            ? result.malformedEvents
            : 0
        ),
      0,
    );
    const deliveryLatencySamples = records
      .map(
        (record) =>
          Date.parse(record.envelope.capturedAt) -
          Date.parse(record.envelope.event.timestamp),
      )
      .filter((sample) => Number.isFinite(sample) && sample >= 0);
    const captureMetrics = {
      callbackDuration: {
        population: "process_tail_samples_not_window_complete",
        maxMs:
          callbackSamples.length === 0
            ? null
            : Math.max(...callbackSamples),
        p50Ms: percentile(callbackSamples, 0.5) ?? null,
        p95Ms: percentile(callbackSamples, 0.95) ?? null,
        sampleCount: callbackSamples.length,
      },
      canonicalEventCount: records.length,
      captureGapCount: records.filter(
        (record) => record.eventType === "capture_gap",
      ).length,
      deliveryLatency: {
        p50Ms: percentile(deliveryLatencySamples, 0.5) ?? null,
        p95Ms: percentile(deliveryLatencySamples, 0.95) ?? null,
        sampleCount: deliveryLatencySamples.length,
      },
      eventCounts: eventCounts(records),
      foregroundAddedLatencyP95Ms: null,
      queueCounts: queueCounts(items),
      schemaVersion: 1,
    };
    const reconciliationReport = {
      drain,
      fileCount: sessionFiles.length,
      malformedEventCount,
      postReconciliationDrain,
      results: reconciliation.map((result) => ({
        ...(result.status === "reconciled"
          ? {
              duplicateEvents: result.duplicateEvents,
              ignoredEvents: result.ignoredEvents,
              malformedEvents: result.malformedEvents,
              parserIssues: result.parserIssues,
              queuedEvents: result.queuedEvents,
              scannedEvents: result.scannedEvents,
              unsupportedEvents: result.unsupportedEvents,
            }
          : {}),
        status: result.status,
      })),
      schemaVersion: 1,
    };
    const guardrails = {
      duplicateCanonicalFactCount: duplicateEventIds,
      foregroundBlockingFailureCount: null,
      internalSessionPersistenceCount,
      missingRequiredEventCount: null,
      malformedEventCount,
      reconciliationFailureCount,
      crossRepositoryLeakageCount: null,
      deletionPropagationFailureCount: null,
      population: "observed_canonical_records",
      schemaVersion: 1,
      secretPersistenceCount,
    };
    const failed =
      duplicateEventIds > 0 ||
      internalSessionPersistenceCount > 0 ||
      secretPersistenceCount > 0 ||
      reconciliationFailureCount > 0 ||
      malformedEventCount > 0;
    const incomplete =
      !drain.completed ||
      !postReconciliationDrain.completed;
    const status: M0DailyAcceptanceResult["status"] =
      failed ? "fail" : incomplete ? "incomplete" : "pass";
    const completedAt = now().toISOString();
    const finalAdapter =
      options.adapter ??
      new CopilotCliAdapter({
        dataRoot: paths.root,
      });
    const [
      finalStatus,
      finalDoctor,
    ] = await Promise.all([
      finalAdapter.status(),
      finalAdapter.doctor(),
    ]);
    const report = {
      completedAt,
      evidenceKind: "observational",
      observationCompleted: !incomplete,
      releaseReadiness: "not_evaluated",
      findings: [
        ...(failed
          ? [
              "One or more capture correctness or privacy checks failed.",
            ]
          : []),
        ...(callbackSamples.length === 0
          ? [
              "No Extension callback timing samples were available.",
            ]
          : []),
        ...(
          captureMetrics.foregroundAddedLatencyP95Ms === null
            ? [
                "Paired foreground latency evidence must be attached separately.",
                "Unmeasured guardrails remain unknown; this report does not approve a release.",
              ]
            : []
        ),
      ],
      runId: state.runId,
      schemaVersion: 1,
      startedAt: state.startedAt,
      status,
    };
    const completedState = retainedRunState({
      ...state,
      status: "completed",
    });
    await Promise.all([
      writeJsonAtomic(join(runDirectory, "run.json"), {
        ...completedState,
        completedAt,
        finalCanonicalEventCount: store.rawEvents().length,
        finalQueueCounts: queueCounts(items),
      }),
      writeJsonAtomic(
        join(runDirectory, "capture-metrics.json"),
        captureMetrics,
      ),
      writeJsonAtomic(
        join(runDirectory, "reconciliation.json"),
        reconciliationReport,
      ),
      writeJsonAtomic(
        join(runDirectory, "guardrails.json"),
        guardrails,
      ),
      writeJsonAtomic(
        join(runDirectory, "final-health.json"),
        {
          capabilities: finalStatus.capabilities.capabilities.map(
            (capability) => ({
              availability: capability.availability,
              capability: capability.capability,
              enabled: capability.enabled,
            }),
          ),
          doctor: {
            checks: finalDoctor.checks.map((check) => ({
              id: check.id,
              status: check.status,
            })),
            providerStatus:
              finalDoctor.providerStatus ?? "unverified",
            status: finalDoctor.status,
          },
          schemaVersion: 1,
        },
      ),
      writeJsonAtomic(join(runDirectory, "report.json"), report),
      writeFile(
        join(runDirectory, "report.md"),
        `# ProvenLoop M0 daily acceptance

- Run: \`${state.runId}\`
- Status: **${status.toUpperCase()}**
- Purpose: capture observation only; release readiness was not evaluated
- Started: ${state.startedAt}
- Completed: ${completedAt}
- Canonical events: ${records.length}
- Callback duration P95 (process tail samples, not a complete window): ${
          captureMetrics.callbackDuration.p95Ms ?? "unavailable"
        } ms
- Delivery latency P95: ${
          captureMetrics.deliveryLatency.p95Ms ?? "unavailable"
        } ms
- Missing required events: unknown (no expected event manifest)
- Malformed events observed: ${malformedEventCount}
- Reconciliation failures: ${reconciliationFailureCount}
- Foreground blocking failures: unknown (not measured)
- Duplicate canonical facts: ${duplicateEventIds}
- Secret persistence: ${secretPersistenceCount}
- Internal Session persistence: ${
          internalSessionPersistenceCount
        }

${report.findings.map((finding) => `- ${finding}`).join("\n")}
`,
        "utf8",
      ),
    ]);
    await unlink(activePath);
    return {
      reportPath: join(runDirectory, "report.json"),
      runDirectory,
      runId: state.runId,
      status,
    };
  } finally {
    store.close();
  }
};
