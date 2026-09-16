import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  sha256DigestSchema,
  scopeSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const releaseGateSchema = z.enum([
  "hard",
  "conditional",
]);

export const expectedGateSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
]);

export const gateStatusSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "infrastructure_error",
]);

export const requirementManifestSchema = z
  .object({
    ...versionedSchemaShape,
    milestone: nonEmptyStringSchema,
    releaseGate: releaseGateSchema,
    replaySpecIds: stringListSchema,
    requiredEvidence: stringListSchema,
    requirementId: identifierSchema,
    scope: scopeSchema,
    statement: nonEmptyStringSchema,
    verifierIds: stringListSchema,
  })
  .strict();

export const replaySpecSchema = z
  .object({
    ...versionedSchemaShape,
    expectedEvidence: stringListSchema,
    expectedGate: expectedGateSchema,
    frozenEnvironment: nonEmptyStringSchema,
    inputEvents: stringListSchema.min(1).optional(),
    inputRef: nonEmptyStringSchema.optional(),
    requirementId: identifierSchema,
    specId: identifierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const inputCount =
      Number(value.inputRef !== undefined) +
      Number(value.inputEvents !== undefined);
    if (inputCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of inputRef or inputEvents is required.",
        path: [
          "inputRef",
        ],
      });
    }
  });

export const evidenceLedgerEntrySchema = z
  .object({
    ...versionedSchemaShape,
    actorId: identifierSchema.optional(),
    claimId: identifierSchema.optional(),
    episodeId: identifierSchema.optional(),
    eventId: identifierSchema.optional(),
    exitCode: z.number().int().optional(),
    inputDigest: sha256DigestSchema.optional(),
    invocationId: identifierSchema.optional(),
    ledgerEntryId: identifierSchema,
    outputDigest: sha256DigestSchema.optional(),
    participantId: identifierSchema.optional(),
    requestedModel: nonEmptyStringSchema.optional(),
    requestedProvider: nonEmptyStringSchema.optional(),
    resolvedModel: nonEmptyStringSchema.optional(),
    resolvedProvider: nonEmptyStringSchema.optional(),
    runId: identifierSchema,
    status: nonEmptyStringSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();

export const gateResultSchema = z
  .object({
    ...versionedSchemaShape,
    evidenceIds: stringListSchema,
    gateId: identifierSchema,
    message: nonEmptyStringSchema,
    status: gateStatusSchema,
  })
  .strict();

export const EVALUATION_EXIT_CODES = {
  gatesPassed: 0,
  gateFailed: 1,
  invalidInput: 2,
  infrastructureError: 3,
} as const;

export const evaluationExitCodeSchema = z.union([
  z.literal(EVALUATION_EXIT_CODES.gatesPassed),
  z.literal(EVALUATION_EXIT_CODES.gateFailed),
  z.literal(EVALUATION_EXIT_CODES.invalidInput),
  z.literal(EVALUATION_EXIT_CODES.infrastructureError),
]);

export type RequirementManifest = z.infer<
  typeof requirementManifestSchema
>;
export type ReplaySpec = z.infer<typeof replaySpecSchema>;
export type EvidenceLedgerEntry = z.infer<
  typeof evidenceLedgerEntrySchema
>;
export type GateResult = z.infer<typeof gateResultSchema>;
export type EvaluationExitCode = z.infer<
  typeof evaluationExitCodeSchema
>;
