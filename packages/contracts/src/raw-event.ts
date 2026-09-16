import { z } from "zod";

import {
  captureEvidenceSchema,
  captureQualitySchema,
  repositoryStateSchema,
} from "./capture-metadata.js";
import {
  isSupportedCopilotCliVersion,
  SUPPORTED_COPILOT_CLI_VERSION_RANGE,
} from "./copilot-cli-version.js";
import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  sha256DigestSchema,
  versionedSchemaShape,
} from "./common.js";
import {
  type SchemaValidationResult,
  validateVersionedSchema,
} from "./validation.js";

export const SUPPORTED_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "session.idle",
  "session.error",
  "prompt.submitted",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "agent.message",
  "agent.turn_started",
  "agent.turn_completed",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "capture_gap",
  "file.changed",
  "test.completed",
  "build.completed",
  "git.commit",
  "git.head_changed",
  "pull_request.updated",
  "review.received",
  "issue.linked",
  "change.reverted",
  "user.corrected",
  "feedback.recorded",
  "claim.declared",
  "delegate.requested",
  "delegate.completed",
  "verification.completed",
] as const;

export const SUPPORTED_ADAPTER_VERSIONS: Readonly<
  Record<string, readonly string[]>
> = {
  "copilot-cli": [
    SUPPORTED_COPILOT_CLI_VERSION_RANGE,
  ],
} as const;

export const supportedEventTypeSchema = z.enum(SUPPORTED_EVENT_TYPES);

export const trustLabelSchema = z.enum([
  "user",
  "system",
  "tool",
  "external-content",
  "model",
]);

export const completionStatusSchema = z.enum([
  "requested",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const verificationBindingSchema = z
  .object({
    correctionEventId: identifierSchema,
    operationEventId: identifierSchema,
  })
  .strict();

export const rawEventSchema = z
  .object({
    ...versionedSchemaShape,
    actorId: identifierSchema.optional(),
    adapter: nonEmptyStringSchema,
    adapterVersion: nonEmptyStringSchema,
    branch: nonEmptyStringSchema.optional(),
    captureQuality: captureQualitySchema.optional(),
    claimId: identifierSchema.optional(),
    commitSha: nonEmptyStringSchema.optional(),
    completionStatus: completionStatusSchema.optional(),
    eventId: identifierSchema,
    eventType: nonEmptyStringSchema,
    evidence: captureEvidenceSchema.optional(),
    exitCode: z.number().int().optional(),
    operationId: identifierSchema.optional(),
    mcp: z.object({
      serverName: nonEmptyStringSchema.max(256),
      toolName: nonEmptyStringSchema.max(256),
      contractDigest: sha256DigestSchema.optional(),
      isError: z.boolean().optional(),
      resultType: z.enum(["success", "failure"]).optional(),
      failureArgument: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).optional(),
    }).strict().optional(),
    parentEventId: identifierSchema.optional(),
    originalParentSourceEventId: identifierSchema.optional(),
    parentBridge: z.array(z.object({
      schemaVersion: z.literal(1), sourceEventId: identifierSchema, parentSourceEventId: identifierSchema,
      eventType: z.enum(["hook.start", "hook.end", "system.message", "permission.requested", "permission.completed", "session.usage_checkpoint", "session.info", "session.model_change"]),
      timestamp: isoTimestampSchema, sessionId: identifierSchema, repoId: identifierSchema, worktree: nonEmptyStringSchema, trust: z.literal("system"),
    }).strict()).min(1).max(32).optional(),
    participantId: identifierSchema.optional(),
    protocol: nonEmptyStringSchema.optional(),
    protocolVersion: nonEmptyStringSchema.optional(),
    redactedArguments: z.unknown().optional(),
    repoId: identifierSchema.optional(),
    repositoryState: repositoryStateSchema.optional(),
    requestedModel: nonEmptyStringSchema.optional(),
    requestedProvider: nonEmptyStringSchema.optional(),
    resolvedModel: nonEmptyStringSchema.optional(),
    resolvedProvider: nonEmptyStringSchema.optional(),
    resultDigest: sha256DigestSchema.optional(),
    sessionId: identifierSchema.optional(),
    timestamp: isoTimestampSchema,
    toolName: nonEmptyStringSchema.optional(),
    trust: trustLabelSchema,
    verificationBinding: verificationBindingSchema.optional(),
    worktree: nonEmptyStringSchema.optional(),
  })
  .strict();

export const supportedRawEventSchema = rawEventSchema.extend({
  eventType: supportedEventTypeSchema,
});

export type RawEvent = z.infer<typeof rawEventSchema>;
export type VerificationBinding = z.infer<
  typeof verificationBindingSchema
>;
export type SupportedEventType = z.infer<typeof supportedEventTypeSchema>;
export type SupportedRawEvent = z.infer<typeof supportedRawEventSchema>;

type RawEventValidationFailure = Exclude<
  SchemaValidationResult<RawEvent>,
  {
    readonly status: "valid";
  }
>;

export type RawEventClassification =
  | RawEventValidationFailure
  | {
      readonly status: "supported";
      readonly value: SupportedRawEvent;
    }
  | {
      readonly status: "unsupported_adapter_version";
      readonly adapter: string;
      readonly adapterVersion: string;
      readonly supportedVersions: readonly string[];
      readonly value: RawEvent;
    }
  | {
      readonly status: "unsupported_event_type";
      readonly eventType: string;
      readonly value: RawEvent;
    };

export const classifyRawEvent = (input: unknown): RawEventClassification => {
  const validation = validateVersionedSchema(
    "rawEvent",
    rawEventSchema,
    input,
  );
  if (validation.status !== "valid") {
    return validation;
  }

  const supportedVersions = SUPPORTED_ADAPTER_VERSIONS[
    validation.value.adapter
  ];
  const adapterVersionSupported =
    validation.value.adapter === "copilot-cli" &&
    isSupportedCopilotCliVersion(
      validation.value.adapterVersion,
    );
  if (supportedVersions === undefined || !adapterVersionSupported) {
    return {
      status: "unsupported_adapter_version",
      adapter: validation.value.adapter,
      adapterVersion: validation.value.adapterVersion,
      supportedVersions: supportedVersions ?? [],
      value: validation.value,
    };
  }

  const eventType = supportedEventTypeSchema.safeParse(
    validation.value.eventType,
  );
  if (!eventType.success) {
    return {
      status: "unsupported_event_type",
      eventType: validation.value.eventType,
      value: validation.value,
    };
  }

  return {
    status: "supported",
    value: {
      ...validation.value,
      eventType: eventType.data,
    },
  };
};
