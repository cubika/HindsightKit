import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const outcomeEvidenceKindSchema = z.enum([
  "test",
  "build",
  "ci",
  "review",
  "fix",
  "bug",
  "revert",
  "user",
]);

export const outcomeEvidenceStrengthSchema = z.enum([
  "direct",
  "plausible",
  "uncertain",
  "unrelated",
]);

export const outcomeEvidenceStateSchema = z.enum([
  "candidate",
  "accepted",
  "rejected",
]);

export const outcomeEvidenceLinkSchema = z
  .object({
    ...versionedSchemaShape,
    createdAt: isoTimestampSchema,
    decidedAt: isoTimestampSchema.optional(),
    episodeId: identifierSchema,
    evidenceId: identifierSchema,
    kind: outcomeEvidenceKindSchema,
    linkId: identifierSchema,
    state: outcomeEvidenceStateSchema,
    strength: outcomeEvidenceStrengthSchema,
    supportingEvidenceIds: stringListSchema,
  })
  .strict();

export type OutcomeEvidenceLink = z.infer<typeof outcomeEvidenceLinkSchema>;
