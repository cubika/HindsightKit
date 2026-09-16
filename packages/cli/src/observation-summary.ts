import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CaptureEnvelope, ContextUseRecord } from "@provenloop/contracts";
import { PROVENLOOP_VERSION } from "@provenloop/contracts";
import { containsKnownSecret } from "@provenloop/domain";
import type { ObservationManifest } from "@provenloop/evaluation";
import { WindowsNamedPipeLeaseProvider } from "@provenloop/platform-windows";

import { PROVENLOOP_CODE_VERSION } from "./release-metadata.js";

const maximumRecords = 5_000;
const maximumArchiveBytes = 4 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

export type ObservationContextUse = ContextUseRecord;

export interface ObservationCorrectionOpportunity {
  readonly opportunityId: string;
  readonly sessionId: string;
  readonly repoId?: string;
  readonly createdAt: string;
  readonly applicable: boolean;
  readonly knowledgeAppliedBeforeCorrection: boolean;
  readonly correctionRepeated: boolean;
  readonly outcomeKnown: boolean;
}

export interface ObservationCaptureHealth {
  readonly sessionId: string;
  readonly repoId?: string;
  readonly timestamp: string;
  readonly callbackCount?: number;
  readonly droppedEvents?: number;
  readonly writeFailures?: number;
}

export interface RecordLocalObservationBatchOptions {
  readonly dataRoot: string;
  readonly events?: readonly CaptureEnvelope[];
  readonly contextUseRecords?: readonly ObservationContextUse[];
  readonly correctionOpportunities?: readonly ObservationCorrectionOpportunity[];
  readonly captureHealth?: readonly ObservationCaptureHealth[];
  readonly capabilityState?: { readonly retrieval?: boolean };
  readonly contextCoverage?: "complete" | "partial";
  readonly codeVersion?: string;
  readonly pluginVersion?: string;
}

interface SafeContext {
  retrievalMode?: "context" | "search";
  observedAt: string;
  returned: number;
  adopted: boolean;
  feedback: NonNullable<ContextUseRecord["feedback"]> | null;
  disposition: NonNullable<ContextUseRecord["retrievalStatus"]> | "unknown";
  latencyMs: number | null;
  renderedTokens: number | null;
}

interface ObservationArchive {
  schemaVersion: 1;
  evidenceKind: "observational";
  date: string;
  sessionDigest: string;
  sessionKnown: boolean;
  repoDigest: string | null;
  codeVersion: string | null;
  pluginVersion: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  truncated: boolean;
  retrievalEnabled: boolean | null;
  contextCoverage: "complete" | "partial";
  events: Record<string, "other" | "correction" | "verification_succeeded" | "verification_failed" | "closed">;
  contexts: Record<string, SafeContext>;
  opportunities: Record<string, { repeated: boolean; applied: boolean; outcomeKnown: boolean }>;
  health: {
    population: "process_snapshot";
    timestamp: string;
    callbackCount: number | null;
    droppedEvents: number | null;
    writeFailures: number | null;
  } | null;
}

export interface LocalObservationSummary {
  readonly schemaVersion: 1;
  readonly evidenceKind: "observational";
  readonly controlledEffect: "not_established";
  readonly date: string;
  readonly dateBasis: "UTC";
  readonly sessionDigest: string | null;
  readonly repoDigest: string | null;
  readonly codeVersion: string | null;
  readonly pluginVersion: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly coverage: "bounded_sample" | "observed_records";
  readonly retrieval: {
    readonly search?: { readonly invocationCount: number; readonly providedCount: number; readonly explicitlyAdoptedCount: number };
    readonly state: "not_observed" | "not_invoked" | "disabled" | "no_match" | "provided" | "explicitly_adopted" | "unknown";
    readonly invocationCount: number | null;
    readonly noMatchCount: number;
    readonly providedCount: number;
    readonly explicitlyAdoptedCount: number;
    readonly feedbackCount: number;
    readonly unknownStatusRecordCount: number;
    readonly renderedTokens: number | null;
    readonly latencyMsTotal: number | null;
  };
  readonly observedEventCount: number;
  readonly observedCorrectionCount: number;
  readonly subsequentCorrectionCount: number | null;
  readonly verification: { readonly succeeded: number | null; readonly failed: number | null };
  readonly outcome: "unknown";
  readonly taskDurationMs: null;
  readonly baselineAssignment: "unknown";
  readonly captureHealth: ObservationArchive["health"];
}

