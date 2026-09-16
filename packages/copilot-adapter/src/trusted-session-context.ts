import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { replaceFileAtomically } from "./atomic-rename.js";

import type { RepositoryState } from "@provenloop/contracts";
import {
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
} from "@provenloop/platform-windows";

const MAX_RECORD_BYTES = 16_384;
const CONTEXT_MAX_AGE_MS = 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
const APPROVAL_MAX_AGE_MS = 5 * 60_000;
const APPROVAL_TEXT = /^(?:confirm|\u786e\u8ba4) PL-[a-f0-9]{12}$/u;

export interface TrustedSessionContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspaceVersion: string;
  readonly repositoryState: RepositoryState;
  readonly repositoryObservedAt: string;
  readonly repositoryId?: string;
  readonly branch?: string;
  readonly commitSha?: string;
  readonly workflowScopeId?: string;
  readonly latestUserMessage?: {
    readonly eventId: string;
    readonly text: string;
    readonly timestamp: string;
  };
}

export interface TrustedSessionContextDiagnostic {
  readonly reason:
    | "reader_probe_busy"
    | "session_producer_inactive"
    | "record_missing"
    | "record_session_mismatch"
    | "record_expired"
    | "record_from_future"
    | "record_producer_inactive"
    | "record_invalid"
    | "record_too_large"
    | "record_read_failed"
    | "context_read_failed"
    | "repository_expired"
    | "repository_from_future"
    | "workspace_refreshing"
    | "repository_unknown";
  readonly recordAgeMs?: number;
  readonly repositoryAgeMs?: number;
  readonly maxAgeMs?: number;
  readonly futureToleranceMs?: number;
  readonly errorCode?: string;
}

type ReportDiagnostic = (diagnostic: TrustedSessionContextDiagnostic) => void;

const safeErrorCode = (error: unknown): string | undefined => {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && [
    "EACCES", "EPERM", "ENOENT", "EIO", "EMFILE", "ENFILE",
    "EBUSY", "ENOTDIR", "EISDIR", "ENAMETOOLONG", "ENOSPC", "EROFS",
  ].includes(code) ? code : undefined;
};

interface ContextRecord {
  readonly schemaVersion: 1;
  readonly producerId: string;
  readonly updatedAt: string;
  readonly context: TrustedSessionContext;
  readonly workspaceRefreshing?: boolean;
}

export interface TrustedSessionWorkspace {
  readonly cwd: string;
  readonly repositoryId?: string;
  readonly branch?: string;
  readonly commitSha?: string;
  readonly repositoryState?: RepositoryState;
  readonly workflowScopeId?: string;
}

