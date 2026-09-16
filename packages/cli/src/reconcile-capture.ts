import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isoTimestampSchema, type CaptureEnvelope } from "@provenloop/contracts";
import {
  assertCopilotAdapterDataRoot,
  captureEnvelopeCompleteness,
  CaptureReconciler,
  readCopilotAdapterState,
  type CaptureReconciliationResult,
} from "@provenloop/copilot-adapter";
import { createCaptureEnvelope, sanitizeDiagnostic } from "@provenloop/domain";
import {
  isUpgradeMaintenanceActive,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

export interface ReconcileCurrentSessionCaptureOptions {
  readonly dataRoot: string;
  readonly sessionId: string;
  /** The trusted SDK session-state parent directory, not a session directory. */
  readonly sessionStateRoot: string;
  readonly minimumTimestamp?: string;
  readonly now?: () => Date;
}

export type ReconcileCurrentSessionCaptureResult =
  | {
      readonly status: "reconciled" | "budget_exhausted";
      readonly minimumTimestamp: string;
      readonly reconciliation: CaptureReconciliationResult;
      readonly enrichedEvents: number;
      readonly diagnostics: readonly string[];
    }
  | {
      readonly status: "skipped" | "rejected" | "failed";
      readonly reason: string;
    };

interface ActiveReconciliation {
  readonly store: CanonicalSqliteStore;
  readonly queue: WindowsCaptureQueue;
  readonly markDirty: () => Promise<void>;
  enrichedEvents: number;
  readonly diagnostics: string[];
}

interface CachedReconciliation {
  readonly minimumTimestamp: string;
  readonly stateRevision: string;
  readonly reconciler: CaptureReconciler;
  active?: ActiveReconciliation;
  replayRequired: boolean;
  lastCompleteOffset?: number;
}

const cache = new Map<string, CachedReconciliation>();
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const safeSessionId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value) &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(value);
const within = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
};

const readSmallJson = async (path: string): Promise<unknown> => {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 16 * 1024) throw new Error("Invalid reconciliation metadata.");
    const buffer = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error("Reconciliation metadata changed while reading.");
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
};

const isRecord = (input: unknown): input is Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const immutableMetadata = (envelope: CaptureEnvelope): unknown => {
  const { captureQuality, redactedArguments, resultDigest, ...event } = envelope.event;
  void captureQuality; void redactedArguments; void resultDigest;
  return JSON.parse(JSON.stringify({
    event, sourceEventId: envelope.sourceEventId, schemaVersion: envelope.schemaVersion,
  })) as unknown;
};

const reconciliationFor = (
  key: string,
  minimumTimestamp: string,
  stateRevision: string,
): CachedReconciliation => {
  const existing = cache.get(key);
  if (existing?.minimumTimestamp === minimumTimestamp && existing.stateRevision === stateRevision) return existing;
  const current = (): ActiveReconciliation => {
    if (entry.active === undefined) throw new Error("Reconciliation is outside its worker lease.");
    return entry.active;
  };
  const entry: CachedReconciliation = {
    minimumTimestamp,
    stateRevision,
    replayRequired: false,
    reconciler: new CaptureReconciler({
      canonical: {
        deduplicationKeys: async () => { throw new Error("Unbounded canonical scan is prohibited."); },
        captureCompleteness: async (_adapter, _version, _session, identities = []) => {
          const store = current().store;
          const statuses = new Map<string, "complete" | "incomplete" | "deleted">();
          for (const identity of identities) {
            const original = store.rawEvent(identity);
            const effective = store.effectiveRawEvent(identity);
            if (original !== undefined && effective !== undefined) {
              statuses.set(identity, original.parseStatus === "supported"
                ? captureEnvelopeCompleteness(effective.envelope, original.envelope)
                : "incomplete");
            }
          }
          return statuses;
        },
      },
      copyLimits: { maxStringChars: 32_768 },
      maxLineChars: 1024 * 1024,
      onDiagnostic: (message) => {
        if (current().diagnostics.length < 20) current().diagnostics.push(sanitizeDiagnostic(message));
      },
      queue: {
        enqueue: (input, options) => current().queue.enqueue(input, options),
        list: async () => { throw new Error("Unbounded queue scan is prohibited."); },
        enqueueIfSourceAbsent: (input, options) => current().queue.enqueueIfSourceAbsent(input, options),
      },
      repairCapture: async (input, identity, source) => {
        const active = current();
        const original = active.store.rawEvent(identity);
        if (original === undefined) return "pending";
        let supplied = createCaptureEnvelope(input);
        if (!isDeepStrictEqual(immutableMetadata(original.envelope), immutableMetadata(supplied))) {
          if (active.diagnostics.length < 20) active.diagnostics.push("Rejected capture repair: source metadata conflicts.");
          return "rejected";
        }
        if (captureEnvelopeCompleteness(supplied) !== "complete") {
          if (active.diagnostics.length < 20) active.diagnostics.push("Capture repair pending: source quality is insufficient.");
          return "pending";
        }
        // Original quality flags describe the first observation; completeness separately checks recovered fields.
        const { captureQuality: _quality, ...event } = supplied.event;
        void _quality;
        supplied = {
          ...supplied,
          event: {
            ...event,
            ...(original.envelope.event.captureQuality === undefined ? {} : {
              captureQuality: original.envelope.event.captureQuality,
            }),
          },
        };
        const result = active.store.enrichRawEvent({ envelope: supplied, sourceDigest: source.sourceDigest });
        if (result.status === "rejected") {
          if (active.diagnostics.length < 20) active.diagnostics.push(
            sanitizeDiagnostic(`Rejected capture repair: ${result.reason ?? "unsafe enrichment"}`),
          );
          return "rejected";
        }
        if (result.status === "enriched") {
          active.enrichedEvents += 1;
          await active.markDirty();
        }
        const effective = active.store.effectiveRawEvent(identity);
        return effective !== undefined && captureEnvelopeCompleteness(effective.envelope, original.envelope) === "complete"
          ? "repaired" : result.status === "enriched" ? "partially_repaired" : "pending";
      },
    }),
  };
  if (cache.size >= 4 && !cache.has(key)) {
    const oldest = [...cache].find(([, value]) => value.active === undefined)?.[0];
    if (oldest === undefined) throw new Error("Current-session reconciliation capacity is exhausted.");
    cache.delete(oldest);
  }
  cache.set(key, entry);
  return entry;
};