const timestamp = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Observation timestamp is invalid.");
  }
  return new Date(milliseconds).toISOString();
};

const safeVersion = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) &&
  !containsKnownSecret(value)
    ? value
    : null;

const nonNegative = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12
    ? value
    : null;

const readJson = async (path: string): Promise<unknown> => {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > maximumArchiveBytes) {
      throw new Error("Observation archive exceeds its size limit.");
    }
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
};

const removeStagingFile = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
  }
};

const atomicJson = async (path: string, value: unknown): Promise<void> => {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path); break; } catch (error) {
        if (process.platform !== "win32" || attempt >= 4 ||
            !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await sleep(10 * 2 ** attempt);
      }
    }
  } finally {
    await removeStagingFile(staging);
  }
};

const identityKey = async (root: string): Promise<Buffer> => {
  await mkdir(root, { recursive: true });
  const path = join(root, ".identity-key");
  const key = await withLock(path, async () => {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const staging = `${path}.${randomUUID()}.tmp`;
      const generated = randomBytes(32);
      try {
        await writeFile(staging, generated, { flag: "wx", mode: 0o600 });
        await rename(staging, path);
        return generated;
      } finally {
        await removeStagingFile(staging);
      }
    }
  });
  if (key.length !== 32) {
    throw new Error("Observation identity key is invalid.");
  }
  return key;
};

const withLock = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const provider = new WindowsNamedPipeLeaseProvider(
    `observation-${createHash("sha256").update(path.toLocaleLowerCase("en-US")).digest("hex")}`,
  );
  const deadline = Date.now() + 5_000;
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    if (Date.now() >= deadline) {
      throw new Error("Observation archive is busy; retry this batch.");
    }
    await sleep(10);
    lease = await provider.tryAcquire();
  }
  try {
    return await operation();
  } finally {
    await lease.release();
  }
};

