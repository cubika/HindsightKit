import { isDeepStrictEqual } from "node:util";
import type { CaptureEnvelope, CaptureQueueItem } from "@provenloop/contracts";
import {
  createCaptureDeduplicationKey,
  createCaptureEnvelope,
  sanitizeDiagnostic,
  type CaptureEventInput,
} from "@provenloop/domain";

import type { CaptureQueueSink } from "./async-writer.js";
import { boundedCaptureQuality } from "./capture-evidence.js";
import {
  CopilotEventMapper,
  type CopilotCallbackCopyLimits,
} from "./event-mapper.js";
import {
  parseCopilotSessionFile,
  SessionFileBudgetError,
  type CopilotSessionEventSource,
  type CopilotSessionFileCursor,
  type CopilotSessionFileHeader,
  type CopilotSessionFileIssue,
} from "./session-file-parser.js";

export interface ReconciliationQueue extends CaptureQueueSink {
  enqueueIfSourceAbsent(
    input: Parameters<CaptureQueueSink["enqueue"]>[0],
    options?: Parameters<CaptureQueueSink["enqueue"]>[1],
  ): Promise<{
    readonly status: "duplicate" | "enqueued";
  }>;
  list(): Promise<readonly CaptureQueueItem[]>;
}

export interface CanonicalCaptureWatermark {
  deduplicationKeys(
    adapter: string,
    adapterVersion: string,
    sessionId: string,
  ): Promise<ReadonlySet<string>>;
  captureCompleteness?(
    adapter: string,
    adapterVersion: string,
    sessionId: string,
    identities?: readonly string[],
  ): Promise<ReadonlyMap<string, "complete" | "incomplete" | "deleted">>;
}

export interface CaptureReconcilerOptions {
  readonly canonical: CanonicalCaptureWatermark;
  readonly copyLimits: CopilotCallbackCopyLimits;
  readonly internalSessionIds?: ReadonlySet<string>;
  readonly maxLineChars: number;
  readonly onDiagnostic?: (message: string) => void;
  readonly queue: ReconciliationQueue;
  readonly repairCapture?: (
    input: CaptureEventInput,
    deduplicationKey: string,
    source: CopilotSessionEventSource,
  ) => Promise<"repaired" | "partially_repaired" | "deleted" | "pending" | "rejected">;
}

export interface ReconcileSessionFileOptions {
  readonly expectedSessionId?: string;
  readonly minimumTimestamp?: string;
  readonly maxBytes?: number;
  readonly maxEvents?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly resume?: boolean;
  readonly requireCompleteLines?: boolean;
  readonly path: string;
}

export type CaptureReconciliationResult =
  | {
      readonly adapterVersion: string;
      readonly duplicateEvents: number;
      readonly ignoredEvents: number;
      readonly malformedEvents: number;
      readonly parserIssues: number;
      readonly partialTail: boolean;
      readonly queuedEvents: number;
      readonly scannedEvents: number;
      readonly sessionId: string;
      readonly status: "reconciled" | "budget_exhausted";
      readonly unsupportedEvents: number;
      readonly incompleteEvents: number;
      readonly repairedEvents: number;
      readonly repairPendingEvents: number;
      readonly unverifiedExistingEvents: number;
      readonly repairRejectedEvents: number;
      readonly outsideObservationEvents: number;
      readonly deferredRepairEvents: number;
      readonly nextByteOffset: number;
      readonly bytesRead: number;
      readonly stopReason?: string;
    }
  | {
      readonly adapterVersion?: string;
      readonly fileVersion?: number;
      readonly reason:
        | "unsupported_adapter_version"
        | "unsupported_session_file_version";
      readonly status: "incompatible";
    }
  | {
      readonly lineNumber: number;
      readonly reason: string;
      readonly status: "malformed";
    }
  | {
      readonly adapterVersion: string;
      readonly sessionId: string;
      readonly status: "skipped_internal";
    }
  | {
      readonly error: string;
      readonly status: "failed";
    }
  | {
      readonly reason: string;
      readonly status: "budget_exhausted";
    };

const omitted = (value: unknown): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  "status" in value && ["omitted_in_callback", "metadata_only"].includes(String(value.status));

