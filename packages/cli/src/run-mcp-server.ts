import {
  randomUUID,
} from "node:crypto";
import {
  access,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import type {
  Readable,
  Writable,
} from "node:stream";

import {
  CopilotCliAdapter,
  assertCopilotAdapterDataRoot,
  readCopilotAdapterState,
  readInternalSessionIds,
  readTrustedSessionContext,
  type TrustedSessionContext,
} from "@provenloop/copilot-adapter";
import {
  PROVENLOOP_VERSION,
  CURRENT_SCHEMA_VERSION,
  type Scope,
  type SessionIdentity,
} from "@provenloop/contracts";
import {
  sanitizeDiagnostic,
  sha256,
  isProvenLoopInternalEnvironment,
} from "@provenloop/domain";
import {
  isUpgradeMaintenanceActive,
  isExtensionShutdownRequested,
  registerActiveExtension,
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  ContextRetrievalService,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_CONTEXT_TOKENS,
  MAX_SEARCH_TOKENS,
  SqliteFtsKnowledgeBackend,
  knowledgeProjectionFromCandidate,
  type ContextExplanation,
  type ContextFeedbackAction,
  type ContextFeedbackRequest,
  type ContextFeedbackResponse,
  type ContextRequest,
  type ContextSearchRequest,
  type ContextResponse,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";
import { PROVENLOOP_CODE_VERSION } from "./release-metadata.js";
import {
  appendMcpIdentityDiagnostic,
  describeMcpIdentityFailure,
  type McpIdentityDiagnostic,
  type McpIdentityReason,
} from "./mcp-identity-diagnostics.js";

interface JsonRpcRequest {
  readonly id?: number | string | null;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

interface ToolCall {
  readonly arguments: unknown;
  readonly name: string;
}

export interface McpServerIo {
  readonly input: Readable;
  readonly output: Writable;
}

type McpExplainRequest = {
  readonly explanationRef: string;
  readonly sessionId: string;
} & Partial<Pick<ContextRequest, "cwd" | "repoId" | "branch" | "headSha" | "trustedWorkspace" | "workflowScopeId">>;

export interface McpToolHandlers {
  context(request: ContextRequest): Promise<ContextResponse>;
  search?(request: ContextSearchRequest): Promise<ContextResponse>;
  unavailableContext?(
    request: ContextRequest,
    detail: string,
  ): Promise<ContextResponse>;
  explain(request: McpExplainRequest): Promise<ContextExplanation>;
  feedback(
    request: ContextFeedbackRequest,
  ): Promise<ContextFeedbackResponse>;
}

export interface McpServerOptions {
  readonly lifecycle?: boolean;
  readonly cwd?: string;
  readonly dataRoot?: string;
  readonly handlers?: McpToolHandlers;
  readonly now?: () => Date;
  readonly sessionId?: string;
  readonly workflowScopeId?: string;
  readonly resolveTrustedContext?: () => Promise<TrustedMcpContext | undefined>;
}

export type TrustedMcpContext = TrustedSessionContext;

const trustedWorkspace = (
  context: TrustedMcpContext,
): NonNullable<ContextRequest["trustedWorkspace"]> => ({
  repositoryState: context.repositoryState,
  repositoryObservedAt: context.repositoryObservedAt,
  ...(context.repositoryState !== "known_repo" ? {} : {
    ...(context.repositoryId === undefined ? {} : { repositoryId: context.repositoryId }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.commitSha === undefined ? {} : { commitSha: context.commitSha }),
  }),
});

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 12;
const SEARCH_PURPOSES = [
  "fact", "constraint", "lesson", "procedure", "rationale",
] as const;

const send = (
  output: Writable,
  message: Readonly<Record<string, unknown>>,
): void => {
  output.write(`${JSON.stringify(message)}\n`);
};

const respond = (
  output: Writable,
  id: JsonRpcRequest["id"],
  result: unknown,
): void => {
  send(output, {
    id: id ?? null,
    jsonrpc: "2.0",
    result,
  });
};

const fail = (
  output: Writable,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): void => {
  send(output, {
    error: {
      code,
      message,
    },
    id: id ?? null,
    jsonrpc: "2.0",
  });
};

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const nonEmptyString = (
  input: unknown,
): string | undefined =>
  typeof input === "string" && input.trim().length > 0
    ? input.trim()
    : undefined;

const optionalString = (
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined =>
  input[key] === undefined
    ? undefined
    : nonEmptyString(input[key]);

const hasOnlyKeys = (
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(input).every((key) => allowed.has(key));
};

const asRequest = (input: unknown): JsonRpcRequest | undefined => {
  const id = isRecord(input) ? input.id : undefined;
  if (
    !isRecord(input) ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string" ||
    (
      id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    )
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    method: input.method,
    ...(id === undefined
      ? {}
      : {
          id,
        }),
    ...(input.params === undefined
      ? {}
      : {
          params: input.params,
        }),
  };
};

const asToolCall = (input: unknown): ToolCall | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const name = nonEmptyString(input.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    arguments: input.arguments ?? {},
    name,
  };
};

const stringList = (
  input: unknown,
): readonly string[] | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(input) ||
    input.some(
      (value) =>
        typeof value !== "string" ||
        value.trim().length === 0,
    )
  ) {
    return undefined;
  }
  return input.map((value) => value.trim());
};

const parseContextRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): ContextRequest | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "fileHints",
      "prompt",
      "tokenBudget",
      "continuationEpisodeId",
    ])
  ) {
    return undefined;
  }
  const prompt = nonEmptyString(input.prompt);
  const fileHints = stringList(input.fileHints);
  const continuationEpisodeId = input.continuationEpisodeId === undefined ? undefined : nonEmptyString(input.continuationEpisodeId);
  if (
    prompt === undefined ||
    (input.continuationEpisodeId !== undefined && (continuationEpisodeId === undefined || continuationEpisodeId.length > 256)) ||
    typeof input.tokenBudget !== "number" ||
    !Number.isInteger(input.tokenBudget) ||
    input.tokenBudget <= 0 ||
    input.tokenBudget > MAX_CONTEXT_TOKENS ||
    (
      input.fileHints !== undefined &&
      fileHints === undefined
    )
  ) {
    return undefined;
  }
  return {
    cwd: trusted.cwd,
    ...(continuationEpisodeId === undefined ? {} : { continuationEpisodeId }),
    ...(fileHints === undefined
      ? {}
      : {
          fileHints,
        }),
    prompt,
    sessionId: trusted.sessionId,
    tokenBudget: input.tokenBudget,
    trustedWorkspace: trustedWorkspace(trusted),
    ...(trusted.workflowScopeId === undefined
      ? {}
      : {
          workflowScopeId: trusted.workflowScopeId,
        }),
  };
};

