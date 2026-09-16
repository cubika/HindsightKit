import { z } from "zod";

import {
  identifierSchema,
  nonEmptyStringSchema,
  versionedSchemaShape,
} from "./common.js";

export const repositoryStateSchema = z.enum([
  "known_repo",
  "known_outside_repo",
  "unknown",
]);

const fieldPathSchema = nonEmptyStringSchema.max(256);

export const captureQualitySchema = z
  .object({
    ...versionedSchemaShape,
    truncatedFields: z.array(fieldPathSchema).max(256),
    omittedFields: z.array(fieldPathSchema).max(256),
    originalLengths: z.record(
      fieldPathSchema,
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ).refine((values) => Object.keys(values).length <= 256, {
      message: "Capture quality has too many original-length entries.",
    }),
  })
  .strict();

export const captureEvidenceSchema = z
  .object({
    ...versionedSchemaShape,
    kind: z.enum([
      "command_verification",
      "file_change",
      "head_observation",
    ]),
    repositoryState: repositoryStateSchema,
    sourceStartEventId: identifierSchema.optional(),
    sourceCompleteEventId: identifierSchema.optional(),
    operationId: identifierSchema.optional(),
    commandFamily: nonEmptyStringSchema.max(128).optional(),
    exitCode: z.number().int().optional(),
    targetPaths: z.array(nonEmptyStringSchema.max(4_096)).max(32).optional(),
    workingDirectory: nonEmptyStringSchema.max(4_096).optional(),
  })
  .strict();

export type RepositoryState = z.infer<typeof repositoryStateSchema>;
export type CaptureQuality = z.infer<typeof captureQualitySchema>;
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
