import {
  captureEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  rawEventSchema,
  type CaptureEnvelope,
  type RawEvent,
} from "@provenloop/contracts";

import { sha256 } from "./digest.js";
import { verificationBinding } from "./verification-proof.js";
import {
  redactCaptureContent,
  redactCaptureMetadata,
  redactPotentialSecrets,
  type CaptureContentInput,
  type CaptureRedactionLimits,
} from "./redaction.js";

export type CaptureEventInput = Omit<
  RawEvent,
  "eventId" | "redactedArguments" | "resultDigest" | "schemaVersion"
> & {
  readonly content?: CaptureContentInput;
  readonly contentDigest?: string;
  readonly internalSession?: boolean;
  readonly sessionId: string;
  readonly sourceEventId: string;
};

export interface CreateCaptureEnvelopeOptions {
  readonly capturedAt?: string;
  readonly redactionLimits?: Partial<CaptureRedactionLimits>;
}

export interface CaptureIdentityInput {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly eventType: string;
  readonly sessionId: string;
  readonly sourceEventId: string;
}

export interface RedactedCaptureEnvelopeResult {
  readonly envelope: CaptureEnvelope;
  readonly redactionApplied: boolean;
}

const definedField = <TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined,
): Partial<Record<TKey, TValue>> =>
  value === undefined
    ? {}
    : {
        [key]: value,
      } as Record<TKey, TValue>;

const sanitizeRedactionMetadata = (
  values: readonly string[],
): string[] =>
  [
    ...new Set(
      values.map((value) => redactPotentialSecrets(value)),
    ),
  ].sort();

const redactCaptureProvenance = (event: RawEvent) => {
  const fields: Record<string, string> = {};
  const locations: Record<string, string> = {};
  const identifiers = new Set<string>();
  let sequence = 0;
  const collect = (value: string, location: string, identifier = false): string => {
    const key = `captureField${sequence++}`;
    fields[key] = value;
    locations[key] = location;
    if (identifier) identifiers.add(key);
    return key;
  };
  const quality = event.captureQuality;
  const truncated = quality?.truncatedFields.map((value, index) =>
    collect(value, `event.captureQuality.truncatedFields[${index}]`),
  );
  const omitted = quality?.omittedFields.map((value, index) =>
    collect(value, `event.captureQuality.omittedFields[${index}]`),
  );
  const lengths = quality === undefined ? undefined
    : Object.entries(quality.originalLengths).map(([key, length], index) => ({
      key: collect(key, `event.captureQuality.originalLengths.keys[${index}]`),
      length,
    }));
  const evidence = event.evidence;
  const evidenceFields = [
    "sourceStartEventId",
    "sourceCompleteEventId",
    "operationId",
    "commandFamily",
    "workingDirectory",
  ] as const;
  const evidenceKeys: Partial<Record<typeof evidenceFields[number], string>> = {};
  for (const field of evidenceFields) {
    const value = evidence?.[field];
    if (value !== undefined) {
      evidenceKeys[field] = collect(value, `event.evidence.${field}`,
        field === "sourceStartEventId" || field === "sourceCompleteEventId" || field === "operationId");
    }
  }
  const targets = evidence?.targetPaths?.map((value, index) =>
    collect(value, `event.evidence.targetPaths[${index}]`),
  );
  const bridgeKeys = event.parentBridge?.map((entry, index) => {
    const keys = ["sourceEventId", "parentSourceEventId", "sessionId", "repoId", "worktree"] as const;
    return Object.fromEntries(keys.map((field) => [field, collect(entry[field], `event.parentBridge[${index}].${field}`, field !== "worktree")]));
  });
  const redacted = redactCaptureMetadata(fields, identifiers);
  const safe = (key: string): string => {
    const value = redacted.values[key];
    if (value === undefined) {
      throw new Error("Capture provenance redaction did not return an expected field.");
    }
    return value;
  };
  return {
    appliedRules: redacted.appliedRules,
    redactedPaths: redacted.redactedPaths.map((path) =>
      locations[path.replace(/^event\./u, "")] ?? path,
    ),
    metadata: {
      ...(event.parentBridge === undefined ? {} : { parentBridge: event.parentBridge.map((entry, index) => ({
        ...entry, ...Object.fromEntries(Object.entries(bridgeKeys?.[index] ?? {}).map(([field, key]) => [field, safe(key)])),
      })) }),
      ...definedField("repositoryState", event.repositoryState),
      ...(quality === undefined ? {} : {
        captureQuality: {
          ...quality,
          truncatedFields: (truncated ?? []).map(safe),
          omittedFields: (omitted ?? []).map(safe),
          originalLengths: Object.fromEntries(
            (lengths ?? []).map(({ key, length }) => [safe(key), length]),
          ),
        },
      }),
      ...(evidence === undefined ? {} : {
        evidence: {
          ...evidence,
          ...Object.fromEntries(
            Object.entries(evidenceKeys).map(([field, key]) => [field, safe(key)]),
          ),
          ...(targets === undefined ? {} : { targetPaths: targets.map(safe) }),
        },
      }),
    },
  };
};