const boundedStringList = (
  input: unknown,
  maxItems: number,
  maxLength: number,
): readonly string[] | undefined => {
  if (!Array.isArray(input) || input.length > maxItems || input.some(
    (value) => typeof value !== "string" || value.length > maxLength,
  )) return undefined;
  return stringList(input);
};

const parseSearchRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): ContextSearchRequest | undefined => {
  if (
    !isRecord(input) || input.protocolVersion !== 1 ||
    !hasOnlyKeys(input, [
      "protocolVersion", "prompt", "fileHints", "alternateQueries",
      "conceptHints", "entityHints", "purposes", "topics", "limit", "tokenBudget",
    ])
  ) return undefined;
  const prompt = nonEmptyString(input.prompt);
  const fileHints = boundedStringList(input.fileHints, 16, 512);
  const alternateQueries = boundedStringList(input.alternateQueries, 3, 2_000);
  const conceptHints = boundedStringList(input.conceptHints, 8, 128);
  const entityHints = boundedStringList(input.entityHints, 16, 256);
  const purposes = boundedStringList(input.purposes, SEARCH_PURPOSES.length, 32);
  const topics = boundedStringList(input.topics, 8, 128);
  const limit = input.limit === undefined ? SEARCH_DEFAULT_LIMIT : input.limit;
  const tokenBudget = input.tokenBudget === undefined ? MAX_SEARCH_TOKENS : input.tokenBudget;
  if (
    prompt === undefined || (input.prompt as string).length > 12_000 ||
    typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT ||
    typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > MAX_SEARCH_TOKENS ||
    (input.fileHints !== undefined && fileHints === undefined) ||
    (input.alternateQueries !== undefined && alternateQueries === undefined) ||
    (input.conceptHints !== undefined && conceptHints === undefined) ||
    (input.entityHints !== undefined && entityHints === undefined) ||
    (input.purposes !== undefined && purposes === undefined) ||
    (input.topics !== undefined && topics === undefined) ||
    purposes?.some((purpose) => !SEARCH_PURPOSES.some((allowed) => allowed === purpose))
  ) return undefined;
  return {
    protocolVersion: 1,
    cwd: trusted.cwd,
    prompt,
    sessionId: trusted.sessionId,
    limit,
    tokenBudget,
    trustedWorkspace: trustedWorkspace(trusted),
    ...(trusted.workflowScopeId === undefined ? {} : { workflowScopeId: trusted.workflowScopeId }),
    ...(fileHints === undefined ? {} : { fileHints }),
    ...(alternateQueries === undefined ? {} : { alternateQueries }),
    ...(conceptHints === undefined ? {} : { conceptHints }),
    ...(entityHints === undefined ? {} : { entityHints }),
    ...(purposes === undefined ? {} : { purposes: purposes as NonNullable<ContextSearchRequest["purposes"]> }),
    ...(topics === undefined ? {} : { topics }),
  };
};

const parseExplainRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): McpExplainRequest | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "explanationRef",
    ])
  ) {
    return undefined;
  }
  const explanationRef = nonEmptyString(input.explanationRef);
  return explanationRef === undefined
    ? undefined
      : {
        cwd: trusted.cwd,
        explanationRef,
        sessionId: trusted.sessionId,
        trustedWorkspace: trustedWorkspace(trusted),
        ...(trusted.workflowScopeId === undefined ? {} : { workflowScopeId: trusted.workflowScopeId }),
      };
};

const feedbackActions = new Set<ContextFeedbackAction>([
  "confirm",
  "helpful",
  "irrelevant",
  "mute_session",
  "revoke",
  "set_scope",
  "stale",
  "wrong",
]);

const scopes = new Set<Scope>([
  "branch",
  "personal",
  "repository",
  "workflow",
]);

