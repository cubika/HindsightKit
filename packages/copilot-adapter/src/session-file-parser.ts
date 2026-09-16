import { createHash, type Hash } from "node:crypto";
import { open } from "node:fs/promises";

import { isoTimestampSchema } from "@provenloop/contracts";

import {
  getCopilotCaptureCapability,
} from "./capabilities.js";
import type {
  CopilotSessionEvent,
  CopilotWorkspaceSnapshot,
} from "./event-mapper.js";

export interface CopilotSessionFileHeader {
  readonly adapterVersion: string;
  readonly fileVersion: number;
  readonly producer?: string;
  readonly sessionId: string;
  readonly workspace: CopilotWorkspaceSnapshot;
}

export interface CopilotSessionFileIssue {
  readonly kind:
    | "malformed_json"
    | "malformed_event"
    | "oversized_line";
  readonly lineNumber: number;
  readonly message: string;
}

type SessionEventConsumer<T> = (
  event: CopilotSessionEvent,
  lineNumber: number,
  source: CopilotSessionEventSource,
) => T | Promise<T>;

export interface CopilotSessionFileParserOptions {
  readonly cursor?: CopilotSessionFileCursor;
  readonly deadlineMs?: number;
  readonly expectedSessionId?: string;
  readonly maxBytes?: number;
  readonly maxEvents?: number;
  readonly maxLineChars: number;
  readonly onEvent: SessionEventConsumer<boolean | undefined> | SessionEventConsumer<void>;
  readonly onHeader?: (
    header: CopilotSessionFileHeader,
  ) => Promise<boolean | undefined> | boolean | undefined;
  readonly onIssue?: (
    issue: CopilotSessionFileIssue,
  ) => Promise<void> | void;
  readonly requireCompleteLines?: boolean;
  readonly signal?: AbortSignal;
}

export interface CopilotSessionEventSource {
  readonly byteOffset: number;
  readonly nextByteOffset: number;
  /** SHA-256 of the observed append-only source prefix ending at nextByteOffset. */
  readonly sourceDigest: string;
}

/** Opaque process-local continuation; reconstructed or deserialized cursors are rejected. */
export interface CopilotSessionFileCursor {
  readonly byteOffset: number;
  readonly lineNumber: number;
}

export type SessionFileStopReason = "bytes" | "events" | "deadline" | "cancelled" | "consumer";

export class SessionFileBudgetError extends Error {
  public override readonly name = "SessionFileBudgetError";
  public constructor(public readonly reason: SessionFileStopReason) {
    super(`Session-file reconciliation stopped at its ${reason} budget.`);
  }
}

interface CursorState {
  readonly discarding: boolean;
  readonly fileIdentity: string;
  readonly headerDigest: string;
  readonly headerLength: number;
  readonly mtimeMs: number;
  readonly prefixHash: Hash;
  readonly requiresSeparator: boolean;
  readonly size: number;
}

const cursorStates = new WeakMap<CopilotSessionFileCursor, CursorState>();
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export type CopilotSessionFileParseResult =
  | {
      readonly eventCount: number;
      readonly header: CopilotSessionFileHeader;
      readonly issueCount: number;
      readonly partialTail: boolean;
      readonly status: "supported";
      readonly stoppedAfterHeader: boolean;
      readonly budgetExhausted: boolean;
      readonly bytesRead: number;
      readonly cursor: CopilotSessionFileCursor;
      readonly stopReason?: SessionFileStopReason;
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
    };

type CopilotSessionFileHeaderResult =
  | CopilotSessionFileHeader
  | Exclude<
      CopilotSessionFileParseResult,
      { readonly status: "supported" }
    >;

export class InvalidSessionFileParserConfigurationError extends Error {
  public override readonly name =
    "InvalidSessionFileParserConfigurationError";

  public constructor() {
    super("Session file maxLineChars must be a positive integer.");
  }
}

interface FirstSessionRecord {
  readonly line: string;
  readonly lineNumber: number;
  readonly nextOffset: number;
}

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const workspaceFromContext = (
  value: unknown,
): CopilotWorkspaceSnapshot => {
  const context = asRecord(value);
  if (context === undefined) {
    return {};
  }
  const branch = optionalString(context, "branch");
  const commitSha = optionalString(context, "headCommit");
  const repoId = optionalString(context, "repository");
  const worktree =
    optionalString(context, "gitRoot") ??
    optionalString(context, "cwd");
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(commitSha === undefined ? {} : { commitSha }),
    ...(repoId === undefined ? {} : { repoId }),
    ...(worktree === undefined ? {} : { worktree }),
  };
};