const summarize = (archive: ObservationArchive): LocalObservationSummary => {
  const contexts = Object.values(archive.contexts).filter((item) => item.retrievalMode !== "search");
  const searches = Object.values(archive.contexts).filter((item) => item.retrievalMode === "search");
  const events = Object.values(archive.events);
  const opportunities = Object.values(archive.opportunities);
  const providedCount = contexts.filter((item) => item.returned > 0).length;
  const adoptedCount = contexts.filter((item) => item.adopted).length;
  const noMatchCount = contexts.filter((item) => item.disposition === "no_match").length;
  const invocationAbsenceKnown = events.includes("closed") &&
    archive.contextCoverage === "complete" && !archive.truncated &&
    archive.sessionKnown && archive.repoDigest !== null && archive.codeVersion !== null;
  return {
    schemaVersion: 1,
    evidenceKind: "observational",
    controlledEffect: "not_established",
    date: archive.date,
    dateBasis: "UTC",
    sessionDigest: archive.sessionKnown ? archive.sessionDigest : null,
    repoDigest: archive.repoDigest,
    codeVersion: archive.codeVersion,
    pluginVersion: archive.pluginVersion,
    firstObservedAt: archive.firstObservedAt,
    lastObservedAt: archive.lastObservedAt,
    coverage: archive.truncated ? "bounded_sample" : "observed_records",
    retrieval: {
      ...(searches.length ? { search: { invocationCount: searches.length, providedCount: searches.filter((item) => item.returned > 0).length,
        explicitlyAdoptedCount: searches.filter((item) => item.adopted).length } } : {}),
      state: adoptedCount > 0 ? "explicitly_adopted"
        : providedCount > 0 ? "provided"
          : contexts.length > 0 && noMatchCount === contexts.length ? "no_match"
            : archive.retrievalEnabled === false ||
                (contexts.length > 0 && contexts.every((item) =>
                  item.disposition === "disabled" || item.disposition === "muted"))
              ? "disabled"
              : contexts.length > 0 ? "unknown"
                : invocationAbsenceKnown
                  ? "not_invoked" : "not_observed",
      invocationCount: contexts.length > 0 ? contexts.length : invocationAbsenceKnown ? 0 : null,
      noMatchCount,
      providedCount,
      explicitlyAdoptedCount: adoptedCount,
      feedbackCount: contexts.filter((item) => item.feedback !== null).length,
      unknownStatusRecordCount: contexts.filter((item) => item.disposition === "unknown").length,
      renderedTokens: contexts.length === 0 || contexts.some((item) => item.renderedTokens === null)
        ? null : contexts.reduce((total, item) => total + (item.renderedTokens ?? 0), 0),
      latencyMsTotal: contexts.length === 0 || contexts.some((item) => item.latencyMs === null)
        ? null : contexts.reduce((total, item) => total + (item.latencyMs ?? 0), 0),
    },
    observedEventCount: events.length,
    observedCorrectionCount: events.filter((kind) => kind === "correction").length,
    subsequentCorrectionCount: opportunities.length === 0
      ? null : opportunities.filter((item) => item.applied && item.repeated).length,
    verification: {
      succeeded: events.some((kind) => kind.startsWith("verification_"))
        ? events.filter((kind) => kind === "verification_succeeded").length : null,
      failed: events.some((kind) => kind.startsWith("verification_"))
        ? events.filter((kind) => kind === "verification_failed").length : null,
    },
    outcome: "unknown",
    taskDurationMs: null,
    baselineAssignment: "unknown",
    captureHealth: archive.health,
  };
};

