import { z } from "zod";
import { identifierSchema, isoTimestampSchema, sha256DigestSchema } from "./common.js";

export const discoveryEnrichmentJobSchema = z.object({
  schemaVersion: z.literal(1), knowledgeId: identifierSchema, knowledgeDigest: sha256DigestSchema,
  sourceDigest: sha256DigestSchema, metadataDigest: sha256DigestSchema, vocabularyVersion: z.string().min(1).max(128),
  state: z.enum(["pending", "running", "accepted", "rejected", "failed", "paused", "superseded"]),
  attempts: z.number().int().min(0).max(3), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema,
  retryAfter: isoTimestampSchema.optional(), deadline: isoTimestampSchema.optional(),
  reason: z.enum(["daily_budget", "disabled", "review_rejected", "invalid_metadata", "provider_failed", "stale_input", "deadline"]).optional(),
}).strict();
export type DiscoveryEnrichmentJob = z.infer<typeof discoveryEnrichmentJobSchema>;