const containsOmission = (value: unknown, depth = 0): boolean => {
  if (depth > 16) return true;
  if (omitted(value)) return true;
  if (value === null || typeof value !== "object") return false;
  if ("status" in value && value.status === "truncated") return true;
  return Object.values(value).some((child) => containsOmission(child, depth + 1));
};

const capturedField = (envelope: CaptureEnvelope, path: string): unknown => {
  const normalized = path
    .replace(/^data\.arguments(?:\.|$)/u, "event.redactedArguments.")
    .replace(/^data\.result(?:\.|$)/u, "content.toolResult.")
    .replace(/^data\.content$/u, "content.message")
    .replace(/^arguments(?:\.|$)/u, "event.redactedArguments.")
    .replace(/^result(?:\.|$)/u, "content.toolResult.")
    .replace(/\.$/u, "");
  let value: unknown = envelope;
  for (const field of normalized.split(".")) {
    if (value === null || typeof value !== "object" || !(field in value)) return undefined;
    value = (value as Record<string, unknown>)[field];
  }
  return value;
};

export const captureEnvelopeCompleteness = (
  envelope: CaptureEnvelope,
  original?: CaptureEnvelope,
): "complete" | "incomplete" => {
  if (
    containsOmission(envelope.event.redactedArguments) ||
    containsOmission(envelope.content) ||
    (envelope.content === undefined && envelope.event.redactedArguments === undefined &&
      envelope.redaction.contentDigest !== undefined)
  ) return "incomplete";
  const quality = envelope.event.captureQuality;
  const lostFields = [
    ...(quality?.omittedFields ?? []),
    ...(quality?.truncatedFields ?? []),
    ...envelope.redaction.truncatedPaths,
    ...envelope.redaction.droppedPaths,
    ...(original?.redaction.truncatedPaths ?? []),
    ...(original?.redaction.droppedPaths ?? []),
  ];
  for (const field of lostFields) {
    const before = original === undefined ? undefined : capturedField(original, field);
    const after = capturedField(envelope, field);
    const recovered = original !== undefined &&
      (before === undefined || omitted(before)) &&
      after !== undefined && !containsOmission(after) &&
      !isDeepStrictEqual(before, after);
    if (!recovered) return "incomplete";
  }
  return "complete";
};

interface PendingRepair {
  readonly input: CaptureEventInput;
  readonly source: CopilotSessionEventSource;
  readonly bytes: number;
}

interface ReconciliationProgress {
  cursor?: CopilotSessionFileCursor;
  header?: CopilotSessionFileHeader;
  mapper?: CopilotEventMapper;
  readonly minimumTimestamp?: string;
  readonly observedIds: Set<string>;
  readonly pending: Map<string, PendingRepair>;
  pendingBytes: number;
}

const safePendingInput = (input: CaptureEventInput): CaptureEventInput => {
  const envelope = createCaptureEnvelope(input);
  const { eventId, redactedArguments, resultDigest, schemaVersion, ...event } = envelope.event;
  void eventId; void resultDigest; void schemaVersion;
  return {
    ...event,
    sessionId: envelope.event.sessionId ?? input.sessionId,
    sourceEventId: envelope.sourceEventId,
    ...(envelope.redaction.contentDigest === undefined ? {} : { contentDigest: envelope.redaction.contentDigest }),
    ...(envelope.redaction.truncatedPaths.length === 0 && envelope.redaction.droppedPaths.length === 0 ? {} : {
      captureQuality: boundedCaptureQuality({
        schemaVersion: 1,
        truncatedFields: [...new Set([
          ...(envelope.event.captureQuality?.truncatedFields ?? []), ...envelope.redaction.truncatedPaths,
        ])],
        omittedFields: [...new Set([
          ...(envelope.event.captureQuality?.omittedFields ?? []), ...envelope.redaction.droppedPaths,
        ])],
        originalLengths: envelope.event.captureQuality?.originalLengths ?? {},
      }),
    }),
    ...(envelope.content === undefined && redactedArguments === undefined ? {} : {
      content: {
        ...(envelope.content?.message === undefined ? {} : { message: envelope.content.message }),
        ...(envelope.content?.safeError === undefined ? {} : { error: envelope.content.safeError }),
        ...(envelope.content?.toolResult === undefined ? {} : { toolResult: envelope.content.toolResult }),
        ...(redactedArguments === undefined ? {} : { toolArguments: redactedArguments }),
      },
    }),
  };
};

