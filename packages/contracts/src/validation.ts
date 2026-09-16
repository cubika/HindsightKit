import { z } from "zod";

import {
  CURRENT_SCHEMA_VERSIONS,
  type SchemaName,
} from "./schema-registry.js";

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type SchemaValidationResult<Value> =
  | {
      readonly status: "valid";
      readonly value: Value;
    }
  | {
      readonly status: "unsupported_version";
      readonly receivedVersion: number;
      readonly supportedVersion: number;
    }
  | {
      readonly status: "invalid";
      readonly issues: readonly ValidationIssue[];
    };

const versionProbeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
  })
  .passthrough();

const toValidationIssues = (
  error: z.ZodError,
): readonly ValidationIssue[] =>
  error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
  }));

export const validateVersionedSchema = <Value>(
  schemaName: SchemaName,
  schema: z.ZodType<Value>,
  input: unknown,
): SchemaValidationResult<Value> => {
  const version = versionProbeSchema.safeParse(input);
  if (!version.success) {
    return {
      status: "invalid",
      issues: toValidationIssues(version.error),
    };
  }

  const supportedVersion = CURRENT_SCHEMA_VERSIONS[schemaName];
  if (version.data.schemaVersion !== supportedVersion) {
    return {
      status: "unsupported_version",
      receivedVersion: version.data.schemaVersion,
      supportedVersion,
    };
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      issues: toValidationIssues(parsed.error),
    };
  }

  return {
    status: "valid",
    value: parsed.data,
  };
};