const inspectHeader = (
  input: unknown,
  expectedSessionId: string | undefined,
  lineNumber: number,
): CopilotSessionFileHeaderResult => {
  const event = asRecord(input);
  if (event === undefined || event.type !== "session.start") {
    return {
      status: "malformed",
      lineNumber,
      reason: "The first Session record must be session.start.",
    };
  }
  if (
    typeof event.id !== "string" ||
    event.id.trim().length === 0 ||
    !Object.prototype.hasOwnProperty.call(event, "parentId") ||
    (
      event.parentId !== null &&
      (
        typeof event.parentId !== "string" ||
        event.parentId.trim().length === 0
      )
    ) ||
    !isoTimestampSchema.safeParse(event.timestamp).success
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason:
        "session.start requires a valid id, parentId, and ISO timestamp.",
    };
  }
  const data = asRecord(event.data);
  if (data === undefined) {
    return {
      status: "malformed",
      lineNumber,
      reason: "session.start data must be an object.",
    };
  }
  const adapterVersion = optionalString(data, "copilotVersion");
  const sessionId = optionalString(data, "sessionId");
  const fileVersion = data.version;
  if (
    adapterVersion === undefined ||
    sessionId === undefined ||
    !Number.isInteger(fileVersion) ||
    (fileVersion as number) < 0
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason:
        "session.start requires copilotVersion, sessionId, and a non-negative integer version.",
    };
  }
  if (
    expectedSessionId !== undefined &&
    expectedSessionId !== sessionId
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason: "Session directory identity does not match session.start.",
    };
  }
  const capability = getCopilotCaptureCapability(adapterVersion);
  if (capability === undefined || capability.status !== "supported") {
    return {
      status: "incompatible",
      adapterVersion,
      fileVersion: fileVersion as number,
      reason: "unsupported_adapter_version",
    };
  }
  if (!capability.sessionFileVersions.includes(fileVersion as number)) {
    return {
      status: "incompatible",
      adapterVersion,
      fileVersion: fileVersion as number,
      reason: "unsupported_session_file_version",
    };
  }
  const producer = optionalString(data, "producer");
  return {
    adapterVersion,
    fileVersion: fileVersion as number,
    ...(producer === undefined ? {} : { producer }),
    sessionId,
    workspace: workspaceFromContext(data.context),
  };
};

const readFirstSessionRecord = (
  buffer: Buffer,
  maxLineChars: number,
  atEnd: boolean,
):
  | FirstSessionRecord
  | {
      readonly lineNumber: number;
      readonly status: "empty" | "oversized" | "header_budget";
    } => {
  let lineNumber = 1;
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline;
    const line = buffer.subarray(start, end).toString("utf8").replace(/\r$/u, "");
    if (line.length > maxLineChars) return { status: "oversized", lineNumber };
    if (newline === -1 && !atEnd) return { status: "header_budget", lineNumber };
    if (line.trim().length > 0) {
      return { line, lineNumber, nextOffset: newline === -1 ? end : end + 1 };
    }
    start = end + 1;
    lineNumber += 1;
  }
  return { status: "empty", lineNumber };
};