export class CaptureReconciler {
  readonly #canonical: CanonicalCaptureWatermark;
  readonly #copyLimits: CopilotCallbackCopyLimits;
  readonly #internalSessionIds: ReadonlySet<string>;
  readonly #maxLineChars: number;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  readonly #queue: ReconciliationQueue;
  readonly #repairCapture: CaptureReconcilerOptions["repairCapture"];
  readonly #progress = new Map<string, ReconciliationProgress>();

  public constructor(options: CaptureReconcilerOptions) {
    this.#canonical = options.canonical;
    this.#copyLimits = options.copyLimits;
    this.#internalSessionIds =
      options.internalSessionIds ?? new Set<string>();
    this.#maxLineChars = options.maxLineChars;
    this.#onDiagnostic = options.onDiagnostic;
    this.#queue = options.queue;
    this.#repairCapture = options.repairCapture;
  }

  public async reconcileSessionFile(
    options: ReconcileSessionFileOptions,
  ): Promise<CaptureReconciliationResult> {
    const minimum = options.minimumTimestamp === undefined
      ? Number.NEGATIVE_INFINITY : Date.parse(options.minimumTimestamp);
    if (Number.isNaN(minimum)) {
      return { status: "failed", error: "Invalid reconciliation observation timestamp." };
    }
    const previous = this.#progress.get(options.path);
    const progress: ReconciliationProgress =
      previous !== undefined && previous.minimumTimestamp === options.minimumTimestamp ? previous : {
        ...(options.minimumTimestamp === undefined ? {} : { minimumTimestamp: options.minimumTimestamp }),
        observedIds: new Set(),
        pending: new Map(),
        pendingBytes: 0,
      };
    let duplicateEvents = 0;
    let ignoredEvents = 0;
    let internalHeader: CopilotSessionFileHeader | undefined;
    let malformedEvents = 0;
    let mapper = progress.mapper;
    let queuedEvents = 0;
    let scannedEvents = 0;
    let unsupportedEvents = 0;
    const known = new Map<string, "complete" | "incomplete" | "deleted" | "unknown">();
    let incompleteEvents = 0;
    let repairedEvents = 0;
    let repairPendingEvents = 0;
    let unverifiedExistingEvents = 0;
    let repairRejectedEvents = 0;
    let outsideObservationEvents = 0;
    let deferredRepairEvents = 0;
    let retriedRepairs = 0;
    const started = performance.now();
    const removePending = (identity: string): void => {
      progress.pendingBytes -= progress.pending.get(identity)?.bytes ?? 0;
      progress.pending.delete(identity);
    };
    const rememberPending = (identity: string, value: CaptureEventInput, source: CopilotSessionEventSource): void => {
      const input = safePendingInput(value);
      const bytes = Buffer.byteLength(JSON.stringify(input));
      removePending(identity);
      while (progress.pending.size >= 500 || progress.pendingBytes + bytes > 8 * 1024 * 1024) {
        const oldest = progress.pending.keys().next().value;
        if (oldest === undefined) break;
        removePending(oldest);
        deferredRepairEvents += 1;
      }
      if (bytes > 8 * 1024 * 1024) {
        deferredRepairEvents += 1;
        return;
      }
      progress.pending.set(identity, { input, bytes, source });
      progress.pendingBytes += bytes;
    };
    const repair = async (value: CaptureEventInput, identity: string, source: CopilotSessionEventSource): Promise<void> => {
      incompleteEvents += 1;
      const repaired = await this.#repairCapture?.(value, identity, source) ?? "pending";
      if (repaired === "repaired" || repaired === "partially_repaired") {
        repairedEvents += 1;
        known.set(identity, repaired === "repaired" ? "complete" : "incomplete");
        if (repaired === "partially_repaired") repairPendingEvents += 1;
      } else if (repaired === "deleted") {
        known.set(identity, "deleted");
      } else if (repaired === "rejected") {
        repairRejectedEvents += 1;
      } else {
        repairPendingEvents += 1;
      }
      removePending(identity);
    };
    const lookup = async (identity: string, header: CopilotSessionFileHeader) =>
      (await this.#canonical.captureCompleteness?.(
        "copilot-cli", header.adapterVersion, header.sessionId, [identity],
      ))?.get(identity);

