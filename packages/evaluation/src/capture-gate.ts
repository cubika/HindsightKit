import {
  captureEnvelopeSchema,
  classifyRawEvent,
  CURRENT_SCHEMA_VERSION,
  evidenceLedgerEntrySchema,
  gateResultSchema,
  type CaptureEnvelope,
  type EvidenceLedgerEntry,
  type GateResult,
} from "@provenloop/contracts";
import { createCaptureDeduplicationKey } from "@provenloop/domain";

import { sha256 } from "./digest.js";

export const createCanonicalCaptureLedgerEntry = (
  runId: string,
  envelope: CaptureEnvelope,
): EvidenceLedgerEntry => {
  const classification = classifyRawEvent(envelope.event);
  const status =
    classification.status === "supported"
      ? "event.supported"
      : classification.status === "unsupported_event_type"
        ? "event.unsupported_type"
        : classification.status === "unsupported_adapter_version"
          ? "event.unsupported_adapter_version"
          : "event.invalid";
  return evidenceLedgerEntrySchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: envelope.event.eventId,
    inputDigest: sha256(envelope),
    ledgerEntryId: `${runId}:capture:${envelope.deduplicationKey}`,
    runId,
    status,
    timestamp: envelope.event.timestamp,
  });
};

export const evaluateCanonicalCaptureGate = (
  envelope: CaptureEnvelope,
  ledgerEntry: EvidenceLedgerEntry,
  expectedRunId: string,
): GateResult => {
  const parsedEnvelope = captureEnvelopeSchema.parse(envelope);
  const parsedLedgerEntry =
    evidenceLedgerEntrySchema.parse(ledgerEntry);
  const classification = classifyRawEvent(parsedEnvelope.event);
  const failures: string[] = [];
  const sessionId = parsedEnvelope.event.sessionId;
  const expectedDeduplicationKey =
    sessionId === undefined
      ? undefined
      : createCaptureDeduplicationKey({
          adapter: parsedEnvelope.event.adapter,
          adapterVersion: parsedEnvelope.event.adapterVersion,
          eventType: parsedEnvelope.event.eventType,
          sessionId,
          sourceEventId: parsedEnvelope.sourceEventId,
        });
  if (classification.status !== "supported") {
    failures.push(
      `Canonical event classification is ${classification.status}.`,
    );
  }
  if (sessionId === undefined) {
    failures.push("Canonical event sessionId is missing.");
  }
  if (
    expectedDeduplicationKey !== undefined &&
    parsedEnvelope.deduplicationKey !== expectedDeduplicationKey
  ) {
    failures.push(
      "Canonical envelope deduplicationKey is inconsistent.",
    );
  }
  if (
    expectedDeduplicationKey !== undefined &&
    parsedEnvelope.event.eventId !==
      `event-${expectedDeduplicationKey}`
  ) {
    failures.push("Canonical eventId is inconsistent.");
  }
  if (parsedLedgerEntry.runId !== expectedRunId) {
    failures.push("Ledger runId does not match the expected run.");
  }
  if (
    parsedLedgerEntry.ledgerEntryId !==
    `${expectedRunId}:capture:${parsedEnvelope.deduplicationKey}`
  ) {
    failures.push(
      "Ledger entry identity does not match the canonical capture.",
    );
  }
  if (
    parsedLedgerEntry.timestamp !== parsedEnvelope.event.timestamp
  ) {
    failures.push(
      "Ledger timestamp does not match the canonical event.",
    );
  }
  if (parsedLedgerEntry.eventId !== parsedEnvelope.event.eventId) {
    failures.push("Ledger eventId does not match the canonical event.");
  }
  if (parsedLedgerEntry.inputDigest !== sha256(parsedEnvelope)) {
    failures.push(
      "Ledger inputDigest does not match the canonical envelope.",
    );
  }
  if (parsedLedgerEntry.status !== "event.supported") {
    failures.push("Ledger status is not event.supported.");
  }
  return gateResultSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    evidenceIds: [
      parsedLedgerEntry.ledgerEntryId,
    ],
    gateId: `${expectedRunId}:canonical-capture`,
    message:
      failures.length === 0
        ? "Canonical capture is supported and bound to Ledger evidence."
        : failures.join(" "),
    status: failures.length === 0 ? "pass" : "fail",
  });
};
