import { z } from "zod";
import { discoveryMetadataSchema } from "./discovery.js";

import {
  finiteNumberSchema,
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  scopeSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const knowledgeKindSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
]);

export const evidenceMarkSchema = z.enum([
  "user_confirmed",
  "externally_verified",
  "repeated_evidence",
]);

export const evidenceTierSchema = z.enum([
  "inferred",
  "user_confirmed",
  "externally_verified",
  "repeated_evidence",
  "disputed",
  "locked_preference",
]);

export const knowledgeStateSchema = z.enum([
  "candidate",
  "active",
  "disputed",
  "superseded",
  "archived",
]);

const knowledgeUtilitySchema = z
  .object({
    applied: nonNegativeIntegerSchema,
    harmful: nonNegativeIntegerSchema,
    helpful: nonNegativeIntegerSchema,
  })
  .strict();

const knowledgeCoverageSchema = z
  .object({
    applicableOpportunities: nonNegativeIntegerSchema,
    observedOutcomes: nonNegativeIntegerSchema,
  })
  .strict();

export const knowledgeCandidateSchema = z
  .object({
    ...versionedSchemaShape,
    appliesWhen: stringListSchema,
    conflictsWith: stringListSchema,
    content: nonEmptyStringSchema,
    coverage: knowledgeCoverageSchema,
    createdAt: isoTimestampSchema,
    discovery: discoveryMetadataSchema.optional(),
    evidenceMarks: z.array(evidenceMarkSchema),
    evidenceTier: evidenceTierSchema,
    expiresAt: isoTimestampSchema.optional(),
    importance: finiteNumberSchema,
    kind: knowledgeKindSchema,
    knowledgeId: identifierSchema,
    nonApplicability: stringListSchema,
    scope: scopeSchema,
    scopeId: identifierSchema.optional(),
    sourceEpisodeIds: stringListSchema,
    sourceEvidenceIds: stringListSchema,
    state: knowledgeStateSchema,
    supersedes: identifierSchema.optional(),
    topicKey: nonEmptyStringSchema,
    utility: knowledgeUtilitySchema,
    validatedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type EvidenceMark = z.infer<typeof evidenceMarkSchema>;
export type EvidenceTier = z.infer<typeof evidenceTierSchema>;
export type KnowledgeCandidate = z.infer<typeof knowledgeCandidateSchema>;
