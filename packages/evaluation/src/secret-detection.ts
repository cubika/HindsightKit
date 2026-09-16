import type { EvidenceLedgerEntry } from "@provenloop/contracts";
import {
  containsKnownSecret,
  containsPotentialSecret,
} from "@provenloop/domain";

export {
  containsKnownSecret,
  containsPotentialSecret,
  redactKnownSecrets,
  redactPotentialSecrets,
} from "@provenloop/domain";

const allLedgerStrings = (
  entry: EvidenceLedgerEntry,
): readonly string[] =>
  [
    entry.actorId,
    entry.claimId,
    entry.episodeId,
    entry.eventId,
    entry.invocationId,
    entry.ledgerEntryId,
    entry.participantId,
    entry.requestedModel,
    entry.requestedProvider,
    entry.resolvedModel,
    entry.resolvedProvider,
    entry.runId,
    entry.status,
  ].filter((value): value is string => value !== undefined);

const entropyEligibleLedgerStrings = (
  entry: EvidenceLedgerEntry,
): readonly string[] =>
  [
    entry.actorId,
    entry.participantId,
    entry.requestedModel,
    entry.requestedProvider,
    entry.resolvedModel,
    entry.resolvedProvider,
  ].filter(
    (value): value is string =>
      value !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        value,
      ),
  );

export const immutableLedgerIdentifierContainsSecret = (
  entry: EvidenceLedgerEntry,
): boolean =>
  containsKnownSecret(entry.ledgerEntryId) ||
  containsKnownSecret(entry.runId);

export const ledgerEntryContainsSecret = (
  entry: EvidenceLedgerEntry,
): boolean =>
  allLedgerStrings(entry).some(containsKnownSecret) ||
  entropyEligibleLedgerStrings(entry).some(containsPotentialSecret);