const assertArchive = (value: unknown): ObservationArchive => {
  const archive = value as ObservationArchive;
  if (
    archive?.schemaVersion !== 1 || archive.evidenceKind !== "observational" ||
    !datePattern.test(archive.date) || !digestPattern.test(archive.sessionDigest) ||
    typeof archive.sessionKnown !== "boolean" ||
    (archive.repoDigest !== null && !digestPattern.test(archive.repoDigest)) ||
    (archive.codeVersion !== null && (typeof archive.codeVersion !== "string" || safeVersion(archive.codeVersion) === null)) ||
    (archive.pluginVersion !== null && (typeof archive.pluginVersion !== "string" || safeVersion(archive.pluginVersion) === null)) ||
    typeof archive.truncated !== "boolean" ||
    ![true, false, null].includes(archive.retrievalEnabled) ||
    !["complete", "partial"].includes(archive.contextCoverage) ||
    archive.events === null || typeof archive.events !== "object" ||
    archive.contexts === null || typeof archive.contexts !== "object" ||
    archive.opportunities === null || typeof archive.opportunities !== "object" ||
    [archive.events, archive.contexts, archive.opportunities].some(
      (items) => Object.keys(items).length > maximumRecords ||
        Object.keys(items).some((id) => !digestPattern.test(id)),
    )
  ) {
    throw new Error("Observation archive is invalid.");
  }
  archive.firstObservedAt = timestamp(archive.firstObservedAt);
  archive.lastObservedAt = timestamp(archive.lastObservedAt);
  if (
    Object.values(archive.events).some((kind) => ![
      "other", "correction", "verification_succeeded", "verification_failed", "closed",
    ].includes(kind)) ||
    Object.values(archive.contexts).some((item) =>
      item === null || typeof item !== "object" ||
      (item.retrievalMode !== undefined && !["context", "search"].includes(item.retrievalMode)) ||
      !Number.isSafeInteger(item.returned) || item.returned < 0 ||
      typeof item.adopted !== "boolean" ||
      ![null, "helpful", "ignored", "irrelevant", "wrong", "stale"].includes(item.feedback) ||
      !["unknown", "disabled", "no_match", "provided", "degraded", "muted"].includes(item.disposition) ||
      (item.latencyMs !== null && nonNegative(item.latencyMs) === null) ||
      (item.renderedTokens !== null && nonNegative(item.renderedTokens) === null),
    ) ||
    Object.values(archive.opportunities).some((item) =>
      item === null || typeof item !== "object" ||
      typeof item.repeated !== "boolean" || typeof item.applied !== "boolean" ||
      typeof item.outcomeKnown !== "boolean",
    )
  ) {
    throw new Error("Observation archive contains invalid counters.");
  }
  if (archive.health !== null) {
    const health = archive.health;
    archive.health = {
      population: "process_snapshot",
      timestamp: timestamp(health.timestamp),
      callbackCount: nonNegative(health.callbackCount),
      droppedEvents: nonNegative(health.droppedEvents),
      writeFailures: nonNegative(health.writeFailures),
    };
  }
  return {
    schemaVersion: 1,
    evidenceKind: "observational",
    date: archive.date,
    sessionDigest: archive.sessionDigest,
    sessionKnown: archive.sessionKnown,
    repoDigest: archive.repoDigest,
    codeVersion: archive.codeVersion,
    pluginVersion: archive.pluginVersion,
    firstObservedAt: archive.firstObservedAt,
    lastObservedAt: archive.lastObservedAt,
    truncated: archive.truncated,
    retrievalEnabled: archive.retrievalEnabled,
    contextCoverage: archive.contextCoverage,
    events: Object.fromEntries(Object.entries(archive.events)),
    contexts: Object.fromEntries(Object.entries(archive.contexts).map(([id, item]) => [id, {
      ...(item.retrievalMode ? { retrievalMode: item.retrievalMode } : {}),
      observedAt: timestamp(item.observedAt),
      returned: item.returned,
      adopted: item.adopted,
      feedback: item.feedback,
      disposition: item.disposition,
      latencyMs: item.latencyMs,
      renderedTokens: item.renderedTokens,
    }])),
    opportunities: Object.fromEntries(Object.entries(archive.opportunities).map(([id, item]) => [id, {
      repeated: item.repeated,
      applied: item.applied,
      outcomeKnown: item.outcomeKnown,
    }])),
    health: archive.health,
  };
};

