import { z } from "zod";

import { ARTIFACT_FORMAT_VERSIONS } from "./artifact-format-versions.js";

export const CURRENT_SCHEMA_VERSION = ARTIFACT_FORMAT_VERSIONS.schema;

export const versionedSchemaShape = {
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
} as const;

export const identifierSchema = z.string().trim().min(1);
export const nonEmptyStringSchema = z.string().trim().min(1);
export const sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);
export const isoTimestampSchema = z.string().datetime({
  offset: true,
});
export const finiteNumberSchema = z.number().finite();
export const nonNegativeIntegerSchema = z.number().int().nonnegative();
export const stringListSchema = z.array(nonEmptyStringSchema);

export const scopeSchema = z.enum([
  "personal",
  "workflow",
  "repository",
  "branch",
]);

export type Scope = z.infer<typeof scopeSchema>;
