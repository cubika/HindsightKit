import { z } from "zod";

import {
  isoTimestampSchema,
  nonEmptyStringSchema,
  sha256DigestSchema,
  versionedSchemaShape,
} from "./common.js";
import { rawEventSchema } from "./raw-event.js";

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const CAPTURE_REDACTION_RULE_VERSION = 1 as const;

export const captureContentSchema = z
  .object({
    message: z.string().optional(),
    safeError: z.string().optional(),
    toolResult: jsonValueSchema.optional(),
  })
  .strict();

export const captureRedactionSchema = z
  .object({
    appliedRules: z.array(nonEmptyStringSchema),
    contentDigest: sha256DigestSchema.optional(),
    droppedPaths: z.array(nonEmptyStringSchema),
    redactedPaths: z.array(nonEmptyStringSchema),
    ruleVersion: z.literal(CAPTURE_REDACTION_RULE_VERSION),
    truncatedPaths: z.array(nonEmptyStringSchema),
  })
  .strict();

const persistedRawEventSchema = rawEventSchema.extend({
  redactedArguments: jsonValueSchema.optional(),
});

export const captureEnvelopeSchema = z
  .object({
    ...versionedSchemaShape,
    capturedAt: isoTimestampSchema,
    content: captureContentSchema.optional(),
    deduplicationKey: sha256DigestSchema,
    event: persistedRawEventSchema,
    redaction: captureRedactionSchema,
    sourceEventId: nonEmptyStringSchema,
  })
  .strict();

export type CaptureContent = z.infer<typeof captureContentSchema>;
export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;
export type CaptureRedaction = z.infer<typeof captureRedactionSchema>;