const parseFeedbackRequest = (
  input: unknown,
  trusted: TrustedMcpContext,
): ContextFeedbackRequest | undefined => {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "action",
      "reason",
      "requestId",
      "resolvesEvidenceIds",
      "scope",
      "targetId",
      "targetRef",
      "userReportedApplied",
    ])
  ) {
    return undefined;
  }
  const action =
    typeof input.action === "string" &&
    feedbackActions.has(input.action as ContextFeedbackAction)
      ? input.action as ContextFeedbackAction
      : undefined;
  const requestId = nonEmptyString(input.requestId);
  const resolvesEvidenceIds = stringList(input.resolvesEvidenceIds);
  const targetRef = input.targetRef;
  const targetKind = isRecord(targetRef) &&
    hasOnlyKeys(targetRef, ["kind", "id"]) &&
    (targetRef.kind === "knowledge" || targetRef.kind === "branch_context")
    ? targetRef.kind
    : undefined;
  const targetId = targetKind === undefined
    ? nonEmptyString(input.targetId)
    : nonEmptyString((targetRef as Readonly<Record<string, unknown>>).id);
  const reason = optionalString(input, "reason");
  const scope =
    typeof input.scope === "string" &&
    scopes.has(input.scope as Scope)
      ? input.scope as Scope
      : undefined;
  if (
    action === undefined ||
    requestId === undefined ||
    targetId === undefined ||
    (input.resolvesEvidenceIds !== undefined && (
      resolvesEvidenceIds === undefined || action !== "confirm"
    )) ||
    (input.targetRef !== undefined && targetKind === undefined) ||
    (input.targetRef !== undefined && input.targetId !== undefined) ||
    (input.userReportedApplied !== undefined &&
      typeof input.userReportedApplied !== "boolean") ||
    (
      input.reason !== undefined &&
      reason === undefined
    ) ||
    (
      input.scope !== undefined &&
      scope === undefined
    ) ||
    (
      action === "set_scope" &&
      scope === undefined
    ) ||
    (
      action !== "set_scope" &&
      scope !== undefined
    )
  ) {
    return undefined;
  }
  return {
    action,
    cwd: trusted.cwd,
    ...(reason === undefined
      ? {}
      : {
          reason,
        }),
    requestId,
    ...(resolvesEvidenceIds === undefined ? {} : {
      resolvesEvidenceIds: [...new Set(resolvesEvidenceIds)].sort(),
    }),
    ...(scope === undefined
      ? {}
      : {
          scope,
        }),
    sessionId: trusted.sessionId,
    targetId,
    trustedWorkspace: trustedWorkspace(trusted),
    ...(targetKind === undefined ? {} : { targetKind }),
    ...(trusted.workflowScopeId === undefined ? {} : {
      workflowScopeId: trusted.workflowScopeId,
    }),
    ...(input.userReportedApplied === undefined ? {} : {
      userReportedApplied: input.userReportedApplied as boolean,
    }),
  };
};

const tools = [
  {
    description:
      "At the start of a new coding task or a resumed task, retrieve scoped local guidance once. Do not repeat unchanged guidance for every turn. Returns at most three items within an estimated rendered token budget.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        continuationEpisodeId: { type: "string", maxLength: 256, description: "The known episode ID only when explicitly continuing that work. Other tasks do not receive its temporary constraints." },
        fileHints: {
          items: {
            type: "string",
          },
          type: "array",
        },
        prompt: {
          type: "string",
        },
        tokenBudget: {
          maximum: MAX_CONTEXT_TOKENS,
          minimum: 1,
          type: "integer",
        },
      },
      required: [
        "prompt",
        "tokenBudget",
      ],
      type: "object",
    },
    name: "provenloop_context",
  },
  {
    description:
      "Search past experience when the current task needs more depth than automatic context. Returns ranked summaries, applicability conditions, and recorded source references. May return previously shown items. Search hints never change the host-provided workspace or scope.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        protocolVersion: { const: 1, type: "integer" },
        prompt: { type: "string", minLength: 1, maxLength: 12_000 },
        alternateQueries: {
          description: "Alternate phrasings of the same task. Preserve its negation and conditions.",
          type: "array", maxItems: 3,
          items: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        conceptHints: {
          description: "Relevant concept names or IDs used as search hints.",
          type: "array", maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        entityHints: {
          description: "Exact identifiers, system names, commands, or errors. Keep significant spelling and case.",
          type: "array", maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 256 },
        },
        fileHints: {
          type: "array", maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        purposes: {
          description: "Optional explicit browse filter; omit to include unclassified experience.",
          type: "array", maxItems: SEARCH_PURPOSES.length,
          items: { type: "string", enum: SEARCH_PURPOSES },
        },
        topics: {
          description: "Optional explicit topic-ID browse filter; omit for relevance search.",
          type: "array", maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        limit: {
          type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, default: SEARCH_DEFAULT_LIMIT,
        },
        tokenBudget: {
          type: "integer", minimum: 1, maximum: MAX_SEARCH_TOKENS, default: MAX_SEARCH_TOKENS,
        },
      },
      required: ["protocolVersion", "prompt"],
      type: "object",
    },
    name: "provenloop_search",
  },
  {
    description:
      "Explain provenance, applicability, lifecycle state, and contradictions for a previously returned item.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        explanationRef: {
          type: "string",
        },
      },
      required: [
        "explanationRef",
      ],
      type: "object",
    },
    name: "provenloop_explain",
  },
  {
    description:
      "Propose feedback on previously returned Knowledge or Branch Context. Persistent feedback requires the real user's exact approval of the returned confirmation code; never approve on the user's behalf.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        action: {
          enum: [
            "helpful",
            "irrelevant",
            "wrong",
            "stale",
            "confirm",
            "revoke",
            "mute_session",
            "set_scope",
          ],
          type: "string",
        },
        reason: {
          type: "string",
        },
        requestId: {
          type: "string",
        },
        resolvesEvidenceIds: {
          description: "For explicit confirmation only: the counterevidence IDs the user has reviewed and is resolving. Ordinary confirmation does not clear other or newer counterevidence.",
          items: { type: "string" },
          type: "array",
        },
        scope: {
          enum: [
            "branch",
            "repository",
            "workflow",
            "personal",
          ],
          type: "string",
        },
        targetId: {
          type: "string",
        },
        targetRef: {
          additionalProperties: false,
          properties: {
            kind: { enum: ["knowledge", "branch_context"], type: "string" },
            id: { type: "string" },
          },
          required: ["kind", "id"],
          type: "object",
        },
        userReportedApplied: {
          description: "True only if the user explicitly reports actually applying this item; helpful alone does not mean applied.",
          type: "boolean",
        },
      },
      required: [
        "action",
        "requestId",
      ],
      oneOf: [
        { required: ["targetRef"] },
        { required: ["targetId"] },
      ],
      type: "object",
    },
    name: "provenloop_feedback",
  },
] as const;

