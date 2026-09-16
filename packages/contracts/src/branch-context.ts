import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const branchContextSchema = z
  .object({
    ...versionedSchemaShape,
    acceptedDecisions: stringListSchema,
    branch: nonEmptyStringSchema,
    branchContextId: identifierSchema,
    closedAt: isoTimestampSchema.optional(),
    closureSourceEventIds: stringListSchema.optional(),
    expiresAt: isoTimestampSchema.optional(),
    explicitConstraints: stringListSchema,
    goal: nonEmptyStringSchema.optional(),
    goalSourceEventId: identifierSchema.optional(),
    headSha: nonEmptyStringSchema,
    implementationState: stringListSchema,
    recentVerificationEvidenceIds: stringListSchema,
    repoId: identifierSchema,
    sourceEpisodeIds: stringListSchema,
    sourceEventIds: stringListSchema.default([]),
    sourceSessionIds: stringListSchema.optional(),
    supersededAt: isoTimestampSchema.optional(),
    supersedingSourceEventId: identifierSchema.optional(),
    unfinishedItems: stringListSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type BranchContext = z.infer<typeof branchContextSchema>;
