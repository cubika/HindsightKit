import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  scopeSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const feedbackTargetTypeSchema = z.enum([
  "branch_context",
  "knowledge",
  "playbook",
  "episode",
  "process_claim",
]);

export const feedbackKindSchema = z.enum([
  "confirm",
  "irrelevant",
  "correct",
  "stale",
  "conflict",
  "weaken",
  "strengthen",
  "revoke",
  "set_scope",
  "mute_session",
]);

export const feedbackSourceSchema = z.enum([
  "user",
  "test",
  "ci",
  "review",
  "revert",
  "analyzer",
  "process_verifier",
]);

const scopeChangeSchema = z
  .object({
    scope: scopeSchema,
    scopeId: identifierSchema.optional(),
  })
  .strict();

export const feedbackEventSchema = z
  .object({
    ...versionedSchemaShape,
    evidenceRef: identifierSchema,
    feedbackId: identifierSchema,
    kind: feedbackKindSchema,
    reason: nonEmptyStringSchema.optional(),
    resolvesEvidenceIds: stringListSchema.optional(),
    scopeChange: scopeChangeSchema.optional(),
    source: feedbackSourceSchema,
    targetId: identifierSchema,
    targetType: feedbackTargetTypeSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();

export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;