export interface TrustedSessionContextPublisherOptions
extends TrustedSessionWorkspace {
  readonly dataRoot: string;
  readonly sessionId: string;
  readonly now?: () => Date;
  readonly onError: (error: unknown) => void;
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const contextPath = (root: string, sessionId: string): string =>
  resolve(
    resolveWindowsProvenLoopPaths(root).data,
    "session-context",
    `${digest(sessionId)}.json`,
  );

const leaseProvider = async (
  root: string,
  sessionId: string,
  producerId?: string,
  scope = "session-context",
) =>
  new WindowsNamedPipeLeaseProvider(
    await resolveWindowsProvenLoopLeaseName(
      root,
      `${scope}-${digest(JSON.stringify([sessionId, producerId ?? null])).slice(0, 32)}`,
    ),
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 4_096;

const validTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

const parseRecord = (value: unknown): ContextRecord => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !nonEmpty(value.producerId) ||
    !validTime(value.updatedAt) ||
    (value.workspaceRefreshing !== undefined && typeof value.workspaceRefreshing !== "boolean") ||
    !isRecord(value.context)
  ) {
    throw new TypeError("Invalid trusted Session context record.");
  }
  const context = value.context;
  if (
    !nonEmpty(context.cwd) ||
    !isAbsolute(context.cwd) ||
    !nonEmpty(context.sessionId) ||
    !nonEmpty(context.workspaceVersion) ||
    !validTime(context.repositoryObservedAt) ||
    !(
      context.repositoryState === "known_repo" ||
      context.repositoryState === "known_outside_repo" ||
      context.repositoryState === "unknown"
    ) ||
    (context.repositoryState === "known_repo" && !nonEmpty(context.repositoryId)) ||
    (context.repositoryState !== "known_repo" &&
      [context.repositoryId, context.branch, context.commitSha]
        .some((field) => field !== undefined)) ||
    [context.repositoryId, context.branch, context.commitSha]
      .some((field) => field !== undefined && !nonEmpty(field)) ||
    (context.workflowScopeId !== undefined &&
      !nonEmpty(context.workflowScopeId))
  ) {
    throw new TypeError("Invalid trusted Session workspace identity.");
  }
  let latestUserMessage: TrustedSessionContext["latestUserMessage"];
  if (context.latestUserMessage !== undefined) {
    const message = context.latestUserMessage;
    if (
      !isRecord(message) ||
      !nonEmpty(message.eventId) ||
      typeof message.text !== "string" ||
      !APPROVAL_TEXT.test(message.text) ||
      !validTime(message.timestamp)
    ) {
      throw new TypeError("Invalid trusted Session approval.");
    }
    latestUserMessage = {
      eventId: message.eventId,
      text: message.text,
      timestamp: message.timestamp,
    };
  }
  return {
    schemaVersion: 1,
    producerId: value.producerId,
    updatedAt: value.updatedAt,
    ...(value.workspaceRefreshing === undefined ? {} : { workspaceRefreshing: value.workspaceRefreshing }),
    context: {
      cwd: context.cwd,
      sessionId: context.sessionId,
      workspaceVersion: context.workspaceVersion,
      repositoryState: context.repositoryState,
      repositoryObservedAt: context.repositoryObservedAt,
      ...(typeof context.repositoryId === "string"
        ? { repositoryId: context.repositoryId }
        : {}),
      ...(typeof context.branch === "string" ? { branch: context.branch } : {}),
      ...(typeof context.commitSha === "string"
        ? { commitSha: context.commitSha }
        : {}),
      ...(context.workflowScopeId === undefined
        ? {}
        : { workflowScopeId: context.workflowScopeId }),
      ...(latestUserMessage === undefined ? {} : { latestUserMessage }),
    },
  };
};

const readRecord = async (path: string): Promise<ContextRecord | undefined> => {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) {
      throw new RangeError("Trusted Session context exceeds its size limit.");
    }
    return parseRecord(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
  } finally {
    await file.close();
  }
};

