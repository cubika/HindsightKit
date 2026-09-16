import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  sha256DigestSchema,
  versionedSchemaShape,
} from "./common.js";

export const deletionTargetTypeSchema = z.enum([
  "episode",
  "knowledge",
  "session",
  "source",
]);

export const deletionStatusSchema = z.enum([
  "running",
  "completing",
  "completed",
  "failed",
]);

export const deletionIdentityTypeSchema = z.enum([
  "deduplication",
  "episode",
  "event",
  "session",
]);

export const deletionIdentityTombstoneSchema = z
  .object({
    digest: sha256DigestSchema,
    identityType: deletionIdentityTypeSchema,
  })
  .strict();

export const deletionPlannedIdentitySchema = z
  .object({
    identifier: nonEmptyStringSchema,
    identityType: deletionIdentityTypeSchema,
  })
  .strict();

export const deletionOperationSchema = z
  .object({
    ...versionedSchemaShape,
    activeTargetId: nonEmptyStringSchema.optional(),
    attemptCount: nonNegativeIntegerSchema,
    blockedIdentityDigests: z
      .array(deletionIdentityTombstoneSchema)
      .default([]),
    completedAt: isoTimestampSchema.optional(),
    deletedDependentCount: nonNegativeIntegerSchema,
    deletedQueueItemCount: nonNegativeIntegerSchema,
    deletedSourceCount: nonNegativeIntegerSchema,
    deletionId: identifierSchema,
    error: nonEmptyStringSchema.optional(),
    gateDigest: sha256DigestSchema.optional(),
    plannedAffectedSessionIds: z
      .array(nonEmptyStringSchema)
      .optional(),
    plannedDependentIds: z.array(nonEmptyStringSchema).optional(),
    plannedDependencySeedIds: z
      .array(nonEmptyStringSchema)
      .optional(),
    plannedQueueItemIds: z.array(nonEmptyStringSchema).optional(),
    plannedQueueIdentities: z
      .array(deletionPlannedIdentitySchema)
      .optional(),
    plannedSourceIds: z.array(nonEmptyStringSchema).optional(),
    propagationEvidenceId: identifierSchema.optional(),
    requestedAt: isoTimestampSchema,
    status: deletionStatusSchema,
    targetDigest: sha256DigestSchema,
    targetType: deletionTargetTypeSchema,
    tombstoneKeyVerifier: sha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      operation.status === "running" &&
      (
        operation.activeTargetId === undefined ||
        operation.completedAt !== undefined ||
        operation.error !== undefined ||
        operation.gateDigest !== undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Running deletion operations cannot have completion fields.",
      });
    }
    if (
      operation.status === "completed" &&
      (
        operation.activeTargetId !== undefined ||
        operation.completedAt === undefined ||
        operation.gateDigest === undefined ||
        operation.propagationEvidenceId === undefined ||
        operation.tombstoneKeyVerifier === undefined ||
        operation.error !== undefined ||
        operation.plannedAffectedSessionIds !== undefined ||
        operation.plannedDependentIds !== undefined ||
        operation.plannedDependencySeedIds !== undefined ||
        operation.plannedQueueItemIds !== undefined ||
        operation.plannedQueueIdentities !== undefined ||
        operation.plannedSourceIds !== undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Completed deletion operations require completion and Gate fields.",
      });
    }
    if (
      operation.status === "completing" &&
      (
        operation.activeTargetId === undefined ||
        operation.completedAt !== undefined ||
        operation.gateDigest === undefined ||
        operation.propagationEvidenceId === undefined ||
        operation.error !== undefined ||
        operation.plannedSourceIds === undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Completing deletion operations require their plan and Gate outbox.",
      });
    }
    if (
      operation.status === "failed" &&
      (
        operation.completedAt === undefined ||
        operation.error === undefined
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Failed deletion operations require completion and error fields.",
      });
    }
  });

export type DeletionOperation = z.infer<
  typeof deletionOperationSchema
>;
export type DeletionIdentityTombstone = z.infer<
  typeof deletionIdentityTombstoneSchema
>;
export type DeletionPlannedIdentity = z.infer<
  typeof deletionPlannedIdentitySchema
>;
export type DeletionIdentityType = z.infer<
  typeof deletionIdentityTypeSchema
>;
export type DeletionStatus = z.infer<
  typeof deletionStatusSchema
>;
export type DeletionTargetType = z.infer<
  typeof deletionTargetTypeSchema
>;