export class InternalCaptureEventError extends Error {
  public override readonly name = "InternalCaptureEventError";

  public constructor() {
    super("Internal ProvenLoop sessions cannot enter the capture queue.");
  }
}

export class InvalidCaptureIdentityError extends Error {
  public override readonly name = "InvalidCaptureIdentityError";

  public constructor(field: "sessionId" | "sourceEventId") {
    super(`Capture event ${field} must be non-empty.`);
  }
}

export const createCaptureDeduplicationKey = (
  input: CaptureIdentityInput,
): string =>
  sha256({
    adapter: input.adapter.trim(),
    adapterVersion: input.adapterVersion.trim(),
    eventType: input.eventType.trim(),
    sessionId: input.sessionId.trim(),
    sourceEventId: input.sourceEventId.trim(),
  });

export const createCaptureEnvelope = (
  input: CaptureEventInput,
  options: CreateCaptureEnvelopeOptions = {},
): CaptureEnvelope => {
  if (input.internalSession === true) {
    throw new InternalCaptureEventError();
  }
  const normalizedSourceEventId = input.sourceEventId.trim();
  if (input.sessionId.trim().length === 0) {
    throw new InvalidCaptureIdentityError("sessionId");
  }
  if (normalizedSourceEventId.length === 0) {
    throw new InvalidCaptureIdentityError("sourceEventId");
  }

  const normalizedEvent = rawEventSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    actorId: input.actorId,
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    branch: input.branch,
    claimId: input.claimId,
    commitSha: input.commitSha,
    completionStatus: input.completionStatus,
    eventId: "event-normalization-placeholder",
    eventType: input.eventType,
    exitCode: input.exitCode,
    operationId: input.operationId,
    parentEventId: input.parentEventId,
    originalParentSourceEventId: input.originalParentSourceEventId,
    participantId: input.participantId,
    protocol: input.protocol,
    protocolVersion: input.protocolVersion,
    repoId: input.repoId,
    requestedModel: input.requestedModel,
    requestedProvider: input.requestedProvider,
    resolvedModel: input.resolvedModel,
    resolvedProvider: input.resolvedProvider,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    toolName: input.toolName,
    trust: input.trust,
    worktree: input.worktree,
    ...definedField("verificationBinding", input.verificationBinding),
    ...definedField("mcp", input.mcp),
    ...definedField("parentBridge", input.parentBridge),
    ...definedField("captureQuality", input.captureQuality),
    ...definedField("evidence", input.evidence),
    ...definedField("repositoryState", input.repositoryState),
  });
  if (normalizedEvent.sessionId === undefined) {
    throw new InvalidCaptureIdentityError("sessionId");
  }
  const deduplicationKey = createCaptureDeduplicationKey({
    adapter: normalizedEvent.adapter,
    adapterVersion: normalizedEvent.adapterVersion,
    eventType: normalizedEvent.eventType,
    sessionId: normalizedEvent.sessionId,
    sourceEventId: normalizedSourceEventId,
  });
  const redacted = redactCaptureContent(
    input.content,
    options.redactionLimits,
  );
  const metadata = redactCaptureMetadata(
    {
      actorId: normalizedEvent.actorId,
      adapter: normalizedEvent.adapter,
      adapterVersion: normalizedEvent.adapterVersion,
      branch: normalizedEvent.branch,
      claimId: normalizedEvent.claimId,
      commitSha: normalizedEvent.commitSha,
      eventType: normalizedEvent.eventType,
      operationId: normalizedEvent.operationId,
      parentEventId: normalizedEvent.parentEventId,
      participantId: normalizedEvent.participantId,
      protocol: normalizedEvent.protocol,
      protocolVersion: normalizedEvent.protocolVersion,
      repoId: normalizedEvent.repoId,
      requestedModel: normalizedEvent.requestedModel,
      requestedProvider: normalizedEvent.requestedProvider,
      resolvedModel: normalizedEvent.resolvedModel,
      resolvedProvider: normalizedEvent.resolvedProvider,
      sessionId: normalizedEvent.sessionId,
      sourceEventId: normalizedSourceEventId,
      toolName: normalizedEvent.toolName,
      worktree: normalizedEvent.worktree,
    },
    new Set([
      "actorId",
      "claimId",
      "commitSha",
      "operationId",
      "parentEventId",
      "participantId",
      "repoId",
      "sessionId",
      "sourceEventId",
    ]),
  );
  const proofMetadata = redactCaptureMetadata(
    {
      correctionEventId: input.verificationBinding?.correctionEventId,
      operationEventId: input.verificationBinding?.operationEventId,
    },
    new Set(["correctionEventId", "operationEventId"]),
  );
  const provenance = redactCaptureProvenance(normalizedEvent);
  const appliedRules = [
    ...new Set([
      ...redacted.redaction.appliedRules,
      ...metadata.appliedRules,
      ...proofMetadata.appliedRules,
      ...provenance.appliedRules,
    ]),
  ].sort();
  const redactedPaths = [
    ...new Set([
      ...redacted.redaction.redactedPaths,
      ...metadata.redactedPaths,
      ...proofMetadata.redactedPaths.map((path) =>
        path.replace("event.", "event.verificationBinding."),
      ),
      ...provenance.redactedPaths,
    ]),
  ].sort();
  const {
    sourceEventId: safeSourceEventId,
    ...safeEventMetadata
  } = metadata.values;
  const event = rawEventSchema.parse({
    ...normalizedEvent,
    ...safeEventMetadata,
    ...provenance.metadata,
    eventId: `event-${deduplicationKey}`,
    ...(input.verificationBinding === undefined
      ? {}
      : {
          verificationBinding: {
            correctionEventId: proofMetadata.values["correctionEventId"],
            operationEventId: proofMetadata.values["operationEventId"],
          },
        }),
    ...(redacted.redactedArguments === undefined
      ? {}
      : {
          redactedArguments: redacted.redactedArguments,
        }),
    ...(redacted.resultDigest === undefined
      ? {}
      : {
          resultDigest: redacted.resultDigest,
        }),
  });

  return captureEnvelopeSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    ...(redacted.content === undefined
      ? {}
      : {
          content: redacted.content,
        }),
    deduplicationKey,
    event,
    redaction: {
      ...redacted.redaction,
      appliedRules,
      ...(redacted.redaction.contentDigest === undefined &&
      input.contentDigest !== undefined
        ? {
            contentDigest: input.contentDigest,
          }
        : {}),
      redactedPaths,
    },
    sourceEventId: safeSourceEventId ?? normalizedSourceEventId,
  });
};