export const recordLocalObservationBatch = async (
  options: RecordLocalObservationBatchOptions,
): Promise<readonly LocalObservationSummary[]> => {
  const root = join(resolve(options.dataRoot), "evaluation", "observations");
  const key = await identityKey(root);
  const digest = (value: string): string => createHmac("sha256", key).update(value).digest("hex");
  const codeVersion = safeVersion(options.codeVersion ?? PROVENLOOP_CODE_VERSION);
  const pluginVersion = safeVersion(options.pluginVersion ?? PROVENLOOP_VERSION);
  const groups = new Map<string, { archive: ObservationArchive; apply: ((archive: ObservationArchive) => void)[] }>();
  const group = (sessionId: string | undefined, repoId: string | undefined, at: string, recordVersion = codeVersion) => {
    const observedAt = timestamp(at);
    const date = observedAt.slice(0, 10);
    const sessionDigest = digest(sessionId === undefined ? "session:missing" : `session:known:${sessionId}`);
    const repoDigest = repoId === undefined ? null : digest(`repo:${repoId}`);
    const id = `${date}\\${digest(JSON.stringify([sessionDigest, repoDigest, recordVersion, pluginVersion]))}`;
    let entry = groups.get(id);
    if (entry === undefined) {
      entry = {
        archive: {
          schemaVersion: 1, evidenceKind: "observational", date, sessionDigest, repoDigest,
          sessionKnown: sessionId !== undefined,
          codeVersion: recordVersion, pluginVersion, firstObservedAt: observedAt, lastObservedAt: observedAt,
          truncated: false, retrievalEnabled: options.capabilityState?.retrieval ?? null,
          contextCoverage: options.contextCoverage ?? "partial",
          events: {}, contexts: {}, opportunities: {}, health: null,
        },
        apply: [],
      };
      groups.set(id, entry);
    }
    entry.apply.push((archive) => {
      archive.firstObservedAt = archive.firstObservedAt < observedAt ? archive.firstObservedAt : observedAt;
      archive.lastObservedAt = archive.lastObservedAt > observedAt ? archive.lastObservedAt : observedAt;
      if (options.capabilityState?.retrieval !== undefined) {
        archive.retrievalEnabled = options.capabilityState.retrieval;
      }
      if (options.contextCoverage === "complete") {
        archive.contextCoverage = "complete";
      }
    });
    return entry.apply;
  };
  const sizes = new WeakMap<object, number>();
  const put = <T>(archive: ObservationArchive, values: Record<string, T>, id: string, value: T): void => {
    const hashed = digest(id);
    const size = sizes.get(values) ?? Object.keys(values).length;
    sizes.set(values, size);
    const exists = Object.hasOwn(values, hashed);
    if (exists || size < maximumRecords) {
      values[hashed] = value;
      if (!exists) {
        sizes.set(values, size + 1);
      }
    } else {
      archive.truncated = true;
    }
  };
  for (const { event } of options.events ?? []) {
    const verification = ["test.completed", "build.completed", "verification.completed"].includes(event.eventType) &&
      (event.trust === "tool" || event.trust === "system");
    const failed = event.completionStatus === "failed" || (event.exitCode !== undefined && event.exitCode !== 0);
    const succeeded = !failed && (event.completionStatus === "succeeded" || event.exitCode === 0);
    const kind = event.eventType === "user.corrected" ? "correction"
      : verification && succeeded ? "verification_succeeded"
        : verification && failed ? "verification_failed"
          : event.eventType === "session.ended" ? "closed" : "other";
    group(event.sessionId, event.repoId, event.timestamp).push((archive) => {
      put(archive, archive.events, event.eventId, kind);
    });
  }
  for (const context of options.contextUseRecords ?? []) {
    group(
      context.sessionId, context.repoId, context.createdAt,
      safeVersion(context.codeVersion),
    ).push((archive) => {
      const previous = archive.contexts[digest(context.requestId)];
      const observedAt = timestamp(context.updatedAt ?? context.createdAt);
      const feedback = ["helpful", "ignored", "irrelevant", "wrong", "stale"].includes(context.feedback ?? "")
        ? context.feedback : undefined;
      const disposition = ["disabled", "no_match", "provided", "degraded", "muted"].includes(context.retrievalStatus ?? "")
        ? context.retrievalStatus : undefined;
      if (previous !== undefined && previous.observedAt > observedAt) {
        return;
      }
      if (archive.lastObservedAt < observedAt) {
        archive.lastObservedAt = observedAt;
      }
      put(archive, archive.contexts, context.requestId, {
        ...(context.retrievalMode ? { retrievalMode: context.retrievalMode } : {}),
        observedAt,
        returned: context.returnedKnowledgeIds.length,
        // Legacy records may contain inferred application, before explicit user-report semantics.
        adopted: previous?.adopted === true ||
          (disposition !== undefined && context.appliedKnowledgeIds.length > 0),
        feedback: feedback ?? previous?.feedback ?? null,
        disposition: disposition ?? "unknown",
        latencyMs: nonNegative(context.latencyMs),
        renderedTokens: nonNegative(context.renderedTokens),
      });
    });
  }
  for (const opportunity of options.correctionOpportunities ?? []) {
    group(opportunity.sessionId, opportunity.repoId, opportunity.createdAt).push((archive) => {
      if (opportunity.applicable) {
        put(archive, archive.opportunities, opportunity.opportunityId, {
          applied: opportunity.knowledgeAppliedBeforeCorrection,
          repeated: opportunity.correctionRepeated,
          outcomeKnown: opportunity.outcomeKnown,
        });
      } else {
        Reflect.deleteProperty(archive.opportunities, digest(opportunity.opportunityId));
        sizes.delete(archive.opportunities);
      }
    });
  }
  for (const health of options.captureHealth ?? []) {
    group(health.sessionId, health.repoId, health.timestamp).push((archive) => {
      const at = timestamp(health.timestamp);
      if (archive.health === null || archive.health.timestamp <= at) {
        archive.health = {
          population: "process_snapshot",
          timestamp: at, callbackCount: nonNegative(health.callbackCount),
          droppedEvents: nonNegative(health.droppedEvents), writeFailures: nonNegative(health.writeFailures),
        };
      }
    });
  }
  const summaries: LocalObservationSummary[] = [];
  for (const [id, entry] of groups) {
    const directory = join(root, entry.archive.date);
    await mkdir(directory, { recursive: true });
    const path = join(root, `${id}.json`);
    await withLock(path, async () => {
      let archive = entry.archive;
      try {
        archive = assertArchive(await readJson(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      for (const apply of entry.apply) {
        apply(archive);
      }
      await atomicJson(path, archive);
      summaries.push(summarize(archive));
    });
  }
  return summaries;
};

export const readLocalObservationSummary = async (options: {
  readonly dataRoot: string;
  readonly date?: string;
  readonly sessionId?: string;
}): Promise<readonly LocalObservationSummary[]> => {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  if (!datePattern.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("Observation date is invalid.");
  }
  const root = join(resolve(options.dataRoot), "evaluation", "observations");
  let entries;
  try {
    entries = await readdir(join(root, date), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const key = await readFile(join(root, ".identity-key"));
  const sessionDigest = options.sessionId === undefined ? undefined
    : createHmac("sha256", key).update(`session:known:${options.sessionId}`).digest("hex");
  const summaries: LocalObservationSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    const archive = assertArchive(await readJson(join(root, date, entry.name)));
    if (sessionDigest === undefined || archive.sessionDigest === sessionDigest) {
      summaries.push(summarize(archive));
    }
  }
  return summaries;
};

export const exportLocalObservationManifest = async (options: {
  readonly dataRoot: string;
  readonly date?: string;
  readonly sessionId?: string;
  readonly codeVersion?: string;
}): Promise<ObservationManifest> => {
  const codeVersion = safeVersion(options.codeVersion ?? PROVENLOOP_CODE_VERSION);
  if (codeVersion === null) {
    throw new Error("Observation export code version is invalid.");
  }
  const summaries = await readLocalObservationSummary(options);
  return {
    schemaVersion: 1,
    evidenceKind: "observational",
    controlledEffect: "not_established",
    codeVersion,
    observations: summaries
      .filter((summary) => summary.codeVersion === codeVersion)
      .map((summary) => ({
        date: summary.date,
        sessionDigest: summary.sessionDigest,
        repoDigest: summary.repoDigest,
        codeVersion: summary.codeVersion,
        invocationCount: summary.retrieval.invocationCount,
        providedCount: summary.retrieval.providedCount,
        explicitlyAdoptedCount: summary.retrieval.explicitlyAdoptedCount,
        noMatchCount: summary.retrieval.noMatchCount,
        feedbackCount: summary.retrieval.feedbackCount,
        unknownStatusRecordCount: summary.retrieval.unknownStatusRecordCount,
        retrievalState: summary.retrieval.state,
        observedCorrectionCount: summary.observedCorrectionCount,
        subsequentCorrectionCount: summary.subsequentCorrectionCount,
        verificationSucceededCount: summary.verification.succeeded,
        verificationFailedCount: summary.verification.failed,
        outcome: summary.outcome,
        coverage: summary.coverage,
      })),
  };
};
