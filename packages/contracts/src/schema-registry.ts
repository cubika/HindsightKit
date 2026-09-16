import { z } from "zod";

import { CURRENT_SCHEMA_VERSION } from "./common.js";

export const SCHEMA_NAMES = [
  "adapterCapability",
  "rawEvent",
  "captureEnvelope",
  "captureQueueItem",
  "deletionOperation",
  "episodeAssociation",
  "episodeGroupingCorrection",
  "workEpisode",
  "branchContext",
  "correctionKey",
  "outcomeEvidenceLink",
  "knowledgeCandidate",
  "feedbackEvent",
  "processClaim",
  "contextUseRecord",
  "correctionOpportunity",
  "requirementManifest",
  "replaySpec",
  "evidenceLedgerEntry",
  "gateResult",
] as const;

export const schemaNameSchema = z.enum(SCHEMA_NAMES);

export type SchemaName = z.infer<typeof schemaNameSchema>;

export interface SchemaMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (input: unknown) => unknown;
}

const noMigrations: readonly SchemaMigration[] = [];

export const CURRENT_SCHEMA_VERSIONS = {
  adapterCapability: CURRENT_SCHEMA_VERSION,
  branchContext: CURRENT_SCHEMA_VERSION,
  captureEnvelope: CURRENT_SCHEMA_VERSION,
  captureQueueItem: CURRENT_SCHEMA_VERSION,
  contextUseRecord: CURRENT_SCHEMA_VERSION,
  correctionKey: CURRENT_SCHEMA_VERSION,
  correctionOpportunity: CURRENT_SCHEMA_VERSION,
  deletionOperation: CURRENT_SCHEMA_VERSION,
  episodeAssociation: CURRENT_SCHEMA_VERSION,
  episodeGroupingCorrection: CURRENT_SCHEMA_VERSION,
  evidenceLedgerEntry: CURRENT_SCHEMA_VERSION,
  feedbackEvent: CURRENT_SCHEMA_VERSION,
  gateResult: CURRENT_SCHEMA_VERSION,
  knowledgeCandidate: CURRENT_SCHEMA_VERSION,
  outcomeEvidenceLink: CURRENT_SCHEMA_VERSION,
  processClaim: CURRENT_SCHEMA_VERSION,
  rawEvent: CURRENT_SCHEMA_VERSION,
  replaySpec: CURRENT_SCHEMA_VERSION,
  requirementManifest: CURRENT_SCHEMA_VERSION,
  workEpisode: CURRENT_SCHEMA_VERSION,
} as const satisfies Readonly<Record<SchemaName, number>>;

export const SCHEMA_MIGRATIONS = {
  adapterCapability: noMigrations,
  branchContext: noMigrations,
  captureEnvelope: noMigrations,
  captureQueueItem: noMigrations,
  contextUseRecord: noMigrations,
  correctionKey: noMigrations,
  correctionOpportunity: noMigrations,
  deletionOperation: noMigrations,
  episodeAssociation: noMigrations,
  episodeGroupingCorrection: noMigrations,
  evidenceLedgerEntry: noMigrations,
  feedbackEvent: noMigrations,
  gateResult: noMigrations,
  knowledgeCandidate: noMigrations,
  outcomeEvidenceLink: noMigrations,
  processClaim: noMigrations,
  rawEvent: noMigrations,
  replaySpec: noMigrations,
  requirementManifest: noMigrations,
  workEpisode: noMigrations,
} as const satisfies Readonly<Record<SchemaName, readonly SchemaMigration[]>>;

export const UNSUPPORTED_SCHEMA_VERSION_POLICY = "reject" as const;