export const redactCaptureEnvelopeForPersistence = (
  input: CaptureEnvelope,
): RedactedCaptureEnvelopeResult => {
  const parsed = captureEnvelopeSchema.parse(input);
  const event = parsed.event;
  const contentInput: CaptureContentInput = {
    ...(parsed.content?.message === undefined
      ? {}
      : {
          message: parsed.content.message,
        }),
    ...(parsed.content?.safeError === undefined
      ? {}
      : {
          error: parsed.content.safeError,
        }),
    ...(event.redactedArguments === undefined
      ? {}
      : {
          toolArguments: event.redactedArguments,
        }),
    ...(parsed.content?.toolResult === undefined
      ? {}
      : {
          toolResult: parsed.content.toolResult,
        }),
  };
  const rebuilt = createCaptureEnvelope(
    {
      adapter: event.adapter,
      adapterVersion: event.adapterVersion,
      ...definedField("actorId", event.actorId),
      ...definedField("branch", event.branch),
      ...definedField("claimId", event.claimId),
      ...definedField("commitSha", event.commitSha),
      ...definedField(
        "completionStatus",
        event.completionStatus,
      ),
      ...(Object.keys(contentInput).length === 0
        ? {}
        : {
            content: contentInput,
          }),
      ...definedField(
        "contentDigest",
        parsed.redaction.contentDigest,
      ),
      eventType: event.eventType,
      ...definedField("exitCode", event.exitCode),
      ...definedField("operationId", event.operationId),
      ...definedField("parentEventId", event.parentEventId),
      ...definedField("originalParentSourceEventId", event.originalParentSourceEventId),
      ...definedField("participantId", event.participantId),
      ...definedField("protocol", event.protocol),
      ...definedField("protocolVersion", event.protocolVersion),
      ...definedField("repoId", event.repoId),
      ...definedField("requestedModel", event.requestedModel),
      ...definedField(
        "requestedProvider",
        event.requestedProvider,
      ),
      ...definedField("resolvedModel", event.resolvedModel),
      ...definedField(
        "resolvedProvider",
        event.resolvedProvider,
      ),
      sessionId: event.sessionId ?? "",
      sourceEventId: parsed.sourceEventId,
      timestamp: event.timestamp,
      ...definedField("toolName", event.toolName),
      trust: event.trust,
      ...definedField("worktree", event.worktree),
      ...definedField("verificationBinding", verificationBinding(parsed)),
      ...definedField("mcp", parsed.event.mcp),
      ...definedField("parentBridge", parsed.event.parentBridge),
      ...definedField("captureQuality", event.captureQuality),
      ...definedField("evidence", event.evidence),
      ...definedField("repositoryState", event.repositoryState),
    },
    {
      capturedAt: parsed.capturedAt,
    },
  );
  const envelope = captureEnvelopeSchema.parse({
    ...rebuilt,
    event: {
      ...rebuilt.event,
      ...(event.resultDigest === undefined
        ? {}
        : {
            resultDigest: event.resultDigest,
          }),
    },
    redaction: {
      ...rebuilt.redaction,
      appliedRules: sanitizeRedactionMetadata([
          ...parsed.redaction.appliedRules,
          ...rebuilt.redaction.appliedRules,
      ]),
      ...(parsed.redaction.contentDigest === undefined
        ? {}
        : {
            contentDigest: parsed.redaction.contentDigest,
          }),
      droppedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.droppedPaths,
          ...rebuilt.redaction.droppedPaths,
      ]),
      redactedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.redactedPaths,
          ...rebuilt.redaction.redactedPaths,
      ]),
      truncatedPaths: sanitizeRedactionMetadata([
          ...parsed.redaction.truncatedPaths,
          ...rebuilt.redaction.truncatedPaths,
      ]),
    },
  });
  return {
    envelope,
    redactionApplied:
      JSON.stringify(envelope) !== JSON.stringify(parsed),
  };
};

export const isProvenLoopInternalEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): boolean => environment.PROVENLOOP_INTERNAL === "1";
