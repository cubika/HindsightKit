import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  scopeSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const correctionKeySchema = z
  .object({
    ...versionedSchemaShape,
    correctionKeyId: identifierSchema,
    createdAt: isoTimestampSchema,
    expectedBehavior: nonEmptyStringSchema,
    scope: scopeSchema,
    scopeId: identifierSchema.optional(),
    sourceCorrectionEventIds: stringListSchema,
    subsystem: nonEmptyStringSchema.optional(),
    taskFamily: nonEmptyStringSchema.optional(),
    trigger: nonEmptyStringSchema,
    verificationEvidenceIds: stringListSchema,
    violatedConstraint: nonEmptyStringSchema,
  })
  .strict();

export const correctionOpportunitySchema = z
  .object({
    ...versionedSchemaShape,
    applicable: z.boolean(),
    correctionKeyId: identifierSchema,
    correctionRepeated: z.boolean(),
    createdAt: isoTimestampSchema,
    episodeId: identifierSchema,
    knowledgeAppliedBeforeCorrection: z.boolean(),
    knowledgeAvailableBeforeCorrection: z.boolean(),
    opportunityId: identifierSchema,
    outcomeKnown: z.boolean(),
  })
  .strict();

export type CorrectionKey = z.infer<typeof correctionKeySchema>;
export type CorrectionOpportunity = z.infer<
  typeof correctionOpportunitySchema
>;
