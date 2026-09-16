import { z } from "zod";

import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  stringListSchema,
  versionedSchemaShape,
} from "./common.js";

export const processClaimKindSchema = z.enum([
  "tested",
  "reviewed",
  "protocol_completed",
  "consensus",
  "other",
]);

export const processClaimStatusSchema = z.enum([
  "declared",
  "verified",
  "rejected",
  "inconclusive",
]);

export const processClaimSchema = z
  .object({
    ...versionedSchemaShape,
    availabilityEvidenceIds: stringListSchema,
    claimId: identifierSchema,
    createdAt: isoTimestampSchema,
    episodeId: identifierSchema,
    evidenceIds: stringListSchema,
    invocationIds: stringListSchema,
    kind: processClaimKindSchema,
    protocol: nonEmptyStringSchema.optional(),
    protocolVersion: nonEmptyStringSchema.optional(),
    requiredEvidence: stringListSchema,
    requiredParticipantIds: stringListSchema,
    status: processClaimStatusSchema,
    verifiedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type ProcessClaim = z.infer<typeof processClaimSchema>;
