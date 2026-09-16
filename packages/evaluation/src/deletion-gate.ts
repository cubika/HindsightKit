import { randomUUID } from "node:crypto";

import {
  CURRENT_SCHEMA_VERSION,
  evidenceLedgerEntrySchema,
  gateResultSchema,
  type EvidenceLedgerEntry,
  type GateResult,
} from "@provenloop/contracts";
import {
  sha256,
} from "@provenloop/domain";

export interface DeletionPropagationGateInput {
  readonly attemptCount: number;
  readonly deletionId: string;
  readonly dependentIds: readonly string[];
  readonly remainingIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly timestamp: string;
}

export interface DeletionPropagationGateResult {
  readonly gate: GateResult;
  readonly gateDigest: string;
  readonly ledgerEntry: EvidenceLedgerEntry;
}

const sorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort();

export const evaluateDeletionPropagation = (
  input: DeletionPropagationGateInput,
): DeletionPropagationGateResult => {
  const sourceIds = sorted(input.sourceIds);
  const dependentIds = sorted(input.dependentIds);
  const remainingIds = sorted(input.remainingIds);
  const evidenceNonce = randomUUID();
  const gateDigest = sha256({
    dependentIds,
    evidenceNonce,
    remainingIds,
    sourceIds,
    supported: true,
  });
  const ledgerEntry = evidenceLedgerEntrySchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ledgerEntryId:
      `${input.deletionId}:propagation:${input.attemptCount}:${randomUUID()}`,
    runId: input.deletionId,
    status: "deletion.propagation.checked",
    outputDigest: gateDigest,
    timestamp: input.timestamp,
  });
  const prohibited = new Set([
    ...sourceIds,
    ...dependentIds,
  ]);
  const leaked = remainingIds.filter((id) => prohibited.has(id));
  const gate = gateResultSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    evidenceIds: [
      ledgerEntry.ledgerEntryId,
    ],
    gateId: `${input.deletionId}:deletion-propagation`,
    message:
      leaked.length === 0
        ? "Deleted sources and dependent records are absent."
        : `Deleted identifiers remain: ${leaked.join(", ")}.`,
    status: leaked.length === 0 ? "pass" : "fail",
  });
  return {
    gate,
    gateDigest,
    ledgerEntry,
  };
};

export const createDeletionCompletionEvidence = (input: {
  readonly deletionId: string;
  readonly gateDigest: string;
  readonly propagationEvidenceId: string;
  readonly timestamp: string;
}): EvidenceLedgerEntry =>
  evidenceLedgerEntrySchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ledgerEntryId: `${input.deletionId}:completed`,
    runId: input.deletionId,
    status: "deletion.completed",
    inputDigest: sha256({
      propagationEvidenceId: input.propagationEvidenceId,
    }),
    outputDigest: input.gateDigest,
    timestamp: input.timestamp,
  });
