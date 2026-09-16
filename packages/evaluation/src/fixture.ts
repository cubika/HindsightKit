import { z } from "zod";

import {
  CURRENT_SCHEMA_VERSION,
  evidenceLedgerEntrySchema,
  processClaimSchema,
} from "@provenloop/contracts";

const nonEmptyStringSchema = z.string().trim().min(1);
const assertionIdSchema = nonEmptyStringSchema;

const identityAssertionSchema = z
  .object({
    assertionId: assertionIdSchema,
    expectedParticipantId: nonEmptyStringSchema.optional(),
    expectedResolvedModel: nonEmptyStringSchema.optional(),
    expectedResolvedProvider: nonEmptyStringSchema.optional(),
    invocationId: nonEmptyStringSchema,
  })
  .strict();

const commandAssertionSchema = z
  .object({
    assertionId: assertionIdSchema,
    claimId: nonEmptyStringSchema.optional(),
    episodeId: nonEmptyStringSchema.optional(),
    expectedExitCode: z.number().int(),
    expectedStatus: z.enum([
      "succeeded",
      "failed",
    ]),
    invocationId: nonEmptyStringSchema,
  })
  .strict();

const persistedContentSchema = z
  .object({
    evidenceId: nonEmptyStringSchema,
    value: z.string(),
  })
  .strict();

const repositoryScopeAssertionSchema = z
  .object({
    evidenceId: nonEmptyStringSchema,
    scope: z.literal("repository"),
    sourceRepoId: nonEmptyStringSchema,
    targetRepoId: nonEmptyStringSchema,
  })
  .strict();

const deletionAssertionSchema = z
  .object({
    dependentIds: z.array(nonEmptyStringSchema),
    evidenceId: nonEmptyStringSchema,
    remainingIds: z.array(nonEmptyStringSchema),
    sourceIds: z.array(nonEmptyStringSchema),
    supported: z.boolean(),
  })
  .strict();

const queueAssertionSchema = z
  .object({
    evidenceId: nonEmptyStringSchema,
    interruptedState: z.enum([
      "pending",
      "claimed",
      "acknowledged",
      "retry",
      "dead-letter",
    ]),
    itemId: nonEmptyStringSchema,
    lost: z.boolean(),
    recoveredState: z.enum([
      "pending",
      "claimed",
      "acknowledged",
      "retry",
      "dead-letter",
    ]),
  })
  .strict();

export const evaluationFixtureSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    commandAssertions: z.array(commandAssertionSchema).default([]),
    deletionAssertions: z.array(deletionAssertionSchema).default([]),
    evidence: z.array(evidenceLedgerEntrySchema).default([]),
    events: z.array(z.unknown()).default([]),
    expectedCanonicalEventCount: z.number().int().nonnegative().optional(),
    fixtureId: nonEmptyStringSchema,
    fixtureVersion: z.number().int().positive(),
    identityAssertions: z.array(identityAssertionSchema).default([]),
    persistedContents: z.array(persistedContentSchema).default([]),
    processClaims: z.array(processClaimSchema).default([]),
    queueAssertions: z.array(queueAssertionSchema).default([]),
    repositoryScopeAssertions: z
      .array(repositoryScopeAssertionSchema)
      .default([]),
  })
  .strict();

export type EvaluationFixture = z.infer<typeof evaluationFixtureSchema>;
