import type {
  JsonValue,
  RawEvent,
} from "@provenloop/contracts";
import { isoTimestampSchema, SUPPORTED_EVENT_TYPES, rawEventSchema } from "@provenloop/contracts";
import {
  isExplicitCorrectionMessage,
  createCaptureDeduplicationKey,
  type CaptureEventInput as DomainCaptureEventInput,
} from "@provenloop/domain";
import {
  boundedText,
  boundedCaptureQuality,
  classifyVerificationCommand,
  commandTargetPaths,
  copyEvidenceValue,
  copyMcpArguments,
  copyToolContentBlocks,
  evidencePaths,
  newCaptureQuality,
  patchTargetPaths,
  pathsWithinWorkspace,
  recordOf,
  resolveEvidencePaths,
  resolveEvidenceDirectory,
  structuredShellResult,
  type CaptureEvidence,
  type CaptureQuality,
  type RepositoryState,
} from "./capture-evidence.js";

type CaptureEventInput = DomainCaptureEventInput;

export interface CopilotSessionEvent {
  readonly mcp?: RawEvent["mcp"];
  readonly agentId?: unknown;
  readonly data?: unknown;
  readonly ephemeral?: unknown;
  readonly id?: unknown;
  readonly parentId?: unknown;
  readonly timestamp?: unknown;
  readonly type?: unknown;
}

export interface CopilotWorkspaceSnapshot {
  readonly cwd?: string;
  readonly workflowScopeId?: string;
  readonly branch?: string;
  readonly commitParents?: readonly string[];
  readonly commitSha?: string;
  readonly repoId?: string;
  readonly worktree?: string;
  readonly repositoryState?: RepositoryState;
}

export interface CopilotCallbackCopyLimits {
  readonly maxStringChars: number;
}

export interface CopilotEventMapperOptions {
  readonly adapterVersion: string;
  readonly copyLimits: CopilotCallbackCopyLimits;
  readonly sessionId: string;
  readonly workspace?: CopilotWorkspaceSnapshot;
}

interface SourceCaptureContext {
  readonly eventId: string;
  readonly repoId: string | undefined;
  readonly worktree: string | undefined;
  readonly correctionEventId: string | undefined;
  readonly parentBridge?: NonNullable<RawEvent["parentBridge"]>;
}

export class InvalidCopilotEventMapperConfigurationError extends Error {
  public override readonly name =
    "InvalidCopilotEventMapperConfigurationError";

  public constructor(field: string) {
    super(`Copilot event mapper ${field} is invalid.`);
  }
}

export type CopilotEventMappingResult =
  | {
      readonly status: "ignored";
      readonly eventType?: string;
      readonly reason:
        | "capability_disabled"
        | "ephemeral"
        | "internal_session";
      readonly sourceEventId?: string;
    }
  | {
      readonly status: "malformed";
      readonly eventType?: string;
      readonly issues: readonly string[];
      readonly sourceEventId?: string;
    }
  | {
      readonly status: "mapped";
      readonly value: CaptureEventInput;
      readonly additionalEvents?: readonly CaptureEventInput[];
    }
  | {
      readonly status: "unsupported";
      readonly value: CaptureEventInput;
    };

const intentionallyIgnoredEventTypes = new Set([
  "assistant.intent",
  "assistant.message_delta",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
  "assistant.usage",
  "session.usage_info",
  "tool.execution_partial_result",
  "tool.execution_progress",
]);
const canonicalEventTypes = new Set<string>(SUPPORTED_EVENT_TYPES);

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

