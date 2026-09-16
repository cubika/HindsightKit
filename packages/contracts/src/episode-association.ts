import { z } from "zod";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const episodeAssociationSignalSchema = z.enum([
  "explicit_merge",
  "explicit_split",
  "repository",
  "branch",
  "commit",
  "commit_ancestry",
  "pull_request",
  "issue",
  "changed_file",
  "test_or_error",
  "task_semantics",
  "temporal_proximity",
]);

export const episodeAssociationStatusSchema = z.enum([
  "associated",
  "candidate",
  "rejected",
]);

export const episodeAssociationEvidenceSchema = z
  .object({
    detail: nonEmptyStringSchema,
    evidenceId: identifierSchema,
    signal: episodeAssociationSignalSchema,
    sourceEventIds: stringListSchema,
    weight: finiteNumberSchema.min(0).max(1),
  })
  .strict();

export const episodeAssociationSchema = z
  .object({
    ...versionedSchemaShape,
    associationId: identifierSchema,
    confidence: finiteNumberSchema.min(0).max(1),
    correctionIds: stringListSchema,
    createdAt: isoTimestampSchema,
    evidence: z.array(episodeAssociationEvidenceSchema).min(1),
    leftSessionId: identifierSchema,
    rightSessionId: identifierSchema,
    status: episodeAssociationStatusSchema,
  })
  .strict()
  .refine(
    (association) =>
      association.leftSessionId < association.rightSessionId,
    {
      message:
        "Episode association Session IDs must be in lexical order.",
    },
  );

export const episodeGroupingCorrectionActionSchema = z.enum([
  "merge",
  "split",
]);

export const episodeGroupingCorrectionSchema = z
  .object({
    ...versionedSchemaShape,
    action: episodeGroupingCorrectionActionSchema,
    correctionId: identifierSchema,
    reason: nonEmptyStringSchema.optional(),
    sessionIds: z.array(identifierSchema).min(2),
    timestamp: isoTimestampSchema,
  })
  .strict()
  .refine(
    (correction) =>
      new Set(correction.sessionIds).size ===
      correction.sessionIds.length,
    {
      message: "Episode correction Session IDs must be unique.",
    },
  );

export type EpisodeAssociation = z.infer<
  typeof episodeAssociationSchema
>;
export type EpisodeAssociationEvidence = z.infer<
  typeof episodeAssociationEvidenceSchema
>;
export type EpisodeAssociationSignal = z.infer<
  typeof episodeAssociationSignalSchema
>;
export type EpisodeAssociationStatus = z.infer<
  typeof episodeAssociationStatusSchema
>;
export type EpisodeGroupingCorrection = z.infer<
  typeof episodeGroupingCorrectionSchema
>;
