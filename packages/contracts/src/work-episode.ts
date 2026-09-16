import { z } from "zod";

import { repositoryStateSchema } from "./capture-metadata.js";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const episodeOutcomeSchema = z.enum([
  "unknown",
  "success",
  "partial",
  "failure",
  "reverted",
]);

export const outcomeQualificationSchema = z.enum([
  "open",
  "censored",
  "qualified",
]);

export const workEpisodeSchema = z
  .object({
    ...versionedSchemaShape,
    associationConfidence: finiteNumberSchema.min(0).max(1),
    associationEvidenceIds: stringListSchema.default([]),
    branches: stringListSchema,
    closureSourceEventIds: stringListSchema.optional(),
    commitIds: stringListSchema,
    correctionEventIds: stringListSchema,
    episodeId: identifierSchema,
    finishedAt: isoTimestampSchema.optional(),
    goal: nonEmptyStringSchema,
    goalSource: z.enum(["user_prompt", "activity_summary"]).optional(),
    goalSourceEventIds: stringListSchema.optional(),
    goalSourceTruncated: z.boolean().optional(),
    issueIds: stringListSchema,
    lastActivityAt: isoTimestampSchema.optional(),
    observationWindowEndsAt: isoTimestampSchema.optional(),
    outcome: episodeOutcomeSchema,
    outcomeEvidenceIds: stringListSchema,
    outcomeQualification: outcomeQualificationSchema,
    outcomeQualifiedAt: isoTimestampSchema.optional(),
    pullRequestIds: stringListSchema,
    repoId: identifierSchema.optional(),
    repositoryState: repositoryStateSchema.optional(),
    sessionIds: stringListSchema,
    sourceEventIds: stringListSchema.default([]),
    startedAt: isoTimestampSchema,
    worktrees: stringListSchema.optional(),
  })
  .strict();

export type WorkEpisode = z.infer<typeof workEpisodeSchema>;