export const reconcileCurrentSessionCapture = async (
  options: ReconcileCurrentSessionCaptureOptions,
): Promise<ReconcileCurrentSessionCaptureResult> => {
  if (!safeSessionId(options.sessionId) || !isAbsolute(options.sessionStateRoot)) {
    return { status: "rejected", reason: "invalid_session_path" };
  }
  if (process.env["PROVENLOOP_INTERNAL"] === "1") return { status: "skipped", reason: "internal_session" };
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  if (options.minimumTimestamp !== undefined && !isoTimestampSchema.safeParse(options.minimumTimestamp).success) {
    return { status: "rejected", reason: "invalid_observation_timestamp" };
  }
  let lease: ProcessLease | undefined;
  let store: CanonicalSqliteStore | undefined;
  let cached: CachedReconciliation | undefined;
  try {
    const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
    if (await isUpgradeMaintenanceActive(paths.root)) return { status: "skipped", reason: "upgrade_maintenance" };
    await assertCopilotAdapterDataRoot(paths);
    const ownerRoot = await realpath(paths.root);
    const state = await readCopilotAdapterState(paths.adapterState, new Date(observedAt));
    if (!state.installed || !state.pluginInstalled || !state.pluginEnabled) {
      return { status: "skipped", reason: "not_installed_or_enabled" };
    }
    if (!state.capabilities.capture.enabled || !state.capabilities.worker.enabled) {
      return { status: "skipped", reason: "capture_or_worker_disabled" };
    }
    try {
      const marker = await readSmallJson(join(paths.internalSessions, `${digest(options.sessionId)}.json`));
      if (!isRecord(marker) || marker.sessionId !== options.sessionId) {
        return { status: "rejected", reason: "invalid_internal_session_marker" };
      }
      return { status: "skipped", reason: "internal_session" };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const provider = new WindowsNamedPipeLeaseProvider(await resolveWindowsCaptureWorkerLeaseName(paths.root));
    lease = await provider.tryAcquire();
    if (lease === undefined) return { status: "skipped", reason: "lease_unavailable" };
    if (await isUpgradeMaintenanceActive(paths.root)) return { status: "skipped", reason: "upgrade_maintenance" };
    const currentState = await readCopilotAdapterState(paths.adapterState, new Date(observedAt));
    if (!isDeepStrictEqual(state, currentState)) return { status: "skipped", reason: "capability_state_changed" };
    const dataDirectory = await realpath(dirname(paths.database));
    if (!within(ownerRoot, dataDirectory) || (await lstat(paths.database)).isSymbolicLink()) {
      return { status: "rejected", reason: "data_root_escape" };
    }
    store = new CanonicalSqliteStore(paths.database);
    const resetCutoff = store.getRecordsResetCutoff();
    const observationDirectory = join(dataDirectory, "capture-observations");
    await mkdir(observationDirectory, { recursive: true });
    if (!within(ownerRoot, await realpath(observationDirectory))) {
      return { status: "rejected", reason: "observation_root_escape" };
    }
    const observationKey = digest(`${resolve(options.sessionStateRoot)}\0${options.sessionId}`);
    const observationPath = join(observationDirectory, `${observationKey}.json`);
    let storedMinimum: string | undefined;
    try {
      const observed = await readSmallJson(observationPath);
      if (
        !isRecord(observed) || observed.schemaVersion !== 1 ||
        !isoTimestampSchema.safeParse(observed.minimumTimestamp).success ||
        !isoTimestampSchema.safeParse(observed.stateRevision).success
      ) return { status: "rejected", reason: "invalid_observation_record" };
      if (observed.stateRevision === state.updatedAt) storedMinimum = String(observed.minimumTimestamp);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const minimumTimestamp = new Date(Math.max(
      resetCutoff === undefined ? Number.NEGATIVE_INFINITY : Date.parse(resetCutoff) + 1,
      Date.parse(state.updatedAt),
      Date.parse(storedMinimum ?? options.minimumTimestamp ?? observedAt),
      options.minimumTimestamp === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.minimumTimestamp),
    )).toISOString();
    if (storedMinimum !== minimumTimestamp) {
      const pendingPath = `${observationPath}.${randomUUID()}.pending`;
      try {
        await writeFile(pendingPath, JSON.stringify({ schemaVersion: 1, minimumTimestamp, stateRevision: state.updatedAt }), "utf8");
        await rename(pendingPath, observationPath);
      } finally {
        await unlink(pendingPath).catch(() => undefined);
      }
    }
    let sourcePath: string;
    let sourceSize: number;
    try {
      const sessionRoot = await realpath(options.sessionStateRoot);
      const sessionPath = join(sessionRoot, options.sessionId);
      const sessionMetadata = await lstat(sessionPath);
      const filePath = join(sessionPath, "events.jsonl");
      const fileMetadata = await lstat(filePath);
      sourceSize = fileMetadata.size;
      sourcePath = await realpath(filePath);
      if (
        !sessionMetadata.isDirectory() || sessionMetadata.isSymbolicLink() ||
        !fileMetadata.isFile() || fileMetadata.isSymbolicLink() ||
        relative(sessionRoot, sourcePath).toLowerCase() !== join(options.sessionId, "events.jsonl").toLowerCase()
      ) return { status: "rejected", reason: "session_source_escape" };
    } catch (error) {
      if (missing(error)) return { status: "skipped", reason: "session_file_not_ready" };
      throw error;
    }
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    const cacheKey = `${ownerRoot}\0${observationKey}`;
    const previous = cache.get(cacheKey);
    if (previous?.replayRequired === true && previous.lastCompleteOffset === sourceSize) cache.delete(cacheKey);
    cached = reconciliationFor(cacheKey, minimumTimestamp, state.updatedAt);
    const active: ActiveReconciliation = {
      store,
      queue,
      enrichedEvents: 0,
      diagnostics: [],
      markDirty: async () => {
        await writeFile(paths.projectionDirty, `${JSON.stringify({ schemaVersion: 1, markedAt: now().toISOString() })}\n`, "utf8");
      },
    };
    cached.active = active;
    const reconciliation = await cached.reconciler.reconcileSessionFile({
      path: sourcePath,
      expectedSessionId: options.sessionId,
      minimumTimestamp,
      maxBytes: 8 * 1024 * 1024,
      maxEvents: 500,
      deadlineMs: 1_500,
      requireCompleteLines: true,
      resume: true,
    });
    if ("deferredRepairEvents" in reconciliation && reconciliation.deferredRepairEvents > 0) cached.replayRequired = true;
    if (reconciliation.status === "reconciled") cached.lastCompleteOffset = reconciliation.nextByteOffset;
    else delete cached.lastCompleteOffset;
    if (reconciliation.status !== "reconciled" && reconciliation.status !== "budget_exhausted") {
      return { status: reconciliation.status === "failed" ? "failed" : "rejected", reason: reconciliation.status };
    }
    return {
      status: reconciliation.status,
      reconciliation,
      minimumTimestamp,
      enrichedEvents: active.enrichedEvents,
      diagnostics: active.diagnostics,
    };
  } catch (error) {
    return { status: "failed", reason: sanitizeDiagnostic(error) };
  } finally {
    if (cached !== undefined) delete cached.active;
    try {
      store?.close();
    } finally {
      await lease?.release();
    }
  }
};