    try {
      if (progress.header !== undefined && this.#canonical.captureCompleteness !== undefined) {
        const maximumRetries = Math.min(50, Math.floor((options.maxEvents ?? 500) / 2));
        for (const [identity, pending] of [...progress.pending]) {
          if (
            retriedRepairs >= maximumRetries || options.signal?.aborted ||
            performance.now() - started >= (options.deadlineMs ?? 1_500)
          ) break;
          retriedRepairs += 1;
          const status = await lookup(identity, progress.header);
          if (status === "incomplete") {
            await repair(pending.input, identity, pending.source);
          } else if (status !== undefined) {
            removePending(identity);
          } else {
            progress.pending.delete(identity);
            progress.pending.set(identity, pending);
          }
        }
      }
      const parseResult = await parseCopilotSessionFile(options.path, {
        ...(progress.cursor === undefined ? {} : { cursor: progress.cursor }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        maxEvents: Math.max(1, (options.maxEvents ?? 500) - retriedRepairs),
        deadlineMs: Math.max(1, (options.deadlineMs ?? 1_500) - (performance.now() - started)),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.requireCompleteLines === undefined ? {} : { requireCompleteLines: options.requireCompleteLines }),
        ...(options.expectedSessionId === undefined
          ? {}
          : {
              expectedSessionId: options.expectedSessionId,
            }),
        maxLineChars: this.#maxLineChars,
        onEvent: async (event, _line, source) => {
          if (mapper === undefined) {
            throw new Error(
              "Session event arrived before a supported header.",
            );
          }
          scannedEvents += 1;
          const mapped = mapper.map(event);
          switch (mapped.status) {
            case "ignored":
              ignoredEvents += 1;
              return;
            case "malformed":
              malformedEvents += 1;
              this.#diagnostic(
                `Malformed Session event: ${mapped.issues.join(" ")}`,
              );
              return;
            case "unsupported":
              unsupportedEvents += 1;
              break;
            case "mapped":
              break;
          }
          if (Date.parse(mapped.value.timestamp) < minimum) {
            outsideObservationEvents += 1;
            return;
          }
          for (const value of [
            mapped.value,
            ...(mapped.status === "mapped" ? mapped.additionalEvents ?? [] : []),
          ]) {
            if (
              options.minimumTimestamp !== undefined &&
              value.evidence?.sourceStartEventId !== undefined &&
              !progress.observedIds.has(value.evidence.sourceStartEventId)
            ) {
              outsideObservationEvents += 1;
              continue;
            }
            const identity = createCaptureDeduplicationKey(value);
            progress.observedIds.add(value.sourceEventId);
            progress.observedIds.add(`event-${identity}`);
            while (progress.observedIds.size > 8_192) {
              const oldest = progress.observedIds.values().next().value;
              if (oldest === undefined) break;
              progress.observedIds.delete(oldest);
            }
            const completeness = progress.header === undefined
              ? known.get(identity)
              : await lookup(identity, progress.header) ?? known.get(identity);
            if (completeness !== undefined) {
              duplicateEvents += 1;
              if (completeness === "incomplete") {
                await repair(value, identity, source);
              } else if (completeness === "unknown") {
                unverifiedExistingEvents += 1;
                if (this.#canonical.captureCompleteness !== undefined) {
                  rememberPending(identity, value, source);
                  repairPendingEvents += 1;
                }
              }
              continue;
            }
            const enqueued = await this.#queue.enqueueIfSourceAbsent(value, {
              environment: {},
            });
            known.set(identity, enqueued.status === "duplicate"
              ? "unknown" : captureEnvelopeCompleteness(createCaptureEnvelope(value)));
            if (enqueued.status === "duplicate") {
              duplicateEvents += 1;
              unverifiedExistingEvents += 1;
              if (this.#canonical.captureCompleteness !== undefined) {
                rememberPending(identity, value, source);
                repairPendingEvents += 1;
              }
            } else {
              queuedEvents += 1;
              if (known.get(identity) === "incomplete") incompleteEvents += 1;
            }
          }
        },
        onHeader: async (header) => {
          internalHeader = header;
          if (this.#internalSessionIds.has(header.sessionId)) {
            return false;
          }
          mapper ??= new CopilotEventMapper({
            adapterVersion: header.adapterVersion,
            copyLimits: this.#copyLimits,
            sessionId: header.sessionId,
            workspace: header.workspace,
          });
          progress.mapper = mapper;
          progress.header = header;
          if (this.#canonical.captureCompleteness !== undefined) return true;
          const [queueItems, canonicalDeduplicationKeys] =
            await Promise.all([
              this.#queue.list(),
              this.#canonical.deduplicationKeys(
                "copilot-cli",
                header.adapterVersion,
                header.sessionId,
              ),
            ]);
          for (const item of queueItems) {
            const envelope = item.envelope;
            if (
              envelope.event.adapter === "copilot-cli" &&
              envelope.event.adapterVersion ===
                header.adapterVersion &&
              envelope.event.sessionId === header.sessionId
            ) {
              known.set(envelope.deduplicationKey, captureEnvelopeCompleteness(envelope));
            }
          }
          for (const deduplicationKey of canonicalDeduplicationKeys) {
            if (!known.has(deduplicationKey)) known.set(deduplicationKey, "unknown");
          }
          return true;
        },
        onIssue: (issue) => {
          this.#reportParserIssue(issue);
        },
      });

      if (parseResult.status === "incompatible") {
        return parseResult;
      }
      if (parseResult.status === "malformed") {
        this.#progress.delete(options.path);
        return parseResult;
      }
      if (
        internalHeader !== undefined &&
        parseResult.stoppedAfterHeader
      ) {
        return {
          status: "skipped_internal",
          adapterVersion: internalHeader.adapterVersion,
          sessionId: internalHeader.sessionId,
        };
      }
      progress.cursor = parseResult.cursor;
      if (deferredRepairEvents > 0) {
        this.#diagnostic(`Capture repairs deferred beyond the bounded cache: ${deferredRepairEvents}. A fresh bounded pass is required.`);
      }
      if (options.resume === true || parseResult.budgetExhausted) {
        if (this.#progress.size >= 4 && !this.#progress.has(options.path)) {
          const oldest = this.#progress.keys().next().value;
          if (oldest !== undefined) this.#progress.delete(oldest);
        }
        this.#progress.set(options.path, progress);
      } else {
        this.#progress.delete(options.path);
      }
      return {
        status: parseResult.budgetExhausted ? "budget_exhausted" : "reconciled",
        adapterVersion: parseResult.header.adapterVersion,
        duplicateEvents,
        ignoredEvents,
        malformedEvents,
        parserIssues: parseResult.issueCount,
        partialTail: parseResult.partialTail,
        queuedEvents,
        scannedEvents,
        sessionId: parseResult.header.sessionId,
        unsupportedEvents,
        incompleteEvents,
        repairedEvents,
        repairPendingEvents,
        unverifiedExistingEvents,
        repairRejectedEvents,
        outsideObservationEvents,
        deferredRepairEvents,
        nextByteOffset: parseResult.cursor.byteOffset,
        bytesRead: parseResult.bytesRead,
        ...(parseResult.stopReason === undefined ? {} : { stopReason: parseResult.stopReason }),
      };
    } catch (error) {
      if (error instanceof SessionFileBudgetError) {
        return { status: "budget_exhausted", reason: error.reason };
      }
      this.#progress.delete(options.path);
      const safeError = sanitizeDiagnostic(error);
      this.#diagnostic(safeError);
      return {
        status: "failed",
        error: safeError,
      };
    }
  }

  #reportParserIssue(issue: CopilotSessionFileIssue): void {
    this.#diagnostic(
      `Session file ${issue.kind} at line ${issue.lineNumber}: ${issue.message}`,
    );
  }

  #diagnostic(value: unknown): void {
    if (this.#onDiagnostic === undefined) {
      return;
    }
    try {
      this.#onDiagnostic(sanitizeDiagnostic(value));
    } catch {
      // Diagnostics cannot interrupt reconciliation.
    }
  }
}