const toolResult = (
  output: Writable,
  id: JsonRpcRequest["id"],
  result: unknown,
): void => {
  respond(output, id, {
    content: [
      {
        text: JSON.stringify(result),
        type: "text",
      },
    ],
    structuredContent: result,
  });
};

const toolError = (
  output: Writable,
  id: JsonRpcRequest["id"],
  error: unknown,
): void => {
  const message = sanitizeDiagnostic(error);
  respond(output, id, {
    content: [
      {
        text: message,
        type: "text",
      },
    ],
    isError: true,
  });
};

const MCP_WRITE_RESERVE_MS = 25;

const withDeadline = async <T>(
  operation: Promise<T>,
  deadline: number,
  message: string,
): Promise<T> => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(message);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

export class LocalMcpToolHandlers implements McpToolHandlers {
  readonly #adapter: CopilotCliAdapter;
  readonly #cwd: string;
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #workflowScopeId: string | undefined;

  public constructor(options: {
    readonly cwd: string;
    readonly dataRoot: string;
    readonly now: () => Date;
    readonly workflowScopeId?: string;
  }) {
    this.#cwd = options.cwd;
    this.#dataRoot = options.dataRoot;
    this.#now = options.now;
    this.#workflowScopeId = options.workflowScopeId;
    this.#adapter = new CopilotCliAdapter({
      dataRoot: options.dataRoot,
      now: options.now,
    });
  }

  public async context(
    request: ContextRequest,
  ): Promise<ContextResponse> {
    return this.#retrieve(request, "context");
  }

  public async search(
    request: ContextSearchRequest,
  ): Promise<ContextResponse> {
    return this.#retrieve(request, "search");
  }

  async #retrieve(
    request: ContextRequest | ContextSearchRequest,
    mode: "context" | "search",
  ): Promise<ContextResponse> {
    const startedAt = Date.now();
    const deadline =
      startedAt + (mode === "search" ? DEFAULT_SEARCH_TIMEOUT_MS : DEFAULT_CONTEXT_TIMEOUT_MS);
    try {
      await this.#assertNotUpgrading();
      const state = await this.#state();
      if (await this.#isInternalSession(request.sessionId)) {
        return {
          items: [],
          retrievalMode: mode,
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId: `context-${randomUUID()}`,
          status: "muted",
          statusDetail: "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      if (!state.capabilities.retrieval.enabled) {
        const requestId = `context-${randomUUID()}`;
        let recorded = false;
        let store: CanonicalSqliteStore | undefined;
        let observationLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
        try {
          const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
          observationLease = await this.#acquireKnowledgeLease();
          await access(paths.database);
          store = new CanonicalSqliteStore(paths.database, {
            busyTimeoutMs: MCP_WRITE_RESERVE_MS,
          });
          recorded = store.appendContextUseRecord({
            schemaVersion: CURRENT_SCHEMA_VERSION,
            appliedKnowledgeIds: [],
            candidateKnowledgeIds: [],
            codeVersion: PROVENLOOP_CODE_VERSION,
            createdAt: this.#now().toISOString(),
            latencyMs: Date.now() - startedAt,
            renderedTokens: 0,
            requestId,
            retrievalMode: mode,
            retrievalStatus: "disabled",
            returnedKnowledgeIds: [],
            sessionId: request.sessionId,
            ...(request.trustedWorkspace?.repositoryState !== "known_repo" ? {} : {
              ...(request.trustedWorkspace.repositoryId === undefined ? {} : {
                repoId: request.trustedWorkspace.repositoryId,
              }),
              ...(request.trustedWorkspace.branch === undefined ? {} : {
                branch: request.trustedWorkspace.branch,
              }),
            }),
          });
        } catch {
          recorded = false;
        } finally {
          try { store?.close(); } finally { await observationLease?.release(); }
        }
        return {
          items: [],
          retrievalMode: mode,
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId,
          status: "degraded",
          statusDetail: recorded
            ? "Retrieval capability is disabled."
            : "Retrieval capability is disabled; its observation could not be persisted.",
        };
      }
      const identity = await withDeadline(
        this.#resolveSessionIdentity(
          request,
          state.detectedCopilotVersion ?? "unknown",
        ),
        deadline - MCP_WRITE_RESERVE_MS,
        "Retrieval deadline expired while resolving repository identity.",
      );
      if (identity.internalSession) {
        return {
          items: [],
          retrievalMode: mode,
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId: `context-${randomUUID()}`,
          status: "muted",
          statusDetail:
            "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      const contextLease = await this.#acquireKnowledgeLease();
      try {
        const {
          repoId: suppliedRepositoryId,
          branch: suppliedBranch,
          headSha: suppliedHead,
          ...unscopedRequest
        } = request;
        void suppliedRepositoryId;
        void suppliedBranch;
        void suppliedHead;
        return await this.#withService((service) => {
          const scopedRequest = {
            ...unscopedRequest,
            now: this.#now(),
            ...(identity.branch === undefined
              ? {}
              : {
                  branch: identity.branch,
                }),
            ...(identity.commitSha === undefined
              ? {}
              : {
                  headSha: identity.commitSha,
                }),
            ...(identity.repositoryId === undefined
              ? {}
              : {
                  repoId: identity.repositoryId,
                }),
          };
          return mode === "search"
            ? service.search({ ...scopedRequest, protocolVersion: 1 })
            : service.context(scopedRequest);
        }, deadline, true);
      } finally {
        await contextLease.release();
      }
    } catch (error) {
      return {
        items: [],
        retrievalMode: mode,
        latencyMs: Date.now() - startedAt,
        renderedTokens: 0,
        requestId: `context-${randomUUID()}`,
        status: "degraded",
        statusDetail: sanitizeDiagnostic(error),
      };
    }
  }

  public async unavailableContext(
    request: ContextRequest,
    detail: string,
  ): Promise<ContextResponse> {
    const startedAt = Date.now();
    const requestId = `context-${randomUUID()}`;
    const retrievalMode = "protocolVersion" in request && request.protocolVersion === 1 ? "search" : "context";
    let store: CanonicalSqliteStore | undefined;
    let observationLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let statusDetail = detail;
    try {
      await this.#assertNotUpgrading();
      const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
      await assertCopilotAdapterDataRoot(paths);
      if (await this.#isInternalSession(request.sessionId)) {
        return {
          items: [],
          retrievalMode,
          latencyMs: Date.now() - startedAt,
          renderedTokens: 0,
          requestId,
          status: "muted",
          statusDetail: "ProvenLoop internal sessions do not receive retrieval context.",
        };
      }
      observationLease = await this.#acquireKnowledgeLease();
      await access(paths.database);
      store = new CanonicalSqliteStore(paths.database, { busyTimeoutMs: MCP_WRITE_RESERVE_MS });
      store.appendContextUseRecord({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliedKnowledgeIds: [],
        candidateKnowledgeIds: [],
        codeVersion: PROVENLOOP_CODE_VERSION,
        createdAt: this.#now().toISOString(),
        latencyMs: Date.now() - startedAt,
        renderedTokens: 0,
        requestId,
        retrievalMode,
        retrievalStatus: "degraded",
        returnedKnowledgeIds: [],
        sessionId: request.sessionId,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("upgrade maintenance")) statusDetail = error.message;
      // An unavailable canonical store must not turn a degraded read into a successful one.
    } finally {
      try { store?.close(); } finally { await observationLease?.release(); }
    }
    return {
      items: [],
      retrievalMode,
      latencyMs: Date.now() - startedAt,
      renderedTokens: 0,
      requestId,
      status: "degraded",
      statusDetail,
    };
  }

  public async explain(request: McpExplainRequest): Promise<ContextExplanation> {
    await this.#assertNotUpgrading();
    await this.#assertRetrievalEnabled();
    if (await this.#isInternalSession(request.sessionId)) {
      throw new Error("Internal sessions cannot inspect user context.");
    }
    let scopedRequest = request;
    if (request.trustedWorkspace !== undefined) {
      const identity = await this.#resolveSessionIdentity({
        cwd: request.cwd ?? this.#cwd,
        sessionId: request.sessionId,
        trustedWorkspace: request.trustedWorkspace,
      }, "unknown");
      const { repoId: suppliedRepositoryId, branch: suppliedBranch, headSha: suppliedHead, ...unscopedRequest } = request;
      void suppliedRepositoryId;
      void suppliedBranch;
      void suppliedHead;
      scopedRequest = {
        ...unscopedRequest,
        ...(identity.repositoryId === undefined ? {} : { repoId: identity.repositoryId }),
        ...(identity.branch === undefined ? {} : { branch: identity.branch }),
        ...(identity.commitSha === undefined ? {} : { headSha: identity.commitSha }),
      };
    }
    return this.#withKnowledgeLease(() =>
      this.#withService(
        (service) =>
          Promise.resolve(service.explain(scopedRequest)),
        undefined,
        true,
      ),
    );
  }

  public async feedback(
    request: ContextFeedbackRequest,
  ): Promise<ContextFeedbackResponse> {
    await this.#assertNotUpgrading();
    const state = await this.#state();
    if (!state.capabilities.retrieval.enabled) {
      throw new Error(
        "Retrieval capability is disabled.",
      );
    }
    if (await this.#isInternalSession(request.sessionId)) {
      throw new Error("Internal sessions cannot submit user feedback.");
    }
    let scopedRequest = request;
    if (request.action === "set_scope") {
      const identity = await this.#resolveSessionIdentity({
        cwd: request.cwd ?? this.#cwd,
        sessionId: request.sessionId,
        ...(request.trustedWorkspace === undefined ? {} : {
          trustedWorkspace: request.trustedWorkspace,
        }),
      }, state.detectedCopilotVersion ?? "unknown");
      if (identity.internalSession) {
        throw new Error(
          "Internal sessions cannot change Knowledge scope.",
        );
      }
      const workflowScopeId = request.workflowScopeId ?? this.#workflowScopeId;
      const {
        branchScopeId: suppliedBranch,
        repositoryScopeId: suppliedRepository,
        ...withoutScope
      } = request;
      void suppliedBranch;
      void suppliedRepository;
      scopedRequest = {
        ...withoutScope,
        ...(identity.branch === undefined
          ? {}
          : {
              branchScopeId: identity.branch,
            }),
        ...(identity.repositoryId === undefined
          ? {}
          : {
              repositoryScopeId: identity.repositoryId,
            }),
        ...(workflowScopeId === undefined
          ? {}
          : {
              workflowScopeId,
            }),
      };
    }
    return this.#withKnowledgeLease(() =>
      this.#withService(
        (service) => service.feedback(scopedRequest),
        undefined,
        true,
      ),
    );
  }

  async #isInternalSession(sessionId: string): Promise<boolean> {
    const paths = resolveWindowsProvenLoopPaths(this.#dataRoot);
    return isProvenLoopInternalEnvironment(process.env) ||
      (await readInternalSessionIds(paths.internalSessions)).has(sessionId.trim());
  }

  async #resolveSessionIdentity(
    request: Pick<ContextRequest, "cwd" | "sessionId" | "trustedWorkspace">,
    adapterVersion: string,
  ): Promise<SessionIdentity> {
    const snapshot = request.trustedWorkspace;
    if (snapshot === undefined) {
      return this.#adapter.resolveSession({
        adapterVersion,
        cwd: request.cwd,
        sessionId: request.sessionId,
      });
    }
    const observedAt = Date.parse(snapshot.repositoryObservedAt);
    const repositoryId = nonEmptyString(snapshot.repositoryId);
    if (
      (snapshot.repositoryState !== "known_repo" &&
        snapshot.repositoryState !== "known_outside_repo") ||
      !Number.isFinite(observedAt) ||
      Date.now() - observedAt > 60_000 ||
      observedAt > Date.now() + 5_000 ||
      (snapshot.repositoryState === "known_repo" &&
        repositoryId === undefined)
    ) {
      throw new Error("Trusted repository identity is unknown, refreshing, or stale.");
    }
    return {
      internalSession: await this.#isInternalSession(request.sessionId),
      sessionId: request.sessionId,
      ...(snapshot.repositoryState !== "known_repo" || repositoryId === undefined ? {} : {
        repositoryId,
        ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
        ...(snapshot.commitSha === undefined ? {} : { commitSha: snapshot.commitSha }),
      }),
    };
  }

  async #withKnowledgeLease<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = await this.#acquireKnowledgeLease();
    try { return await operation(); } finally { await lease.release(); }
  }

  async #assertNotUpgrading(): Promise<void> {
    if (await isUpgradeMaintenanceActive(this.#dataRoot)) {
      throw new Error("ProvenLoop upgrade maintenance is in progress; retry after it finishes.");
    }
  }

  async #acquireKnowledgeLease() {
    await this.#assertNotUpgrading();
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    const lease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(
        paths.root,
        "knowledge-projection",
      ),
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error(
        "Knowledge projection is busy.",
      );
    }
    try {
      await this.#assertNotUpgrading();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async #assertRetrievalEnabled(): Promise<void> {
    const state = await this.#state();
    if (!state.capabilities.retrieval.enabled) {
      throw new Error(
        "Retrieval capability is disabled.",
      );
    }
  }

  async #state() {
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    await assertCopilotAdapterDataRoot(paths);
    return readCopilotAdapterState(
      paths.adapterState,
      this.#now(),
    );
  }

  async #withService<T>(
    operation: (
      service: ContextRetrievalService,
    ) => Promise<T>,
    deadline: number | undefined,
    knowledgeLeaseHeld = false,
  ): Promise<T> {
    const effectiveDeadline =
      deadline ?? Date.now() + DEFAULT_CONTEXT_TIMEOUT_MS;
    const paths = resolveWindowsProvenLoopPaths(
      this.#dataRoot,
    );
    await assertCopilotAdapterDataRoot(paths);
    await Promise.all([
      access(paths.database),
      access(paths.knowledgeDatabase),
    ]);
    const remainingBeforeOpen =
      effectiveDeadline - Date.now();
    if (remainingBeforeOpen <= MCP_WRITE_RESERVE_MS) {
      throw new Error(
        "Retrieval deadline expired before database initialization.",
      );
    }
    const busyTimeoutMs = Math.max(
      1,
      Math.min(
        MCP_WRITE_RESERVE_MS,
        remainingBeforeOpen - MCP_WRITE_RESERVE_MS,
      ),
    );
    const store = new CanonicalSqliteStore(paths.database, {
      busyTimeoutMs,
    });
    let backend: SqliteFtsKnowledgeBackend | undefined;
    try {
      backend = new SqliteFtsKnowledgeBackend(
        paths.knowledgeDatabase,
        {
          busyTimeoutMs,
        },
      );
      const activeBackend = backend;
      const serviceTimeoutMs =
        effectiveDeadline - Date.now() - MCP_WRITE_RESERVE_MS;
      if (serviceTimeoutMs <= 0) {
        throw new Error(
          "Retrieval deadline expired during database initialization.",
        );
      }
      const service = new ContextRetrievalService({
        backend: activeBackend,
        codeVersion: PROVENLOOP_CODE_VERSION,
        now: this.#now,
        store,
        syncKnowledge: async (candidate) => {
          const syncCurrent = async (): Promise<void> => {
            const current = store.knowledgeCandidates([
              candidate.knowledgeId,
            ])[0];
            if (current === undefined) {
              throw new Error(
                "Knowledge projection target no longer exists.",
              );
            }
            await activeBackend.index([
              knowledgeProjectionFromCandidate(current, store.learningProposals([current.knowledgeId]),
                store.discoveryProfiles([current]).get(current.knowledgeId)),
            ]);
          };
          if (knowledgeLeaseHeld) {
            await syncCurrent();
            return;
          }
          const lease = await new WindowsNamedPipeLeaseProvider(
            await resolveWindowsProvenLoopLeaseName(
              paths.root,
              "knowledge-projection",
            ),
          ).tryAcquire();
          if (lease === undefined) {
            throw new Error(
              "Knowledge projection is busy.",
            );
          }
          try {
            await syncCurrent();
          } finally {
            await lease.release();
          }
        },
        timeoutMs: serviceTimeoutMs,
      });
      return await operation(service);
    } finally {
      try { await backend?.closeAsync(); } finally { store.close(); }
    }
  }
}