const requiredString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: string[],
): string | undefined => {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${field} must be a non-empty string.`);
    return undefined;
  }
  if (field !== "message" && field !== "error" &&
      value.length > (field === "cwd" ? 32_768 : 256)) {
    issues.push(`${field} exceeds its capture metadata limit.`);
    return undefined;
  }
  return value;
};

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field];
  const maximum = ["content", "detailedContent", "message", "errorReason"].includes(field)
    ? Number.MAX_SAFE_INTEGER
    : field === "cwd" || field === "gitRoot" ? 32_768
    : field === "branch" ? 1_024 : 256;
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value
    : undefined;
};

const requiredBoolean = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  issues: string[],
): boolean | undefined => {
  const value = record[field];
  if (typeof value !== "boolean") {
    issues.push(`${field} must be a boolean.`);
    return undefined;
  }
  return value;
};

const optionalFiniteNumber = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const positiveInteger = (
  value: number,
  field: string,
): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidCopilotEventMapperConfigurationError(field);
  }
  return value;
};

const normalizedWorkspace = (
  snapshot: CopilotWorkspaceSnapshot,
): CopilotWorkspaceSnapshot => ({
  ...(snapshot.cwd?.trim() ? { cwd: snapshot.cwd.trim() } : {}),
  ...(snapshot.workflowScopeId?.trim() ? { workflowScopeId: snapshot.workflowScopeId.trim() } : {}),
  repositoryState: snapshot.repositoryState === "unknown" || snapshot.repositoryState === "known_outside_repo"
    ? snapshot.repositoryState
    : snapshot.repoId?.trim() ? "known_repo" : "unknown",
  ...(snapshot.branch?.trim()
    ? {
        branch: snapshot.branch.trim(),
      }
    : {}),
  ...(snapshot.commitSha?.trim()
    ? {
        commitSha: snapshot.commitSha.trim(),
      }
    : {}),
  ...(snapshot.commitParents === undefined
    ? {}
    : {
        commitParents: [
          ...new Set(
            snapshot.commitParents
              .map((commit) => commit.trim())
              .filter((commit) => commit.length > 0),
          ),
        ].sort(),
      }),
  ...(snapshot.repoId?.trim()
    ? {
        repoId: snapshot.repoId.trim(),
      }
    : {}),
  ...(snapshot.worktree?.trim()
    ? {
        worktree: snapshot.worktree.trim(),
      }
    : {}),
});

const copyBoundedValue = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
  quality: CaptureQuality,
  path: string,
): JsonValue | undefined => {
  return copyEvidenceValue(value, limits.maxStringChars, quality, path);
};

const copyToolResult = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
  quality: CaptureQuality,
): JsonValue | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return copyBoundedValue(value, limits, quality, "toolResult");
  }
  const record = asRecord(value);
  const content = optionalString(record, "content");
  const detailedContent = optionalString(record, "detailedContent");
  const contents = record.contents;
  const structuredContent = record.structuredContent;
  if (
    content === undefined &&
    detailedContent === undefined &&
    !Array.isArray(contents) &&
    structuredContent === undefined
  ) {
    return copyBoundedValue(value, limits, quality, "toolResult");
  }
  const copied = recordOf(copyBoundedValue(value, limits, quality, "toolResult"));
  if (copied.status === "omitted_in_callback") {
    const index = quality.omittedFields.indexOf("toolResult");
    if (index >= 0) quality.omittedFields.splice(index, 1);
  }
  return {
    ...(copied.status === "omitted_in_callback" ? {} : copied as Readonly<Record<string, JsonValue>>),
    ...(content === undefined
      ? {}
      : {
          content: boundedText(content, limits.maxStringChars, quality, "toolResult.content"),
        }),
    ...(detailedContent === undefined
      ? {}
      : {
          detailedContent: boundedText(detailedContent, limits.maxStringChars, quality, "toolResult.detailedContent"),
        }),
    ...(Array.isArray(contents)
      ? {
          contents: copyToolContentBlocks(contents, limits.maxStringChars, quality),
        }
      : {}),
    ...(structuredContent === undefined
      ? {}
      : {
          structuredContent: copyBoundedValue(
            structuredContent, limits, quality, "toolResult.structuredContent",
          ) ?? null,
        }),
  };
};

const copyError = (
  value: unknown,
  limits: CopilotCallbackCopyLimits,
  quality: CaptureQuality,
): JsonValue | undefined => {
  if (typeof value === "string") {
    return boundedText(value, limits.maxStringChars, quality, "error");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return copyBoundedValue(value, limits, quality, "error");
  }
  const record = asRecord(value);
  const code = optionalString(record, "code");
  const message = optionalString(record, "message");
  const name = optionalString(record, "name");
  return {
    ...(code === undefined ? {} : { code: boundedText(code, limits.maxStringChars, quality, "error.code") }),
    ...(message === undefined
      ? {}
      : {
          message: boundedText(message, limits.maxStringChars, quality, "error.message"),
        }),
    ...(name === undefined ? {} : { name: boundedText(name, limits.maxStringChars, quality, "error.name") }),
  };
};

const userMessageTrust = (
  data: Readonly<Record<string, unknown>>,
): RawEvent["trust"] => {
  if (data.isAutopilotContinuation === true) {
    return "system";
  }
  const source = optionalString(data, "source");
  if (source?.startsWith("agent-") === true) {
    return "model";
  }
  return source === undefined || source === "user"
    ? "user"
    : "system";
};

const messageContent = (
  data: Readonly<Record<string, unknown>>,
  limits: CopilotCallbackCopyLimits,
  issues: string[],
  quality: CaptureQuality,
): string | undefined => {
  const content = data.content;
  if (typeof content !== "string") {
    issues.push("content must be a string.");
    return undefined;
  }
  return content.length === 0
    ? undefined
    : boundedText(content, limits.maxStringChars, quality, "message");
};

export class CopilotEventMapper {
  readonly #adapterVersion: string;
  readonly #copyLimits: CopilotCallbackCopyLimits;
  readonly #sessionId: string;
  readonly #toolNames = new Map<string, string>();
  readonly #operations = new Map<string, {
    readonly sourceEventId: string;
    readonly toolName: string;
    readonly arguments: JsonValue | undefined;
    readonly workspace: CopilotWorkspaceSnapshot;
    readonly truncated: boolean;
    readonly correctionEventId?: string;
    readonly workspacePending: boolean;
    readonly builtinTool: boolean;
    readonly mcp?: RawEvent["mcp"];
  }>();
  readonly #sourceEvents = new Map<string, SourceCaptureContext>();
  readonly #canonicalSourceEvents = new Map<string, SourceCaptureContext>();
  #lastEmittedCommitSha: string | undefined;
  #workspace: CopilotWorkspaceSnapshot;
  #workspacePending = false;

  public constructor(options: CopilotEventMapperOptions) {
    if (options.adapterVersion.trim().length === 0 || options.adapterVersion.length > 128) {
      throw new InvalidCopilotEventMapperConfigurationError(
        "adapterVersion",
      );
    }
    if (options.sessionId.trim().length === 0 || options.sessionId.length > 128) {
      throw new InvalidCopilotEventMapperConfigurationError(
        "sessionId",
      );
    }
    this.#adapterVersion = options.adapterVersion.trim();
    this.#copyLimits = {
      maxStringChars: positiveInteger(
        options.copyLimits.maxStringChars,
        "copyLimits.maxStringChars",
      ),
    };
    this.#sessionId = options.sessionId.trim();
    this.#workspace = normalizedWorkspace(options.workspace ?? {});
    this.#lastEmittedCommitSha = this.#workspace.commitSha;
  }

  public updateWorkspace(
    snapshot: CopilotWorkspaceSnapshot,
    timestamp = new Date().toISOString(),
  ): CaptureEventInput | undefined {
    const updated = normalizedWorkspace(snapshot);
    this.#workspace = updated;
    this.#workspacePending = false;
    if (
      updated.commitSha === undefined ||
      updated.commitParents === undefined ||
      updated.commitSha === this.#lastEmittedCommitSha
    ) {
      return undefined;
    }
    this.#lastEmittedCommitSha = updated.commitSha;
    return {
      ...this.#base(
        `workspace-head-${updated.commitSha}`,
        "git.head_changed",
        timestamp,
        "system",
      ),
      commitSha: updated.commitSha,
      evidence: {
        schemaVersion: 1,
        kind: "head_observation",
        repositoryState: updated.repositoryState ?? "unknown",
      },
      content: {
        toolArguments: {
          parents: updated.commitParents,
        },
      },
    };
  }

  public currentWorkspace(): CopilotWorkspaceSnapshot {
    return {
      ...this.#workspace,
      ...(this.#workspace.commitParents === undefined
        ? {}
        : {
            commitParents: [
              ...this.#workspace.commitParents,
            ],
          }),
    };
  }

  public resetCaptureChain(): void {
    this.#operations.clear();
    this.#toolNames.clear();
    this.#sourceEvents.clear();
    this.#canonicalSourceEvents.clear();
  }

  public sessionStarted(
    timestamp = new Date().toISOString(),
  ): CaptureEventInput {
    return {
      ...this.#base(
        `extension-start-${this.#sessionId}`,
        "session.started",
        timestamp,
        "system",
      ),
    };
  }

  public map(input: unknown): CopilotEventMappingResult {
    const result = this.#map(input);
    if (result.status === "mapped" || result.status === "unsupported") {
      for (const event of [result.value, ...(result.status === "mapped" ? result.additionalEvents ?? [] : [])]) {
        if (event.captureQuality !== undefined) event.captureQuality = boundedCaptureQuality(event.captureQuality);
      }
    }
    return result;
  }

  #map(input: unknown): CopilotEventMappingResult {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      return {
        issues: [
          "event must be an object.",
        ],
        status: "malformed",
      };
    }
    const event = input as Readonly<Record<string, unknown>>;
    const parsedMcp = rawEventSchema.shape.mcp.safeParse(event.mcp);
    const mcp = parsedMcp.success ? parsedMcp.data : undefined;
    const issues: string[] = [];
    const sourceEventId =
      typeof event.id === "string" && event.id.trim().length > 0 && event.id.length <= 256
        ? event.id
        : undefined;
    const eventType =
      typeof event.type === "string" && event.type.trim().length > 0 && event.type.length <= 128
        ? event.type
        : undefined;
    const parsedTimestamp = isoTimestampSchema.safeParse(
      typeof event.timestamp === "string" && event.timestamp.length <= 64
        ? event.timestamp : undefined,
    );
    const timestamp = parsedTimestamp.success
      ? parsedTimestamp.data
      : undefined;
    if (sourceEventId === undefined) {
      issues.push("id must be a non-empty string.");
    }
    if (eventType === undefined) {
      issues.push("type must be a non-empty string.");
    }
    if (timestamp === undefined) {
      issues.push("timestamp must be an ISO-8601 string.");
    }
    if (!Object.prototype.hasOwnProperty.call(event, "parentId")) {
      issues.push("parentId is required.");
    } else if (event.parentId !== null) {
      if (
        typeof event.parentId !== "string" ||
        event.parentId.trim().length === 0 ||
        event.parentId.length > 256
      ) {
        issues.push("parentId must be a non-empty string or null.");
      }
    }
    if (event.agentId !== undefined) {
      if (
        typeof event.agentId !== "string" ||
        event.agentId.trim().length === 0 ||
        event.agentId.length > 256
      ) {
        issues.push("agentId must be a non-empty string when present.");
      }
    }
    if (
      !Object.prototype.hasOwnProperty.call(event, "data") ||
      event.data === null ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    ) {
      issues.push("data must be an object.");
    }
    if (
      sourceEventId === undefined ||
      eventType === undefined ||
      timestamp === undefined ||
      issues.length > 0
    ) {
      return {
        status: "malformed",
        ...(eventType === undefined ? {} : { eventType }),
        issues,
        ...(sourceEventId === undefined ? {} : { sourceEventId }),
      };
    }

    const data = asRecord(event.data);
    const observedParent = typeof event.parentId === "string" ? this.#sourceEvents.get(event.parentId) : undefined;
    const bridgeTypes = new Set(["hook.start", "hook.end", "system.message", "permission.requested", "permission.completed", "session.usage_checkpoint", "session.info", "session.model_change"]);
    if (bridgeTypes.has(eventType) && observedParent !== undefined && typeof event.parentId === "string" &&
        this.#workspace.repoId !== undefined && this.#workspace.worktree !== undefined &&
        observedParent.repoId === this.#workspace.repoId && observedParent.worktree === this.#workspace.worktree &&
        (observedParent.parentBridge?.length ?? 0) < 32) {
      const parentBridge = [{ schemaVersion: 1 as const, sourceEventId, parentSourceEventId: event.parentId, eventType: eventType as NonNullable<RawEvent["parentBridge"]>[number]["eventType"], timestamp, sessionId: this.#sessionId,
        repoId: this.#workspace.repoId, worktree: this.#workspace.worktree, trust: "system" as const }, ...(observedParent.parentBridge ?? [])];
      if (this.#sourceEvents.size >= 4_096) { const oldest = this.#sourceEvents.keys().next().value; if (oldest !== undefined) this.#sourceEvents.delete(oldest); }
      this.#sourceEvents.set(sourceEventId, { ...observedParent, parentBridge });
      return { status: "ignored", reason: "ephemeral", eventType, sourceEventId };
    }
    const quality = newCaptureQuality();
    if (this.#workspacePending) quality.omittedFields.push("workspace.gitContext");
    if (typeof event.parentId === "string" && !this.#sourceEvents.has(event.parentId)) {
      quality.omittedFields.push("parentEventId");
    }
    const common = {
      ...this.#base(
        sourceEventId,
        eventType,
        timestamp,
        "system",
      ),
      captureQuality: quality,
      ...(observedParent?.parentBridge === undefined ? {} : { parentBridge: observedParent.parentBridge, originalParentSourceEventId: event.parentId as string }),
      ...(typeof event.parentId === "string"
        ? {
            parentEventId: this.#sourceEvents.get(event.parentId)?.eventId ?? event.parentId,
          }
        : {}),
      ...(typeof event.agentId === "string"
        ? {
            participantId: event.agentId,
          }
        : {}),
    };

    switch (eventType) {
      case "session.start": {
        const sessionId = requiredString(data, "sessionId", issues);
        const copilotVersion = requiredString(
          data,
          "copilotVersion",
          issues,
        );
        const fileVersion = data.version;
        if (!Number.isInteger(fileVersion)) {
          issues.push("version must be an integer.");
        }
        if (
          sessionId !== undefined &&
          sessionId.trim() !== this.#sessionId
        ) {
          issues.push(
            "session.start sessionId does not match the capture session.",
          );
        }
        if (
          copilotVersion !== undefined &&
          copilotVersion.trim() !== this.#adapterVersion
        ) {
          issues.push(
            "session.start copilotVersion does not match the adapter.",
          );
        }
        const context = asRecord(data.context);
        if (issues.length === 0) {
          this.updateWorkspace(this.#contextWorkspace(context));
        }
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...this.#base(
              sourceEventId,
              "session.started",
              timestamp,
              "system",
            ),
            protocol: "copilot-session-file",
            ...(Number.isInteger(fileVersion)
              ? {
                  protocolVersion: String(fileVersion),
                }
              : {}),
          },
        );
      }
      case "user.message": {
        const content = messageContent(
          data,
          this.#copyLimits,
          issues,
          quality,
        );
        const source = optionalString(data, "source");
        const autopilotContinuation =
          data.isAutopilotContinuation === true;
        const trust = userMessageTrust(data);
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType:
              trust === "user" &&
              isExplicitCorrectionMessage(content)
                ? "user.corrected"
                : "prompt.submitted",
            ...(source === undefined && !autopilotContinuation
              ? {}
              : {
                  actorId:
                    source ??
                    "copilot-autopilot-continuation",
                }),
            trust,
            ...(content === undefined
              ? {}
              : {
                  content: {
                    message: content,
                  },
                }),
          },
        );
      }
      case "tool.execution_start": {
        const toolCallId = requiredString(
          data,
          "toolCallId",
          issues,
        );
        const toolName = requiredString(data, "toolName", issues);
        if (toolCallId !== undefined && toolName !== undefined) {
          this.#toolNames.set(toolCallId, toolName);
        }
        const toolArguments = (mcp !== undefined || typeof data.mcpServerName === "string") ? copyMcpArguments(data.arguments, quality) : copyBoundedValue(
          data.arguments,
          this.#copyLimits,
          quality,
          "toolArguments",
        );
        if (issues.length === 0 && toolCallId !== undefined && toolName !== undefined) {
          if (this.#operations.size >= 256) {
            const oldest = this.#operations.keys().next().value;
            if (oldest !== undefined) {
              this.#operations.delete(oldest);
              this.#toolNames.delete(oldest);
            }
          }
          this.#operations.set(toolCallId, {
            sourceEventId,
            toolName,
            arguments: toolArguments,
            workspace: this.currentWorkspace(),
            truncated: quality.truncatedFields.some((path) =>
              /^toolArguments\.(?:command|cwd|path|file|filePath|filepath|target|targetPath|paths|files|targets|changedFiles|patch|input|shellId|mode)(?:\.|\[|$)/u.test(path),
            ),
            workspacePending: this.#workspacePending,
            builtinTool: data.mcpServerName === undefined && data.mcpToolName === undefined,
            ...(mcp === undefined ? {} : { mcp }),
            ...(() => {
              const parent = typeof event.parentId === "string" ? this.#sourceEvents.get(event.parentId) : undefined;
              return parent?.correctionEventId !== undefined &&
                parent.repoId === this.#workspace.repoId &&
                parent.worktree === this.#workspace.worktree
                ? { correctionEventId: parent.correctionEventId } : {};
            })(),
          });
        }
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "tool.started",
            ...(mcp === undefined ? {} : { mcp }),
            completionStatus: "running",
            ...(toolCallId === undefined
              ? {}
              : {
                  operationId: toolCallId,
                }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "tool",
            ...(toolArguments === undefined
              ? {}
              : {
                  content: {
                    toolArguments,
                  },
                }),
          },
        );
      }
      case "tool.execution_complete": {
        const toolCallId = requiredString(
          data,
          "toolCallId",
          issues,
        );
        const success = requiredBoolean(data, "success", issues);
        const started = toolCallId === undefined ? undefined : this.#operations.get(toolCallId);
        const completionMcp = mcp ?? started?.mcp;
        const toolName =
          toolCallId === undefined
            ? undefined
            : this.#toolNames.get(toolCallId);
        if (toolCallId !== undefined && success !== undefined && issues.length === 0) {
          this.#toolNames.delete(toolCallId);
          this.#operations.delete(toolCallId);
        }
        const toolResult = copyToolResult(
          data.result,
          this.#copyLimits,
          quality,
        );
        const error = copyError(
          data.error,
          this.#copyLimits,
          quality,
        );
        const shellTool = started !== undefined && /^(?:powershell|bash)$/u.test(started.toolName);
        const shellResult = shellTool && started?.builtinTool
          ? structuredShellResult(toolResult, quality) : undefined;
        const exitCode = shellResult?.exitCode;
        const model = optionalString(data, "model");
        const mapped = this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(completionMcp === undefined ? {} : { mcp: { ...completionMcp,
              ...(typeof asRecord(data.result).isError === "boolean" ? { isError: asRecord(data.result).isError as boolean } : {}) } }),
            eventType:
              success === false ? "tool.failed" : "tool.completed",
            completionStatus:
              success === false ? "failed" : "succeeded",
            ...(toolCallId === undefined
              ? {}
              : {
                  operationId: toolCallId,
                }),
            ...(toolName === undefined ? {} : { toolName }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "tool",
            ...(
              toolResult === undefined && error === undefined
                ? {}
                : {
                    content: {
                      ...(error === undefined ? {} : { error }),
                      ...(toolResult === undefined
                        ? {}
                        : {
                            toolResult,
                          }),
                    },
                  }
            ),
          },
        );
        if (mapped.status !== "mapped" || started === undefined) return mapped;
        const additionalEvents: CaptureEventInput[] = [];
        // Derived events point directly to this canonical completion, not its native parent.
        const derivedCommon = { ...common, parentBridge: undefined, originalParentSourceEventId: undefined };
        const args = recordOf(started.arguments);
        const command = typeof args.command === "string" ? args.command : undefined;
        const verification = command === undefined || started.truncated || !shellTool
          ? undefined
          : classifyVerificationCommand(command);
        const resultRecord = recordOf(toolResult);
        const reportedCwd = shellResult?.cwd;
        const cwdCandidate = typeof reportedCwd === "string" ? reportedCwd
          : args.shellId !== undefined ? undefined
          : typeof args.cwd === "string" ? args.cwd
          : started.workspace.cwd ?? started.workspace.worktree;
        const executionCwd = cwdCandidate === undefined ? undefined
          : resolveEvidenceDirectory(cwdCandidate, started.workspace.cwd ?? started.workspace.worktree);
        const resolvedTargets = resolveEvidencePaths(
          command === undefined ? [] : commandTargetPaths(command), executionCwd,
        );
        const targetPaths = resolvedTargets ?? [];
        const completedExecution = (args.mode === undefined || args.mode === "sync") &&
          (args.detach === undefined || args.detach === false);
        const completeDirectory = !quality.truncatedFields.some((path) =>
          /^toolResult\.contents\[\d+\]\.(?:cwd|shellId)$/u.test(path),
        );
        const sameRepository = pathsWithinWorkspace(
          [...targetPaths, ...(executionCwd === undefined ? [] : [executionCwd])], started.workspace.worktree,
        ) && executionCwd !== undefined && resolvedTargets !== undefined &&
          completedExecution && completeDirectory &&
          !started.workspacePending && !this.#workspacePending &&
          started.workspace.repositoryState === "known_repo" &&
          this.#workspace.repositoryState === "known_repo" &&
          started.workspace.repoId !== undefined &&
          started.workspace.repoId === this.#workspace.repoId &&
          started.workspace.branch === this.#workspace.branch &&
          started.workspace.commitSha === this.#workspace.commitSha;
        const proof: CaptureEvidence = {
          schemaVersion: 1,
          kind: "command_verification",
          repositoryState: sameRepository ? "known_repo" : "unknown",
          sourceStartEventId: started.sourceEventId,
          sourceCompleteEventId: sourceEventId,
          ...(toolCallId === undefined ? {} : { operationId: toolCallId }),
          targetPaths,
          ...(executionCwd === undefined ? {} : { workingDirectory: executionCwd }),
        };
        if (verification !== undefined) {
          if (exitCode === undefined) quality.omittedFields.push("verification.exitCode");
          if (!started.builtinTool) quality.omittedFields.push("verification.toolProvenance");
          if (!sameRepository) quality.omittedFields.push("verification.repositoryBinding");
          if (success === false && exitCode === 0) {
            quality.omittedFields.push("verification.conflictingOutcome");
          }
        }
        if (verification !== undefined && exitCode !== undefined && sameRepository &&
            !(success === false && exitCode === 0)) {
          additionalEvents.push({
            ...derivedCommon,
            ...started.workspace,
            eventType: verification.eventType,
            operationId: toolCallId,
            parentEventId: this.#sourceEvents.get(sourceEventId)?.eventId ?? sourceEventId,
            completionStatus: exitCode === 0 ? "succeeded" : "failed",
            exitCode,
            toolName: started.toolName,
            trust: "tool",
            evidence: { ...proof, commandFamily: verification.commandFamily, exitCode },
            ...(started.correctionEventId === undefined ? {} : {
              verificationBinding: {
                correctionEventId: started.correctionEventId,
                operationEventId: `event-${createCaptureDeduplicationKey({
                  adapter: "copilot-cli", adapterVersion: this.#adapterVersion,
                  sessionId: this.#sessionId, eventType: "tool.started",
                  sourceEventId: started.sourceEventId,
                })}`,
              },
            }),
            content: {
              toolArguments: {
                ...args as Readonly<Record<string, JsonValue>>,
                ...(executionCwd === undefined ? {} : { cwd: executionCwd }),
                sourceStartEventId: started.sourceEventId,
                sourceCompleteEventId: sourceEventId,
                commandFamily: verification.commandFamily,
                exitCode,
              },
              ...(toolResult === undefined ? {} : { toolResult }),
            },
          });
        }
        const nativeEdit = /^(?:edit|create|write_file|replace_string_in_file)$/u.test(started.toolName);
        const patch = typeof started.arguments === "string" ? started.arguments
          : typeof args.patch === "string" ? args.patch
          : typeof args.input === "string" ? args.input : undefined;
        const changedPaths = resolveEvidencePaths(evidencePaths({
          changedFiles: resultRecord.changedFiles,
          ...(started.toolName === "apply_patch" && patch !== undefined
            ? { paths: patchTargetPaths(patch) } : {}),
          ...(nativeEdit ? args : {}),
        }), executionCwd) ?? [];
        if (success === true && started.builtinTool && changedPaths.length > 0 && !started.truncated &&
            completedExecution && completeDirectory &&
            !quality.truncatedFields.some((path) => path.startsWith("toolResult.changedFiles")) &&
            pathsWithinWorkspace(changedPaths, started.workspace.worktree)) {
          additionalEvents.push({
            ...derivedCommon,
            ...started.workspace,
            eventType: "file.changed",
            operationId: toolCallId,
            parentEventId: this.#sourceEvents.get(sourceEventId)?.eventId ?? sourceEventId,
            completionStatus: "succeeded",
            trust: "tool",
            evidence: { ...proof, kind: "file_change", targetPaths: changedPaths },
            content: {
              message: changedPaths.join("\n"),
              toolArguments: { changedFiles: changedPaths },
            },
          });
        }
        return {
          ...mapped,
          ...(verification === undefined ? {} : {
            value: {
              ...mapped.value,
              evidence: {
                ...proof,
                commandFamily: verification.commandFamily,
                ...(exitCode === undefined ? {} : { exitCode }),
              },
            },
          }),
          additionalEvents,
        };
      }
      case "assistant.message": {
        const messageId = requiredString(
          data,
          "messageId",
          issues,
        );
        const content = messageContent(
          data,
          this.#copyLimits,
          issues,
          quality,
        );
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "agent.message",
            ...(Array.isArray(data.toolRequests) && data.toolRequests.length > 0
              ? { completionStatus: "running" as const } : {}),
            ...(messageId === undefined
              ? {}
              : {
                  operationId: messageId,
                }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "model",
            ...(content === undefined
              ? {}
              : {
                  content: {
                    message: content,
                  },
                }),
          },
        );
      }
      case "assistant.turn_start":
      case "assistant.turn_end": {
        const turnId = requiredString(data, "turnId", issues);
        const model = optionalString(data, "model");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: eventType === "assistant.turn_start" ? "agent.turn_started" : "agent.turn_completed",
            completionStatus: eventType === "assistant.turn_start" ? "running" : "succeeded",
            ...(turnId === undefined ? {} : { operationId: turnId }),
            ...(model === undefined ? {} : { resolvedModel: model }),
            trust: "model",
          },
        );
      }
      case "session.idle":
        return this.#mappedOrMalformed([], eventType, sourceEventId, {
            ...common,
            eventType: "session.idle",
            trust: "system",
            ...(data.aborted === true
              ? {
                  completionStatus: "cancelled",
                }
              : {}),
          });
      case "session.error": {
        const errorType = requiredString(
          data,
          "errorType",
          issues,
        );
        const message = requiredString(data, "message", issues);
        const statusCode = optionalFiniteNumber(data, "statusCode");
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "session.error",
            completionStatus: "failed",
            ...(optionalString(data, "providerCallId") === undefined
              ? {}
              : {
                  operationId: optionalString(
                    data,
                    "providerCallId",
                  ),
                }),
            trust: "system",
            ...(
              errorType === undefined || message === undefined
                ? {}
                : {
                    content: {
                      error: {
                        ...(statusCode === undefined
                          ? {}
                          : {
                              code: String(statusCode),
                            }),
                        message: boundedText(message, this.#copyLimits.maxStringChars, quality, "error.message"),
                        name: boundedText(errorType, this.#copyLimits.maxStringChars, quality, "error.name"),
                      },
                    },
                  }
            ),
          },
        );
      }
      case "session.context_changed": {
        requiredString(data, "cwd", issues);
        if (data.pendingGitContext === true) {
          const next = this.#contextWorkspace(data);
          this.#workspacePending = true;
          quality.omittedFields.push("workspace.gitContext");
          this.#workspace = normalizedWorkspace({
            ...(next.cwd === undefined ? {} : { cwd: next.cwd }),
            ...(next.workflowScopeId === undefined ? {} : { workflowScopeId: next.workflowScopeId }),
            ...(next.worktree === undefined ? {} : { worktree: next.worktree }),
            ...(next.repoId === undefined ? {} : { repoId: next.repoId }),
            repositoryState: next.repositoryState ?? "unknown",
          });
          return this.#mappedOrMalformed(
            issues,
            eventType,
            sourceEventId,
            {
              ...this.#base(sourceEventId, eventType, timestamp, "system"),
              captureQuality: quality,
              ...(typeof event.parentId === "string"
                ? { parentEventId: this.#sourceEvents.get(event.parentId)?.eventId ?? event.parentId } : {}),
            },
            "unsupported",
          );
        }
        const snapshot = this.#contextWorkspace(data);
        if (issues.length === 0) {
          this.updateWorkspace(snapshot);
        }
        const updatedCommon = {
          ...this.#base(
            sourceEventId,
            eventType,
            timestamp,
            "system",
          ),
          ...(typeof event.parentId === "string"
            ? {
                parentEventId: this.#sourceEvents.get(event.parentId)?.eventId ?? event.parentId,
              }
            : {}),
          ...(typeof event.agentId === "string"
            ? {
                participantId: event.agentId,
              }
            : {}),
        };
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...updatedCommon,
            eventType,
          },
          "unsupported",
        );
      }
      case "session.shutdown": {
        const rawShutdownType = requiredString(
          data,
          "shutdownType",
          issues,
        );
        const shutdownType =
          rawShutdownType === "routine" || rawShutdownType === "error"
            ? rawShutdownType
            : undefined;
        if (
          rawShutdownType !== undefined &&
          shutdownType === undefined
        ) {
          issues.push(
            "shutdownType must be either routine or error.",
          );
        }
        const codeChangesRecord = asRecord(data.codeChanges);
        const filesModified = Array.isArray(
          codeChangesRecord.filesModified,
        )
          ? codeChangesRecord.filesModified.length
          : undefined;
        const linesAdded = optionalFiniteNumber(
          codeChangesRecord,
          "linesAdded",
        );
        const linesRemoved = optionalFiniteNumber(
          codeChangesRecord,
          "linesRemoved",
        );
        const codeChanges: JsonValue | undefined =
          filesModified === undefined &&
          linesAdded === undefined &&
          linesRemoved === undefined
            ? undefined
            : {
                ...(filesModified === undefined
                  ? {}
                  : { filesModified }),
                ...(linesAdded === undefined ? {} : { linesAdded }),
                ...(linesRemoved === undefined
                  ? {}
                  : { linesRemoved }),
              };
        return this.#mappedOrMalformed(
          issues,
          eventType,
          sourceEventId,
          {
            ...common,
            eventType: "session.ended",
            completionStatus:
              shutdownType === "error" ? "failed" : "succeeded",
            ...(optionalString(data, "currentModel") === undefined
              ? {}
              : {
                  resolvedModel: optionalString(
                    data,
                    "currentModel",
                  ),
                }),
            trust: "system",
            ...(
              codeChanges === undefined &&
              optionalString(data, "errorReason") === undefined
                ? {}
                : {
                    content: {
                      ...(optionalString(data, "errorReason") ===
                      undefined
                        ? {}
                        : {
                            error: boundedText(
                              optionalString(data, "errorReason") ?? "",
                              this.#copyLimits.maxStringChars,
                              quality,
                              "error",
                            ),
                          }),
                      ...(codeChanges === undefined
                        ? {}
                        : {
                            toolResult: {
                              codeChanges,
                              shutdownType:
                                shutdownType ?? "unknown",
                            },
                          }),
                    },
                  }
            ),
          },
        );
      }
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        return this.#mapSubagent(
          common,
          data,
          eventType,
          sourceEventId,
          issues,
        );
      default:
        if (
          event.ephemeral === true ||
          intentionallyIgnoredEventTypes.has(eventType)
        ) {
          return {
            status: "ignored",
            eventType,
            reason: "ephemeral",
            sourceEventId,
          };
        }
        return this.#mappedOrMalformed([], eventType, sourceEventId, {
          ...common,
          eventType: canonicalEventTypes.has(eventType)
            ? `copilot.unmapped.${eventType}` : eventType,
        }, "unsupported");
    }
  }

  #mapSubagent(
    common: CaptureEventInput,
    data: Readonly<Record<string, unknown>>,
    eventType:
      | "subagent.completed"
      | "subagent.failed"
      | "subagent.started",
    sourceEventId: string,
    issues: string[],
  ): CopilotEventMappingResult {
    const toolCallId = requiredString(data, "toolCallId", issues);
    const agentName = requiredString(data, "agentName", issues);
    const model = optionalString(data, "model");
    const error =
      eventType === "subagent.failed"
        ? requiredString(data, "error", issues)
        : undefined;
    const cancelled =
      eventType === "subagent.completed" &&
      data.cancelled === true;
    const durationMs = optionalFiniteNumber(data, "durationMs");
    const totalTokens = optionalFiniteNumber(data, "totalTokens");
    const totalToolCalls = optionalFiniteNumber(
      data,
      "totalToolCalls",
    );
    const metrics: JsonValue | undefined =
      durationMs === undefined &&
      totalTokens === undefined &&
      totalToolCalls === undefined
        ? undefined
        : {
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(totalToolCalls === undefined
              ? {}
              : { totalToolCalls }),
          };
    return this.#mappedOrMalformed(
      issues,
      eventType,
      sourceEventId,
      {
        ...common,
        eventType,
        ...(toolCallId === undefined
          ? {}
          : {
              operationId: toolCallId,
            }),
        ...(agentName === undefined
          ? {}
          : {
              participantId: common.participantId ?? agentName,
              toolName: `subagent:${agentName}`,
            }),
        ...(eventType === "subagent.started"
          ? {
              completionStatus: "running" as const,
              ...(model === undefined
                ? {}
                : {
                    requestedModel: model,
                  }),
            }
          : {
              completionStatus:
                eventType === "subagent.failed"
                  ? "failed" as const
                  : cancelled
                    ? "cancelled" as const
                    : "succeeded" as const,
              ...(model === undefined
                ? {}
                : {
                    resolvedModel: model,
                  }),
            }),
        trust: "model",
        ...(
          error === undefined && metrics === undefined
            ? {}
            : {
                content: {
                  ...(error === undefined ? {} : {
                    error: boundedText(
                      error, this.#copyLimits.maxStringChars,
                      common.captureQuality ?? newCaptureQuality(), "error",
                    ),
                  }),
                  ...(metrics === undefined
                    ? {}
                    : {
                        toolResult: metrics,
                      }),
                },
              }
        ),
      },
    );
  }

  #base(
    sourceEventId: string,
    eventType: string,
    timestamp: string,
    trust: RawEvent["trust"],
  ): CaptureEventInput {
    return {
      adapter: "copilot-cli",
      adapterVersion: this.#adapterVersion,
      eventType,
      sessionId: this.#sessionId,
      sourceEventId,
      timestamp,
      trust,
      ...this.#workspace,
    };
  }

  #contextWorkspace(context: Readonly<Record<string, unknown>>): CopilotWorkspaceSnapshot {
    const cwd = optionalString(context, "cwd");
    const worktree = optionalString(context, "gitRoot") ?? cwd;
    const comparable = (value: string): string =>
      value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
    const sameWorktree = worktree !== undefined && this.#workspace.worktree !== undefined &&
      comparable(worktree) === comparable(this.#workspace.worktree);
    const explicitlyOutside = context.gitRoot === null && context.repository === null;
    const repoId = explicitlyOutside ? undefined
      : (sameWorktree ? this.#workspace.repoId : undefined) ??
        optionalString(context, "repository");
    const branch = optionalString(context, "branch");
    const commitSha = optionalString(context, "headCommit");
    const workflowScopeId = context.workflowScopeId === null ? undefined
      : optionalString(context, "workflowScopeId") ?? this.#workspace.workflowScopeId;
    return normalizedWorkspace({
      ...(cwd === undefined ? {} : { cwd }),
      ...(workflowScopeId === undefined ? {} : { workflowScopeId }),
      ...(worktree === undefined ? {} : { worktree }),
      ...(repoId === undefined ? {} : { repoId }),
      ...(branch === undefined ? {} : { branch }),
      ...(commitSha === undefined ? {} : { commitSha }),
      repositoryState: explicitlyOutside ? "known_outside_repo"
        : repoId !== undefined && (optionalString(context, "repository") !== undefined ||
          this.#workspace.repositoryState === "known_repo") ? "known_repo" : "unknown",
    });
  }

  #mappedOrMalformed(
    issues: readonly string[],
    eventType: string,
    sourceEventId: string,
    value: CaptureEventInput,
    validStatus: "mapped" | "unsupported" = "mapped",
  ): CopilotEventMappingResult {
    if (issues.length === 0) {
      const parent = value.parentEventId === undefined
        ? undefined : this.#canonicalSourceEvents.get(value.parentEventId);
      const eventId = `event-${createCaptureDeduplicationKey(value)}`;
      const correctionEventId = value.eventType === "user.corrected" && value.trust === "user"
        ? eventId
        : value.trust !== "user" &&
          parent?.repoId === value.repoId && parent?.worktree === value.worktree
          ? parent?.correctionEventId : undefined;
      if (this.#sourceEvents.size >= 4_096) {
        const oldest = this.#sourceEvents.keys().next().value;
        if (oldest !== undefined) {
          const removed = this.#sourceEvents.get(oldest);
          if (removed !== undefined) this.#canonicalSourceEvents.delete(removed.eventId);
          this.#sourceEvents.delete(oldest);
        }
      }
      const previous = this.#sourceEvents.get(sourceEventId);
      if (previous !== undefined) this.#canonicalSourceEvents.delete(previous.eventId);
      const context = {
        eventId, correctionEventId, repoId: value.repoId, worktree: value.worktree,
      };
      this.#sourceEvents.set(sourceEventId, context);
      this.#canonicalSourceEvents.set(eventId, context);
      return {
          status: validStatus,
          value,
        };
    }
    return {
          status: "malformed",
          eventType,
          issues,
          sourceEventId,
        };
  }
}
