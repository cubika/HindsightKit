import { z } from "zod";
import { isoTimestampSchema, sha256DigestSchema } from "./common.js";

export const DISCOVERY_MAX_PROFILE_BYTES = 65_536;
const boundedText = z.string().trim().min(1);
export const experiencePurposeSchema = z.enum(["fact", "constraint", "lesson", "procedure", "rationale"]);
export const discoveryPolaritySchema = z.enum(["positive", "excluded_context", "required_condition"]);

export const discoveryFeatureSchema = <T extends z.ZodTypeAny>(value: T) => z.object({
  value, basisIds: z.array(boundedText.max(128)).min(1).max(32), polarity: discoveryPolaritySchema,
}).strict();

export const discoveryEntitySchema = z.object({ kind: boundedText.max(64), value: boundedText.max(512) }).strict();
export const discoveryParaphraseSchema = z.object({ language: boundedText.max(32), text: boundedText.max(1_024) }).strict();
export const discoveryBasisSchema = z.object({
  id: boundedText.max(128), field: z.enum(["content", "appliesWhen", "nonApplicability"]),
  clauseIndex: z.number().int().min(0).max(1_024).optional(), text: boundedText.max(8_192),
}).strict();

/** Navigation only. A pointer does not establish evidence or authorize a read. */
export const sourceReferenceSchema = z.object({
  sourceRefId: boundedText.max(128), kind: z.enum(["file", "directory", "url"]),
  locator: boundedText.max(2_048), repositoryId: boundedText.max(256).optional(),
  anchor: boundedText.max(512).optional(), evidenceIds: z.array(boundedText.max(256)).max(32).default([]),
  contentDigest: sha256DigestSchema.optional(), revision: boundedText.max(256).optional(),
  availability: z.enum(["captured", "pointer_only", "unavailable"]), observedAt: isoTimestampSchema.optional(),
  relationship: z.enum(["supports", "background", "investigation_start"]),
}).strict().superRefine((reference, context) => {
  if (reference.kind === "directory" && reference.relationship !== "investigation_start") {
    context.addIssue({ code: "custom", path: ["relationship"], message: "A directory is an investigation starting point." });
  }
  if (reference.kind === "url") {
    try {
      if (!["http:", "https:"].includes(new URL(reference.locator).protocol)) throw new Error("protocol");
    } catch { context.addIssue({ code: "custom", path: ["locator"], message: "Expected an HTTP or HTTPS URL." }); }
  }
});

const featureShape = {
  purposes: z.array(discoveryFeatureSchema(experiencePurposeSchema)).max(2),
  topics: z.array(discoveryFeatureSchema(boundedText.max(128))).max(8),
  entities: z.array(discoveryFeatureSchema(discoveryEntitySchema)).max(16),
  paraphrases: z.array(discoveryFeatureSchema(discoveryParaphraseSchema)).max(8),
  shorterSummary: discoveryFeatureSchema(boundedText.max(2_048)).optional(),
};

export const discoveryMetadataSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  purposes: featureShape.purposes.optional(), topics: featureShape.topics.optional(),
  entities: featureShape.entities.optional(), paraphrases: featureShape.paraphrases.optional(),
  shorterSummary: featureShape.shorterSummary, sourceReferences: z.array(sourceReferenceSchema).max(16).optional(),
  producer: z.enum(["deterministic", "model_reviewed", "user"]).optional(),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > DISCOVERY_MAX_PROFILE_BYTES) {
    context.addIssue({ code: "custom", message: "Discovery metadata exceeds the byte limit." });
  }
});

export const discoveryReviewSchema = z.object({
  discoveryInputDigest: sha256DigestSchema, profileDigest: sha256DigestSchema,
  reviewVersion: boundedText.max(128), reviewer: boundedText.max(256),
  reviewDigest: sha256DigestSchema, accepted: z.boolean(),
}).strict();

export const discoveryProfileSchema = z.object({
  schemaVersion: z.literal(1), knowledgeId: boundedText.max(256), knowledgeDigest: sha256DigestSchema,
  vocabularyVersion: boundedText.max(128), ...featureShape, basis: z.array(discoveryBasisSchema).max(33),
  sourceReferences: z.array(sourceReferenceSchema).max(16),
  producer: z.enum(["deterministic", "model_reviewed", "user"]),
  discoveryInputDigest: sha256DigestSchema, profileDigest: sha256DigestSchema, review: discoveryReviewSchema.optional(),
}).strict().superRefine((value, context) => {
  const basisIds = new Set(value.basis.map((basis) => basis.id));
  if (basisIds.size !== value.basis.length) context.addIssue({ code: "custom", path: ["basis"], message: "Basis IDs must be unique." });
  const features = [...value.purposes, ...value.topics, ...value.entities, ...value.paraphrases, ...(value.shorterSummary ? [value.shorterSummary] : [])];
  if (features.some((feature) => feature.basisIds.some((id) => !basisIds.has(id)))) {
    context.addIssue({ code: "custom", message: "Every discovery feature must reference an existing basis." });
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > DISCOVERY_MAX_PROFILE_BYTES) {
    context.addIssue({ code: "custom", message: "Discovery profile exceeds the byte limit." });
  }
});

export type ExperiencePurpose = z.infer<typeof experiencePurposeSchema>;
export type DiscoveryPolarity = z.infer<typeof discoveryPolaritySchema>;
export interface DiscoveryFeature<T> { value: T; basisIds: string[]; polarity: DiscoveryPolarity }
export type DiscoveryEntity = z.infer<typeof discoveryEntitySchema>;
export type DiscoveryParaphrase = z.infer<typeof discoveryParaphraseSchema>;
export type DiscoveryBasis = z.infer<typeof discoveryBasisSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type DiscoveryMetadata = z.infer<typeof discoveryMetadataSchema>;
export type DiscoveryProfile = z.infer<typeof discoveryProfileSchema>;
export type DiscoveryReview = z.infer<typeof discoveryReviewSchema>;