const callTool = async (
  call: ToolCall,
  handlers: McpToolHandlers,
  trusted: TrustedMcpContext,
): Promise<unknown> => {
  switch (call.name) {
    case "provenloop_context": {
      const request = parseContextRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_context arguments.",
        );
      }
      return handlers.context(request);
    }
    case "provenloop_search": {
      const request = parseSearchRequest(call.arguments, trusted);
      if (request === undefined) {
        throw new TypeError("Invalid provenloop_search arguments.");
      }
      if (handlers.search === undefined) {
        throw new Error("Deeper search is unavailable in this host.");
      }
      return handlers.search(request);
    }
    case "provenloop_explain": {
      const request = parseExplainRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_explain arguments.",
        );
      }
      return handlers.explain(request);
    }
    case "provenloop_feedback": {
      const request = parseFeedbackRequest(
        call.arguments,
        trusted,
      );
      if (request === undefined) {
        throw new TypeError(
          "Invalid provenloop_feedback arguments.",
        );
      }
      const approvalCode = `PL-${sha256({
        action: request.action,
        cwd: trusted.cwd,
        reason: request.reason,
        requestId: request.requestId,
        resolvesEvidenceIds: request.resolvesEvidenceIds,
        scope: request.scope,
        sessionId: trusted.sessionId,
        targetId: request.targetId,
        targetKind: request.targetKind ?? "knowledge",
        userReportedApplied: request.userReportedApplied === true,
        workspaceVersion: trusted.workspaceVersion,
      }).slice(0, 12)}`;
      const approval = trusted.latestUserMessage;
      const approvedText = approval?.text.trim();
      if (
        approval === undefined ||
        approval.eventId.trim().length === 0 ||
        !Number.isFinite(Date.parse(approval.timestamp)) ||
        Date.now() - Date.parse(approval.timestamp) > 5 * 60_000 ||
        Date.parse(approval.timestamp) > Date.now() + 5_000 ||
        (approvedText !== `确认 ${approvalCode}` &&
          approvedText !== `confirm ${approvalCode}`)
      ) {
        return {
          action: request.action,
          confirmationCode: approvalCode,
          requestId: request.requestId,
          message: `Proposed ${request.action} for ${request.targetKind ?? "knowledge"}:${request.targetId}; user-reported application: ${request.userReportedApplied === true}. Ask the user to approve by replying exactly: 确认 ${approvalCode}`,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.resolvesEvidenceIds === undefined ? {} : {
            resolvesEvidenceIds: request.resolvesEvidenceIds,
          }),
          ...(request.scope === undefined ? {} : { scope: request.scope }),
          status: "confirmation_required",
          targetRef: {
            kind: request.targetKind ?? "knowledge",
            id: request.targetId,
          },
          userReportedApplied: request.userReportedApplied === true,
        };
      }
      return handlers.feedback({
        ...request,
        evidenceRef: approval.eventId,
        source: "user",
      });
    }
    default:
      throw new Error(`Unknown tool: ${call.name}.`);
  }
};

