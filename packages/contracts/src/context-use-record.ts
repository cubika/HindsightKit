import { z } from "zod";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  sha256DigestSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const contextFeedbackSchema = z.enum([
  "helpful",
  "ignored",
  "irrelevant",
  "wrong",
  "stale",
]);

export const contextRetrievalStatusSchema = z.enum([
  "provided",
  "no_match",
  "disabled",
  "muted",
  "degraded",
]);

export const contextRelevanceSchema = z.object({
  knowledgeId: identifierSchema,
  knowledgeDigest: sha256DigestSchema,
  profileDigest: sha256DigestSchema.optional(),
  querySignature: sha256DigestSchema,
  policyVersion: z.string().trim().min(1).max(128),
  matchedConcepts: z.array(z.string().trim().min(1).max(128)).max(16),
  matchedEntities: z.array(z.string().trim().min(1).max(512)).max(16),
  unresolvedConditions: z.array(z.string().trim().min(1).max(2048)).max(16),
}).strict();

export const contextUseRecordSchema = z
  .object({
    ...versionedSchemaShape,
    appliedKnowledgeIds: stringListSchema,
    branch: nonEmptyStringSchema.optional(),
    candidateKnowledgeIds: stringListSchema,
    codeVersion: nonEmptyStringSchema.optional(),
    createdAt: isoTimestampSchema,
    episodeId: identifierSchema.optional(),
    feedback: contextFeedbackSchema.optional(),
    latencyMs: finiteNumberSchema.nonnegative(),
    repoId: identifierSchema.optional(),
    renderedTokens: nonNegativeIntegerSchema,
    requestId: identifierSchema,
    retrievalMode: z.enum(["context", "search"]).optional(),
    relevance: z.array(contextRelevanceSchema).max(60).optional(),
    retrievalStatus: contextRetrievalStatusSchema.optional(),
    returnedKnowledgeIds: stringListSchema,
    sessionId: identifierSchema,
    updatedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type ContextUseRecord = z.infer<typeof contextUseRecordSchema>;
export type ContextRelevance = z.infer<typeof contextRelevanceSchema>;
export type ContextRetrievalStatus = z.infer<
  typeof contextRetrievalStatusSchema
>;