const readActiveRecord = async (
  dataRoot: string,
  sessionId: string,
  now: Date,
  report: ReportDiagnostic,
): Promise<ContextRecord | undefined> => {
  const guardProvider = await leaseProvider(dataRoot, sessionId, undefined, "session-context-probe");
  const guard = await guardProvider.tryAcquire();
  if (guard === undefined) {
    report({ reason: "reader_probe_busy" });
    return undefined;
  }
  try {
    // Readers must not mistake another reader's temporary probe lease for a live producer.
    const provider = await leaseProvider(dataRoot, sessionId);
    const unowned = await provider.tryAcquire();
    if (unowned !== undefined) {
      await unowned.release();
      report({ reason: "session_producer_inactive" });
      return undefined;
    }
    let record: ContextRecord | undefined;
    try {
      record = await readRecord(contextPath(dataRoot, sessionId));
    } catch (error) {
      const errorCode = safeErrorCode(error);
      report({
        reason: error instanceof SyntaxError || error instanceof TypeError ? "record_invalid"
          : error instanceof RangeError ? "record_too_large" : "record_read_failed",
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      throw error;
    }
    if (record === undefined) {
      report({ reason: "record_missing" });
      return undefined;
    }
    if (record.context.sessionId !== sessionId) {
      report({ reason: "record_session_mismatch" });
      return undefined;
    }
    const recordAgeMs = now.getTime() - Date.parse(record.updatedAt);
    if (recordAgeMs > CONTEXT_MAX_AGE_MS || recordAgeMs < -FUTURE_TOLERANCE_MS) {
      report({
        reason: recordAgeMs > CONTEXT_MAX_AGE_MS ? "record_expired" : "record_from_future",
        recordAgeMs, maxAgeMs: CONTEXT_MAX_AGE_MS, futureToleranceMs: FUTURE_TOLERANCE_MS,
      });
      return undefined;
    }
    const producer = await leaseProvider(dataRoot, sessionId, record.producerId);
    const inactiveProducer = await producer.tryAcquire();
    if (inactiveProducer !== undefined) {
      await inactiveProducer.release();
      report({ reason: "record_producer_inactive", recordAgeMs });
      return undefined;
    }
    return record;
  } finally {
    await guard.release();
  }
};

export const readTrustedSessionContext = async (
  dataRoot: string,
  sessionId: string,
  now: Date = new Date(),
  onDiagnostic?: ReportDiagnostic,
): Promise<TrustedSessionContext | undefined> => {
  if (!nonEmpty(sessionId)) {
    throw new TypeError("A non-empty trusted Session ID is required.");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Trusted Session context requires a valid current time.");
  }
  let reported = false;
  const report: ReportDiagnostic = (diagnostic) => {
    reported = true;
    try { onDiagnostic?.(diagnostic); } catch { /* Diagnostics cannot change identity checks. */ }
  };
  let record: ContextRecord | undefined;
  try {
    record = await readActiveRecord(dataRoot, sessionId, now, report);
  } catch (error) {
    if (!reported) {
      const errorCode = safeErrorCode(error);
      report({ reason: "context_read_failed", ...(errorCode === undefined ? {} : { errorCode }) });
    }
    throw error;
  }
  if (record === undefined) return undefined;
  const snapshot = record.context;
  const repositoryAgeMs = now.getTime() - Date.parse(snapshot.repositoryObservedAt);
  const repositoryFresh =
    repositoryAgeMs <= CONTEXT_MAX_AGE_MS && repositoryAgeMs >= -FUTURE_TOLERANCE_MS;
  if (!repositoryFresh || snapshot.repositoryState === "unknown") {
    report({
      reason: !repositoryFresh
        ? (repositoryAgeMs > CONTEXT_MAX_AGE_MS ? "repository_expired" : "repository_from_future")
        : record.workspaceRefreshing === true ? "workspace_refreshing" : "repository_unknown",
      recordAgeMs: now.getTime() - Date.parse(record.updatedAt),
      repositoryAgeMs, maxAgeMs: CONTEXT_MAX_AGE_MS, futureToleranceMs: FUTURE_TOLERANCE_MS,
    });
  }
  const context: TrustedSessionContext = repositoryFresh ? snapshot : {
    cwd: snapshot.cwd,
    sessionId,
    workspaceVersion: snapshot.workspaceVersion,
    repositoryState: "unknown",
    repositoryObservedAt: snapshot.repositoryObservedAt,
    ...(snapshot.workflowScopeId === undefined
      ? {}
      : { workflowScopeId: snapshot.workflowScopeId }),
    ...(snapshot.latestUserMessage === undefined
      ? {}
      : { latestUserMessage: snapshot.latestUserMessage }),
  };
  const approval = context.latestUserMessage;
  if (
    approval !== undefined &&
    (
      now.getTime() - Date.parse(approval.timestamp) > APPROVAL_MAX_AGE_MS ||
      Date.parse(approval.timestamp) > now.getTime() + 5_000
    )
  ) {
    return {
      cwd: context.cwd,
      sessionId,
      workspaceVersion: context.workspaceVersion,
      repositoryState: context.repositoryState,
      repositoryObservedAt: context.repositoryObservedAt,
      ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
      ...(context.branch === undefined ? {} : { branch: context.branch }),
      ...(context.commitSha === undefined ? {} : { commitSha: context.commitSha }),
      ...(context.workflowScopeId === undefined
        ? {}
        : { workflowScopeId: context.workflowScopeId }),
    };
  }
  return context;
};

export class TrustedSessionContextPublisher {
  readonly #options: TrustedSessionContextPublisherOptions;
  readonly #producerId = randomUUID();
  readonly #path: string;
  #workspace: TrustedSessionWorkspace;
  #workspaceKey: string;
  #repositoryObservedAt: string;
  #refreshing = false;
  #revision = 0;
  #approval: TrustedSessionContext["latestUserMessage"];
  #lease: ProcessLease | undefined;
  #producerLease: ProcessLease | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #scheduled: NodeJS.Immediate | undefined;
  #flushing: Promise<void> | undefined;
  #dirty = true;
  #stopped = false;

  public constructor(options: TrustedSessionContextPublisherOptions) {
    if (!nonEmpty(options.sessionId)) {
      throw new TypeError("A non-empty trusted Session ID is required.");
    }
    this.#options = options;
    this.#path = contextPath(options.dataRoot, options.sessionId);
    this.#workspace = this.#normalizeWorkspace(options);
    this.#workspaceKey = JSON.stringify(this.#workspace);
    this.#repositoryObservedAt = (options.now?.() ?? new Date()).toISOString();
  }

  #normalizeWorkspace(workspace: TrustedSessionWorkspace): TrustedSessionWorkspace {
    const repositoryState = workspace.repositoryState ??
      (workspace.repositoryId === undefined ? "unknown" : "known_repo");
    if (
      !nonEmpty(workspace.cwd) ||
      !isAbsolute(workspace.cwd) ||
      (
        workspace.workflowScopeId !== undefined &&
        !nonEmpty(workspace.workflowScopeId)
      ) ||
      [workspace.repositoryId, workspace.branch, workspace.commitSha]
        .some((value) => value !== undefined && !nonEmpty(value)) ||
      (repositoryState === "known_repo" && workspace.repositoryId === undefined)
    ) {
      throw new TypeError("An absolute trusted workspace is required.");
    }
    return {
      cwd: resolve(workspace.cwd),
      repositoryState,
      ...(repositoryState !== "known_repo" || workspace.repositoryId === undefined ? {} : {
        repositoryId: workspace.repositoryId,
      }),
      ...(repositoryState !== "known_repo" || workspace.branch === undefined
        ? {}
        : { branch: workspace.branch }),
      ...(repositoryState !== "known_repo" || workspace.commitSha === undefined ? {} : {
        commitSha: workspace.commitSha,
      }),
      ...(workspace.workflowScopeId === undefined ? {} : {
        workflowScopeId: workspace.workflowScopeId,
      }),
    };
  }

  public async start(): Promise<void> {
    if (this.#stopped || this.#lease !== undefined) {
      throw new Error("Trusted Session context publisher cannot be restarted.");
    }
    const provider = await leaseProvider(
      this.#options.dataRoot,
      this.#options.sessionId,
    );
    this.#lease = await provider.tryAcquire();
    if (this.#lease === undefined) {
      throw new Error("Trusted Session context already has an active producer.");
    }
    try {
      const producer = await leaseProvider(
        this.#options.dataRoot,
        this.#options.sessionId,
        this.#producerId,
      );
      this.#producerLease = await producer.tryAcquire();
      if (this.#producerLease === undefined) {
        throw new Error("Trusted Session producer identity is already active.");
      }
      await mkdir(dirname(this.#path), { recursive: true });
      await this.flush();
      this.#heartbeat = setInterval(() => this.#schedule(), 10_000);
      this.#heartbeat.unref();
    } catch (error) {
      await this.#releaseLeases();
      throw error;
    }
  }

  async #releaseLeases(): Promise<void> {
    const producer = this.#producerLease;
    const session = this.#lease;
    this.#producerLease = undefined;
    this.#lease = undefined;
    try {
      await producer?.release();
    } finally {
      await session?.release();
    }
  }

  public updateWorkspace(workspace: TrustedSessionWorkspace): void {
    if (this.#stopped) {
      return;
    }
    const normalized = this.#normalizeWorkspace(workspace);
    const key = JSON.stringify(normalized);
    this.#refreshing = false;
    this.#repositoryObservedAt = (this.#options.now?.() ?? new Date()).toISOString();
    if (key === this.#workspaceKey) {
      this.#schedule();
      return;
    }
    this.#workspace = normalized;
    this.#workspaceKey = key;
    this.#revision += 1;
    this.#approval = undefined;
    this.#schedule();
  }

  public beginWorkspaceRefresh(): void {
    if (this.#stopped) {
      return;
    }
    this.#refreshing = true;
    this.#schedule();
  }

  public observeUserMessage(
    message: NonNullable<TrustedSessionContext["latestUserMessage"]>,
  ): void {
    if (this.#stopped) {
      return;
    }
    const text = message.text.length <= 96 ? message.text.trim() : "";
    this.#approval =
      nonEmpty(message.eventId) &&
      validTime(message.timestamp) &&
      APPROVAL_TEXT.test(text)
        ? { eventId: message.eventId, text, timestamp: message.timestamp }
        : undefined;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#stopped) {
      return;
    }
    this.#dirty = true;
    if (this.#scheduled !== undefined || this.#flushing !== undefined) {
      return;
    }
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      void this.flush().catch((error: unknown) => {
        try { this.#options.onError(error); } catch { /* Reporting cannot create an unhandled background rejection. */ }
      });
    });
    this.#scheduled.unref();
  }

  public async flush(): Promise<void> {
    if (this.#flushing !== undefined) {
      await this.#flushing;
      return;
    }
    if (this.#lease === undefined) {
      throw new Error("Trusted Session context publisher has not started.");
    }
    this.#flushing = this.#writePending();
    let completed = false;
    try {
      await this.#flushing;
      completed = true;
    } finally {
      this.#flushing = undefined;
      if (completed && this.#dirty && !this.#stopped) {
        this.#schedule();
      }
    }
  }

  async #writePending(): Promise<void> {
    while (this.#dirty) {
      this.#dirty = false;
      const record: ContextRecord = {
        schemaVersion: 1,
        producerId: this.#producerId,
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
        workspaceRefreshing: this.#refreshing,
        context: {
          cwd: this.#workspace.cwd,
          sessionId: this.#options.sessionId,
          workspaceVersion: `${this.#producerId}:${this.#revision}`,
          repositoryState: this.#refreshing ? "unknown" :
            this.#workspace.repositoryState ?? "unknown",
          repositoryObservedAt: this.#repositoryObservedAt,
          ...(this.#refreshing || this.#workspace.repositoryId === undefined
            ? {}
            : { repositoryId: this.#workspace.repositoryId }),
          ...(this.#refreshing || this.#workspace.branch === undefined
            ? {}
            : { branch: this.#workspace.branch }),
          ...(this.#refreshing || this.#workspace.commitSha === undefined
            ? {}
            : { commitSha: this.#workspace.commitSha }),
          ...(this.#workspace.workflowScopeId === undefined
            ? {}
            : { workflowScopeId: this.#workspace.workflowScopeId }),
          ...(this.#approval === undefined ? {} : {
            latestUserMessage: this.#approval,
          }),
        },
      };
      const body = JSON.stringify(record);
      if (Buffer.byteLength(body, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("Trusted Session context exceeds its size limit.");
      }
      const temporary = `${this.#path}.${this.#producerId}.tmp`;
      try {
        const file = await open(temporary, "w");
        try {
          await file.writeFile(body, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await replaceFileAtomically(temporary, this.#path);
      } catch (error) {
        this.#dirty = true;
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    clearImmediate(this.#scheduled);
    try {
      await this.#flushing;
      const record = await readRecord(this.#path);
      if (record?.producerId === this.#producerId) {
        await rm(this.#path, { force: true });
      }
    } finally {
      await this.#releaseLeases();
    }
  }
}
