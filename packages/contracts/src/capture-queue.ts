import { z } from "zod";

import { captureEnvelopeSchema } from "./capture.js";
import {
  identifierSchema,
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  versionedSchemaShape,
} from "./common.js";

export const CAPTURE_QUEUE_STATES = [
  "pending",
  "claimed",
  "acknowledged",
  "retry",
  "dead-letter",
] as const;

export const captureQueueStateSchema = z.enum(CAPTURE_QUEUE_STATES);

const captureQueueItemBaseShape = {
  ...versionedSchemaShape,
  attemptCount: nonNegativeIntegerSchema,
  createdAt: isoTimestampSchema,
  envelope: captureEnvelopeSchema,
  failureCount: nonNegativeIntegerSchema.default(0),
  queueItemId: identifierSchema,
  updatedAt: isoTimestampSchema,
} as const;

const pendingCaptureQueueItemSchema = z
  .object({
    ...captureQueueItemBaseShape,
    state: z.literal("pending"),
  })
  .strict();

const claimedCaptureQueueItemSchema = z
  .object({
    ...captureQueueItemBaseShape,
    claimedAt: isoTimestampSchema,
    claimExpiresAt: isoTimestampSchema,
    claimOwnerId: identifierSchema,
    state: z.literal("claimed"),
  })
  .strict();

const acknowledgedCaptureQueueItemSchema = z
  .object({
    ...captureQueueItemBaseShape,
    acknowledgedAt: isoTimestampSchema,
    state: z.literal("acknowledged"),
  })
  .strict();

const retryCaptureQueueItemSchema = z
  .object({
    ...captureQueueItemBaseShape,
    lastError: nonEmptyStringSchema,
    nextAttemptAt: isoTimestampSchema,
    state: z.literal("retry"),
  })
  .strict();

const deadLetterCaptureQueueItemSchema = z
  .object({
    ...captureQueueItemBaseShape,
    lastError: nonEmptyStringSchema,
    state: z.literal("dead-letter"),
  })
  .strict();

export const captureQueueItemSchema = z.discriminatedUnion("state", [
  pendingCaptureQueueItemSchema,
  claimedCaptureQueueItemSchema,
  acknowledgedCaptureQueueItemSchema,
  retryCaptureQueueItemSchema,
  deadLetterCaptureQueueItemSchema,
]);

export type CaptureQueueItem = z.infer<typeof captureQueueItemSchema>;
export type CaptureQueueState = z.infer<typeof captureQueueStateSchema>;