export const parseCopilotSessionFile = async (
  path: string,
  options: CopilotSessionFileParserOptions,
): Promise<CopilotSessionFileParseResult> => {
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  const maxEvents = options.maxEvents ?? 500;
  const deadlineMs = options.deadlineMs ?? 1_500;
  if (!Number.isInteger(options.maxLineChars) || options.maxLineChars <= 0 ||
    !Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES ||
    !Number.isInteger(maxEvents) || maxEvents <= 0 || maxEvents > 500 ||
    !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 5_000) {
    throw new InvalidSessionFileParserConfigurationError();
  }
  const started = performance.now();
  const timeStop = (): SessionFileStopReason | undefined =>
    options.signal?.aborted ? "cancelled"
      : performance.now() - started >= deadlineMs ? "deadline" : undefined;
  const initialStop = timeStop();
  if (initialStop !== undefined) throw new SessionFileBudgetError(initialStop);
  const previous = options.cursor === undefined ? undefined : cursorStates.get(options.cursor);
  if (options.cursor !== undefined && previous === undefined) {
    throw new Error("Session-file cursor is not an authenticated parser continuation.");
  }
  const handle = await open(path, "r");
  try {
    const readBounded = async (buffer: Buffer, position: number): Promise<number> => {
      let count = 0;
      while (count < buffer.length && timeStop() === undefined) {
        const read = await handle.read(buffer, count, buffer.length - count, position + count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      return count;
    };
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) {
      return { status: "malformed", lineNumber: 1, reason: "Session source must be a regular file." };
    }
    const fileIdentity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
    if (previous !== undefined && (
      previous.fileIdentity !== fileIdentity ||
      metadata.size < previous.size ||
      (metadata.size === previous.size && metadata.mtimeMs !== previous.mtimeMs)
    )) {
      return { status: "malformed", lineNumber: 1, reason: "Session source changed instead of appending." };
    }
    if (previous !== undefined && previous.headerLength >= maxBytes) {
      throw new SessionFileBudgetError("bytes");
    }
    const prefix = Buffer.allocUnsafe(Math.min(
      metadata.size, maxBytes, previous?.headerLength ?? 64 * 1024,
    ));
    const firstRead = await readBounded(prefix, 0);
    const headerBuffer = prefix.subarray(0, firstRead);
    let bytesRead = firstRead;
    const firstRecord = readFirstSessionRecord(
      headerBuffer, options.maxLineChars, headerBuffer.length === metadata.size,
    );
    if ("status" in firstRecord) {
      const stopped = timeStop();
      if (stopped !== undefined) throw new SessionFileBudgetError(stopped);
      return {
        status: "malformed",
        lineNumber: firstRecord.lineNumber,
        reason: firstRecord.status === "oversized"
          ? "session.start exceeds the line-size limit."
          : firstRecord.status === "header_budget"
            ? "session.start exceeds the bounded header budget."
            : "Session file is empty.",
      };
    }
    let headerInput: unknown;
    try {
      headerInput = JSON.parse(firstRecord.line.replace(/^\uFEFF/u, "")) as unknown;
    } catch {
      return { status: "malformed", lineNumber: firstRecord.lineNumber, reason: "session.start is not valid JSON." };
    }
    const inspected = inspectHeader(headerInput, options.expectedSessionId, firstRecord.lineNumber);
    if ("status" in inspected) return inspected;
    if (options.requireCompleteLines === true && headerBuffer[firstRecord.nextOffset - 1] !== 0x0a) {
      return { status: "malformed", lineNumber: firstRecord.lineNumber, reason: "session.start is not a complete JSONL record." };
    }
    const header = inspected;
    const headerDigest = createHash("sha256").update(headerBuffer.subarray(0, firstRecord.nextOffset)).digest("hex");
    if (previous !== undefined && (
      previous.headerDigest !== headerDigest || previous.headerLength !== firstRecord.nextOffset
    )) {
      return { status: "malformed", lineNumber: firstRecord.lineNumber, reason: "Session header changed during reconciliation." };
    }
    let prefixHash = previous?.prefixHash.copy() ??
      createHash("sha256").update(headerBuffer.subarray(0, firstRecord.nextOffset));
    let committedOffset = options.cursor?.byteOffset ?? firstRecord.nextOffset;
    let lineNumber = options.cursor?.lineNumber ?? firstRecord.lineNumber + 1;
    let discarding = previous?.discarding ?? false;
    let requiresSeparator = previous?.requiresSeparator ?? false;
    let eventCount = 0;
    let attemptedRecords = 0;
    let issueCount = 0;
    let partialTail = false;
    let stopReason: SessionFileStopReason | undefined;
    const finish = (stoppedAfterHeader = false): CopilotSessionFileParseResult => {
      const cursor = Object.freeze({ byteOffset: committedOffset, lineNumber });
      cursorStates.set(cursor, {
        discarding, fileIdentity, headerDigest, headerLength: firstRecord.nextOffset,
        mtimeMs: metadata.mtimeMs, prefixHash: prefixHash.copy(),
        requiresSeparator, size: metadata.size,
      });
      return {
        status: "supported", eventCount, header, issueCount, partialTail,
        stoppedAfterHeader, budgetExhausted: stopReason !== undefined,
        bytesRead, cursor, ...(stopReason === undefined ? {} : { stopReason }),
      };
    };
    if (await options.onHeader?.(header) === false) return finish(true);
    const beforeEvents = timeStop();
    if (beforeEvents !== undefined) {
      stopReason = beforeEvents;
      if (previous === undefined) {
        committedOffset = 0;
        lineNumber = firstRecord.lineNumber;
        prefixHash = createHash("sha256");
      }
      return finish();
    }
    if (previous === undefined) {
      const accepted = await options.onEvent(headerInput as CopilotSessionEvent, firstRecord.lineNumber, {
        byteOffset: 0,
        nextByteOffset: firstRecord.nextOffset,
        sourceDigest: prefixHash.copy().digest("hex"),
      });
      if (accepted === false) {
        stopReason = "consumer";
        committedOffset = 0;
        lineNumber = firstRecord.lineNumber;
        prefixHash = createHash("sha256");
        return finish();
      }
      eventCount += 1;
      attemptedRecords += 1;
    }
    const prefetched = committedOffset < headerBuffer.length
      ? headerBuffer.subarray(committedOffset)
      : Buffer.alloc(0);
    const readOffset = committedOffset + prefetched.length;
    const remainder = Buffer.allocUnsafe(
      Math.min(Math.max(0, metadata.size - readOffset), Math.max(0, maxBytes - bytesRead)),
    );
    const read = await readBounded(remainder, readOffset);
    bytesRead += read;
    const data = Buffer.concat([prefetched, remainder.subarray(0, read)]);
    const dataOffset = committedOffset;
    const atSnapshotEnd = dataOffset + data.length === metadata.size;
    let position = 0;
    const commit = (end: number, nextLine: number): void => {
      prefixHash.update(data.subarray(position, end));
      committedOffset = dataOffset + end;
      position = end;
      lineNumber = nextLine;
    };
    const reportOversized = async (byteBudget = false): Promise<void> => {
      issueCount += 1;
      await options.onIssue?.({
        kind: "oversized_line", lineNumber,
        message: byteBudget
          ? "Session event exceeds the per-pass byte limit."
          : "Session event exceeds the line-size limit.",
      });
    };
    while (position < data.length) {
      stopReason = timeStop() ?? (attemptedRecords >= maxEvents ? "events" : undefined);
      if (stopReason !== undefined) break;
      const newline = data.indexOf(0x0a, position);
      const end = newline === -1 ? data.length : newline + 1;
      if (requiresSeparator) {
        const separator = data.subarray(position, end).toString("utf8");
        if (separator.trim().length !== 0) {
          return { status: "malformed", lineNumber, reason: "Appended Session data has no JSONL separator." };
        }
        commit(end, newline === -1 ? lineNumber : lineNumber + 1);
        requiresSeparator = newline === -1;
        continue;
      }
      if (discarding) {
        commit(end, newline === -1 ? lineNumber : lineNumber + 1);
        discarding = newline === -1;
        continue;
      }
      const raw = data.subarray(position, newline === -1 ? end : newline);
      const text = raw.toString("utf8").replace(/\r$/u, "");
      if (text.length > options.maxLineChars ||
        (newline === -1 && !atSnapshotEnd && position === 0)) {
        attemptedRecords += 1;
        await reportOversized(text.length <= options.maxLineChars);
        commit(end, newline === -1 ? lineNumber : lineNumber + 1);
        discarding = newline === -1;
        continue;
      }
      if (newline === -1 && (!atSnapshotEnd || options.requireCompleteLines === true)) {
        partialTail = atSnapshotEnd;
        stopReason = atSnapshotEnd ? undefined : "bytes";
        break;
      }
      if (text.trim().length === 0) {
        commit(end, newline === -1 ? lineNumber : lineNumber + 1);
        continue;
      }
      attemptedRecords += 1;
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        if (newline === -1) {
          partialTail = true;
          break;
        }
        issueCount += 1;
        await options.onIssue?.({ kind: "malformed_json", lineNumber, message: "Session event is not valid JSON." });
        commit(end, lineNumber + 1);
        continue;
      }
      if (asRecord(value) === undefined) {
        issueCount += 1;
        await options.onIssue?.({ kind: "malformed_event", lineNumber, message: "Session event must be a JSON object." });
        commit(end, newline === -1 ? lineNumber : lineNumber + 1);
        continue;
      }
      const sourceDigest = prefixHash.copy().update(data.subarray(position, end)).digest("hex");
      const accepted = await options.onEvent(value as CopilotSessionEvent, lineNumber, {
        byteOffset: dataOffset + position,
        nextByteOffset: dataOffset + end,
        sourceDigest,
      });
      if (accepted === false) {
        stopReason = "consumer";
        break;
      }
      eventCount += 1;
      requiresSeparator = newline === -1;
      commit(end, newline === -1 ? lineNumber : lineNumber + 1);
    }
    if (discarding && atSnapshotEnd) partialTail = true;
    if (stopReason === undefined && !partialTail && committedOffset < metadata.size) stopReason = "bytes";
    return finish();
  } finally {
    await handle.close();
  }
};