export const runMcpServer = async (
  io: McpServerIo = {
    input: process.stdin,
    output: process.stdout,
  },
  options: McpServerOptions = {},
): Promise<void> => {
  const root = options.dataRoot ?? resolveWindowsProvenLoopDataRoot();
  const sessionId = options.sessionId ?? nonEmptyString(process.env.SESSION_ID);
  const sessionIdSource = options.resolveTrustedContext !== undefined ? "resolver"
    : options.sessionId !== undefined ? "options"
      : sessionId !== undefined ? "environment" : "missing";
  const resolveTrustedContext = async (): Promise<{
    context?: TrustedMcpContext;
    diagnostic?: McpIdentityDiagnostic;
    failed?: boolean;
  }> => {
    let diagnostic: McpIdentityDiagnostic | undefined;
    try {
      if (options.resolveTrustedContext !== undefined) {
        const context = await options.resolveTrustedContext();
        return context === undefined
          ? { diagnostic: { reason: "resolver_unavailable" } }
          : { context };
      }
      if (sessionId === undefined) return { diagnostic: { reason: "session_id_missing" } };
      if (sessionId.trim().length === 0) return { failed: true, diagnostic: { reason: "session_id_missing" } };
      const context = await readTrustedSessionContext(root, sessionId, options.now?.() ?? new Date(),
        (value) => { diagnostic = value; });
      return { ...(context === undefined ? {} : { context }), ...(diagnostic === undefined ? {} : { diagnostic }) };
    } catch {
      return { failed: true, diagnostic: diagnostic ?? { reason: "resolver_failed" } };
    }
  };
  let previousIdentityFailure: { reason: McpIdentityReason; identityCheckId: string } | undefined;
  let identityObservationSequence = 0;
  const handlers =
    options.handlers ??
    new LocalMcpToolHandlers({
      cwd: options.cwd ?? process.cwd(),
      dataRoot: root,
      now: options.now ?? (() => new Date()),
      ...(options.workflowScopeId === undefined
        ? {}
        : {
            workflowScopeId: options.workflowScopeId,
          }),
    });
  let registration: Awaited<ReturnType<typeof registerActiveExtension>> | undefined;
  if (options.lifecycle ?? (io.input === process.stdin && options.handlers === undefined)) {
    registration = await registerActiveExtension(root, `mcp-${process.pid}-${randomUUID()}`);
  }
  const input = createInterface({
    crlfDelay: Infinity,
    input: io.input,
  });
  const pending = new Set<Promise<void>>();
  let stopTimer: NodeJS.Timeout | undefined;
  let lifecycleCheck: Promise<void> | undefined;
  let loopError: Error | undefined;
  let stopping = false;
  const stopInput = (): void => {
    stopping = true;
    input.close();
    io.input.pause();
  };
  if (registration) {
    stopTimer = setInterval(() => {
      if (lifecycleCheck !== undefined) return;
      lifecycleCheck = isExtensionShutdownRequested(root)
        .then((requested) => {
          if (requested) stopInput();
        })
        .catch((error: unknown) => {
          loopError ??= new Error("MCP shutdown status could not be verified.", {
            cause: error,
          });
          stopInput();
        })
        .finally(() => { lifecycleCheck = undefined; });
    }, 100);
    stopTimer.unref();
  }
  const running = new Promise<void>((resolve) => {
    input.on("line", (line) => {
      if (stopping) return;
      const handling = (async () => {
        if (line.trim().length === 0) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          fail(io.output, null, -32700, "Parse error");
          return;
        }
        const request = asRequest(parsed);
        if (request === undefined) {
          fail(io.output, null, -32600, "Invalid Request");
          return;
        }
        switch (request.method) {
          case "initialize":
            if (request.id !== undefined) {
              respond(io.output, request.id, {
                capabilities: {
                  tools: {},
                },
                instructions:
                  "For a new coding task or resumed task, call provenloop_context once before substantive work with relevant fileHints and tokenBudget 600. Do not repeatedly inject unchanged guidance. Call provenloop_search with protocolVersion 1 when the current task needs deeper past experience; use a focused prompt and preserve conditions in alternate queries. It supports engineering tasks generally. Use provenloop_explain on a returned explanationRef to inspect captured evidence, and open selected recorded sources with normal file or browser tools. Treat unavailable identity or empty results honestly. Persistent feedback requires the real user's exact approval of the server's confirmation code; never approve on the user's behalf. User-confirmed rules are not externally verified knowledge, and displayed or helpful context is not automatically applied or a verified outcome.",
                protocolVersion: MCP_PROTOCOL_VERSION,
                serverInfo: {
                  name: "provenloop",
                  version: PROVENLOOP_VERSION,
                },
              });
            }
            break;
          case "notifications/initialized":
            break;
          case "ping":
            if (request.id !== undefined) {
              respond(io.output, request.id, {});
            }
            break;
          case "tools/list":
            if (request.id !== undefined) {
              respond(io.output, request.id, {
                tools,
              });
            }
            break;
          case "tools/call": {
            if (request.id === undefined) {
              break;
            }
            const call = asToolCall(request.params);
            if (call === undefined) {
              fail(
                io.output,
                request.id,
                -32602,
                "Invalid tools/call parameters.",
              );
              break;
            }
            try {
              const startedAt = Date.now();
              const resolution = await resolveTrustedContext();
              const observation = {
                identityCheckId: `identity-${randomUUID()}`,
                observationSequence: ++identityObservationSequence,
                observedAt: new Date().toISOString(),
              };
              const trusted = resolution.context;
              if (
                trusted === undefined ||
                (trusted.repositoryState !== "known_repo" &&
                  trusted.repositoryState !== "known_outside_repo")
              ) {
                const diagnostic = resolution.diagnostic ?? { reason: "repository_unknown" as const };
                const failure = { reason: diagnostic.reason, identityCheckId: observation.identityCheckId };
                previousIdentityFailure = failure;
                const detail = describeMcpIdentityFailure(diagnostic.reason);
                const resolvedSessionId = trusted?.sessionId ?? sessionId;
                const logFailure = (requestId: string) => {
                  return appendMcpIdentityDiagnostic(root, {
                    event: "trusted_identity_unavailable", diagnostic, requestId, sessionIdSource, ...observation,
                    ...(resolvedSessionId === undefined ? {} : { sessionId: resolvedSessionId }),
                    elapsedMs: Date.now() - startedAt,
                  });
                };
                if (resolution.failed) {
                  const requestId = `mcp-${randomUUID()}`;
                  await logFailure(requestId);
                  throw new Error(`${detail} Request ID: ${requestId}. See logs/mcp.jsonl.`);
                }
                if (call.name === "provenloop_context" || call.name === "provenloop_search") {
                  let requestId = `context-${randomUUID()}`;
                  try {
                    const contextRequest = trusted === undefined
                      ? undefined
                      : call.name === "provenloop_search"
                        ? parseSearchRequest(call.arguments, trusted)
                        : parseContextRequest(call.arguments, trusted);
                    const result: ContextResponse = contextRequest !== undefined && handlers.unavailableContext !== undefined
                      ? await handlers.unavailableContext(contextRequest, detail)
                      : {
                        items: [],
                        retrievalMode: call.name === "provenloop_search" ? "search" : "context",
                        latencyMs: Date.now() - startedAt,
                        renderedTokens: 0,
                        requestId,
                        status: "degraded",
                        statusDetail: detail,
                      };
                    requestId = result.requestId;
                    toolResult(io.output, request.id, result);
                  } catch (error) {
                    throw new Error(`${sanitizeDiagnostic(error)} Identity check: [${diagnostic.reason}]. Request ID: ${requestId}. See logs/mcp.jsonl.`, { cause: error });
                  } finally {
                    await logFailure(requestId);
                  }
                  break;
                }
                const requestId = `mcp-${randomUUID()}`;
                await logFailure(requestId);
                throw new Error(`${detail} Request ID: ${requestId}. See logs/mcp.jsonl.`);
              }
              if (previousIdentityFailure !== undefined) {
                const previousFailure = previousIdentityFailure;
                previousIdentityFailure = undefined;
                await appendMcpIdentityDiagnostic(root, {
                  event: "trusted_identity_recovered", previousReason: previousFailure.reason,
                  previousIdentityCheckId: previousFailure.identityCheckId, sessionIdSource, ...observation,
                  requestId: `mcp-${randomUUID()}`, sessionId: trusted.sessionId,
                  elapsedMs: Date.now() - startedAt,
                });
              }
              toolResult(
                io.output,
                request.id,
                await callTool(call, handlers, trusted),
              );
            } catch (error) {
              toolError(io.output, request.id, error);
            }
            break;
          }
          default:
            if (request.id !== undefined) {
              fail(
                io.output,
                request.id,
                -32601,
                "Method not found",
              );
            }
        }
      })();
      pending.add(handling);
      void handling.then(
        () => { pending.delete(handling); },
        (error: unknown) => {
          pending.delete(handling);
          loopError ??= new Error("MCP protocol processing failed.", { cause: error });
          stopInput();
        },
      );
    });
    input.once("error", (error: Error) => {
      loopError ??= new Error("MCP input failed.", { cause: error });
      stopInput();
    });
    input.once("close", () => {
      stopping = true;
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
  try {
    await running;
    clearInterval(stopTimer);
    await lifecycleCheck;
    if (loopError !== undefined) throw loopError;
  } finally {
    clearInterval(stopTimer);
    stopInput();
    await registration?.release();
  }
};
