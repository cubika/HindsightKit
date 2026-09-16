import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  backup,
  DatabaseSync,
} from "./node-sqlite.js";

import {
  branchContextSchema,
  discoveryEnrichmentJobSchema, discoveryProfileSchema, type DiscoveryEnrichmentJob, type DiscoveryProfile,
  learningWindowSchema, learningJobSchema, ruleProposalSchema, learningRecoveryReceiptSchema,
  type LearningWindow, type LearningJob, type RuleProposal, type LearningRecoveryReceipt, type LearningComparisonCandidate,
  learningComparisonCandidateSchema, learningProposalSource,
  captureEnvelopeSchema,
  captureQueueItemSchema,
  classifyRawEvent,
  CURRENT_SCHEMA_VERSION,
  contextUseRecordSchema,
  correctionKeySchema,
  correctionOpportunitySchema,
  deletionOperationSchema,
  deletionTargetTypeSchema,
  episodeAssociationSchema,
  episodeGroupingCorrectionSchema,
  feedbackEventSchema,
  knowledgeCandidateSchema,
  isoTimestampSchema,
  workEpisodeSchema,
  type BranchContext,
  type CaptureEnvelope,
  type CaptureQueueItem,
  type ContextUseRecord,
  type CorrectionKey,
  type CorrectionOpportunity,
  type DeletionOperation,
  type DeletionPlannedIdentity,
  type DeletionIdentityType,
  type DeletionTargetType,
  type EpisodeAssociation,
  type EpisodeGroupingCorrection,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  createCaptureDeduplicationKey,
  deletionIdentityDigest,
  redactCaptureEnvelopeForPersistence,
  sanitizeDiagnostic,
  sha256,
  KnowledgeAdmissionPolicy,
  validateLearningResponse,
  hasAcceptedLearningDistillation,
  learningSourceUse, researchTerms, containsPotentialSecret,
  conflictingShellLearning,
  selectAgentResearchEvents,
  closedAgentResearchTurn,
  knowledgeDiscoveryDigest, validateDiscoveryProfile, DISCOVERY_VOCABULARY_VERSION,
  type ResearchTurnEvent,
} from "@provenloop/domain";
import {
  resolveWindowsProvenLoopLeaseName,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";

export interface SqliteMigration {
  readonly sql: string;
  readonly version: number;
}

export interface CanonicalSqliteStoreOptions {
  /** Reserved for the reset coordinator while it owns the maintenance barriers. */
  readonly allowRecordsReset?: boolean;
  readonly allowSchemaMigration?: boolean;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: (
    stage: "after_raw_event_insert" | "after_restore_key_install" | "before_reset_generation_publish",
  ) => void;
  readonly migrations?: readonly SqliteMigration[];
  readonly now?: () => Date;
}

export interface CanonicalStoreHealth {
  readonly busyTimeoutMs: number;
  readonly journalMode: string;
  readonly quickCheck: string;
  readonly userVersion: number;
}

export interface CanonicalRestoreOptions extends CanonicalSqliteStoreOptions {
  readonly expectedTargetFingerprint?: string;
}

export interface CanonicalBackupManifest {
  readonly formatVersion: 1;
  readonly product: "ProvenLoopCanonicalBackup";
  readonly createdAt: string;
  readonly databaseDigest: string;
  readonly deletionKeyDigest: string;
  readonly schemaVersion: number;
  readonly runtimeVersion?: string;
}

export interface CanonicalTimeRange {
  readonly since: string;
  readonly until: string;
  readonly timeBasis?: "event" | "observed";
  readonly sessionId?: string;
  readonly limit?: number;
  readonly after?: {
    readonly timestamp: string;
    readonly id: string;
  };
}

export interface CanonicalRangePage<T> {
  readonly records: readonly T[];
  readonly next?: { readonly timestamp: string; readonly id: string };
}

export interface CanonicalEnrichmentResult {
  readonly status: "enriched" | "duplicate" | "rejected";
  readonly reason?: string;
}

export interface CanonicalRecordsResetCounts {
  readonly events: number;
  readonly knowledge: number;
  readonly episodes: number;
  readonly jobs: number;
  readonly usage: number;
  readonly records: number;
}

export interface LearningPromptWork {
  readonly deduplicationKey: string;
  readonly eventId: string;
  readonly generation: number;
  readonly events: readonly CaptureEnvelope[];
  readonly origin?: "agent";
}

interface RestoreJournal {
  readonly formatVersion: 1;
  readonly pid: number;
  readonly operationId: string;
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly previousPath: string;
  readonly hadTarget: boolean;
  readonly phase: "preparing" | "installing";
  readonly previousDigest?: string;
  readonly replacementDigest?: string;
}

export type CanonicalIngestResult =
  | {
      readonly deduplicationKey: string;
      readonly status: "duplicate" | "stored";
    }
  | {
      readonly deduplicationKey: string;
      readonly reason: string;
      readonly status: "rejected" | "unsupported";
    };

export interface CanonicalRawEventRecord {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly deduplicationKey: string;
  readonly deliveryCount: number;
  readonly envelope: CaptureEnvelope;
  readonly eventId: string;
  readonly eventType: string;
  readonly lastSeenAt?: string;
  readonly parseStatus: string;
  readonly sessionId?: string;
  readonly sourceEventId: string;
}

export interface CanonicalParserErrorRecord {
  readonly errorKind: string;
  readonly message: string;
  readonly queueItemId: string;
}

export interface QueueProcessingRecord {
  readonly queueItemId: string;
  readonly status: string;
}

export interface WorkEpisodeProjectionWriteResult {
  readonly associations: number;
  readonly corrections: number;
  readonly episodes: number;
}

export interface CorrectionProjectionWriteResult {
  readonly correctionKeys: number;
  readonly opportunities: number;
}

export interface CanonicalKnowledgeAdmissionEvidence {
  readonly learningProposals?: readonly RuleProposal[];
  readonly learningReceipts?: readonly LearningRecoveryReceipt[];
  readonly contextUseRecords: readonly ContextUseRecord[];
  readonly correctionKeys: readonly CorrectionKey[];
  readonly correctionSourceEventIds: ReadonlySet<string>;
  readonly envelopes: readonly CaptureEnvelope[];
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly workEpisodes: readonly WorkEpisode[];
}

export interface CanonicalDeletionTarget {
  readonly targetId: string;
  readonly targetType: DeletionTargetType;
}

export interface CanonicalDeletionMutationResult {
  readonly affectedSessionIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly sourceIds: readonly string[];
}

const canonicalReferenceMigrationSql = (
  table: "raw_events" | "parser_errors",
  path: string,
): string => {
  const value = `json_extract(safe_envelope_json, '${path}')`;
  return `UPDATE ${table}
    SET safe_envelope_json = json_set(safe_envelope_json, '${path}', lower(${value}))
    WHERE safe_envelope_json IS NOT NULL
      AND typeof(${value}) = 'text'
      AND length(${value}) = 70
      AND lower(substr(${value}, 1, 6)) = 'event-'
      AND substr(${value}, 7) NOT GLOB '*[^0-9A-Fa-f]*';`;
};

export const DEFAULT_SQLITE_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE raw_events (
        deduplication_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        adapter TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        repo_id TEXT,
        branch TEXT,
        worktree TEXT,
        commit_sha TEXT,
        event_timestamp TEXT NOT NULL,
        trust TEXT NOT NULL,
        content_digest TEXT,
        result_digest TEXT,
        redaction_rule_version INTEGER NOT NULL,
        parse_status TEXT NOT NULL,
        safe_envelope_json TEXT NOT NULL,
        storage_redaction_applied INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        delivery_count INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX raw_events_source_identity
        ON raw_events(
          adapter,
          adapter_version,
          session_id,
          event_type,
          source_event_id
        );

      CREATE TABLE parser_errors (
        parser_error_id INTEGER PRIMARY KEY,
        queue_item_id TEXT NOT NULL,
        deduplication_key TEXT,
        error_kind TEXT NOT NULL,
        message TEXT NOT NULL,
        safe_envelope_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(queue_item_id, error_kind)
      ) STRICT;

      CREATE TABLE identities (
        identity_id TEXT PRIMARY KEY,
        identity_type TEXT NOT NULL,
        canonical_value TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE queue_processing (
        queue_item_id TEXT PRIMARY KEY,
        deduplication_key TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        last_error TEXT,
        processed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE work_episodes (
        episode_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evidence_links (
        link_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE process_claims (
        claim_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE feedback_events (
        feedback_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE deletion_operations (
        deletion_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE metrics (
        metric_id INTEGER PRIMARY KEY,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        dimensions_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evaluation_runs (
        run_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        report_digest TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE branch_contexts (
        branch_context_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX branch_context_scope
        ON branch_contexts(repo_id, branch);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE knowledge_candidates (
        knowledge_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE context_use_records (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX context_use_session
        ON context_use_records(session_id, created_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE session_mutes (
        feedback_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX session_mutes_session
        ON session_mutes(session_id, created_at);

      CREATE INDEX session_mutes_target
        ON session_mutes(target_id);

      INSERT INTO session_mutes (
        feedback_id,
        session_id,
        target_id,
        created_at
      )
      SELECT feedback_id,
             json_extract(body_json, '$.evidenceRef'),
             json_extract(body_json, '$.targetId'),
             created_at
        FROM feedback_events
       WHERE json_extract(body_json, '$.kind') = 'mute_session';
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE correction_keys (
        correction_key_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX correction_keys_scope
        ON correction_keys(scope, scope_id);

      CREATE TABLE correction_opportunities (
        opportunity_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        correction_key_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        applicable INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX correction_opportunities_key
        ON correction_opportunities(correction_key_id, created_at);

      CREATE INDEX correction_opportunities_episode
        ON correction_opportunities(episode_id);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE correction_key_sources (
        correction_key_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        PRIMARY KEY (correction_key_id, source_event_id)
      ) STRICT;

      INSERT INTO correction_key_sources (
        correction_key_id,
        source_event_id
      )
      SELECT DISTINCT correction_keys.correction_key_id,
                      CAST(source.value AS TEXT)
        FROM correction_keys
        JOIN json_each(
          correction_keys.body_json,
          '$.sourceCorrectionEventIds'
        ) AS source;

      CREATE INDEX correction_key_sources_event
        ON correction_key_sources(
          source_event_id,
          correction_key_id
        );

      CREATE INDEX raw_events_event_id
        ON raw_events(event_id);

      CREATE INDEX context_use_episode
        ON context_use_records(
          json_extract(body_json, '$.episodeId'),
          created_at
        );

      CREATE INDEX feedback_events_target
        ON feedback_events(
          json_extract(body_json, '$.targetId'),
          created_at
        );
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE raw_event_enrichments (
        enrichment_id TEXT PRIMARY KEY,
        deduplication_key TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        original_digest TEXT NOT NULL,
        safe_envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX raw_event_enrichments_event
        ON raw_event_enrichments(deduplication_key, created_at, enrichment_id);

      CREATE INDEX raw_events_time
        ON raw_events(event_timestamp, deduplication_key);

      CREATE INDEX context_use_time
        ON context_use_records(created_at, request_id);

      ${["raw_events", "parser_errors"].flatMap((table) =>
        [
          "$.event.parentEventId",
          "$.event.verificationBinding.correctionEventId",
          "$.event.verificationBinding.operationEventId",
        ].map((path) => canonicalReferenceMigrationSql(
          table as "raw_events" | "parser_errors", path,
        )),
      ).join("\n")}

      DELETE FROM correction_opportunities;
      DELETE FROM correction_key_sources;
      DELETE FROM correction_keys;
      DELETE FROM knowledge_candidates
        WHERE knowledge_id LIKE 'correction-knowledge-%'
          AND COALESCE(json_extract(body_json, '$.evidenceTier'), '') <> 'user_confirmed'
          AND json_extract(body_json, '$.state') <> 'superseded';
      DELETE FROM branch_contexts;
    `,
  },
  {
    version: 9,
    sql: "ALTER TABLE feedback_events ADD COLUMN replacement_json TEXT;",
  },
  {
    version: 10,
    sql: `
      CREATE TABLE context_use_records_v10 (
        request_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO context_use_records_v10 (
        request_id, schema_version, session_id, body_json, source_digest, created_at, updated_at
      )
      SELECT request_id, schema_version, session_id, body_json, source_digest, created_at, created_at
        FROM context_use_records;
      DROP TABLE context_use_records;
      ALTER TABLE context_use_records_v10 RENAME TO context_use_records;
      CREATE INDEX context_use_session ON context_use_records(session_id, created_at);
      CREATE INDEX context_use_episode ON context_use_records(json_extract(body_json, '$.episodeId'), created_at);
      CREATE INDEX context_use_time ON context_use_records(created_at, request_id);
      CREATE INDEX context_use_observed ON context_use_records(updated_at, request_id);
      CREATE INDEX raw_events_observed ON raw_events(last_seen_at, deduplication_key);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE learning_jobs (job_id TEXT PRIMARY KEY, window_id TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, body_json TEXT NOT NULL, window_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(window_id, revision)) STRICT;
      CREATE TABLE learning_sources (job_id TEXT NOT NULL REFERENCES learning_jobs(job_id) ON DELETE CASCADE, event_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(job_id,event_id)) STRICT;
      CREATE INDEX learning_source_event ON learning_sources(event_id);
      CREATE TABLE learning_proposals (proposal_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES learning_jobs(job_id) ON DELETE CASCADE, knowledge_id TEXT NOT NULL, body_json TEXT NOT NULL, receipt_json TEXT) STRICT;
      CREATE INDEX learning_proposal_knowledge ON learning_proposals(knowledge_id);
      CREATE TABLE learning_attempts (attempt_id INTEGER PRIMARY KEY, attempted_at TEXT NOT NULL) STRICT;
      CREATE INDEX learning_attempt_day ON learning_attempts(attempted_at);
      CREATE TABLE learning_notices (knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_candidates(knowledge_id) ON DELETE CASCADE, claimed_at TEXT NOT NULL) STRICT;
      CREATE TABLE learning_suppressions (target_digest TEXT PRIMARY KEY) STRICT;
    `,
  },
  {
    version: 12,
    sql: `
      UPDATE raw_events SET event_timestamp=
        strftime('%Y-%m-%dT%H:%M:%S', substr(event_timestamp,1,19) ||
          CASE WHEN substr(event_timestamp,-1)='Z' THEN 'Z' ELSE substr(event_timestamp,-6) END) || '.' ||
        CASE WHEN substr(event_timestamp,20,1)='.' THEN
          substr(substr(event_timestamp,21,length(event_timestamp)-20-
            CASE WHEN substr(event_timestamp,-1)='Z' THEN 1 ELSE 6 END) || '000',1,3)
          ELSE '000' END || 'Z';
      CREATE TABLE learning_event_changes (
        deduplication_key TEXT PRIMARY KEY REFERENCES raw_events(deduplication_key) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE learning_prompt_work (
        deduplication_key TEXT PRIMARY KEY REFERENCES raw_events(deduplication_key) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        not_before INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX learning_prompt_due ON learning_prompt_work(not_before);
      CREATE INDEX raw_events_learning_context
        ON raw_events(session_id, repo_id, worktree, event_timestamp, event_id)
        WHERE parse_status = 'supported' AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal';
      CREATE INDEX raw_events_learning_prompts
        ON raw_events(session_id, repo_id, worktree, event_timestamp, event_id)
        WHERE parse_status = 'supported' AND trust = 'user' AND event_type = 'prompt.submitted';
      CREATE INDEX learning_jobs_state ON learning_jobs(state, updated_at, job_id);
      CREATE INDEX learning_jobs_inference ON learning_jobs(updated_at, job_id)
        WHERE state IN ('pending','paused','failed') AND json_extract(body_json, '$.attempts') < 3;
      CREATE INDEX learning_jobs_expiry ON learning_jobs(json_extract(body_json, '$.expiresAt'))
        WHERE state NOT IN ('archived', 'cancelled');
      CREATE INDEX learning_proposal_job ON learning_proposals(job_id);
      CREATE TABLE learning_notice_work (
        knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_candidates(knowledge_id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO learning_notice_work
        SELECT knowledge_id FROM knowledge_candidates
        WHERE knowledge_id LIKE 'learning-knowledge-%' AND json_extract(body_json, '$.state')='active'
          AND knowledge_id NOT IN (SELECT knowledge_id FROM learning_notices);
      INSERT INTO learning_prompt_work
        SELECT deduplication_key, 1, 0 FROM raw_events
        WHERE parse_status = 'supported' AND trust = 'user' AND event_type = 'prompt.submitted'
          AND session_id IS NOT NULL AND repo_id IS NOT NULL AND worktree IS NOT NULL;
    `,
  },
  {
    version: 13,
    // Semantic proposals and resumable/superseded jobs require the current reader.
    sql: `
      CREATE INDEX learning_jobs_window_state ON learning_jobs(window_id,state);
      CREATE INDEX learning_shell_scope ON learning_proposals(
        json_extract(receipt_json, '$.repoId'), json_extract(receipt_json, '$.branch'),
        json_extract(receipt_json, '$.commitSha'), json_extract(receipt_json, '$.predicate.toolName')
      ) WHERE json_extract(receipt_json, '$.proves')='repository_test_command';
    `,
  },
  {
    version: 14,
    // Agent provenance is a new reader boundary; anchors reuse the durable bounded work queue.
    sql: `
      CREATE INDEX raw_events_learning_agents ON raw_events(session_id,repo_id,worktree,event_timestamp,event_id)
        WHERE parse_status='supported' AND trust='model' AND event_type='agent.message'
          AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal';
      INSERT OR IGNORE INTO learning_prompt_work
        SELECT deduplication_key,1,0 FROM raw_events WHERE parse_status='supported' AND trust='model' AND event_type='agent.message'
          AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
          AND session_id IS NOT NULL AND repo_id IS NOT NULL AND worktree IS NOT NULL;
    `,
  },
  {
    version: 15,
    // Retention metadata, quoted reference delivery, and episode closure need the current reader.
    sql: `CREATE INDEX learning_proposal_concepts ON learning_proposals(json_extract(body_json, '$.canonicalKey'));`,
  },
  {
    version: 16,
    sql: `CREATE TABLE record_reset (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), cutoff TEXT NOT NULL) STRICT;`,
  },
  {
    version: 17,
    // Preflight failures and bounded legacy input-budget recovery require the current reader.
    sql: "CREATE INDEX learning_jobs_input_failure ON learning_jobs(json_extract(body_json, '$.failureKind'), json_extract(body_json, '$.extractorVersion'));",
  },
  {
    version: 18,
    // Bound model-review metadata and job review summaries require the current reader.
    sql: "CREATE INDEX learning_proposal_distillation ON learning_proposals(json_extract(body_json, '$.distillation.inputDigest'));",
  },
  {
    version: 19,
    // Original-language discovery/exclusion phrases are bound to English lesson reviews.
    sql: "CREATE INDEX learning_proposal_query_terms ON learning_proposals(json_type(body_json, '$.queryTerms'));",
  },
  {
    version: 20,
    // Reviewed relations, applicability metadata and inferred-lesson notices require this reader.
    sql: `CREATE TABLE learning_auto_expiry (
      knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_candidates(knowledge_id) ON DELETE CASCADE,
      expired_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE learning_relation_conflicts (
      knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_candidates(knowledge_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX learning_proposal_relations ON learning_proposals(json_type(body_json, '$.relations'));`,
  },
  {
    version: 21,
    sql: "CREATE INDEX raw_events_session_type ON raw_events(session_id,event_type,event_timestamp) WHERE parse_status='supported';" +
      "CREATE INDEX raw_events_operation ON raw_events(session_id,json_extract(safe_envelope_json,'$.event.operationId')) WHERE parse_status='supported';" +
      "CREATE INDEX raw_events_counterevidence ON raw_events(session_id,event_timestamp) WHERE parse_status='supported' AND (" +
      "event_type IN ('change.reverted','tool.failed') OR json_extract(safe_envelope_json,'$.event.completionStatus')='failed' " +
      "OR (json_extract(safe_envelope_json,'$.event.exitCode') IS NOT NULL AND json_extract(safe_envelope_json,'$.event.exitCode')!=0) " +
      "OR json_extract(safe_envelope_json,'$.event.mcp.isError')=1 OR json_extract(safe_envelope_json,'$.event.mcp.resultType')='failure');",
  },
  {
    version: 22,
    // Optional discovery and query-feedback fields require this JSON reader.
    sql: "CREATE INDEX knowledge_discovery_metadata ON knowledge_candidates(json_type(body_json, '$.discovery'));" +
      "CREATE INDEX context_use_retrieval_mode ON context_use_records(json_extract(body_json, '$.retrievalMode'));",
  },
  {
    version: 23,
    sql: `CREATE TABLE discovery_enrichment (knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_candidates(knowledge_id) ON DELETE CASCADE,
      state TEXT NOT NULL, body_json TEXT NOT NULL, profile_json TEXT, updated_at TEXT NOT NULL) STRICT;
      CREATE INDEX discovery_enrichment_due ON discovery_enrichment(state,updated_at);
      CREATE TABLE discovery_enrichment_cursor (singleton INTEGER PRIMARY KEY CHECK(singleton=1), knowledge_id TEXT NOT NULL) STRICT;`,
  },
] as const satisfies readonly SqliteMigration[];

// Dependent rows precede their source tables; reset retains only schema and replay protection.
const RECORD_RESET_TABLES = [
  "discovery_enrichment", "discovery_enrichment_cursor",
  "learning_sources", "learning_proposals", "learning_notices", "learning_notice_work", "learning_auto_expiry", "learning_relation_conflicts",
  "learning_event_changes", "learning_prompt_work", "raw_event_enrichments",
  "correction_key_sources", "correction_opportunities", "context_use_records",
  "session_mutes", "feedback_events", "evidence_links", "process_claims", "queue_processing",
  "identities", "learning_jobs", "learning_attempts", "learning_suppressions",
  "knowledge_candidates", "branch_contexts", "work_episodes", "correction_keys",
  "parser_errors", "raw_events", "deletion_operations", "metrics", "evaluation_runs",
] as const;

export class UnsupportedDatabaseVersionError extends Error {
  public override readonly name = "UnsupportedDatabaseVersionError";

  public constructor(version: number, latestVersion: number) {
    super(
      `Database version ${version} is newer than supported version ${latestVersion}.`,
    );
  }
}

export class CanonicalMigrationRequiredError extends Error {
  public override readonly name = "CanonicalMigrationRequiredError";

  public constructor(current: number, latest: number) {
    super(`Canonical schema ${current} requires a verified maintenance upgrade to ${latest}; run provenloop upgrade before reopening it.`);
  }
}

export class InvalidMigrationPlanError extends Error {
  public override readonly name = "InvalidMigrationPlanError";

  public constructor() {
    super("SQLite migrations must be contiguous and start at version 1.");
  }
}

export class InvalidCanonicalSchemaError extends Error {
  public override readonly name = "InvalidCanonicalSchemaError";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class StaleCanonicalStoreError extends Error {
  public override readonly name = "StaleCanonicalStoreError";

  public constructor() {
    super("Canonical storage changed during maintenance; close and reopen this store before retrying.");
  }
}

const digestBytes = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const readOptionalText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const writeDurable = async (path: string, value: string): Promise<void> => {
  const staged = `${path}.${randomUUID()}.pending`;
  try {
    const file = await open(staged, "wx", 0o600);
    try {
      await file.writeFile(value, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(staged, path);
  } finally {
    await unlink(staged).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    });
  }
};

const rangeParameters = (input: CanonicalTimeRange): {
  since: string;
  until: string;
  limit: number;
  timeBasis: "event" | "observed";
} => {
  const since = new Date(input.since);
  const until = new Date(input.until);
  const limit = input.limit ?? 500;
  const timeBasis = input.timeBasis ?? "event";
  if (
    !Number.isFinite(since.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    since >= until ||
    !Number.isInteger(limit) || limit < 1 || limit > 1_000 ||
    !["event", "observed"].includes(timeBasis)
  ) {
    throw new RangeError("A valid time range and a limit between 1 and 1000 are required.");
  }
  if (input.after !== undefined && (
    !Number.isFinite(Date.parse(input.after.timestamp)) ||
    input.after.id.length === 0
  )) {
    throw new RangeError("The range cursor is invalid.");
  }
  return { since: since.toISOString(), until: until.toISOString(), limit, timeBasis };
};

const mergeMissingContent = (original: unknown, supplied: unknown): unknown => {
  if (supplied === undefined) {
    return original;
  }
  if (original === undefined) {
    return supplied;
  }
  if (isDeepStrictEqual(original, supplied)) {
    return original;
  }
  if (
    original !== null && typeof original === "object" &&
    !Array.isArray(original) &&
    ["omitted_in_callback", "metadata_only"].includes(
      String((original as Record<string, unknown>).status),
    )
  ) {
    return supplied;
  }
  if (
    original !== null && supplied !== null &&
    typeof original === "object" && typeof supplied === "object" &&
    !Array.isArray(original) && !Array.isArray(supplied)
  ) {
    const merged: Record<string, unknown> = {
      ...(original as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(supplied)) {
      merged[key] = mergeMissingContent(merged[key], value);
    }
    return merged;
  }
  throw new Error("Enrichment cannot replace an already recorded fact.");
};

const asNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return Number(value);
};

const optionalText = (value: string | undefined): string | null =>
  value ?? null;

const normalizedEventReference = (value: string): string =>
  /^event-[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : value;

const normalizedCaptureReferences = (input: CaptureEnvelope): CaptureEnvelope => {
  const binding = input.event.verificationBinding;
  return captureEnvelopeSchema.parse({
    ...input,
    event: {
      ...input.event,
      ...(input.event.parentEventId === undefined ? {} : {
        parentEventId: normalizedEventReference(input.event.parentEventId),
      }),
      ...(binding === undefined ? {} : {
        verificationBinding: {
          correctionEventId: normalizedEventReference(binding.correctionEventId),
          operationEventId: normalizedEventReference(binding.operationEventId),
        },
      }),
    },
  });
};

const evidenceArguments = (input: CaptureEnvelope): Readonly<Record<string, unknown>> | undefined => {
  if (!["test.completed", "build.completed", "verification.completed", "file.changed"].includes(input.event.eventType)) {
    return undefined;
  }
  const value = input.event.redactedArguments;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
};

const captureSdkSources = (input: CaptureEnvelope): readonly {
  readonly sourceEventId: string;
  readonly eventTypes: readonly string[];
}[] => {
  const arguments_ = evidenceArguments(input);
  const start = input.event.evidence?.sourceStartEventId ?? arguments_?.sourceStartEventId;
  const complete = input.event.evidence?.sourceCompleteEventId ?? arguments_?.sourceCompleteEventId;
  return [
    ...(typeof start === "string" ? [{ sourceEventId: start, eventTypes: ["tool.started"] }] : []),
    ...(typeof complete === "string"
      ? [{ sourceEventId: complete, eventTypes: ["tool.completed", "tool.failed"] }]
      : []),
  ];
};

// SDK source IDs are opaque and scoped; do not treat them as global event IDs.
const captureSourceAlias = (
  input: CaptureEnvelope,
  sourceEventId = input.sourceEventId,
  eventType = input.event.eventType,
): string | undefined => input.event.sessionId === undefined ? undefined : `event-${createCaptureDeduplicationKey({
  adapter: input.event.adapter,
  adapterVersion: input.event.adapterVersion,
  eventType,
  sessionId: input.event.sessionId,
  sourceEventId,
})}`;

const captureEvidenceReferences = (input: CaptureEnvelope): readonly string[] => {
  const binding = input.event.verificationBinding;
  return [
    ...(input.event.parentEventId === undefined ? [] : [input.event.parentEventId]),
    ...(binding === undefined ? [] : [binding.correctionEventId, binding.operationEventId]),
    ...captureSdkSources(input).flatMap((source) => source.eventTypes.flatMap((eventType) => {
      const reference = captureSourceAlias(input, source.sourceEventId, eventType);
      return reference === undefined ? [] : [reference];
    })),
  ].map(normalizedEventReference);
};

const conflictingCaptureEvidence = (input: CaptureEnvelope): boolean => {
  const evidence = input.event.evidence;
  const arguments_ = evidenceArguments(input);
  if (evidence === undefined || arguments_ === undefined) return false;
  return [
    ["sourceStartEventId", evidence.sourceStartEventId],
    ["sourceCompleteEventId", evidence.sourceCompleteEventId],
    ["commandFamily", evidence.commandFamily],
    ["exitCode", evidence.exitCode],
    ["targetPaths", evidence.targetPaths],
    ["workingDirectory", evidence.workingDirectory],
    ["cwd", evidence.workingDirectory],
  ].some(([field, expected]) =>
    expected !== undefined && arguments_[String(field)] !== undefined &&
    !isDeepStrictEqual(arguments_[String(field)], expected),
  );
};

const normalizedFeedbackEvent = (input: FeedbackEvent): FeedbackEvent =>
  feedbackEventSchema.parse({
    ...input,
    evidenceRef: normalizedEventReference(input.evidenceRef),
    ...(input.resolvesEvidenceIds === undefined ? {} : {
      resolvesEvidenceIds: input.resolvesEvidenceIds.map(normalizedEventReference),
    }),
  });

const feedbackResolutionIdentities = (
  event: FeedbackEvent,
): readonly DeletionPlannedIdentity[] =>
  (event.resolvesEvidenceIds ?? []).flatMap((identifier): DeletionPlannedIdentity[] => {
    if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
      return [{ identifier: identifier.toLowerCase(), identityType: "event" }];
    }
    if (/^[a-f0-9]{64}$/iu.test(identifier)) {
      return [{ identifier: identifier.toLowerCase(), identityType: "deduplication" }];
    }
    return [];
  });

const normalizedKnowledgeCandidate = (
  input: KnowledgeCandidate,
): KnowledgeCandidate => {
  const parsed = knowledgeCandidateSchema.parse(input);
  return knowledgeCandidateSchema.parse({
    ...parsed,
    sourceEvidenceIds: parsed.sourceEvidenceIds.map(
      (identifier) =>
        /^(?:event-)?[a-f0-9]{64}$/iu.test(identifier)
          ? identifier.toLowerCase()
          : identifier,
    ),
  });
};

const firstColumn = (
  row: Readonly<Record<string, unknown>>,
): unknown => Object.values(row)[0];

const sqliteIdentifier = (value: string): string =>
  `"${value.replaceAll("\"", "\"\"")}"`;

const normalizeSchemaSql = (value: unknown): string =>
  String(value).replaceAll(/\s+/gu, " ").trim();

interface TypedDeletionReferences {
  readonly deduplication: Set<string>;
  readonly episode: Set<string>;
  readonly event: Set<string>;
  readonly record: Set<string>;
  readonly session: Set<string>;
}

const normalizedReferenceKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[-_.]/gu, "");

const stringValues = (value: unknown): readonly string[] =>
  typeof value === "string"
    ? [
        value,
      ]
    : Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string",
        )
      : [];

const bodyReferences = (
  input: unknown,
  references: TypedDeletionReferences,
): boolean => {
  if (input === null || typeof input !== "object") {
    return false;
  }
  if (Array.isArray(input)) {
    return input.some((value) =>
      bodyReferences(value, references),
    );
  }
  const record = input as Readonly<Record<string, unknown>>;
  if (
    record.targetType === "episode" &&
    typeof record.targetId === "string" &&
    references.episode.has(record.targetId)
  ) {
    return true;
  }
  if (
    record.targetType === "process_claim" &&
    typeof record.targetId === "string" &&
    references.record.has(record.targetId)
  ) {
    return true;
  }
  if (
    record.targetType === "knowledge" &&
    typeof record.targetId === "string" &&
    references.record.has(`knowledge:${record.targetId}`)
  ) {
    return true;
  }
  if (
    record.targetType === "branch_context" &&
    typeof record.targetId === "string" &&
    references.record.has(`branch-context:${record.targetId}`)
  ) {
    return true;
  }
  if (
    record.kind === "mute_session" &&
    typeof record.evidenceRef === "string" &&
    references.session.has(record.evidenceRef)
  ) {
    return true;
  }
  for (const [
    key,
    value,
  ] of Object.entries(record)) {
    const normalized = normalizedReferenceKey(key);
    const values = stringValues(value);
    const matched =
      [
        "episodeid",
        "sourceepisodeids",
      ].includes(normalized)
        ? values.some((id) => references.episode.has(id))
        : [
              "leftsessionid",
              "rightsessionid",
              "sessionid",
              "sessionids",
            ].includes(normalized)
          ? values.some((id) => references.session.has(id))
          : [
                "correctioneventids",
                "correctioneventid",
                "eventid",
                "parenteventid",
                "operationeventid",
                "sourcestarteventid",
                "sourcecompleteeventid",
                "sourceid",
                "sourcecorrectioneventids",
                "sourceeventids",
              ].includes(normalized)
            ? values.some(
                (id) =>
                  references.event.has(id) ||
                  references.event.has(id.toLowerCase()),
              )
            : [
                  "availabilityevidenceids",
                  "correctionids",
                  "evidenceid",
                  "evidenceids",
                  "evidenceref",
                  "invocationids",
                  "sourceevidenceids",
                  "resolvesevidenceids",
                  "recentverificationevidenceids",
                  "supportingevidenceids",
                  "verificationevidenceids",
                ].includes(normalized)
              ? values.some(
                  (id) =>
                      references.deduplication.has(id) ||
                      references.deduplication.has(
                        id.toLowerCase(),
                      ) ||
                      references.event.has(id) ||
                      references.event.has(id.toLowerCase()) ||
                      references.record.has(id),
                  )
              : [
                      "candidateknowledgeids",
                      "conflictswith",
                      "knowledgeid",
                      "previousknowledgeid",
                      "replacementknowledgeid",
                      "supersedes",
                    ].includes(normalized)
                  ? values.some((id) =>
                      references.record.has(`knowledge:${id}`),
                    )
                  : [
                        "appliedknowledgeids",
                        "returnedknowledgeids",
                      ].includes(normalized)
                    ? values.some((id) =>
                        references.record.has(id),
                      )
              : normalized === "correctionkeyid"
                ? values.some((id) => references.record.has(id))
              : false;
    if (matched || bodyReferences(value, references)) {
      return true;
    }
  }
  return false;
};

const placeholders = (count: number): string =>
  Array.from({
    length: count,
  }, () => "?").join(", ");

const SQLITE_PARAMETER_CHUNK_SIZE = 500;

const sqliteChunks = <T>(
  values: readonly T[],
): readonly (readonly T[])[] => {
  const chunks: T[][] = [];
  for (
    let index = 0;
    index < values.length;
    index += SQLITE_PARAMETER_CHUNK_SIZE
  ) {
    chunks.push(
      values.slice(index, index + SQLITE_PARAMETER_CHUNK_SIZE),
    );
  }
  return chunks;
};

const validateDeletionTargetId = (
  targetType: DeletionTargetType,
  targetId: string,
): void => {
  if (
    targetType === "source" &&
    !/^(?:event-)?[a-f0-9]{64}$/iu.test(targetId)
  ) {
    throw new Error(
      "Source deletion requires a canonical event ID or deduplication key.",
    );
  }
};

const normalizedDeletionTargetId = (
  targetType: DeletionTargetType,
  targetId: string,
): string =>
  targetType === "source"
    ? targetId.toLowerCase()
    : targetId;

const sourceIdentityForms = (targetId: string): readonly string[] =>
  targetId.startsWith("event-")
    ? [
        targetId,
        targetId.slice("event-".length),
      ]
    : [
        targetId,
        `event-${targetId}`,
      ];

const deletionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface LoadedDeletionIdentityKey {
  readonly key: string;
}

const loadDeletionIdentityKey = (
  path: string,
): LoadedDeletionIdentityKey => {
  if (path === ":memory:") {
    return {
      key: randomBytes(32).toString("hex"),
    };
  }
  const keyPath = `${path}.deletion.key`;
  try {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (/^[a-f0-9]{64}$/u.test(existing)) {
      return {
        key: existing,
      };
    }
    throw new Error("Canonical deletion identity key is malformed.");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  if (existsSync(path)) {
    let existingDatabase: DatabaseSync | undefined;
    try {
      existingDatabase = new DatabaseSync(path, {
        readOnly: true,
      });
      const table = existingDatabase
        .prepare(
          `SELECT COUNT(*) AS count
             FROM sqlite_master
            WHERE type = 'table'
              AND name = 'deletion_operations'`,
        )
        .get() as Readonly<Record<string, unknown>>;
      if (asNumber(table.count) > 0) {
        const operations = existingDatabase
          .prepare(
            `SELECT COUNT(*) AS count
               FROM deletion_operations`,
          )
          .get() as Readonly<Record<string, unknown>>;
        if (asNumber(operations.count) > 0) {
          throw new InvalidCanonicalSchemaError(
            "Canonical deletion identity key is missing.",
          );
        }
      }
    } finally {
      existingDatabase?.close();
    }
  }
  const generated = randomBytes(32).toString("hex");
  try {
    const descriptor = openSync(keyPath, "wx");
    try {
      writeFileSync(descriptor, generated, "utf8");
    } finally {
      closeSync(descriptor);
    }
    return {
      key: generated,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const existing = readFileSync(keyPath, "utf8").trim();
      if (/^[a-f0-9]{64}$/u.test(existing)) {
        return {
          key: existing,
        };
      }
    }
    throw error;
  }
};

const deleteDependentRows = (
  database: DatabaseSync,
  table: string,
  idColumn: string,
  bodyColumn: string,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT ${idColumn} AS id, ${bodyColumn} AS body
         FROM ${table}`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.id);
    remove.run(id);
    const reference =
      table === "knowledge_candidates"
        ? `knowledge:${id}`
        : id;
    dependentIds.add(reference);
    references.record.add(reference);
    deleted += 1;
  }
  return deleted;
};

const deleteRebuildableProjectionRows = (
  database: DatabaseSync,
  table: string,
  idColumn: string,
  bodyColumn: string,
  references: TypedDeletionReferences,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT ${idColumn} AS id, ${bodyColumn} AS body
         FROM ${table}`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ?`,
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.id);
    remove.run(id);
    references.record.add(
      table === "branch_contexts"
        ? `branch-context:${id}`
        : id,
    );
    deleted += 1;
  }
  return deleted;
};

const deleteEvidenceLinkRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
  dependencySeedIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT link_id, body_json
         FROM evidence_links`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM evidence_links WHERE link_id = ?",
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body_json)) as unknown;
    if (!bodyReferences(parsed, references)) {
      continue;
    }
    const id = String(row.link_id);
    remove.run(id);
    if (episodeAssociationSchema.safeParse(parsed).success) {
      dependencySeedIds.add(id);
    } else {
      dependentIds.add(id);
    }
    references.record.add(id);
    deleted += 1;
  }
  return deleted;
};

const deleteIdentityRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT identity_id, identity_type, canonical_value
         FROM identities`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM identities WHERE identity_id = ?",
  );
  for (const row of rows) {
    const identityId = String(row.identity_id);
    const identityType = String(row.identity_type)
      .toLowerCase();
    const canonicalValue = String(row.canonical_value);
    const matches =
      references.record.has(identityId) ||
      references.record.has(canonicalValue) ||
      (
        identityType.includes("alias") &&
        (
          references.event.has(canonicalValue) ||
          references.session.has(canonicalValue) ||
          references.episode.has(canonicalValue)
        )
      ) ||
      (
        identityType.includes("dedup") &&
        references.deduplication.has(canonicalValue)
      ) ||
      (
        identityType.includes("session") &&
        references.session.has(canonicalValue)
      ) ||
      (
        identityType.includes("episode") &&
        references.episode.has(canonicalValue)
      ) ||
      (
        identityType.includes("event") &&
        references.event.has(canonicalValue)
      );
    if (!matches) {
      continue;
    }
    remove.run(identityId);
    dependentIds.add(identityId);
    references.record.add(identityId);
    deleted += 1;
  }
  return deleted;
};

const feedbackMutatesKnowledge = (
  event: FeedbackEvent,
): boolean =>
  event.targetType === "knowledge" &&
  ![
    "irrelevant",
    "mute_session",
  ].includes(event.kind);

const feedbackIntentDigest = (
  event: FeedbackEvent,
): string => {
  const {
    timestamp: _timestamp,
    ...intent
  } = event;
  void _timestamp;
  return sha256(intent);
};

const confirmedRuleIntentDigest = (candidate: KnowledgeCandidate): string =>
  sha256({
    schemaVersion: candidate.schemaVersion,
    knowledgeId: candidate.knowledgeId,
    supersedes: candidate.supersedes,
    content: candidate.content,
    appliesWhen: candidate.appliesWhen,
    nonApplicability: candidate.nonApplicability,
    scope: candidate.scope,
    scopeId: candidate.scopeId,
    kind: candidate.kind,
    topicKey: candidate.topicKey,
    importance: candidate.importance,
    sourceEpisodeIds: candidate.sourceEpisodeIds,
    sourceEvidenceIds: candidate.sourceEvidenceIds,
  });

const deleteFeedbackRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
  dependentIds: Set<string>,
  affectedKnowledgeIds: Set<string>,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT *
         FROM feedback_events`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM feedback_events WHERE feedback_id = ?",
  );
  for (const row of rows) {
    const parsed = JSON.parse(String(row.body_json)) as unknown;
    const replacement = row.replacement_json == null
      ? undefined
      : JSON.parse(String(row.replacement_json)) as Record<string, unknown>;
    if (
      !bodyReferences(parsed, references) &&
      !bodyReferences(replacement, references)
    ) {
      continue;
    }
    const id = String(row.feedback_id);
    const event = feedbackEventSchema.parse(parsed);
    remove.run(id);
    dependentIds.add(id);
    references.record.add(id);
    if (feedbackMutatesKnowledge(event)) {
      affectedKnowledgeIds.add(event.targetId);
    }
    if (typeof replacement?.replacementKnowledgeId === "string") {
      affectedKnowledgeIds.add(replacement.replacementKnowledgeId);
    }
    deleted += 1;
  }
  return deleted;
};

const deleteSessionMuteRows = (
  database: DatabaseSync,
  references: TypedDeletionReferences,
): number => {
  let deleted = 0;
  const rows = database
    .prepare(
      `SELECT session_id, feedback_id, target_id
         FROM session_mutes`,
    )
    .all() as readonly Readonly<Record<string, unknown>>[];
  const remove = database.prepare(
    "DELETE FROM session_mutes WHERE feedback_id = ?",
  );
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const feedbackId = String(row.feedback_id);
    const targetId = String(row.target_id);
    if (
      !references.session.has(sessionId) &&
      !references.record.has(feedbackId) &&
      !references.record.has(`knowledge:${targetId}`)
    ) {
      continue;
    }
    remove.run(feedbackId);
    deleted += 1;
  }
  return deleted;
};

const createExpectedCanonicalObjectSql = (
  migrations: readonly SqliteMigration[],
): ReadonlyMap<
  string,
  string
> => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations) {
      database.exec(migration.sql);
    }
    const rows = database
      .prepare(
        `SELECT name, sql, type
           FROM sqlite_master
          WHERE sql IS NOT NULL
            AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return new Map(
      rows.map((row) => [
        `${String(row.type)}:${String(row.name)}`,
        normalizeSchemaSql(row.sql),
      ]),
    );
  } finally {
    database.close();
  }
};

interface ExpectedSqliteColumn {
  readonly name: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly type: "INTEGER" | "TEXT";
}

const RUNTIME_SCHEMA_COLUMNS = {
  branch_contexts: [
    ["branch_context_id", "TEXT", true, true],
    ["repo_id", "TEXT", true, false],
    ["branch", "TEXT", true, false],
    ["head_sha", "TEXT", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["updated_at", "TEXT", true, false],
    ["expires_at", "TEXT", false, false],
  ],
  correction_keys: [
    ["correction_key_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["scope", "TEXT", true, false],
    ["scope_id", "TEXT", false, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  correction_key_sources: [
    ["correction_key_id", "TEXT", true, true],
    ["source_event_id", "TEXT", true, true],
  ],
  correction_opportunities: [
    ["opportunity_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["correction_key_id", "TEXT", true, false],
    ["episode_id", "TEXT", true, false],
    ["applicable", "INTEGER", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  context_use_records: [
    ["request_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["session_id", "TEXT", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
    ["updated_at", "TEXT", true, false],
  ],
  feedback_events: [
    ["feedback_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
    ["replacement_json", "TEXT", false, false],
  ],
  knowledge_candidates: [
    ["knowledge_id", "TEXT", true, true],
    ["schema_version", "INTEGER", true, false],
    ["body_json", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
    ["updated_at", "TEXT", true, false],
  ],
  parser_errors: [
    ["parser_error_id", "INTEGER", false, true],
    ["queue_item_id", "TEXT", true, false],
    ["deduplication_key", "TEXT", false, false],
    ["error_kind", "TEXT", true, false],
    ["message", "TEXT", true, false],
    ["safe_envelope_json", "TEXT", false, false],
    ["created_at", "TEXT", true, false],
  ],
  queue_processing: [
    ["queue_item_id", "TEXT", true, true],
    ["deduplication_key", "TEXT", false, false],
    ["status", "TEXT", true, false],
    ["attempt_count", "INTEGER", true, false],
    ["failure_count", "INTEGER", true, false],
    ["last_error", "TEXT", false, false],
    ["processed_at", "TEXT", true, false],
  ],
  raw_events: [
    ["deduplication_key", "TEXT", true, true],
    ["event_id", "TEXT", true, false],
    ["source_event_id", "TEXT", true, false],
    ["schema_version", "INTEGER", true, false],
    ["adapter", "TEXT", true, false],
    ["adapter_version", "TEXT", true, false],
    ["event_type", "TEXT", true, false],
    ["session_id", "TEXT", false, false],
    ["repo_id", "TEXT", false, false],
    ["branch", "TEXT", false, false],
    ["worktree", "TEXT", false, false],
    ["commit_sha", "TEXT", false, false],
    ["event_timestamp", "TEXT", true, false],
    ["trust", "TEXT", true, false],
    ["content_digest", "TEXT", false, false],
    ["result_digest", "TEXT", false, false],
    ["redaction_rule_version", "INTEGER", true, false],
    ["parse_status", "TEXT", true, false],
    ["safe_envelope_json", "TEXT", true, false],
    ["storage_redaction_applied", "INTEGER", true, false],
    ["first_seen_at", "TEXT", true, false],
    ["last_seen_at", "TEXT", true, false],
    ["delivery_count", "INTEGER", true, false],
  ],
  raw_event_enrichments: [
    ["enrichment_id", "TEXT", true, true],
    ["deduplication_key", "TEXT", true, false],
    ["source_digest", "TEXT", true, false],
    ["original_digest", "TEXT", true, false],
    ["safe_envelope_json", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
  schema_migrations: [
    ["version", "INTEGER", false, true],
    ["applied_at", "TEXT", true, false],
  ],
  session_mutes: [
    ["feedback_id", "TEXT", true, true],
    ["session_id", "TEXT", true, false],
    ["target_id", "TEXT", true, false],
    ["created_at", "TEXT", true, false],
  ],
} as const satisfies Readonly<
  Record<
    string,
    readonly [
      string,
      ExpectedSqliteColumn["type"],
      boolean,
      boolean,
    ][]
  >
>;

interface ExpectedSqliteIndex {
  readonly columns: readonly string[];
  readonly name?: string;
  readonly origin: "c" | "pk" | "u";
  readonly unique?: boolean;
  readonly partial?: boolean;
}

const RUNTIME_SCHEMA_INDEXES = {
  branch_contexts: [
    {
      columns: [
        "branch_context_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "repo_id",
        "branch",
      ],
      name: "branch_context_scope",
      origin: "c",
    },
  ],
  correction_keys: [
    {
      columns: [
        "correction_key_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "scope",
        "scope_id",
      ],
      name: "correction_keys_scope",
      origin: "c",
      unique: false,
    },
  ],
  correction_key_sources: [
    {
      columns: [
        "correction_key_id",
        "source_event_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "source_event_id",
        "correction_key_id",
      ],
      name: "correction_key_sources_event",
      origin: "c",
      unique: false,
    },
  ],
  correction_opportunities: [
    {
      columns: [
        "episode_id",
      ],
      name: "correction_opportunities_episode",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "correction_key_id",
        "created_at",
      ],
      name: "correction_opportunities_key",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "opportunity_id",
      ],
      origin: "pk",
    },
  ],
  context_use_records: [
    {
      columns: ["updated_at", "request_id"],
      name: "context_use_observed",
      origin: "c",
      unique: false,
    },
    { columns: ["null"], name: "context_use_retrieval_mode", origin: "c", unique: false },
    {
      columns: ["created_at", "request_id"],
      name: "context_use_time",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "null",
        "created_at",
      ],
      name: "context_use_episode",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "session_id",
        "created_at",
      ],
      name: "context_use_session",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "request_id",
      ],
      origin: "pk",
    },
  ],
  knowledge_candidates: [
    { columns: ["null"], name: "knowledge_discovery_metadata", origin: "c", unique: false },
    {
      columns: [
        "knowledge_id",
      ],
      origin: "pk",
    },
  ],
  deletion_operations: [
    {
      columns: [
        "deletion_id",
      ],
      origin: "pk",
    },
  ],
  evaluation_runs: [
    {
      columns: [
        "run_id",
      ],
      origin: "pk",
    },
  ],
  evidence_links: [
    {
      columns: [
        "link_id",
      ],
      origin: "pk",
    },
  ],
  feedback_events: [
    {
      columns: [
        "null",
        "created_at",
      ],
      name: "feedback_events_target",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "feedback_id",
      ],
      origin: "pk",
    },
  ],
  identities: [
    {
      columns: [
        "identity_id",
      ],
      origin: "pk",
    },
  ],
  metrics: [],
  parser_errors: [
    {
      columns: [
        "queue_item_id",
        "error_kind",
      ],
      origin: "u",
    },
  ],
  process_claims: [
    {
      columns: [
        "claim_id",
      ],
      origin: "pk",
    },
  ],
  queue_processing: [
    {
      columns: [
        "queue_item_id",
      ],
      origin: "pk",
    },
  ],
  raw_events: [
    { columns: ["session_id", "event_type", "event_timestamp"], name: "raw_events_session_type", origin: "c", unique: false, partial: true },
    { columns: ["session_id", "null"], name: "raw_events_operation", origin: "c", unique: false, partial: true },
    { columns: ["session_id", "event_timestamp"], name: "raw_events_counterevidence", origin: "c", unique: false, partial: true },
    { columns: ["session_id", "repo_id", "worktree", "event_timestamp", "event_id"], name: "raw_events_learning_context", origin: "c", unique: false, partial: true },
    { columns: ["session_id", "repo_id", "worktree", "event_timestamp", "event_id"], name: "raw_events_learning_agents", origin: "c", unique: false, partial: true },
    { columns: ["session_id", "repo_id", "worktree", "event_timestamp", "event_id"], name: "raw_events_learning_prompts", origin: "c", unique: false, partial: true },
    {
      columns: ["last_seen_at", "deduplication_key"],
      name: "raw_events_observed",
      origin: "c",
      unique: false,
    },
    {
      columns: ["event_timestamp", "deduplication_key"],
      name: "raw_events_time",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "adapter",
        "adapter_version",
        "session_id",
        "event_type",
        "source_event_id",
      ],
      name: "raw_events_source_identity",
      origin: "c",
    },
    {
      columns: [
        "event_id",
      ],
      name: "raw_events_event_id",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "deduplication_key",
      ],
      origin: "pk",
    },
  ],
  raw_event_enrichments: [
    { columns: ["enrichment_id"], origin: "pk" },
    {
      columns: ["deduplication_key", "created_at", "enrichment_id"],
      name: "raw_event_enrichments_event",
      origin: "c",
      unique: false,
    },
  ],
  schema_migrations: [],
  session_mutes: [
    {
      columns: [
        "feedback_id",
      ],
      origin: "pk",
    },
    {
      columns: [
        "session_id",
        "created_at",
      ],
      name: "session_mutes_session",
      origin: "c",
      unique: false,
    },
    {
      columns: [
        "target_id",
      ],
      name: "session_mutes_target",
      origin: "c",
      unique: false,
    },
  ],
  work_episodes: [
    {
      columns: [
        "episode_id",
      ],
      origin: "pk",
    },
  ],
} as const satisfies Readonly<
  Record<string, readonly ExpectedSqliteIndex[]>
>;

export class CanonicalSqliteStore {
  readonly #database: DatabaseSync;
  readonly #allowRecordsReset: boolean;
  readonly #allowSchemaMigration: boolean;
  readonly #deletionIdentityKey: string;
  #generation: string | undefined;
  readonly #faultInjector:
    | CanonicalSqliteStoreOptions["faultInjector"]
    | undefined;
  readonly #now: () => Date;
  readonly #path: string;

  public constructor(
    path: string,
    options: CanonicalSqliteStoreOptions = {},
  ) {
    this.#path = path === ":memory:" ? path : resolve(path);
    path = this.#path;
    this.#allowRecordsReset = options.allowRecordsReset ?? false;
    if (path !== ":memory:" && !this.#allowRecordsReset && existsSync(resolve(dirname(path), "records-reset.pending.json"))) {
      throw new Error("Canonical storage is blocked while record reset is pending. Complete record reset before continuing.");
    }
    if (path !== ":memory:" && existsSync(`${path}.restore.lock`)) {
      throw new Error("Canonical storage is under maintenance; recover the interrupted restore or retry after maintenance.");
    }
    this.#generation = path === ":memory:" ? undefined :
      readOptionalText(`${path}.restore.generation`);
    this.#allowSchemaMigration = options.allowSchemaMigration ?? false;
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs <= 0) {
      throw new RangeError("busyTimeoutMs must be a positive integer.");
    }
    const migrations =
      options.migrations ?? DEFAULT_SQLITE_MIGRATIONS;
    this.#validateMigrations(migrations);
    const deletionIdentityKey = loadDeletionIdentityKey(path);
    this.#deletionIdentityKey = deletionIdentityKey.key;
    this.#faultInjector = options.faultInjector;
    this.#now = options.now ?? (() => new Date());
    this.#database = new DatabaseSync(path);
    try {
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
      this.#database.exec("PRAGMA journal_mode = WAL;");
      this.#applyMigrations(migrations);
      this.#validateDeletionIdentityKey();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  public getRecordsResetCutoff(): string | undefined {
    this.#assertNoRestoreBarrier();
    const exists = this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_reset'").get();
    if (!exists) return undefined;
    const row = this.#database.prepare("SELECT cutoff FROM record_reset WHERE singleton=1").get();
    return row ? isoTimestampSchema.parse(String(row.cutoff)) : undefined;
  }

  public previewRecordsReset(): CanonicalRecordsResetCounts {
    this.#assertNoRestoreBarrier();
    const tables = new Set(this.#database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => String(row.name)));
    const counts = new Map(RECORD_RESET_TABLES.map((table) => [table, tables.has(table)
      ? Number(this.#database.prepare(`SELECT count(*) AS count FROM ${sqliteIdentifier(table)}`).get()?.count ?? 0) : 0]));
    return { events: counts.get("raw_events") ?? 0, knowledge: counts.get("knowledge_candidates") ?? 0,
      episodes: counts.get("work_episodes") ?? 0, jobs: counts.get("learning_jobs") ?? 0,
      usage: counts.get("context_use_records") ?? 0, records: [...counts.values()].reduce((total, count) => total + count, 0) };
  }

  /** Caller holds installation maintenance leases and resets queue/projections under the same cutoff. */
  public clearAllRecords(cutoff: string): CanonicalRecordsResetCounts {
    this.#assertNoRestoreBarrier();
    const timestamp = new Date(isoTimestampSchema.parse(cutoff)).toISOString();
    if (!this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_reset'").get()) {
      throw new Error("Record reset requires the current database schema. Upgrade before clearing records.");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const previous = this.getRecordsResetCutoff();
      if (previous && Date.parse(timestamp) < Date.parse(previous)) throw new Error("Record reset cutoff cannot move backwards.");
      const counts = this.previewRecordsReset();
      this.#database.prepare("INSERT INTO record_reset(singleton,cutoff) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET cutoff=excluded.cutoff").run(timestamp);
      for (const table of RECORD_RESET_TABLES) this.#database.exec(`DELETE FROM ${sqliteIdentifier(table)};`);
      // Invalidate cached handles before the new empty state becomes visible. A failed commit
      // can leave an advanced generation, which safely requires callers to reopen and retry.
      this.#advanceRecordsResetGeneration();
      this.#database.exec("COMMIT;");
      return counts;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public learningJobs(): readonly LearningJob[] {
    this.#assertNoRestoreBarrier();
    return this.#database.prepare("SELECT body_json FROM learning_jobs ORDER BY created_at, job_id").all()
      .map((row) => learningJobSchema.parse(JSON.parse(String(row.body_json))));
  }

  public learningJobsDue(now: Date, kind: "maintenance" | "evidence" | "inference", limit = 32): readonly LearningJob[] {
    this.#assertNoRestoreBarrier();
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new RangeError("Invalid learning job page size.");
    const timestamp = now.toISOString();
    const expiry = "json_extract(body_json, '$.expiresAt')";
    const rows = kind === "maintenance"
      ? [
        ...this.#database.prepare(`SELECT body_json FROM learning_jobs WHERE state NOT IN ('archived','cancelled') AND ${expiry} <= ? LIMIT ?`).all(timestamp, limit),
        ...this.#database.prepare("SELECT body_json FROM learning_jobs WHERE state='running' AND json_extract(body_json, '$.deadline') <= ? LIMIT ?").all(timestamp, limit),
      ].slice(0, limit)
      : this.#database.prepare(`SELECT body_json FROM learning_jobs WHERE ${kind === "evidence" ? "state='waiting_evidence'" : "state IN ('pending','paused','failed') AND coalesce(json_extract(body_json, '$.failureKind'), '') != 'input_too_large' AND (json_extract(body_json, '$.attempts') < 3 OR (json_extract(body_json, '$.inputBudgetRecovery.retryDispatched')=0 AND state IN ('pending','paused')))"}
         AND ${expiry} > ? ${kind === "inference" ? "AND coalesce(json_extract(body_json, '$.retryAfter'), '') <= ?" : ""}
         ORDER BY updated_at, job_id LIMIT ?`).all(...(kind === "inference" ? [timestamp, timestamp, limit] : [timestamp, limit]));
    return rows.map((row) => learningJobSchema.parse(JSON.parse(String(row.body_json))));
  }

  public learningProposalsForJob(jobId: string): readonly RuleProposal[] {
    this.#assertNoRestoreBarrier();
    return this.#database.prepare("SELECT body_json FROM learning_proposals WHERE job_id=?").all(jobId)
      .map((row) => ruleProposalSchema.parse(JSON.parse(String(row.body_json))));
  }

  /** Retry only deterministic input preparation failures after an extractor change. */
  public recoverLearningInputFailures(extractorVersion: string, now: Date, limit = 32): number {
    this.#assertNoRestoreBarrier();
    if (!extractorVersion.trim() || !Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 128) {
      throw new Error("Invalid learning input recovery request.");
    }
    if (this.hasActiveDeletion()) return 0;
    const rows = this.#database.prepare("SELECT target.body_json FROM learning_jobs target WHERE target.state='failed' AND json_extract(target.body_json,'$.extractorVersion') != ? AND json_extract(target.body_json,'$.expiresAt') > ? AND (json_extract(target.body_json,'$.failureKind')='input_too_large' OR json_extract(target.body_json,'$.error') IN ('Learning window exceeds the inference budget.','Error: Learning window exceeds the inference budget.')) AND NOT EXISTS (SELECT 1 FROM learning_jobs sibling WHERE sibling.window_id=target.window_id AND sibling.state IN ('archived','cancelled')) AND NOT EXISTS (SELECT 1 FROM learning_proposals proposal JOIN learning_jobs origin ON origin.job_id=proposal.job_id WHERE origin.window_id=target.window_id) ORDER BY target.updated_at,target.job_id LIMIT ?")
      .all(extractorVersion, now.toISOString(), limit);
    let recovered = 0;
    for (const row of rows) {
      const job = learningJobSchema.parse(JSON.parse(String(row.body_json)));
      const window = this.learningWindow(job.jobId);
      if (!window || !this.learningSourcesCurrent(window)) {
        this.transitionLearningJob({ ...job, state: window && this.learningSourcesExist(window) ? "superseded" : "cancelled", updatedAt: now.toISOString() }, "failed");
        continue;
      }
      if (this.#database.prepare("SELECT 1 FROM learning_jobs WHERE window_id=? AND state IN ('cancelled','archived') LIMIT 1").get(job.windowId)) continue;
      if (this.#database.prepare("SELECT 1 FROM learning_proposals proposal JOIN learning_jobs job ON job.job_id=proposal.job_id WHERE job.window_id=? LIMIT 1").get(job.windowId)) continue;
      const historicalRepair = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE window_id=? AND json_extract(body_json,'$.inputBudgetRecovery') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(job.windowId);
      const repair = historicalRepair ? learningJobSchema.parse(JSON.parse(String(historicalRepair.body_json))).inputBudgetRecovery : undefined;
      const legacy = job.failureKind === undefined;
      if ((legacy && repair !== undefined) || (job.attempts >= 3 && !legacy && repair?.retryDispatched !== false)) {
        this.transitionLearningJob({ ...job, extractorVersion, updatedAt: now.toISOString() }, "failed");
        continue;
      }
      const next = learningJobSchema.parse({
        ...job, state: "pending", extractorVersion, updatedAt: now.toISOString(),
        ...(legacy ? { inputBudgetRecovery: {
          fromExtractorVersion: job.extractorVersion, previousAttempts: job.attempts,
          grantedAt: now.toISOString(), retryDispatched: false,
        } } : {}),
      });
      delete next.failureKind; delete next.error; delete next.result;
      delete next.deadline; delete next.retryAfter; delete next.pauseReason;
      if (this.transitionLearningJob(next, "failed")) recovered += 1;
    }
    return recovered;
  }

  public pendingLearningActivationIds(): readonly string[] {
    this.#assertNoRestoreBarrier();
    return this.#database.prepare("SELECT knowledge_id FROM learning_notice_work ORDER BY rowid LIMIT 32").all()
      .map((row) => String(row.knowledge_id));
  }

  // A durable worklist coalesces ingestion and enrichment without rereading historical bodies.
  public learningPromptWork(now: Date, limit = 8, changeLimit = 128): readonly LearningPromptWork[] {
    this.#assertNoRestoreBarrier();
    if (![limit, changeLimit].every((value) => Number.isInteger(value) && value > 0 && value <= 128)) {
      throw new RangeError("Invalid learning work page size.");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (this.hasActiveDeletion()) { this.#database.exec("ROLLBACK;"); return []; }
      const changes = this.#database.prepare(`SELECT raw_events.* FROM learning_event_changes
        JOIN raw_events USING(deduplication_key) ORDER BY learning_event_changes.rowid LIMIT ?`).all(changeLimit);
      const touch = this.#database.prepare(`INSERT INTO learning_prompt_work VALUES (?,1,?)
        ON CONFLICT(deduplication_key) DO UPDATE SET generation=generation+1, not_before=max(not_before,excluded.not_before)`);
      for (const changed of changes) {
        if (changed.session_id !== null && changed.repo_id !== null && changed.worktree !== null) {
          const keys = new Set<string>();
          const identity = [String(changed.session_id), String(changed.repo_id), String(changed.worktree), String(changed.event_timestamp), String(changed.event_id)];
          const previous = this.#database.prepare(`SELECT deduplication_key FROM raw_events
            WHERE parse_status='supported' AND trust='user' AND event_type='prompt.submitted'
              AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id) <= (?,?)
            ORDER BY event_timestamp DESC, event_id DESC LIMIT 1`).get(...identity);
          if (previous) keys.add(String(previous.deduplication_key));
          if (changed.trust === "model" && changed.event_type === "agent.message" &&
              JSON.parse(String(changed.safe_envelope_json)).event.actorId !== "provenloop-internal") keys.add(String(changed.deduplication_key));
          if (["agent.turn_completed", "session.idle"].includes(String(changed.event_type))) {
            const agent = this.#database.prepare(`SELECT deduplication_key FROM raw_events
              WHERE parse_status='supported' AND trust='model' AND event_type='agent.message'
                AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
                AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)<=(?,?)
              ORDER BY event_timestamp DESC,event_id DESC LIMIT 1`).get(...identity);
            if (agent) keys.add(String(agent.deduplication_key));
          }
          const nextUser = this.#database.prepare(`SELECT event_timestamp,event_id FROM raw_events
            WHERE parse_status='supported' AND trust='user' AND event_type='prompt.submitted'
              AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)>(?,?)
            ORDER BY event_timestamp,event_id LIMIT 1`).get(...identity);
          const laterSummary = this.#database.prepare(`SELECT deduplication_key FROM raw_events
            WHERE parse_status='supported' AND trust='model' AND event_type='agent.message'
              AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
              AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)>=(?,?)
              ${nextUser ? "AND (event_timestamp,event_id)<(?,?)" : ""}
            ORDER BY event_timestamp DESC,event_id DESC LIMIT 1`).get(...identity,
            ...(nextUser ? [String(nextUser.event_timestamp), String(nextUser.event_id)] : []));
          if (laterSummary) keys.add(String(laterSummary.deduplication_key));
          const effective = this.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(changed.safe_envelope_json))));
          const completionSource = effective.event.evidence?.sourceCompleteEventId;
          if (completionSource) {
            // Native derived proof may arrive long after another foreground turn has started.
            const completion = this.#database.prepare(`SELECT event_timestamp,event_id FROM raw_events
              WHERE adapter=? AND adapter_version=? AND session_id=? AND event_type='tool.completed' AND source_event_id=?`).get(
              effective.event.adapter, effective.event.adapterVersion, effective.event.sessionId ?? "", completionSource);
            if (completion) {
              const prompt = this.#database.prepare(`SELECT deduplication_key FROM raw_events
                WHERE parse_status='supported' AND trust='user' AND event_type='prompt.submitted'
                  AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)<=(?,?)
                ORDER BY event_timestamp DESC,event_id DESC LIMIT 1`).get(
                String(changed.session_id), String(changed.repo_id), String(changed.worktree), String(completion.event_timestamp), String(completion.event_id));
              if (prompt) keys.add(String(prompt.deduplication_key));
            }
          }
          for (const prompt of this.#database.prepare(`SELECT DISTINCT raw_events.deduplication_key FROM learning_sources affected
            JOIN learning_jobs ON learning_jobs.job_id=affected.job_id
            JOIN learning_sources source ON source.job_id=affected.job_id
            JOIN raw_events ON raw_events.event_id=source.event_id
            WHERE affected.event_id=? AND learning_jobs.state NOT IN ('cancelled','archived')
              AND NOT EXISTS (SELECT 1 FROM learning_jobs newer WHERE newer.window_id=learning_jobs.window_id AND newer.rowid>learning_jobs.rowid)
              AND ((raw_events.trust='user' AND raw_events.event_type='prompt.submitted')
                OR (raw_events.trust='model' AND raw_events.event_type='agent.message' AND raw_events.event_id=json_extract(learning_jobs.window_json, '$.anchorEventId'))) LIMIT 128`).all(String(changed.event_id))) {
            keys.add(String(prompt.deduplication_key));
          }
          // A failed operation may support several adjacent user turns; do not stop at the first.
          const following = this.#database.prepare(`SELECT deduplication_key, trust, event_type FROM raw_events
            WHERE parse_status='supported' AND session_id=? AND repo_id=? AND worktree=?
              AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
              AND (event_timestamp,event_id) > (?,?) ORDER BY event_timestamp, event_id LIMIT 12`).all(...identity);
          for (const prompt of following) {
            if ((prompt.trust === "user" && prompt.event_type === "prompt.submitted") || (prompt.trust === "model" && prompt.event_type === "agent.message")) keys.add(String(prompt.deduplication_key));
          }
          for (const key of keys) touch.run(key, Date.parse(String(changed.event_timestamp)) + 2_000);
        }
        this.#database.prepare("DELETE FROM learning_event_changes WHERE deduplication_key=?").run(String(changed.deduplication_key));
      }
      const prompts = this.#database.prepare(`SELECT raw_events.*, learning_prompt_work.generation FROM learning_prompt_work
        JOIN raw_events USING(deduplication_key) WHERE not_before <= ? ORDER BY not_before, learning_prompt_work.rowid LIMIT ?`).all(now.getTime(), limit);
      const agentTasks = new Map<string, { eventId: string; events: CaptureEnvelope[] }>();
      const work = prompts.map((prompt): LearningPromptWork => {
        const values = [String(prompt.session_id), String(prompt.repo_id), String(prompt.worktree), String(prompt.event_timestamp), String(prompt.event_id)];
        if (prompt.trust === "model" && prompt.event_type === "agent.message") {
          const boundary = this.#database.prepare(`SELECT event_timestamp,event_id FROM raw_events
            WHERE parse_status='supported' AND trust='user' AND event_type='prompt.submitted'
              AND session_id=? AND repo_id=? AND worktree=? AND (event_timestamp,event_id)<=(?,?)
            ORDER BY event_timestamp DESC,event_id DESC LIMIT 1`).get(...values);
          const key = boundary ? String(boundary.event_id) : String(prompt.event_id);
          let selected = agentTasks.get(key);
          if (!selected) {
            selected = this.#agentResearchTask(String(prompt.session_id), String(prompt.repo_id), String(prompt.worktree),
              boundary ? { timestamp: String(boundary.event_timestamp), eventId: String(boundary.event_id) } : undefined,
              String(prompt.event_id));
            agentTasks.set(key, selected);
          }
          return { deduplicationKey: String(prompt.deduplication_key), eventId: selected.eventId, generation: Number(prompt.generation), origin: "agent", events: selected.events };
        }
        const adjacent = (direction: "before" | "after") => this.#database.prepare(`SELECT safe_envelope_json FROM raw_events
          WHERE parse_status='supported' AND session_id=? AND repo_id=? AND worktree=?
            AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
            AND (event_timestamp,event_id) ${direction === "before" ? "<" : ">="} (?,?)
          ORDER BY event_timestamp ${direction === "before" ? "DESC" : "ASC"}, event_id ${direction === "before" ? "DESC" : "ASC"} LIMIT 64`).all(...values);
        const events = [...adjacent("before").reverse(), ...adjacent("after").slice(0, 32)].map((row) =>
          this.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json)))));
        const additionalProofs = events.filter((entry) => entry.event.eventType === "tool.completed" && Date.parse(entry.event.timestamp) >= Date.parse(String(prompt.event_timestamp))).slice(0, 32).flatMap((completion) => {
          // Native proof shares its completion source ID, so the existing source-identity index is sufficient.
          const row = this.#database.prepare(`SELECT safe_envelope_json FROM raw_events WHERE adapter=? AND adapter_version=?
            AND session_id=? AND event_type='test.completed' AND source_event_id=?`).get(
            completion.event.adapter, completion.event.adapterVersion, completion.event.sessionId ?? "", completion.sourceEventId);
          if (!row) return [];
          const proof = this.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json))));
          return events.some((entry) => entry.event.eventId === proof.event.eventId) ? [] : [proof];
        });
        return { deduplicationKey: String(prompt.deduplication_key), eventId: String(prompt.event_id), generation: Number(prompt.generation), events: [...events, ...additionalProofs] };
      });
      this.#database.exec("COMMIT;");
      return work;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  #agentResearchTask(
    sessionId: string, repoId: string, worktree: string,
    boundary: { timestamp: string; eventId: string } | undefined, fallbackEventId: string,
  ): { eventId: string; events: CaptureEnvelope[] } {
    if (!boundary) return { eventId: fallbackEventId, events: [] };
    const nextUser = this.#database.prepare(`SELECT event_timestamp,event_id FROM raw_events
      WHERE parse_status='supported' AND session_id=? AND repo_id=? AND worktree=? AND trust='user'
        AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
        AND (event_timestamp,event_id)>(?,?) ORDER BY event_timestamp,event_id LIMIT 1`)
      .get(sessionId, repoId, worktree, boundary.timestamp, boundary.eventId);
    const closingEvents = this.#database.prepare(`SELECT event_id,event_timestamp,event_type,trust,
      json_extract(safe_envelope_json,'$.event.actorId') AS actor_id,
      json_extract(safe_envelope_json,'$.event.participantId') AS participant_id,
      json_extract(safe_envelope_json,'$.event.completionStatus') AS completion_status,
      length(trim(coalesce(json_extract(safe_envelope_json,'$.content.message'),'')))>0 AS has_message FROM raw_events
      WHERE parse_status='supported' AND session_id=? AND repo_id=? AND worktree=?
        AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
        AND event_type IN ('agent.message','agent.turn_started','agent.turn_completed','session.idle','tool.started','tool.completed','tool.failed')
        AND (event_timestamp,event_id)>(?,?) ${nextUser ? "AND (event_timestamp,event_id)<(?,?)" : ""}
      ORDER BY event_timestamp,event_id`).iterate(sessionId, repoId, worktree, boundary.timestamp, boundary.eventId,
      ...(nextUser ? [String(nextUser.event_timestamp), String(nextUser.event_id)] : []));
    const read = (eventId: string): CaptureEnvelope => this.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(
      this.#database.prepare("SELECT safe_envelope_json FROM raw_events WHERE event_id=?").get(eventId)?.safe_envelope_json,
    ))));
    const task = read(boundary.eventId);
    const turn = closedAgentResearchTurn((function* (): Generator<ResearchTurnEvent> {
      for (const row of closingEvents) {
        if (row.event_type === "agent.message") {
          // Reconciliation may fill a message body after its original metadata was captured.
          const message = read(String(row.event_id));
          yield { ...message.event, hasMessage: Boolean(message.content?.message?.trim()) };
          continue;
        }
        yield {
        eventId: String(row.event_id), timestamp: String(row.event_timestamp), eventType: String(row.event_type),
        trust: row.trust as ResearchTurnEvent["trust"], hasMessage: Number(row.has_message) === 1,
        ...(typeof row.completion_status === "string" ? { completionStatus: row.completion_status as NonNullable<ResearchTurnEvent["completionStatus"]> } : {}),
        ...(typeof row.actor_id === "string" ? { actorId: row.actor_id } : {}),
        ...(typeof row.participant_id === "string" ? { participantId: row.participant_id } : {}),
        };
      }
    })(), task.event.participantId);
    if (!turn) return { eventId: fallbackEventId, events: [] };
    const summary = read(turn.summary.eventId); const closed = read(turn.closure.eventId);
    const rows = this.#database.prepare(`SELECT safe_envelope_json FROM raw_events
      WHERE parse_status='supported' AND session_id=? AND repo_id=? AND worktree=?
        AND coalesce(json_extract(safe_envelope_json, '$.event.actorId'),'') != 'provenloop-internal'
        AND (event_timestamp,event_id)>=(?,?) AND (event_timestamp,event_id)<=(?,?)
      ORDER BY event_timestamp,event_id`).iterate(sessionId, repoId, worktree, boundary.timestamp, boundary.eventId, turn.closure.timestamp, turn.closure.eventId);
    const events = selectAgentResearchEvents((function* (store: CanonicalSqliteStore) {
      for (const row of rows) yield store.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json))));
    })(this), task, summary, closed);
    return { eventId: summary.event.eventId, events };
  }

  public completeLearningPromptWork(work: LearningPromptWork, notBefore?: number): void {
    this.#assertNoRestoreBarrier();
    if (notBefore === undefined) {
      this.#database.prepare("DELETE FROM learning_prompt_work WHERE deduplication_key=? AND generation=?").run(work.deduplicationKey, work.generation);
    } else {
      this.#database.prepare("UPDATE learning_prompt_work SET not_before=? WHERE deduplication_key=? AND generation=?").run(notBefore, work.deduplicationKey, work.generation);
    }
  }

  #markLearningEventChange(deduplicationKey: string): void {
    if (asNumber(this.#database.prepare("PRAGMA user_version").get()?.user_version) >= 12) {
      this.#database.prepare("INSERT OR IGNORE INTO learning_event_changes VALUES (?)").run(deduplicationKey);
    }
  }

  public archiveExpiredLearning(knowledgeId: string, now: Date): boolean {
    this.#assertNoRestoreBarrier();
    const candidate = this.knowledgeCandidates([knowledgeId])[0];
    if (!candidate || candidate.state !== "candidate" || !candidate.expiresAt ||
        Date.parse(candidate.expiresAt) > now.getTime() || this.hasActiveDeletion()) return false;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const archived = { ...candidate, state: "archived" as const };
      this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?")
        .run(JSON.stringify(archived), sha256(archived), now.toISOString(), knowledgeId);
      this.#database.prepare("INSERT OR REPLACE INTO learning_auto_expiry VALUES (?,?)").run(knowledgeId, candidate.expiresAt);
      this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(knowledgeId);
      this.#database.exec("COMMIT;"); return true;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  #automaticLearningMutable(candidate: KnowledgeCandidate): boolean {
    return candidate.scope === "repository" && candidate.evidenceTier === "inferred" && candidate.conflictsWith.length === 0 &&
      (candidate.state === "candidate" || (candidate.state === "disputed" &&
        Boolean(this.#database.prepare("SELECT 1 FROM learning_relation_conflicts WHERE knowledge_id=?").get(candidate.knowledgeId))) || (candidate.state === "archived" &&
        Boolean(this.#database.prepare("SELECT 1 FROM learning_auto_expiry WHERE knowledge_id=?").get(candidate.knowledgeId)))) &&
      !this.feedbackEvents(candidate.knowledgeId).some((event) => event.source === "user") && !this.knowledgeDeletionBlocked(candidate.knowledgeId);
  }

  /** Bounded comparison material. Relations remain proposals until the commit rechecks each digest. */
  public learningComparisonCandidates(window: LearningWindow): readonly LearningComparisonCandidate[] {
    this.#assertNoRestoreBarrier();
    const anchor = window.events.find((entry) => entry.event.eventId === window.anchorEventId) ??
      window.events.find((entry) => entry.event.trust === "user" && entry.event.timestamp === window.createdAt);
    const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
    const query = normalize(anchor?.content?.message ?? "");
    const generic = new Set(["以后", "应该", "必须", "这个", "我们", "现在", "需要", "不要", "使用", "仓库"]);
    const chineseTerms = (value: string) => [...new Set((value.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((span) =>
      Array.from({ length: Math.max(0, span.length - 1) }, (_, index) => span.slice(index, index + 2))))].filter((term) => !generic.has(term));
    const terms = [...new Set([...researchTerms(query), ...chineseTerms(query)])];
    const rows = this.#database.prepare(`SELECT body_json FROM knowledge_candidates WHERE
      json_extract(body_json,'$.scope')='repository' AND json_extract(body_json,'$.scopeId')=?
      AND json_extract(body_json,'$.state') IN ('candidate','active','archived','disputed') ORDER BY updated_at DESC,knowledge_id`).iterate(window.repoId);
    const ranked: { value: LearningComparisonCandidate; score: number }[] = [];
    for (const row of rows) {
      const candidate = knowledgeCandidateSchema.parse(JSON.parse(String(row.body_json)));
      if (this.knowledgeDeletionBlocked(candidate.knowledgeId)) continue;
      const mutable = this.#automaticLearningMutable(candidate);
      const reviewed = this.learningProposals([candidate.knowledgeId]).filter((proposal) =>
        hasAcceptedLearningDistillation(proposal, proposal.sourceDigests) && proposal.rule === candidate.content &&
        sha256(proposal.discovery ?? null) === sha256(candidate.discovery ?? null) &&
        sha256([proposal.trigger]) === sha256(candidate.appliesWhen) && sha256(proposal.exclusions) === sha256(candidate.nonApplicability) &&
        proposal.sourceDigests.length === candidate.sourceEvidenceIds.length &&
        proposal.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
        (() => { const sourceWindow = this.learningWindow(proposal.jobId); return sourceWindow && this.learningSourcesCurrent(sourceWindow); })());
      const prior = reviewed[0];
      const parsed = learningComparisonCandidateSchema.safeParse({ knowledgeId: candidate.knowledgeId, targetDigest: sha256(candidate),
        rule: candidate.content, trigger: candidate.appliesWhen, exclusions: candidate.nonApplicability, canonicalKey: prior?.canonicalKey,
        state: candidate.state, evidenceTier: candidate.evidenceTier, mutable: mutable && prior !== undefined });
      if (!parsed.success || JSON.stringify(parsed.data).length > 7000) continue;
      const searchable = normalize([candidate.content, ...candidate.appliesWhen, prior?.canonicalKey ?? ""].join(" "));
      let score = terms.filter((term) => searchable.includes(term)).length;
      for (const proposal of reviewed) {
        const quotes = [proposal.userSource?.quote, proposal.agentSource?.quote, ...(proposal.supportingSources ?? []).map((source) => source.quote),
          ...(proposal.agentSource?.evidenceSources ?? []).map((source) => source.quote)].filter((quote): quote is string => quote !== undefined).map(normalize);
        const aliases = proposal.queryTerms?.include.filter((term) => !containsPotentialSecret(term) &&
          quotes.some((quote) => quote.includes(normalize(term)))) ?? [];
        score += aliases.filter((alias) => !generic.has(normalize(alias)) && query.includes(normalize(alias))).length * 12;
        // Older reviewed lessons may lack queryTerms. Their bound original-language
        // evidence still supplies weak topic matches; it is never sent as new guidance.
        score += terms.filter((term) => quotes.some((quote) => quote.includes(term))).length * 0.5;
      }
      ranked.push({ value: parsed.data, score });
      ranked.sort((a, b) => b.score - a.score);
      // Stream the complete repository while retaining only a bounded shortlist.
      // Recency is a tie-breaker, never a prefilter that can hide an old policy.
      if (ranked.length > 32) ranked.pop();
    }
    const selected: LearningComparisonCandidate[] = [];
    for (const { value } of ranked) {
      if (selected.length >= 8) break;
      if (JSON.stringify([...selected, value]).length > 7000) continue;
      selected.push(value);
    }
    return selected;
  }

  #reviewedLearningNoticeEligible(candidate: KnowledgeCandidate, now: Date): boolean {
    if (!this.#automaticLearningMutable(candidate) || candidate.state !== "candidate" ||
        (candidate.expiresAt && Date.parse(candidate.expiresAt) <= now.getTime()) ||
        this.knowledgeCandidatesWithUnavailableSources([candidate]).size > 0) return false;
    const evidence = this.knowledgeAdmissionEvidence([candidate]);
    return Boolean(learningSourceUse(candidate, evidence.learningProposals ?? [], evidence.envelopes, evidence.contextUseRecords)?.distilledLesson);
  }

  public claimLearningActivationNotice(knowledgeId: string): boolean {
    this.#assertNoRestoreBarrier();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const candidate = this.knowledgeCandidates([knowledgeId])[0];
      if (this.hasActiveDeletion()) { this.#database.exec("ROLLBACK;"); return false; }
      const eligible = candidate && ((candidate.state === "active" && candidate.evidenceTier === "externally_verified" &&
        new KnowledgeAdmissionPolicy().evaluate({ candidate, ...this.knowledgeAdmissionEvidence([candidate]) }).admitted) ||
        this.#reviewedLearningNoticeEligible(candidate, this.#now()));
      if (!candidate || !knowledgeId.startsWith("learning-knowledge-") || !eligible) {
        // Rotate ineligible entries so later valid notices still get a bounded turn.
        this.#database.prepare("UPDATE learning_notice_work SET rowid=(SELECT coalesce(max(rowid),0)+1 FROM learning_notice_work) WHERE knowledge_id=?").run(knowledgeId);
        this.#database.exec("COMMIT;"); return false;
      }
      const claimed = Number(this.#database.prepare("INSERT OR IGNORE INTO learning_notices VALUES (?,?)").run(knowledgeId, this.#now().toISOString()).changes) === 1;
      this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(knowledgeId);
      this.#database.exec("COMMIT;"); return claimed;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public releaseLearningActivationNotice(knowledgeId: string): void {
    this.#assertNoRestoreBarrier();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare("DELETE FROM learning_notices WHERE knowledge_id=?").run(knowledgeId);
      this.#database.prepare("INSERT OR IGNORE INTO learning_notice_work SELECT knowledge_id FROM knowledge_candidates WHERE knowledge_id=?").run(knowledgeId);
      this.#database.exec("COMMIT;");
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public learningWindow(jobId: string): LearningWindow | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database.prepare("SELECT window_json FROM learning_jobs WHERE job_id=?").get(jobId);
    return row ? learningWindowSchema.parse(JSON.parse(String(row.window_json))) : undefined;
  }

  public learningProposals(knowledgeIds?: readonly string[]): readonly RuleProposal[] {
    this.#assertNoRestoreBarrier();
    const rows = knowledgeIds === undefined ? this.#database.prepare("SELECT body_json FROM learning_proposals ORDER BY proposal_id").all()
      : [...new Set(knowledgeIds)].flatMap((id) => this.#database.prepare("SELECT body_json FROM learning_proposals WHERE knowledge_id=? ORDER BY proposal_id").all(id));
    return rows.map((row) => ruleProposalSchema.parse(JSON.parse(String(row.body_json))));
  }

  public learningReceipts(knowledgeIds?: readonly string[]): readonly LearningRecoveryReceipt[] {
    this.#assertNoRestoreBarrier();
    const rows = knowledgeIds === undefined ? this.#database.prepare("SELECT receipt_json FROM learning_proposals WHERE receipt_json IS NOT NULL ORDER BY proposal_id").all()
      : [...new Set(knowledgeIds)].flatMap((id) => this.#database.prepare("SELECT receipt_json FROM learning_proposals WHERE knowledge_id=? AND receipt_json IS NOT NULL ORDER BY proposal_id").all(id));
    return rows.map((row) => learningRecoveryReceiptSchema.parse(JSON.parse(String(row.receipt_json))));
  }

  #learningShellPeers(receipts: readonly LearningRecoveryReceipt[]): readonly { proposal: RuleProposal; receipt: LearningRecoveryReceipt }[] {
    const peers = new Map<string, { proposal: RuleProposal; receipt: LearningRecoveryReceipt }>();
    for (const receipt of receipts) {
      if (receipt.proves !== "repository_test_command") continue;
      const rows = this.#database.prepare(`SELECT proposal.body_json,proposal.receipt_json FROM learning_proposals proposal
        JOIN knowledge_candidates candidate ON candidate.knowledge_id=proposal.knowledge_id
        WHERE json_extract(proposal.receipt_json, '$.proves')='repository_test_command'
          AND json_extract(proposal.receipt_json, '$.repoId')=?
          AND json_extract(proposal.receipt_json, '$.branch')=? AND json_extract(proposal.receipt_json, '$.commitSha')=?
          AND json_extract(proposal.receipt_json, '$.predicate.toolName')=?
          AND json_extract(candidate.body_json, '$.state') IN ('active','disputed')`).all(
        receipt.repoId, receipt.branch, receipt.commitSha, receipt.predicate.toolName);
      for (const row of rows) {
        const proposal = ruleProposalSchema.parse(JSON.parse(String(row.body_json)));
        peers.set(proposal.proposalId, { proposal, receipt: learningRecoveryReceiptSchema.parse(JSON.parse(String(row.receipt_json))) });
      }
    }
    return [...peers.values()];
  }

  public scheduleLearningWindow(input: LearningWindow, expiresAt: string, now = this.#now()): LearningJob | undefined {
    this.#assertNoRestoreBarrier();
    const window = learningWindowSchema.parse(input);
    if (this.hasActiveDeletion() || !this.learningSourcesCurrent(window)) return undefined;
    const existing = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE window_id=? AND revision=?").get(window.windowId, window.revision);
    if (existing) return learningJobSchema.parse(JSON.parse(String(existing.body_json)));
    // A revision is not independent evidence and must not renew candidate expiry.
    const first = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE window_id=? ORDER BY rowid LIMIT 1").get(window.windowId);
    const prior = first ? learningJobSchema.parse(JSON.parse(String(first.body_json))) : undefined;
    if (this.#database.prepare("SELECT 1 FROM learning_jobs WHERE window_id=? AND state IN ('cancelled','archived') LIMIT 1").get(window.windowId)) return undefined;
    const latest = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE window_id=? ORDER BY rowid DESC LIMIT 1").get(window.windowId);
    const previous = latest ? learningJobSchema.parse(JSON.parse(String(latest.body_json))) : undefined;
    const previousRepairRow = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE window_id=? AND json_extract(body_json,'$.inputBudgetRecovery') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(window.windowId);
    const previousRepair = previousRepairRow ? learningJobSchema.parse(JSON.parse(String(previousRepairRow.body_json))).inputBudgetRecovery : undefined;
    const task = window.origin === "agent" ? window.events.find((entry) => entry.event.trust === "user" && entry.event.eventType === "prompt.submitted") : undefined;
    const taskBudget = task ? this.#database.prepare(`SELECT max(json_extract(job.body_json, '$.attempts')) AS attempts,
      min(json_extract(job.body_json, '$.expiresAt')) AS expires_at FROM learning_sources source JOIN learning_jobs job ON job.job_id=source.job_id
      WHERE source.event_id=? AND json_extract(job.window_json, '$.origin')='agent'`).get(task.event.eventId) : undefined;
    const attempts = Math.max(Number(taskBudget?.attempts ?? 0), Number(this.#database.prepare("SELECT coalesce(max(json_extract(body_json, '$.attempts')),0) AS attempts FROM learning_jobs WHERE window_id=?").get(window.windowId)?.attempts));
    const jobId = `learning-job-${sha256([window.windowId, window.revision]).slice(0, 24)}`;
    // Reconciliation can fill missing proof without changing the extracted correction.
    const saved = previous ? this.learningProposalsForJob(previous.jobId) : [];
    // A model review is bound to its full captured window. Enrichment requires a
    // new review with the original lifetime and attempt budget, not a copied digest.
    const needsDistillationReview = saved.some((proposal) => {
      const candidate = this.knowledgeCandidates([proposal.knowledgeId])[0];
      return hasAcceptedLearningDistillation(proposal, proposal.sourceDigests) &&
        candidate?.state === "candidate" && candidate.evidenceTier === "inferred" && candidate.conflictsWith.length === 0 &&
        !this.feedbackEvents(proposal.knowledgeId).some((entry) => entry.source === "user") &&
        sha256(proposal.sourceDigests) !== sha256(window.sources);
    });
    const retained = previous && ["waiting_evidence", "superseded"].includes(previous.state)
      ? saved.filter((proposal) => {
        if (proposal.distillation) return false;
        const candidate = this.knowledgeCandidates([proposal.knowledgeId])[0];
        if (candidate?.state !== "candidate" || this.feedbackEvents(proposal.knowledgeId).some((entry) => entry.source === "user")) return false;
        const { rule, trigger, exclusions, userSource, agentSource, failedOperationEventId, retryOperationEventId, completionEventId, predicate, shellPredicate, retention, supportingSources, canonicalKey } = proposal;
        try {
          return validateLearningResponse(window, { schemaVersion: 1, proposals: [{ rule, trigger, exclusions, userSource, agentSource, failedOperationEventId, retryOperationEventId, completionEventId, predicate, shellPredicate, retention, supportingSources, canonicalKey }] }).proposals.length === 1;
        } catch { return false; }
      }).map((proposal) => ruleProposalSchema.parse({ ...proposal, jobId, proposalId: `learning-proposal-${sha256([jobId, proposal.proposalId]).slice(0, 24)}`, sourceDigests: window.sources })) : [];
    const job = learningJobSchema.parse({ schemaVersion: 1, jobId,
      windowId: window.windowId, revision: window.revision, state: "pending", attempts, createdAt: window.createdAt,
      updatedAt: now.toISOString(), expiresAt: prior?.expiresAt ?? (typeof taskBudget?.expires_at === "string" ? taskBudget.expires_at : expiresAt), extractorVersion: "correction-extractor-1",
      ...(saved.length && !needsDistillationReview ? { state: retained.length ? "waiting_evidence" : "evaluated", result: previous?.result } : {}),
      ...(previous?.state === "paused" ? { state: "paused", retryAfter: previous.retryAfter, pauseReason: previous.pauseReason } : {}),
      ...(previousRepair === undefined ? {} : { inputBudgetRecovery: previousRepair }),
    });
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      if (this.hasActiveDeletion() || !this.learningSourcesCurrent(window)) { this.#database.exec("ROLLBACK;"); return undefined; }
      this.#database.prepare(`UPDATE learning_jobs SET state='superseded', body_json=json_set(body_json, '$.state', 'superseded')
        WHERE window_id=? AND state NOT IN ('archived','cancelled','superseded')`).run(window.windowId);
      this.#database.prepare("INSERT OR IGNORE INTO learning_jobs VALUES (?,?,?,?,?,?,?,?)").run(job.jobId, job.windowId, job.revision, job.state, JSON.stringify(job), JSON.stringify(window), job.createdAt, job.updatedAt);
      for (const source of window.sources) this.#database.prepare("INSERT OR IGNORE INTO learning_sources VALUES (?,?,?)").run(job.jobId, source.eventId, source.digest);
      for (const proposal of retained) this.#database.prepare("INSERT OR IGNORE INTO learning_proposals VALUES (?,?,?,?,NULL)").run(proposal.proposalId, job.jobId, proposal.knowledgeId, JSON.stringify(proposal));
      this.#database.exec("COMMIT;"); return job;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public learningSourcesCurrent(window: LearningWindow): boolean {
    this.#assertNoRestoreBarrier();
    return window.sources.every((source) => {
      const row = this.#database.prepare("SELECT safe_envelope_json FROM raw_events WHERE event_id=?").get(source.eventId);
      return row !== undefined && sha256(this.#effectiveEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json))))) === source.digest;
    });
  }

  public learningSourcesExist(window: LearningWindow): boolean {
    this.#assertNoRestoreBarrier();
    return window.sources.every((source) => this.#database.prepare("SELECT 1 FROM raw_events WHERE event_id=?").get(source.eventId) !== undefined);
  }

  public learningAttemptCount(window: LearningWindow, fallback: number): number {
    this.#assertNoRestoreBarrier();
    const task = window.origin === "agent" ? window.events.find((entry) => entry.event.trust === "user" && entry.event.eventType === "prompt.submitted") : undefined;
    if (!task) return fallback;
    return Math.max(fallback, Number(this.#database.prepare(`SELECT coalesce(max(json_extract(job.body_json, '$.attempts')),0) AS attempts
      FROM learning_sources source JOIN learning_jobs job ON job.job_id=source.job_id
      WHERE source.event_id=? AND json_extract(job.window_json, '$.origin')='agent'`).get(task.event.eventId)?.attempts ?? 0));
  }

  public learningProposalWasRecalled(proposal: RuleProposal, window: LearningWindow): boolean {
    this.#assertNoRestoreBarrier();
    if (!proposal.agentSource) return false;
    const summary = window.events.find((entry) => entry.event.eventId === proposal.agentSource?.eventId);
    if (!summary) return false;
    const since = Math.min(...window.events.map((entry) => Date.parse(entry.event.timestamp)));
    const until = Date.parse(summary.event.timestamp);
    return this.contextUseRecords(window.sessionId).some((record) => Date.parse(record.createdAt) >= since && Date.parse(record.createdAt) <= until &&
      [...record.returnedKnowledgeIds, ...record.appliedKnowledgeIds].some((id) => id === proposal.knowledgeId || id === `knowledge:${proposal.knowledgeId}`));
  }

  public transitionLearningJob(input: LearningJob, expectedState: LearningJob["state"]): boolean {
    this.#assertNoRestoreBarrier();
    const job = learningJobSchema.parse(input);
    if (this.hasActiveDeletion()) return false;
    // Advance the indexed queue clock on ties while retaining the actual observation time in the body.
    return Number(this.#database.prepare(`UPDATE learning_jobs SET state=?,body_json=?,updated_at=CASE WHEN updated_at>=?
      THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') ELSE ? END WHERE job_id=? AND state=?`)
      .run(job.state, JSON.stringify(job), job.updatedAt, job.updatedAt, job.jobId, expectedState).changes) === 1;
  }

  #discoverySourceDigest(candidate: KnowledgeCandidate): string {
    const evidence = this.knowledgeAdmissionEvidence([candidate]);
    return sha256({ sources: evidence.envelopes.map((entry) => [entry.event.eventId, sha256(entry)]).sort(),
      episodes: evidence.workEpisodes.map((episode) => [episode.episodeId, sha256(episode)]).sort(),
      proposals: (evidence.learningProposals ?? []).map((proposal) => [proposal.proposalId, sha256(proposal)]).sort() });
  }

  #discoveryEligible(candidate: KnowledgeCandidate, now: Date): boolean {
    if (this.hasActiveDeletion() || !["active", "candidate"].includes(candidate.state) || candidate.discovery?.producer === "user" ||
        candidate.expiresAt && Date.parse(candidate.expiresAt) <= now.getTime() ||
        this.knowledgeCandidatesWithUnavailableSources([candidate]).has(candidate.knowledgeId)) return false;
    const evidence = this.knowledgeAdmissionEvidence([candidate]);
    return new KnowledgeAdmissionPolicy().evaluate({ candidate, ...evidence }).admitted;
  }

  /** Scan a bounded durable page without copying source material into the job queue. */
  public scheduleDiscoveryEnrichment(now: Date, limit = 32): number {
    this.#assertNoRestoreBarrier();
    if (this.hasActiveDeletion()) return 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new RangeError("Invalid discovery page size.");
    const cursor = String(this.#database.prepare("SELECT knowledge_id FROM discovery_enrichment_cursor WHERE singleton=1").get()?.knowledge_id ?? "");
    const rows = this.#database.prepare("SELECT body_json FROM knowledge_candidates WHERE knowledge_id>? ORDER BY knowledge_id LIMIT ?").all(cursor, limit);
    let scheduled = 0; let last = "";
    for (const row of rows) {
      const candidate = knowledgeCandidateSchema.parse(JSON.parse(String(row.body_json))); last = candidate.knowledgeId;
      if (candidate.discovery?.producer === "user" || !["active", "candidate"].includes(candidate.state) ||
          candidate.expiresAt && Date.parse(candidate.expiresAt) <= now.getTime()) continue;
      const knowledgeDigest = knowledgeDiscoveryDigest(candidate);
      const metadataDigest = sha256(candidate.discovery ?? null);
      const priorRow = this.#database.prepare("SELECT body_json FROM discovery_enrichment WHERE knowledge_id=?").get(candidate.knowledgeId);
      const prior = priorRow ? discoveryEnrichmentJobSchema.parse(JSON.parse(String(priorRow.body_json))) : undefined;
      const sourceDigest = this.#discoverySourceDigest(candidate);
      if (prior && prior.knowledgeDigest === knowledgeDigest && prior.metadataDigest === metadataDigest && prior.sourceDigest === sourceDigest &&
          prior.vocabularyVersion === DISCOVERY_VOCABULARY_VERSION) continue;
      if (!this.#discoveryEligible(candidate, now)) continue;
      const job: DiscoveryEnrichmentJob = { schemaVersion: 1, knowledgeId: candidate.knowledgeId, knowledgeDigest, sourceDigest, metadataDigest,
        vocabularyVersion: DISCOVERY_VOCABULARY_VERSION, state: "pending", attempts: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.#database.prepare("INSERT INTO discovery_enrichment VALUES (?,?,?,NULL,?) ON CONFLICT(knowledge_id) DO UPDATE SET state=excluded.state,body_json=excluded.body_json,profile_json=NULL,updated_at=excluded.updated_at")
        .run(job.knowledgeId, job.state, JSON.stringify(job), job.updatedAt); scheduled += 1;
    }
    this.#database.prepare("INSERT INTO discovery_enrichment_cursor VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET knowledge_id=excluded.knowledge_id")
      .run(rows.length === limit ? last : "");
    return scheduled;
  }

  public discoveryEnrichmentJob(now: Date): DiscoveryEnrichmentJob | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database.prepare("SELECT body_json FROM discovery_enrichment WHERE " +
      "(state IN ('pending','paused','failed') AND json_extract(body_json,'$.attempts')<3 AND " +
      "(json_extract(body_json,'$.retryAfter') IS NULL OR json_extract(body_json,'$.retryAfter')<=?)) OR " +
      "(state='running' AND json_extract(body_json,'$.deadline')<=?) ORDER BY updated_at,knowledge_id LIMIT 1").get(now.toISOString(), now.toISOString());
    return row ? discoveryEnrichmentJobSchema.parse(JSON.parse(String(row.body_json))) : undefined;
  }

  public discoveryEnrichmentCandidate(job: DiscoveryEnrichmentJob, now: Date): KnowledgeCandidate | undefined {
    this.#assertNoRestoreBarrier();
    const candidate = this.knowledgeCandidates([job.knowledgeId])[0];
    return candidate && job.vocabularyVersion === DISCOVERY_VOCABULARY_VERSION && knowledgeDiscoveryDigest(candidate) === job.knowledgeDigest &&
      sha256(candidate.discovery ?? null) === job.metadataDigest && this.#discoveryEligible(candidate, now) &&
      this.#discoverySourceDigest(candidate) === job.sourceDigest ? candidate : undefined;
  }

  public transitionDiscoveryEnrichmentJob(input: DiscoveryEnrichmentJob, expectedState: DiscoveryEnrichmentJob["state"]): boolean {
    this.#assertNoRestoreBarrier(); const job = discoveryEnrichmentJobSchema.parse(input);
    if (this.hasActiveDeletion()) return false;
    return Number(this.#database.prepare("UPDATE discovery_enrichment SET state=?,body_json=?,updated_at=? WHERE knowledge_id=? AND state=? " +
      "AND json_extract(body_json,'$.knowledgeDigest')=? AND json_extract(body_json,'$.sourceDigest')=? AND json_extract(body_json,'$.metadataDigest')=?")
      .run(job.state, JSON.stringify(job), job.updatedAt, job.knowledgeId, expectedState, job.knowledgeDigest, job.sourceDigest, job.metadataDigest).changes) === 1;
  }

  public commitDiscoveryEnrichment(input: DiscoveryEnrichmentJob, profile: DiscoveryProfile, now: Date): boolean {
    this.#assertNoRestoreBarrier(); const job = discoveryEnrichmentJobSchema.parse(input);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const candidate = this.discoveryEnrichmentCandidate(job, now);
      if (!candidate || !validateDiscoveryProfile(candidate, profile) || profile.producer !== "model_reviewed") { this.#database.exec("ROLLBACK;"); return false; }
      const accepted = { ...job, state: "accepted" as const, updatedAt: now.toISOString() }; delete accepted.deadline; delete accepted.retryAfter; delete accepted.reason;
      const changed = this.#database.prepare("UPDATE discovery_enrichment SET state='accepted',body_json=?,profile_json=?,updated_at=? WHERE knowledge_id=? AND state='running' " +
        "AND json_extract(body_json,'$.knowledgeDigest')=? AND json_extract(body_json,'$.sourceDigest')=? AND json_extract(body_json,'$.metadataDigest')=?")
        .run(JSON.stringify(accepted), JSON.stringify(profile), accepted.updatedAt, job.knowledgeId, job.knowledgeDigest, job.sourceDigest, job.metadataDigest);
      this.#database.exec("COMMIT;"); return Number(changed.changes) === 1;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public discoveryProfiles(candidates: readonly KnowledgeCandidate[]): ReadonlyMap<string, DiscoveryProfile> {
    this.#assertNoRestoreBarrier(); const profiles = new Map<string, DiscoveryProfile>();
    if (asNumber(this.#database.prepare("PRAGMA user_version").get()?.user_version) < 23 || this.hasActiveDeletion()) return profiles;
    for (const candidate of candidates) {
      if (candidate.discovery?.producer === "user") continue;
      const row = this.#database.prepare("SELECT body_json,profile_json FROM discovery_enrichment WHERE knowledge_id=? AND state='accepted'").get(candidate.knowledgeId);
      if (!row) continue;
      const job = discoveryEnrichmentJobSchema.parse(JSON.parse(String(row.body_json)));
      const current = this.discoveryEnrichmentCandidate(job, this.#now());
      const profile = discoveryProfileSchema.safeParse(JSON.parse(String(row.profile_json)));
      if (current && knowledgeDiscoveryDigest(current) === knowledgeDiscoveryDigest(candidate) && profile.success && validateDiscoveryProfile(current, profile.data)) profiles.set(candidate.knowledgeId, profile.data);
    }
    return profiles;
  }

  public discoveryEnrichmentStatus(): Readonly<Record<string, number>> {
    this.#assertNoRestoreBarrier();
    if (asNumber(this.#database.prepare("PRAGMA user_version").get()?.user_version) < 23) return {};
    return Object.fromEntries(this.#database.prepare("SELECT state,count(*) AS count FROM discovery_enrichment GROUP BY state").all()
      .map((row) => [String(row.state), Number(row.count)]));
  }

  public reserveLearningAttempt(now: Date, limit: number): boolean {
    this.#assertNoRestoreBarrier();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const day = now.toISOString().slice(0, 10);
      const count = Number(this.#database.prepare("SELECT count(*) AS count FROM learning_attempts WHERE attempted_at>=?").get(`${day}T00:00:00.000Z`)?.count ?? 0);
      if (this.hasActiveDeletion() || count >= limit) { this.#database.exec("ROLLBACK;"); return false; }
      this.#database.prepare("INSERT INTO learning_attempts(attempted_at) VALUES (?)").run(now.toISOString());
      this.#database.exec("COMMIT;"); return true;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public commitLearningResult(input: { job: LearningJob; proposals: readonly RuleProposal[]; receipts: readonly LearningRecoveryReceipt[]; candidates: readonly KnowledgeCandidate[]; reevaluation?: boolean }): boolean {
    this.#assertNoRestoreBarrier();
    const job = learningJobSchema.parse(input.job);
    const proposals = input.proposals.map((entry) => ruleProposalSchema.parse(entry));
    const receipts = input.receipts.map((entry) => learningRecoveryReceiptSchema.parse(entry));
    const candidates = input.candidates.map(normalizedKnowledgeCandidate);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const window = this.learningWindow(job.jobId);
      const stored = this.#database.prepare("SELECT state FROM learning_jobs WHERE job_id=?").get(job.jobId);
      if (!window || stored?.state !== (input.reevaluation ? "waiting_evidence" : "running") || Date.parse(job.updatedAt) >= Date.parse(job.expiresAt) || this.hasActiveDeletion() || !this.learningSourcesCurrent(window) ||
          proposals.some((proposal) => this.learningProposalWasRecalled(proposal, window)) ||
          candidates.some((item) => this.knowledgeDeletionBlocked(item.knowledgeId)) || this.knowledgeCandidatesWithUnavailableSources(candidates).size > 0) { this.#database.exec("ROLLBACK;"); return false; }
      // A reviewed relationship is valid only against the exact candidate the
      // reviewer compared. Source enrichment and user controls can invalidate it.
      const relationTargets = new Map<string, KnowledgeCandidate>();
      const rejectedRevisions = new Set<string>();
      for (const proposal of proposals) {
        if (!proposal.relations?.length) continue;
        if (input.reevaluation || proposal.predicate || proposal.shellPredicate ||
            !hasAcceptedLearningDistillation(proposal, window.sources)) { this.#database.exec("ROLLBACK;"); return false; }
        for (const relation of proposal.relations) {
          const target = this.knowledgeCandidates([relation.knowledgeId])[0];
          const prior = target && this.learningProposals([target.knowledgeId]).find((entry) =>
            hasAcceptedLearningDistillation(entry, entry.sourceDigests) && entry.rule === target.content &&
            sha256([entry.trigger]) === sha256(target.appliesWhen) && sha256(entry.exclusions) === sha256(target.nonApplicability) &&
            entry.sourceDigests.length === target.sourceEvidenceIds.length &&
            entry.sourceDigests.every((source) => target.sourceEvidenceIds.includes(source.eventId)) &&
            (() => { const priorWindow = this.learningWindow(entry.jobId); return priorWindow && this.learningSourcesCurrent(priorWindow); })());
          if (!target || target.scopeId !== window.repoId || sha256(target) !== relation.targetDigest ||
              !this.#automaticLearningMutable(target) || !prior ||
              relationTargets.has(target.knowledgeId) || prior.retention?.kind !== proposal.retention?.kind ||
              (relation.kind === "equivalent" && proposal.knowledgeId !== target.knowledgeId) ||
              (relation.kind === "supersedes" && (!proposal.userSource || proposal.retention?.kind !== "convention" ||
                prior.retention?.kind !== "convention" || proposal.knowledgeId === target.knowledgeId)) ||
              this.knowledgeCandidatesWithUnavailableSources([target]).size > 0) { this.#database.exec("ROLLBACK;"); return false; }
          relationTargets.set(target.knowledgeId, target);
        }
      }
      // Exact concept keys are useful for a conservative conflict stop even when
      // the extractor omitted a relation. Similarity never authorizes replacement.
      for (const proposal of proposals) {
        if (proposal.relations?.length || !proposal.canonicalKey || !hasAcceptedLearningDistillation(proposal, window.sources)) continue;
        const peers = this.#database.prepare(`SELECT DISTINCT candidate.body_json FROM learning_proposals prior
          JOIN knowledge_candidates candidate ON prior.knowledge_id=candidate.knowledge_id
          WHERE json_extract(prior.body_json,'$.canonicalKey')=? AND json_extract(candidate.body_json,'$.scopeId')=?
          AND candidate.knowledge_id != ? AND json_extract(candidate.body_json,'$.state') IN ('candidate','active','archived')`)
          .all(proposal.canonicalKey, window.repoId, proposal.knowledgeId);
        const conflicts = peers.map((row) => knowledgeCandidateSchema.parse(JSON.parse(String(row.body_json)))).filter((peer) =>
          peer.content !== proposal.rule || sha256(peer.appliesWhen) !== sha256([proposal.trigger]) || sha256(peer.nonApplicability) !== sha256(proposal.exclusions));
        if (conflicts.length === 0) continue;
        for (const peer of conflicts) if (this.#automaticLearningMutable(peer) && peer.state === "candidate") {
          const disputed = { ...peer, state: "disputed" as const };
          this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?")
            .run(JSON.stringify(disputed), sha256(disputed), job.updatedAt, peer.knowledgeId);
          this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(peer.knowledgeId);
          this.#database.prepare("INSERT OR IGNORE INTO learning_relation_conflicts VALUES (?)").run(peer.knowledgeId);
        }
        const failed = { ...job, state: "failed" as const, result: "error" as const, error: "A prior lesson with the same concept requires an explicit relationship review.",
          ...(job.distillation ? { distillation: { ...job.distillation, accepted: 0, rejected: job.distillation.proposed,
            reasons: [...job.distillation.reasons, "Retention: unresolved relationship"].slice(0, 3) } } : {}) };
        this.#database.prepare("UPDATE learning_jobs SET state=?,body_json=?,updated_at=? WHERE job_id=?")
          .run(failed.state, JSON.stringify(failed), job.updatedAt, job.jobId);
        this.#database.exec("COMMIT;"); return false;
      }
      if (input.reevaluation) {
        const priorRow = this.#database.prepare("SELECT body_json FROM learning_jobs WHERE job_id=?").get(job.jobId);
        const priorJob = priorRow ? learningJobSchema.parse(JSON.parse(String(priorRow.body_json))) : undefined;
        if (!priorJob || priorJob.attempts !== job.attempts || priorJob.expiresAt !== job.expiresAt || Date.parse(job.updatedAt) >= Date.parse(job.expiresAt)) { this.#database.exec("ROLLBACK;"); return false; }
        const saved = this.learningProposalsForJob(job.jobId);
        const feedback = this.feedbackEvents();
        if (proposals.some((proposal) => !saved.some((entry) => entry.proposalId === proposal.proposalId && sha256(entry) === sha256(proposal))) ||
            candidates.some((candidate) => {
              const existing = this.knowledgeCandidates([candidate.knowledgeId])[0];
              return !existing || existing.state !== "candidate" || existing.evidenceTier !== "inferred" ||
                (existing.expiresAt !== undefined && Date.parse(job.updatedAt) >= Date.parse(existing.expiresAt)) ||
                feedback.some((entry) => entry.targetId === candidate.knowledgeId && entry.source === "user");
            })) { this.#database.exec("ROLLBACK;"); return false; }
      }
      for (const proposal of proposals) {
        if (proposal.jobId !== job.jobId) throw new Error("Learning proposal job mismatch.");
        const receipt = receipts.find((entry) => entry.proposalId === proposal.proposalId);
        this.#database.prepare("INSERT OR IGNORE INTO learning_proposals VALUES (?,?,?,?,?)").run(proposal.proposalId, job.jobId, proposal.knowledgeId, JSON.stringify(proposal), receipt ? JSON.stringify(receipt) : null);
        if (input.reevaluation && receipt) this.#database.prepare("UPDATE learning_proposals SET receipt_json=? WHERE proposal_id=? AND receipt_json IS NULL").run(JSON.stringify(receipt), proposal.proposalId);
      }
      for (const candidate of candidates) {
        if (candidate.state === "active") {
          const evidence = this.knowledgeAdmissionEvidence([candidate]);
          const sourceSessionIds = new Set(window.events.map((entry) => entry.event.sessionId).filter((id): id is string => id !== undefined));
          const admitted = new KnowledgeAdmissionPolicy().evaluate({ candidate, ...evidence,
            learningProposals: proposals, learningReceipts: receipts,
            contextUseRecords: [...sourceSessionIds].flatMap((id) => this.contextUseRecords(id)),
          });
          if (!admitted.admitted) throw new Error("Learning activation failed current canonical admission.");
        }
        // Existing user controls always win over extraction/replay.
        const existing = this.knowledgeCandidates([candidate.knowledgeId])[0];
        if (existing) {
          const userControls = this.feedbackEvents().some((event) => event.targetId === candidate.knowledgeId && event.source === "user");
          const newReceipt = receipts.find((receipt) => proposals.some((proposal) => proposal.knowledgeId === candidate.knowledgeId && proposal.proposalId === receipt.proposalId));
          const originEventId = newReceipt?.userEventId ?? newReceipt?.agentEventId;
          if (existing.state === "candidate" && candidate.state === "active" && !userControls && newReceipt && originEventId && (input.reevaluation || !existing.sourceEvidenceIds.includes(originEventId))) {
            this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?").run(JSON.stringify(candidate), sha256(candidate), candidate.validatedAt ?? candidate.createdAt, candidate.knowledgeId);
            this.#database.prepare("INSERT OR IGNORE INTO learning_notice_work VALUES (?)").run(candidate.knowledgeId);
          }
          if (this.#automaticLearningMutable(existing) && candidate.state === "candidate" &&
              candidate.evidenceTier === "inferred" && !userControls && !input.reevaluation) {
            const incoming = proposals.find((proposal) => proposal.knowledgeId === candidate.knowledgeId &&
              hasAcceptedLearningDistillation(proposal, window.sources) && sha256(proposal.sourceDigests) === sha256(window.sources) &&
              candidate.content === proposal.rule && sha256(candidate.appliesWhen) === sha256([proposal.trigger]) &&
              sha256(proposal.discovery ?? null) === sha256(candidate.discovery ?? null) &&
              sha256(candidate.nonApplicability) === sha256(proposal.exclusions));
            const priorProposals = this.learningProposals().filter((proposal) => proposal.knowledgeId === existing.knowledgeId &&
              proposal.jobId !== job.jobId && hasAcceptedLearningDistillation(proposal, proposal.sourceDigests) &&
              existing.content === proposal.rule && sha256(existing.appliesWhen) === sha256([proposal.trigger]) &&
              sha256(proposal.discovery ?? null) === sha256(existing.discovery ?? null) &&
              sha256(existing.nonApplicability) === sha256(proposal.exclusions) &&
              existing.sourceEvidenceIds.length === proposal.sourceDigests.length &&
              proposal.sourceDigests.every((source) => existing.sourceEvidenceIds.includes(source.eventId)));
            const priorWindows = priorProposals.map((proposal) => this.learningWindow(proposal.jobId));
            const anchorId = incoming && learningProposalSource(incoming).eventId;
            const currentTask = window.origin === "agent" ? window.events.find((entry) => entry.event.trust === "user" && entry.event.eventType === "prompt.submitted")?.event.eventId : anchorId;
            const independent = anchorId && currentTask && priorWindows.length > 0 && priorWindows.every((priorWindow) =>
              priorWindow && priorWindow.windowId !== window.windowId && !priorWindow.sources.some((source) => source.eventId === currentTask));
            const exact = candidate.content === existing.content && sha256(candidate.appliesWhen) === sha256(existing.appliesWhen) &&
              sha256(candidate.nonApplicability) === sha256(existing.nonApplicability) && priorProposals.some((prior) =>
                sha256(prior.retrievalScope) === sha256(incoming?.retrievalScope));
            const equivalent = incoming?.relations?.some((relation) => relation.kind === "equivalent" && relation.knowledgeId === existing.knowledgeId);
            const enrichment = existing.state === "candidate" && priorWindows.some((priorWindow) => priorWindow?.windowId === window.windowId) &&
              priorWindows.every((priorWindow) => priorWindow !== undefined && !this.learningSourcesCurrent(priorWindow));
            if (incoming && (enrichment || (independent && (equivalent || (exact && existing.state !== "disputed"))))) {
              const expiry = [existing.expiresAt, candidate.expiresAt].filter((value): value is string => value !== undefined)
                .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
              const renewedExpiry = [existing.expiresAt, candidate.expiresAt].filter((value): value is string => value !== undefined)
                .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
              const refreshed = normalizedKnowledgeCandidate({ ...candidate, createdAt: existing.createdAt,
                importance: existing.importance, utility: existing.utility, coverage: existing.coverage,
                ...(independent && renewedExpiry ? { expiresAt: renewedExpiry } : expiry ? { expiresAt: expiry } : {}) });
              this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?")
                .run(JSON.stringify(refreshed), sha256(refreshed), job.updatedAt, candidate.knowledgeId);
              this.#database.prepare("DELETE FROM learning_auto_expiry WHERE knowledge_id=?").run(candidate.knowledgeId);
              this.#database.prepare("DELETE FROM learning_relation_conflicts WHERE knowledge_id=?").run(candidate.knowledgeId);
              if (this.#reviewedLearningNoticeEligible(refreshed, new Date(job.updatedAt))) {
                this.#database.prepare("INSERT OR IGNORE INTO learning_notice_work VALUES (?)").run(candidate.knowledgeId);
              }
            } else if (incoming && independent && !exact && !equivalent) {
              // Changed exceptions need an explicit relationship review; stop
              // returning the obsolete wording while that ambiguity is unresolved.
              const disputed = { ...existing, state: "disputed" as const };
              this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?")
                .run(JSON.stringify(disputed), sha256(disputed), job.updatedAt, existing.knowledgeId);
              this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(existing.knowledgeId);
              this.#database.prepare("INSERT OR IGNORE INTO learning_relation_conflicts VALUES (?)").run(existing.knowledgeId);
              rejectedRevisions.add(incoming.proposalId);
              this.#database.prepare("DELETE FROM learning_proposals WHERE proposal_id=?").run(incoming.proposalId);
            }
          }
          continue;
        }
        this.#database.prepare("INSERT INTO knowledge_candidates VALUES (?,?,?,?,?,?)").run(candidate.knowledgeId, candidate.schemaVersion, JSON.stringify(candidate), sha256(candidate), candidate.createdAt, candidate.validatedAt ?? candidate.createdAt);
        if (candidate.state === "active" || this.#reviewedLearningNoticeEligible(candidate, new Date(job.updatedAt))) {
          this.#database.prepare("INSERT OR IGNORE INTO learning_notice_work VALUES (?)").run(candidate.knowledgeId);
        }
      }
      for (const proposal of proposals) for (const relation of proposal.relations ?? []) {
        if (relation.kind !== "supersedes") continue;
        const target = relationTargets.get(relation.knowledgeId);
        const replacement = this.knowledgeCandidates([proposal.knowledgeId])[0];
        if (!target || !replacement || replacement.state !== "candidate" || replacement.content !== proposal.rule) {
          this.#database.exec("ROLLBACK;"); return false;
        }
        const superseded = { ...target, state: "superseded" as const };
        this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?")
          .run(JSON.stringify(superseded), sha256(superseded), job.updatedAt, target.knowledgeId);
        this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(target.knowledgeId);
        this.#database.prepare("DELETE FROM learning_auto_expiry WHERE knowledge_id=?").run(target.knowledgeId);
        this.#database.prepare("DELETE FROM learning_relation_conflicts WHERE knowledge_id=?").run(target.knowledgeId);
      }
      const shellPeers = this.#learningShellPeers(receipts);
      for (const incoming of shellPeers) {
        if (incoming.receipt.proves !== "repository_test_command" || !receipts.some((receipt) => receipt.receiptId === incoming.receipt.receiptId)) continue;
        for (const peer of shellPeers) {
          if (peer.receipt.proves !== "repository_test_command" || peer.proposal.knowledgeId === incoming.proposal.knowledgeId || !conflictingShellLearning(incoming.receipt, peer.receipt)) continue;
          for (const [knowledgeId, conflictId] of [[incoming.proposal.knowledgeId, peer.proposal.knowledgeId], [peer.proposal.knowledgeId, incoming.proposal.knowledgeId]]) {
            if (!knowledgeId || !conflictId) continue;
            const existing = this.knowledgeCandidates([knowledgeId])[0];
            if (!existing || !["active", "disputed"].includes(existing.state)) continue;
            const disputed = { ...existing, state: "disputed", conflictsWith: [...new Set([...existing.conflictsWith, conflictId])] };
            this.#database.prepare("UPDATE knowledge_candidates SET body_json=?,source_digest=?,updated_at=? WHERE knowledge_id=?").run(JSON.stringify(disputed), sha256(disputed), job.updatedAt, knowledgeId);
            this.#database.prepare("DELETE FROM learning_notice_work WHERE knowledge_id=?").run(knowledgeId);
          }
        }
      }
      const completedJob = rejectedRevisions.size ? { ...job, state: "failed" as const, result: "error" as const,
        error: "Changed lesson conditions require an explicit relationship review.",
        ...(job.distillation ? { distillation: { ...job.distillation, accepted: Math.max(0, job.distillation.accepted - rejectedRevisions.size),
          rejected: job.distillation.rejected + rejectedRevisions.size, reasons: [...job.distillation.reasons, "Retention: unresolved relationship"].slice(0, 3) } } : {}) } : job;
      this.#database.prepare("UPDATE learning_jobs SET state=?,body_json=?,updated_at=? WHERE job_id=?").run(completedJob.state, JSON.stringify(completedJob), job.updatedAt, job.jobId);
      this.#database.exec("COMMIT;"); return rejectedRevisions.size === 0;
    } catch (error) { this.#database.exec("ROLLBACK;"); throw error; }
  }

  public async backupTo(
    path: string,
    options: { readonly runtimeVersion?: string } = {},
  ): Promise<number> {
    this.#assertNoRestoreBarrier();
    if (this.#path !== ":memory:" && resolve(path) === this.#path) {
      throw new Error("A backup destination must differ from its source database.");
    }
    await mkdir(dirname(path), {
      recursive: true,
    });
    const pages = await backup(this.#database, path);
    await writeDurable(
      `${path}.deletion.key`,
      this.#deletionIdentityKey,
    );
    this.#assertNoRestoreBarrier();
    await CanonicalSqliteStore.#writeBackupManifest(path, options.runtimeVersion);
    await CanonicalSqliteStore.verifyBackup(path);
    return pages;
  }

  public static async backupDatabase(
    sourcePath: string,
    path: string,
    options: { readonly runtimeVersion?: string } = {},
  ): Promise<CanonicalBackupManifest> {
    if (resolve(sourcePath) === resolve(path)) {
      throw new Error("A backup destination must differ from its source database.");
    }
    await mkdir(dirname(path), { recursive: true });
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      CanonicalSqliteStore.#assertRestorableBackup(source, DEFAULT_SQLITE_MIGRATIONS);
      await backup(source, path);
      const key = readOptionalText(`${sourcePath}.deletion.key`);
      if (key === undefined || !/^[a-f0-9]{64}$/u.test(key)) {
        throw new InvalidCanonicalSchemaError("A valid deletion key is required for a complete backup.");
      }
      await writeDurable(`${path}.deletion.key`, key);
      await CanonicalSqliteStore.#writeBackupManifest(path, options.runtimeVersion);
      return await CanonicalSqliteStore.verifyBackup(path);
    } finally {
      source.close();
    }
  }

  static async #writeBackupManifest(
    path: string,
    runtimeVersion?: string,
  ): Promise<void> {
    const database = new DatabaseSync(path, { readOnly: true });
    let schemaVersion: number;
    try {
      schemaVersion = asNumber(database.prepare("PRAGMA user_version").get()?.user_version);
      const check = database.prepare("PRAGMA quick_check").get();
      if (check === undefined || firstColumn(check) !== "ok") {
        throw new InvalidCanonicalSchemaError("The backup failed SQLite integrity validation.");
      }
    } finally {
      database.close();
    }
    const manifest: CanonicalBackupManifest = {
      formatVersion: 1,
      product: "ProvenLoopCanonicalBackup",
      createdAt: new Date().toISOString(),
      schemaVersion,
      databaseDigest: digestBytes(await readFile(path)),
      deletionKeyDigest: digestBytes((await readFile(`${path}.deletion.key`, "utf8")).trim()),
      ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
    };
    await writeDurable(`${path}.manifest.json`, JSON.stringify(manifest));
  }

  public static async verifyBackup(path: string): Promise<CanonicalBackupManifest> {
    const manifest = JSON.parse(await readFile(`${path}.manifest.json`, "utf8")) as CanonicalBackupManifest;
    const deletionKey = (await readFile(`${path}.deletion.key`, "utf8")).trim();
    if (
      manifest.product !== "ProvenLoopCanonicalBackup" ||
      manifest.formatVersion !== 1 ||
      !Number.isInteger(manifest.schemaVersion) ||
      manifest.databaseDigest !== digestBytes(await readFile(path)) ||
      !/^[a-f0-9]{64}$/u.test(deletionKey) ||
      manifest.deletionKeyDigest !== digestBytes(deletionKey)
    ) {
      throw new InvalidCanonicalSchemaError("The backup manifest, database, and deletion key do not match.");
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      CanonicalSqliteStore.#assertRestorableBackup(database, DEFAULT_SQLITE_MIGRATIONS);
      const check = database.prepare("PRAGMA quick_check").get();
      if (
        asNumber(database.prepare("PRAGMA user_version").get()?.user_version) !== manifest.schemaVersion ||
        check === undefined || firstColumn(check) !== "ok"
      ) {
        throw new InvalidCanonicalSchemaError("The backup schema or integrity check failed.");
      }
      const verifier = deletionIdentityDigest(
        "key", "provenloop-deletion-tombstone-key", deletionKey,
      );
      for (const row of database.prepare("SELECT body_json FROM deletion_operations").all()) {
        if (deletionOperationSchema.parse(JSON.parse(String(row.body_json))).tombstoneKeyVerifier !== verifier) {
          throw new InvalidCanonicalSchemaError("The backup deletion key does not match its tombstones.");
        }
      }
    } finally {
      database.close();
    }
    return manifest;
  }

  public static databaseFingerprint(path: string): string {
    const database = new DatabaseSync(path, { readOnly: true });
    const digest = createHash("sha256");
    try {
      digest.update(JSON.stringify(database.prepare("PRAGMA user_version").get()));
      const tables = database.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all();
      for (const table of tables) {
        digest.update(JSON.stringify(table));
        for (const row of database.prepare(
          `SELECT * FROM ${sqliteIdentifier(String(table.name))} ORDER BY rowid`,
        ).iterate()) {
          digest.update(JSON.stringify(row, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          ));
        }
      }
      return digest.digest("hex");
    } finally {
      database.close();
    }
  }

  public static databaseVersion(path: string): number {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return asNumber(database.prepare("PRAGMA user_version").get()?.user_version);
    } finally {
      database.close();
    }
  }

  public static async restoreFromBackup(
    backupPath: string,
    targetPath: string,
    options: CanonicalRestoreOptions = {},
  ): Promise<CanonicalStoreHealth> {
    await mkdir(dirname(resolve(targetPath)), { recursive: true });
    const lease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dirname(resolve(targetPath)), "canonical-restore"),
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error("Another canonical restore or recovery is already executing.");
    }
    try {
      return await CanonicalSqliteStore.#restoreFromBackupLocked(backupPath, targetPath, options);
    } finally {
      await lease.release();
    }
  }

  static async #restoreFromBackupLocked(
    backupPath: string,
    targetPath: string,
    options: CanonicalRestoreOptions,
  ): Promise<CanonicalStoreHealth> {
    targetPath = resolve(targetPath);
    backupPath = resolve(backupPath);
    if (targetPath === backupPath) {
      throw new Error("A backup cannot be restored over itself.");
    }
    await mkdir(dirname(targetPath), {
      recursive: true,
    });
    await CanonicalSqliteStore.#recoverInterruptedRestoreLocked(targetPath);
    const restoreBarrierPath = `${targetPath}.restore.lock`;
    const restoreBarrier = await open(restoreBarrierPath, "wx");
    const requiredTombstones = new Map<string, DeletionOperation>();
    const requiredLearningSuppressions = new Set<string>();
    const requiredUserFeedback = new Map<string, string>();
    const requiredLifecycleStates = new Map<string, string>();
    const requiredDiscoveryOverrides = new Map<string, string>();
    const requiredLearningMutability = new Map<string, boolean>();
    let requiredResetCutoff: string | undefined;
    let installedIncompleteDeletion = false;
    let requiredDeletionKey: string | undefined;
    const restoreId = randomUUID();
    const temporaryPath = `${targetPath}.restore-${restoreId}.tmp`;
    let journal: RestoreJournal = {
      formatVersion: 1,
      pid: process.pid,
      operationId: restoreId,
      targetPath,
      temporaryPath,
      previousPath: `${targetPath}.restore-${restoreId}.previous`,
      hadTarget: existsSync(targetPath),
      phase: "preparing",
    };
    try {
      await restoreBarrier.writeFile(JSON.stringify(journal), "utf8");
      await restoreBarrier.sync();
    } finally {
      await restoreBarrier.close();
    }
    let retainJournal = false;
    try {
      if (existsSync(`${backupPath}.manifest.json`)) {
        await CanonicalSqliteStore.verifyBackup(backupPath);
      }
      if (existsSync(targetPath)) {
      let current: DatabaseSync | undefined;
      try {
        current = new DatabaseSync(targetPath);
        current.exec("BEGIN EXCLUSIVE;");
        if (asNumber(current.prepare("PRAGMA user_version").get()?.user_version) >= 16) {
          const reset = current.prepare("SELECT cutoff FROM record_reset WHERE singleton=1").get();
          if (reset) requiredResetCutoff = isoTimestampSchema.parse(String(reset.cutoff));
        }
        for (const row of current.prepare("SELECT feedback_id,body_json FROM feedback_events WHERE json_extract(body_json, '$.source')='user'").all()) {
          requiredUserFeedback.set(String(row.feedback_id), sha256(JSON.parse(String(row.body_json))));
        }
        if (asNumber(current.prepare("PRAGMA user_version").get()?.user_version) >= 3) {
          for (const row of current.prepare("SELECT knowledge_id,body_json FROM knowledge_candidates WHERE json_extract(body_json,'$.discovery.producer')='user'").all()) {
            requiredDiscoveryOverrides.set(String(row.knowledge_id), sha256(JSON.parse(String(row.body_json)).discovery));
          }
          for (const row of current.prepare("SELECT knowledge_id,body_json FROM knowledge_candidates WHERE json_extract(body_json, '$.state') IN ('archived','disputed','superseded')").all()) {
            requiredLifecycleStates.set(String(row.knowledge_id), String(JSON.parse(String(row.body_json)).state));
            if (asNumber(current.prepare("PRAGMA user_version").get()?.user_version) >= 20) {
              const id = String(row.knowledge_id);
              requiredLearningMutability.set(id, Boolean(current.prepare("SELECT 1 FROM learning_auto_expiry WHERE knowledge_id=? UNION ALL SELECT 1 FROM learning_relation_conflicts WHERE knowledge_id=?").get(id, id)));
            }
          }
        }
        if (asNumber(current.prepare("PRAGMA user_version").get()?.user_version) >= 11) {
          for (const row of current.prepare("SELECT target_digest FROM learning_suppressions").all()) requiredLearningSuppressions.add(String(row.target_digest));
        }
        const hasTable = current
          .prepare(
            `SELECT COUNT(*) AS count
               FROM sqlite_master
              WHERE type = 'table'
                AND name = 'deletion_operations'`,
          )
          .get() as Readonly<Record<string, unknown>>;
        if (asNumber(hasTable.count) > 0) {
          const rows = current
            .prepare(
              `SELECT body_json
                 FROM deletion_operations
                ORDER BY updated_at`,
            )
            .all() as readonly Readonly<Record<string, unknown>>[];
          for (const row of rows) {
            const operation = deletionOperationSchema.parse(
              JSON.parse(String(row.body_json)) as unknown,
            );
            if (operation.status === "completed") {
              requiredTombstones.set(
                operation.deletionId,
                operation,
              );
            } else {
              installedIncompleteDeletion = true;
            }
          }
        }
        current.exec("COMMIT;");
      } finally {
        try {
          current?.exec("ROLLBACK;");
        } catch {
          // The exclusive transaction may already be committed.
        }
        current?.close();
      }
      if (requiredTombstones.size > 0 || requiredLearningSuppressions.size > 0) {
        requiredDeletionKey = (
          await readFile(`${targetPath}.deletion.key`, "utf8")
        ).trim();
      }
      }
      if (installedIncompleteDeletion) {
        throw new InvalidCanonicalSchemaError(
          "Cannot restore while a deletion operation is incomplete.",
        );
      }
      if (
        options.expectedTargetFingerprint !== undefined &&
        (
          !journal.hadTarget ||
          CanonicalSqliteStore.databaseFingerprint(targetPath) !== options.expectedTargetFingerprint
        )
      ) {
        throw new Error("Canonical data changed before the restore barrier was acquired; refusing to overwrite new writes.");
      }
      if (journal.hadTarget) {
        await CanonicalSqliteStore.backupDatabase(targetPath, journal.previousPath);
        journal = {
          ...journal,
          previousDigest: CanonicalSqliteStore.databaseFingerprint(targetPath),
        };
        await writeDurable(restoreBarrierPath, JSON.stringify(journal));
      }
      let backupDeletionKey: string | undefined;
      let source: DatabaseSync | undefined;
      try {
        source = new DatabaseSync(backupPath, {
          readOnly: true,
        });
        CanonicalSqliteStore.#assertRestorableBackup(
          source,
          options.migrations ?? DEFAULT_SQLITE_MIGRATIONS,
        );
        for (const [knowledgeId, digest] of requiredDiscoveryOverrides) {
          const prior = asNumber(source.prepare("PRAGMA user_version").get()?.user_version) >= 3
            ? source.prepare("SELECT body_json FROM knowledge_candidates WHERE knowledge_id=?").get(knowledgeId) : undefined;
          if (!prior || sha256(JSON.parse(String(prior.body_json)).discovery) !== digest) {
            throw new InvalidCanonicalSchemaError("Backup predates a user discovery correction.");
          }
        }
        if (requiredResetCutoff !== undefined) {
          const reset = asNumber(source.prepare("PRAGMA user_version").get()?.user_version) >= 16
            ? source.prepare("SELECT cutoff FROM record_reset WHERE singleton=1").get() : undefined;
          if (!reset || Date.parse(isoTimestampSchema.parse(String(reset.cutoff))) < Date.parse(requiredResetCutoff)) {
            throw new InvalidCanonicalSchemaError("Backup predates the installed record reset.");
          }
        }
        const backupOperationRows = source
          .prepare(
            `SELECT body_json
               FROM deletion_operations
              ORDER BY updated_at`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[];
        try {
          backupDeletionKey = (
            await readFile(`${backupPath}.deletion.key`, "utf8")
          ).trim();
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) ||
            backupOperationRows.length > 0
          ) {
            throw error;
          }
          backupDeletionKey = randomBytes(32).toString("hex");
        }
        if (!/^[a-f0-9]{64}$/u.test(backupDeletionKey)) {
          throw new InvalidCanonicalSchemaError(
            "Backup deletion identity key is malformed.",
          );
        }
        if (
          backupOperationRows.length > 0 &&
          requiredDeletionKey !== undefined &&
          backupDeletionKey !== requiredDeletionKey
        ) {
          throw new InvalidCanonicalSchemaError(
            "Backup deletion identity key does not match the installed database.",
          );
        }
        if (requiredTombstones.size > 0) {
          const backupTombstones = new Map(
            backupOperationRows.flatMap((row) => {
              const operation = deletionOperationSchema.parse(
                JSON.parse(String(row.body_json)) as unknown,
              );
              if (operation.status !== "completed") {
                return [];
              }
              return [
                [
                  operation.deletionId,
                  operation,
                ] as const,
              ];
            }),
          );
          for (const [
            deletionId,
            required,
          ] of requiredTombstones) {
            const candidate = backupTombstones.get(deletionId);
            if (
              candidate === undefined ||
              candidate.targetDigest !== required.targetDigest ||
              candidate.tombstoneKeyVerifier !==
                required.tombstoneKeyVerifier ||
              JSON.stringify(candidate.blockedIdentityDigests) !==
                JSON.stringify(required.blockedIdentityDigests)
            ) {
              throw new InvalidCanonicalSchemaError(
                "Backup is missing an installed deletion tombstone.",
              );
            }
          }
        }
        if (requiredLearningSuppressions.size > 0) {
          const available = asNumber(source.prepare("PRAGMA user_version").get()?.user_version) >= 11
            ? new Set(source.prepare("SELECT target_digest FROM learning_suppressions").all().map((row) => String(row.target_digest))) : new Set<string>();
          if (backupDeletionKey !== requiredDeletionKey || [...requiredLearningSuppressions].some((digest) => !available.has(digest))) {
            throw new InvalidCanonicalSchemaError("Backup is missing an installed learning deletion suppression.");
          }
        }
        for (const [feedbackId, digest] of requiredUserFeedback) {
          const row = source.prepare("SELECT body_json FROM feedback_events WHERE feedback_id=?").get(feedbackId);
          if (!row || sha256(JSON.parse(String(row.body_json))) !== digest) {
            throw new InvalidCanonicalSchemaError("Backup is missing an installed user knowledge control.");
          }
        }
        for (const [knowledgeId, state] of requiredLifecycleStates) {
          if (asNumber(source.prepare("PRAGMA user_version").get()?.user_version) < 3) {
            throw new InvalidCanonicalSchemaError("Backup would reverse an installed knowledge lifecycle state.");
          }
          const row = source.prepare("SELECT body_json FROM knowledge_candidates WHERE knowledge_id=?").get(knowledgeId);
          if (!row || JSON.parse(String(row.body_json)).state !== state) {
            throw new InvalidCanonicalSchemaError("Backup would reverse an installed knowledge lifecycle state.");
          }
          if (requiredLearningMutability.get(knowledgeId) === false && asNumber(source.prepare("PRAGMA user_version").get()?.user_version) >= 20 &&
              source.prepare("SELECT 1 FROM learning_auto_expiry WHERE knowledge_id=? UNION ALL SELECT 1 FROM learning_relation_conflicts WHERE knowledge_id=?").get(knowledgeId, knowledgeId)) {
            throw new InvalidCanonicalSchemaError("Backup would restore automatic learning over an explicit lifecycle control.");
          }
        }
        await backup(source, temporaryPath);
        await writeFile(
          `${temporaryPath}.deletion.key`,
          backupDeletionKey,
          "utf8",
        );
      } finally {
        source?.close();
      }

      let health: CanonicalStoreHealth;
      let restored: CanonicalSqliteStore | undefined;
      try {
        restored = new CanonicalSqliteStore(
          temporaryPath,
          { ...options, allowSchemaMigration: true },
        );
        health = restored.health();
      } finally {
        restored?.close();
      }
      if (health.quickCheck !== "ok") {
        throw new Error(
          `Restored SQLite quick_check failed: ${health.quickCheck}.`,
        );
      }
      journal = {
        ...journal,
        phase: "installing",
        replacementDigest: CanonicalSqliteStore.databaseFingerprint(temporaryPath),
      };
      await writeDurable(restoreBarrierPath, JSON.stringify(journal));
      await writeDurable(`${targetPath}.restore.generation`, restoreId);
      let validatedSource: DatabaseSync | undefined;
      try {
        validatedSource = new DatabaseSync(temporaryPath, {
          readOnly: true,
        });
        await writeDurable(
          `${targetPath}.deletion.key`,
          backupDeletionKey,
        );
        options.faultInjector?.("after_restore_key_install");
        await backup(validatedSource, targetPath);
      } finally {
        validatedSource?.close();
      }

      let installedDatabase: DatabaseSync | undefined;
      try {
        installedDatabase = new DatabaseSync(targetPath);
        installedDatabase.exec(
          `PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`,
        );
        CanonicalSqliteStore.#assertRestorableBackup(
          installedDatabase,
          options.migrations ?? DEFAULT_SQLITE_MIGRATIONS,
        );
        health = CanonicalSqliteStore.#databaseHealth(installedDatabase);
      } finally {
        installedDatabase?.close();
      }
      if (health.quickCheck !== "ok") {
        throw new Error(
          `Installed SQLite quick_check failed: ${health.quickCheck}.`,
        );
      }
      return health;
    } catch (error) {
      if (journal.phase === "installing") {
        try {
          await CanonicalSqliteStore.#rollBackRestore(journal);
        } catch (recoveryError) {
          retainJournal = true;
          throw new AggregateError(
            [error, recoveryError],
            "Restore failed and requires recovery. The maintenance journal and verified snapshots were preserved; no unrecognized writes were overwritten.",
            { cause: recoveryError },
          );
        }
      }
      throw error;
    } finally {
      if (!retainJournal) {
        await CanonicalSqliteStore.#removeDatabaseFiles(temporaryPath);
        await CanonicalSqliteStore.#removeDatabaseFiles(journal.previousPath);
        await unlink(restoreBarrierPath).catch(CanonicalSqliteStore.#ignoreMissing);
      }
    }
  }

  public static async recoverInterruptedRestore(targetPath: string): Promise<void> {
    const lease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dirname(resolve(targetPath)), "canonical-restore"),
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error("Another canonical restore or recovery is already executing.");
    }
    try {
      await CanonicalSqliteStore.#recoverInterruptedRestoreLocked(targetPath);
    } finally {
      await lease.release();
    }
  }

  static async #recoverInterruptedRestoreLocked(targetPath: string): Promise<void> {
    targetPath = resolve(targetPath);
    const path = `${targetPath}.restore.lock`;
    const content = readOptionalText(path);
    if (content === undefined) {
      return;
    }
    let journal: RestoreJournal;
    try {
      journal = JSON.parse(content) as RestoreJournal;
    } catch {
      throw new Error("The restore journal is incomplete or legacy; preserve the database and backups for explicit recovery.");
    }
    if (
      journal.formatVersion !== 1 || !Number.isInteger(journal.pid) || journal.pid <= 0 ||
      journal.targetPath !== targetPath ||
      !/^[a-f0-9-]{36}$/u.test(journal.operationId) ||
      journal.temporaryPath !== `${targetPath}.restore-${journal.operationId}.tmp` ||
      journal.previousPath !== `${targetPath}.restore-${journal.operationId}.previous` ||
      !["preparing", "installing"].includes(journal.phase)
    ) {
      throw new Error("The restore journal is malformed; automatic recovery was refused.");
    }
    try {
      process.kill(journal.pid, 0);
      throw new Error("A restore is still active; wait for its owning process to finish.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
    if (journal.phase === "installing") {
      await CanonicalSqliteStore.#rollBackRestore(journal);
    }
    await CanonicalSqliteStore.#removeDatabaseFiles(journal.temporaryPath);
    await CanonicalSqliteStore.#removeDatabaseFiles(journal.previousPath);
    await unlink(path);
  }

  static async #rollBackRestore(journal: RestoreJournal): Promise<void> {
    if (existsSync(journal.targetPath)) {
      const currentDigest = CanonicalSqliteStore.databaseFingerprint(journal.targetPath);
      if (
        currentDigest !== journal.previousDigest &&
        currentDigest !== journal.replacementDigest
      ) {
        throw new Error("The restore target contains unrecognized changes; refusing to overwrite possible new data.");
      }
    }
    if (journal.hadTarget) {
      await CanonicalSqliteStore.verifyBackup(journal.previousPath);
      const previous = new DatabaseSync(journal.previousPath, { readOnly: true });
      try {
        await writeDurable(
          `${journal.targetPath}.deletion.key`,
          (await readFile(`${journal.previousPath}.deletion.key`, "utf8")).trim(),
        );
        await backup(previous, journal.targetPath);
      } finally {
        previous.close();
      }
    } else {
      await CanonicalSqliteStore.#removeDatabaseFiles(journal.targetPath);
    }
    await writeDurable(`${journal.targetPath}.restore.generation`, randomUUID());
  }

  public health(): CanonicalStoreHealth {
    this.#assertNoRestoreBarrier();
    return CanonicalSqliteStore.#databaseHealth(this.#database);
  }

  static #databaseHealth(database: DatabaseSync): CanonicalStoreHealth {
    const journalMode = database
      .prepare("PRAGMA journal_mode;")
      .get() as Readonly<Record<string, unknown>>;
    const busyTimeout = database
      .prepare("PRAGMA busy_timeout;")
      .get() as Readonly<Record<string, unknown>>;
    const quickCheck = database
      .prepare("PRAGMA quick_check;")
      .get() as Readonly<Record<string, unknown>>;
    const userVersion = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    return {
      busyTimeoutMs: asNumber(firstColumn(busyTimeout)),
      journalMode: String(firstColumn(journalMode)),
      quickCheck: String(firstColumn(quickCheck)),
      userVersion: asNumber(firstColumn(userVersion)),
    };
  }

  public hasActiveDeletion(): boolean {
    this.#assertNoRestoreBarrier();
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM deletion_operations
          WHERE status IN ('running', 'completing', 'failed')`,
      )
      .get() as Readonly<Record<string, unknown>>;
    return asNumber(row.count) > 0;
  }

  public beginDeletion(
    target: CanonicalDeletionTarget,
    deletionId: string = randomUUID(),
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const targetType = deletionTargetTypeSchema.parse(
      target.targetType,
    );
    const targetId = normalizedDeletionTargetId(
      targetType,
      target.targetId.trim(),
    );
    if (
      targetId.length === 0 ||
      !deletionIdPattern.test(deletionId)
    ) {
      throw new Error(
        "Deletion target and operation IDs must be non-empty.",
      );
    }
    validateDeletionTargetId(targetType, targetId);
    const targetDigest = deletionIdentityDigest(
      "target",
      `${targetType}:${targetId}`,
      this.#deletionIdentityKey,
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      const existing = (this.#database
        .prepare(
          `SELECT body_json
             FROM deletion_operations
            ORDER BY updated_at DESC`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[])
        .map((row) =>
          deletionOperationSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        );
      const active = existing.find(
        (candidate) =>
          candidate.status === "running" ||
          candidate.status === "completing",
      );
      if (active !== undefined) {
        if (active.targetDigest !== targetDigest) {
          throw new Error(
            "A deletion operation is already active.",
          );
        }
        this.#database.exec("COMMIT;");
        return active;
      }
      const completed = existing.find(
        (candidate) =>
          candidate.status === "completed" &&
          candidate.targetDigest === targetDigest,
      );
      if (completed !== undefined) {
        this.#database.exec("COMMIT;");
        return completed;
      }
      const resumable = existing.find(
        (candidate) =>
          candidate.status === "failed" &&
          candidate.targetDigest === targetDigest,
      );
      if (resumable !== undefined) {
        const resumed = deletionOperationSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        activeTargetId: targetId,
        attemptCount: resumable.attemptCount + 1,
        blockedIdentityDigests:
          resumable.blockedIdentityDigests,
        deletedDependentCount: 0,
        deletedQueueItemCount: 0,
        deletedSourceCount: 0,
        deletionId: resumable.deletionId,
        ...(resumable.plannedAffectedSessionIds === undefined
          ? {}
          : {
              plannedAffectedSessionIds:
                resumable.plannedAffectedSessionIds,
            }),
        ...(resumable.plannedDependentIds === undefined
          ? {}
          : {
              plannedDependentIds:
                resumable.plannedDependentIds,
            }),
        ...(resumable.plannedDependencySeedIds === undefined
          ? {}
          : {
              plannedDependencySeedIds:
                resumable.plannedDependencySeedIds,
            }),
        ...(resumable.plannedSourceIds === undefined
          ? {}
          : {
              plannedSourceIds: resumable.plannedSourceIds,
            }),
        ...(resumable.plannedQueueItemIds === undefined
          ? {}
          : {
              plannedQueueItemIds:
                resumable.plannedQueueItemIds,
            }),
        ...(resumable.plannedQueueIdentities === undefined
          ? {}
          : {
              plannedQueueIdentities:
                resumable.plannedQueueIdentities,
            }),
        requestedAt: resumable.requestedAt,
        status: "running",
        targetDigest,
        targetType,
        tombstoneKeyVerifier:
          this.#deletionIdentityKeyVerifier(),
      });
        this.#writeDeletionOperation(resumed);
        this.#database.exec("COMMIT;");
        return resumed;
      }
      if (
        existing.some((candidate) => candidate.status === "failed")
      ) {
        throw new Error(
          "A failed deletion must be resumed before another deletion starts.",
        );
      }
      if (
        targetType === "knowledge" &&
        this.knowledgeCandidates([
          targetId,
        ]).length === 0
      ) {
        throw new Error(
          `Knowledge ${targetId} does not exist.`,
        );
      }
      const operation = deletionOperationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      activeTargetId: targetId,
      attemptCount: 1,
      blockedIdentityDigests: [],
      deletedDependentCount: 0,
      deletedQueueItemCount: 0,
      deletedSourceCount: 0,
      deletionId,
      requestedAt: this.#now().toISOString(),
      status: "running",
      targetDigest,
      targetType,
      tombstoneKeyVerifier:
        this.#deletionIdentityKeyVerifier(),
    });
      this.#database
        .prepare(
          `INSERT INTO deletion_operations (
             deletion_id,
             status,
             body_json,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          operation.deletionId,
          operation.status,
          JSON.stringify(operation),
          operation.requestedAt,
          operation.requestedAt,
        );
      this.#database.exec("COMMIT;");
      return operation;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public deletionOperation(
    deletionId: string,
  ): DeletionOperation | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE deletion_id = ?`,
      )
      .get(deletionId) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : deletionOperationSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        );
  }

  public deleteCanonicalTarget(
    deletionId: string,
    target: CanonicalDeletionTarget,
  ): CanonicalDeletionMutationResult {
    this.#assertNoRestoreBarrier();
    let operation = this.deletionOperation(deletionId);
    if (operation?.status !== "running") {
      throw new Error(
        `Deletion operation ${deletionId} is not active.`,
      );
    }
    const targetType = deletionTargetTypeSchema.parse(
      target.targetType,
    );
    const targetId = normalizedDeletionTargetId(
      targetType,
      target.targetId.trim(),
    );
    validateDeletionTargetId(targetType, targetId);
    if (
      operation.targetType !== targetType ||
      operation.targetDigest !==
        deletionIdentityDigest(
          "target",
          `${targetType}:${targetId}`,
          this.#deletionIdentityKey,
        )
    ) {
      throw new Error(
        "Deletion target does not match the active operation.",
      );
    }
    const allRawRows = this.#database
      .prepare(
        `SELECT deduplication_key,
                event_id,
                session_id,
                safe_envelope_json
           FROM raw_events`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const allParserRows = this.#database
      .prepare(
        `SELECT parser_error_id,
                queue_item_id,
                deduplication_key,
                safe_envelope_json
           FROM parser_errors`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const episodeTarget =
      targetType === "episode"
        ? this.workEpisodes().find(
            (episode) => episode.episodeId === targetId,
          )
        : undefined;
    const sourceIds = new Set(
      operation.plannedSourceIds ??
        (
          targetType === "source"
            ? sourceIdentityForms(targetId)
            : []
        ),
    );
    const dependentIds = new Set(
      operation.plannedDependentIds ?? [],
    );
    if (targetType === "knowledge") {
      dependentIds.add(`knowledge:${targetId}`);
    }
    const dependencySeedIds = new Set(
      operation.plannedDependencySeedIds ?? [],
    );
    if (targetType === "episode") {
      dependencySeedIds.add(targetId);
    }
    const targetSessionIds = new Set(
      operation.plannedAffectedSessionIds ?? [],
    );
    const candidateSessionIds = new Set(targetSessionIds);
    if (targetType === "session") {
      targetSessionIds.add(targetId);
      candidateSessionIds.add(targetId);
    }
    if (episodeTarget !== undefined) {
      for (const eventId of episodeTarget.sourceEventIds) {
        sourceIds.add(eventId);
      }
      for (const sessionId of episodeTarget.sessionIds) {
        targetSessionIds.add(sessionId);
        candidateSessionIds.add(sessionId);
      }
    }
    const knownIdentityIds = new Set(
      allRawRows.flatMap((row) => [
        String(row.deduplication_key),
        String(row.event_id),
      ]),
    );
    const parserEnvelopes = new Map<number, CaptureEnvelope>();
    for (const row of allParserRows) {
      if (row.safe_envelope_json === null) {
        continue;
      }
      const parsed = captureEnvelopeSchema.safeParse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      if (parsed.success) {
        parserEnvelopes.set(
          asNumber(row.parser_error_id),
          parsed.data,
        );
        knownIdentityIds.add(parsed.data.deduplicationKey);
        knownIdentityIds.add(parsed.data.event.eventId);
      }
    }
    const referenceIdentifiers = new Set(
      sourceIds,
    );
    const selectedRawKeys = new Set<string>();
    const selectedParserIds = new Set<number>();
    let changed: boolean;
    do {
      changed = false;
      for (const row of allRawRows) {
        const deduplicationKey = String(row.deduplication_key);
        if (selectedRawKeys.has(deduplicationKey)) {
          continue;
        }
        const eventId = String(row.event_id);
        const sessionId =
          row.session_id === null
            ? undefined
            : String(row.session_id);
        const envelope = this.#effectiveEnvelope(captureEnvelopeSchema.parse(
          JSON.parse(String(row.safe_envelope_json)) as unknown,
        ));
        const sourceAlias = captureSourceAlias(envelope);
        const directlySelected =
          (
            targetType === "source" &&
            (
              deduplicationKey === targetId ||
              eventId === targetId
            )
          ) ||
          (
            targetType === "session" &&
            sessionId === targetId
          ) ||
          (
            targetType === "episode" &&
            (
              sourceIds.has(eventId) ||
              (
                sessionId !== undefined &&
                targetSessionIds.has(sessionId)
              )
            )
          );
        if (
          !directlySelected &&
          !(sourceAlias !== undefined && referenceIdentifiers.has(sourceAlias)) &&
          !captureEvidenceReferences(envelope).some((id) =>
            referenceIdentifiers.has(id),
          )
        ) {
          continue;
        }
        selectedRawKeys.add(deduplicationKey);
        sourceIds.add(deduplicationKey);
        sourceIds.add(eventId);
        referenceIdentifiers.add(deduplicationKey);
        referenceIdentifiers.add(eventId);
        if (sourceAlias !== undefined) {
          sourceIds.add(sourceAlias);
          referenceIdentifiers.add(sourceAlias);
        }
        if (sessionId !== undefined) {
          candidateSessionIds.add(sessionId);
        }
        changed = true;
      }
      for (const row of allParserRows) {
        const parserErrorId = asNumber(row.parser_error_id);
        if (selectedParserIds.has(parserErrorId)) {
          continue;
        }
        const envelope = parserEnvelopes.get(parserErrorId);
        const sourceAlias = envelope === undefined ? undefined : captureSourceAlias(envelope);
        const deduplicationKey =
          row.deduplication_key === null
            ? undefined
            : String(row.deduplication_key);
        const directlySelected =
          (
            targetType === "source" &&
            (
              (
                deduplicationKey !== undefined &&
                sourceIds.has(deduplicationKey)
              ) ||
              (
                envelope !== undefined &&
                sourceIds.has(envelope.event.eventId)
              )
            )
          ) ||
          (
            targetType === "session" &&
            envelope?.event.sessionId === targetId
          ) ||
          (
            targetType === "episode" &&
            envelope !== undefined &&
            (
              sourceIds.has(envelope.event.eventId) ||
              (
                envelope.event.sessionId !== undefined &&
                targetSessionIds.has(
                  envelope.event.sessionId,
                )
              )
            )
          );
        if (
          !directlySelected &&
          !(sourceAlias !== undefined && referenceIdentifiers.has(sourceAlias)) &&
          (
            envelope === undefined ||
            !captureEvidenceReferences(envelope).some((id) =>
              referenceIdentifiers.has(id),
            )
          )
        ) {
          continue;
        }
        selectedParserIds.add(parserErrorId);
        dependentIds.add(String(row.queue_item_id));
        if (sourceAlias !== undefined) {
          sourceIds.add(sourceAlias);
          referenceIdentifiers.add(sourceAlias);
        }
        if (deduplicationKey !== undefined) {
          sourceIds.add(deduplicationKey);
          referenceIdentifiers.add(deduplicationKey);
        }
        if (envelope !== undefined) {
          sourceIds.add(envelope.event.eventId);
          sourceIds.add(envelope.deduplicationKey);
          referenceIdentifiers.add(envelope.event.eventId);
          referenceIdentifiers.add(envelope.deduplicationKey);
          if (envelope.event.sessionId !== undefined) {
            candidateSessionIds.add(envelope.event.sessionId);
          }
        }
        changed = true;
      }
    } while (changed);
    const deduplicationKeys = [...selectedRawKeys].sort();
    const oldEpisodes = this.workEpisodes();
    const selectedEventIds = new Set(
      allRawRows
        .filter((row) =>
          selectedRawKeys.has(String(row.deduplication_key)),
        )
        .map((row) => String(row.event_id)),
    );
    for (const episode of oldEpisodes) {
      if (
        (
          targetType === "episode" &&
          episode.episodeId === targetId
        ) ||
        episode.sourceEventIds.some((eventId) =>
          selectedEventIds.has(eventId),
        ) ||
        (
          targetType === "session" &&
          episode.sessionIds.includes(targetId)
        )
      ) {
        dependencySeedIds.add(episode.episodeId);
      }
    }
    operation = deletionOperationSchema.parse({
      ...operation,
      plannedAffectedSessionIds: [
        ...targetSessionIds,
      ].sort(),
      plannedDependentIds: [
        ...dependentIds,
      ].sort(),
      plannedDependencySeedIds: [
        ...dependencySeedIds,
      ].sort(),
      plannedSourceIds: [
        ...sourceIds,
      ].sort(),
    });
    this.#writeDeletionOperation(operation);
    const oldAssociations = this.episodeAssociations();
    const affectedLearningJobs = new Set<string>();
    for (const row of this.#database.prepare("SELECT job_id,event_id FROM learning_sources").all()) {
      if (sourceIds.has(String(row.event_id))) affectedLearningJobs.add(String(row.job_id));
    }
    if (targetType === "knowledge") for (const proposal of this.learningProposals([targetId])) affectedLearningJobs.add(proposal.jobId);
    const affectedLearningKnowledge = new Set<string>(targetType === "knowledge" ? [targetId] : []);
    const allLearningProposals = this.learningProposals();
    let learningChanged: boolean;
    do {
      learningChanged = false;
      for (const proposal of allLearningProposals) {
        // Relationship reviews retain the compared identity and its digest. A
        // descendant cannot keep that binding after its target is forgotten.
        if (proposal.relations?.some((relation) => affectedLearningKnowledge.has(relation.knowledgeId)) &&
            !affectedLearningJobs.has(proposal.jobId)) {
          affectedLearningJobs.add(proposal.jobId); learningChanged = true;
        }
        if (affectedLearningJobs.has(proposal.jobId) && !affectedLearningKnowledge.has(proposal.knowledgeId)) {
          affectedLearningKnowledge.add(proposal.knowledgeId); learningChanged = true;
        }
        if (affectedLearningKnowledge.has(proposal.knowledgeId) && !affectedLearningJobs.has(proposal.jobId)) {
          affectedLearningJobs.add(proposal.jobId); learningChanged = true;
        }
      }
    } while (learningChanged);
    for (const id of affectedLearningKnowledge) dependentIds.add(`knowledge:${id}`);
    for (const jobId of affectedLearningJobs) {
      dependentIds.add(jobId);
      for (const row of this.#database.prepare("SELECT proposal_id,receipt_json FROM learning_proposals WHERE job_id=?").all(jobId)) {
        dependentIds.add(String(row.proposal_id));
        if (row.receipt_json) dependentIds.add(learningRecoveryReceiptSchema.parse(JSON.parse(String(row.receipt_json))).receiptId);
      }
    }
    operation = deletionOperationSchema.parse({ ...operation, plannedDependentIds: [...dependentIds].sort() });
    this.#writeDeletionOperation(operation);

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      for (const id of affectedLearningKnowledge) {
        this.#database.prepare("INSERT OR IGNORE INTO learning_suppressions VALUES (?)").run(deletionIdentityDigest("target", `knowledge:${id}`, this.#deletionIdentityKey));
        this.#database.prepare("DELETE FROM knowledge_candidates WHERE knowledge_id=?").run(id);
      }
      for (const id of affectedLearningJobs) this.#database.prepare("DELETE FROM learning_jobs WHERE job_id=?").run(id);
      if (targetType === "knowledge") {
        this.#database.prepare("DELETE FROM learning_jobs WHERE job_id IN (SELECT job_id FROM learning_proposals WHERE knowledge_id=?)").run(targetId);
        this.#database
          .prepare(
            "DELETE FROM knowledge_candidates WHERE knowledge_id = ?",
          )
          .run(targetId);
      }
      for (const chunk of sqliteChunks(deduplicationKeys)) {
        const parameters = placeholders(chunk.length);
        const learningJobs = this.#database.prepare(`SELECT DISTINCT job_id FROM learning_sources WHERE event_id IN (SELECT event_id FROM raw_events WHERE deduplication_key IN (${parameters}))`).all(...chunk);
        for (const row of learningJobs) {
          dependentIds.add(String(row.job_id));
          for (const proposal of this.#database.prepare("SELECT proposal_id,receipt_json FROM learning_proposals WHERE job_id=?").all(String(row.job_id))) {
            dependentIds.add(String(proposal.proposal_id));
            if (proposal.receipt_json) dependentIds.add(learningRecoveryReceiptSchema.parse(JSON.parse(String(proposal.receipt_json))).receiptId);
          }
          this.#database.prepare("DELETE FROM learning_jobs WHERE job_id=?").run(String(row.job_id));
        }
        if (this.#hasEnrichments()) {
          for (const row of this.#database.prepare(
            `SELECT enrichment_id FROM raw_event_enrichments
              WHERE deduplication_key IN (${parameters})`,
          ).all(...chunk)) {
            dependentIds.add(String(row.enrichment_id));
          }
          this.#database.prepare(
            `DELETE FROM raw_event_enrichments
              WHERE deduplication_key IN (${parameters})`,
          ).run(...chunk);
        }
        this.#database
          .prepare(
            `DELETE FROM parser_errors
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...chunk);
        this.#database
          .prepare(
            `DELETE FROM queue_processing
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...chunk);
        this.#database
          .prepare(
            `DELETE FROM raw_events
              WHERE deduplication_key IN (${parameters})`,
          )
          .run(...chunk);
      }
      if (selectedParserIds.size > 0) {
        const parserIds = [...selectedParserIds];
        const parserQueueItemIds = allParserRows
          .filter((row) =>
            selectedParserIds.has(asNumber(row.parser_error_id)),
          )
          .map((row) => String(row.queue_item_id));
        if (parserQueueItemIds.length > 0) {
          this.#database
            .prepare(
              `DELETE FROM queue_processing
                WHERE queue_item_id IN (${placeholders(
                  parserQueueItemIds.length,
                )})`,
            )
            .run(...parserQueueItemIds);
        }
        this.#database
          .prepare(
            `DELETE FROM parser_errors
              WHERE parser_error_id IN (${placeholders(
                parserIds.length,
              )})`,
          )
          .run(...parserIds);
      }
      const removedSessionIds = new Set(
        [...candidateSessionIds].filter((sessionId) => {
          const row = this.#database
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM raw_events
                WHERE session_id = ?`,
            )
            .get(sessionId) as Readonly<Record<string, unknown>>;
          return asNumber(row.count) === 0;
        }),
      );
      for (const episode of oldEpisodes) {
        if (
          (
            targetType === "episode" &&
            episode.episodeId === targetId
          ) ||
          episode.sessionIds.some((sessionId) =>
            removedSessionIds.has(sessionId),
          )
        ) {
          dependentIds.add(episode.episodeId);
          this.#database
            .prepare(
              "DELETE FROM work_episodes WHERE episode_id = ?",
            )
            .run(episode.episodeId);
        }
      }
      for (const association of oldAssociations) {
        if (
          removedSessionIds.has(association.leftSessionId) ||
          removedSessionIds.has(association.rightSessionId)
        ) {
          dependentIds.add(association.associationId);
          this.#database
            .prepare(
              "DELETE FROM evidence_links WHERE link_id = ?",
            )
            .run(association.associationId);
        }
      }
      const dependencyReferences: TypedDeletionReferences = {
        deduplication: new Set(
          [...sourceIds].filter((id) =>
            /^[a-f0-9]{64}$/iu.test(id),
          ),
        ),
        episode: new Set(dependencySeedIds),
        event: new Set(
          [...sourceIds].filter((id) =>
            /^event-[a-f0-9]{64}$/iu.test(id),
          ),
        ),
        record: new Set(dependentIds),
        session: new Set(removedSessionIds),
      };
      const affectedKnowledgeIds = new Set<string>();
      let deletedInPass: number;
      do {
        deletedInPass =
          deleteIdentityRows(
            this.#database,
            dependencyReferences,
            dependentIds,
          ) +
          deleteEvidenceLinkRows(
            this.#database,
            dependencyReferences,
            dependentIds,
            dependencySeedIds,
          ) +
          deleteRebuildableProjectionRows(
            this.#database,
            "branch_contexts",
            "branch_context_id",
            "body_json",
            dependencyReferences,
          ) +
          deleteDependentRows(
            this.#database,
            "correction_keys",
            "correction_key_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteDependentRows(
            this.#database,
            "correction_opportunities",
            "opportunity_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          (
            targetType === "knowledge"
              ? 0
              : deleteDependentRows(
                  this.#database,
                  "knowledge_candidates",
                  "knowledge_id",
                  "body_json",
                  dependencyReferences,
                  dependentIds,
                )
          ) +
          deleteDependentRows(
            this.#database,
            "process_claims",
            "claim_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteFeedbackRows(
            this.#database,
            dependencyReferences,
            dependentIds,
            affectedKnowledgeIds,
          ) +
          deleteSessionMuteRows(
            this.#database,
            dependencyReferences,
          ) +
          deleteDependentRows(
            this.#database,
            "context_use_records",
            "request_id",
            "body_json",
            dependencyReferences,
            dependentIds,
          ) +
          deleteDependentRows(
            this.#database,
            "metrics",
            "metric_id",
            "dimensions_json",
            dependencyReferences,
            dependentIds,
          );
      } while (deletedInPass > 0);
      this.#database.exec(
        `DELETE FROM correction_key_sources
          WHERE correction_key_id NOT IN (
            SELECT correction_key_id
              FROM correction_keys
          );`,
      );
      if (targetType === "knowledge") {
        const timestamp = operation.requestedAt;
        const rows = this.#database
          .prepare(
            `SELECT body_json
               FROM knowledge_candidates
              ORDER BY knowledge_id`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[];
        for (const row of rows) {
          const candidate = knowledgeCandidateSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          );
          if (
            candidate.supersedes !== targetId &&
            !candidate.conflictsWith.includes(targetId)
          ) {
            continue;
          }
          const {
            supersedes,
            ...withoutSupersedes
          } = candidate;
          const updated = knowledgeCandidateSchema.parse({
            ...withoutSupersedes,
            conflictsWith: candidate.conflictsWith.filter(
              (conflict) => conflict !== targetId,
            ),
            expiresAt: timestamp,
            state: "archived",
            ...(supersedes === undefined ||
            supersedes === targetId
              ? {}
              : {
                  supersedes,
                }),
            validatedAt: timestamp,
          });
          this.#database
            .prepare(
              `UPDATE knowledge_candidates
                  SET body_json = ?,
                      source_digest = ?,
                      updated_at = ?
                WHERE knowledge_id = ?`,
            )
            .run(
              JSON.stringify(updated),
              sha256(updated),
              timestamp,
              updated.knowledgeId,
            );
        }
      }
      for (const knowledgeId of affectedKnowledgeIds) {
        const row = this.#database
          .prepare(
            `SELECT body_json
               FROM knowledge_candidates
              WHERE knowledge_id = ?`,
          )
          .get(knowledgeId) as
          | Readonly<Record<string, unknown>>
          | undefined;
        if (row === undefined) {
          continue;
        }
        const candidate = knowledgeCandidateSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        );
        const deactivated = knowledgeCandidateSchema.parse({
          ...candidate,
          expiresAt: operation.requestedAt,
          state: candidate.state === "superseded" ? "superseded" : "archived",
          validatedAt: operation.requestedAt,
        });
        this.#database
          .prepare(
            `UPDATE knowledge_candidates
                SET body_json = ?,
                    source_digest = ?,
                    updated_at = ?
              WHERE knowledge_id = ?`,
          )
          .run(
            JSON.stringify(deactivated),
            sha256(deactivated),
            operation.requestedAt,
            knowledgeId,
          );
      }
      const planned = deletionOperationSchema.parse({
        ...operation,
        plannedAffectedSessionIds: [
          ...targetSessionIds,
        ].sort(),
        plannedDependentIds: [
          ...dependentIds,
        ].sort(),
        plannedDependencySeedIds: [
          ...dependencySeedIds,
        ].sort(),
        plannedSourceIds: [
          ...sourceIds,
        ].sort(),
      });
      this.#writeDeletionOperation(planned);
      this.#database.exec("COMMIT;");
      return {
        affectedSessionIds: [...targetSessionIds].sort(),
        dependentIds: [...dependentIds].sort(),
        sourceIds: [...sourceIds].sort(),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public remainingIdentifiers(
    identifiers: ReadonlySet<string>,
  ): readonly string[] {
    this.#assertNoRestoreBarrier();
    const remaining = new Set<string>();
    const inspect = (id: unknown, body?: unknown): void => {
      const normalizedId = String(id);
      if (identifiers.has(normalizedId)) {
        remaining.add(normalizedId);
      }
      if (body !== undefined) {
        const parsed =
          typeof body === "string"
            ? JSON.parse(body) as unknown
            : body;
        const references: TypedDeletionReferences = {
          deduplication: new Set(),
          episode: new Set(),
          event: new Set(),
          record: new Set(identifiers),
          session: new Set(),
        };
        if (bodyReferences(parsed, references)) {
          for (const identifier of identifiers) {
            remaining.add(identifier);
          }
        }
      }
    };
    for (const row of this.#database
      .prepare(
        `SELECT deduplication_key,
                event_id,
                source_event_id,
                session_id,
                safe_envelope_json
           FROM raw_events`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
      const envelope = captureEnvelopeSchema.parse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      for (const reference of captureEvidenceReferences(envelope)) {
        if (identifiers.has(reference)) {
          remaining.add(reference);
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT parser_error_id,
                queue_item_id,
                deduplication_key,
                safe_envelope_json
           FROM parser_errors`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
      if (row.safe_envelope_json !== null) {
        const parsed = captureEnvelopeSchema.safeParse(
          JSON.parse(String(row.safe_envelope_json)) as unknown,
        );
        if (
          parsed.success &&
          [
            parsed.data.deduplicationKey,
            parsed.data.event.eventId,
            parsed.data.event.sessionId,
            ...captureEvidenceReferences(parsed.data),
          ].some(
            (identifier) =>
              identifier !== undefined &&
              identifiers.has(identifier),
          )
        ) {
          for (const identifier of [
            parsed.data.deduplicationKey,
            parsed.data.event.eventId,
            parsed.data.event.sessionId,
            ...captureEvidenceReferences(parsed.data),
          ]) {
            if (
              identifier !== undefined &&
              identifiers.has(identifier)
            ) {
              remaining.add(identifier);
            }
          }
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT queue_item_id,
                deduplication_key,
                last_error
           FROM queue_processing`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (value !== null && identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT identity_id, canonical_value
           FROM identities`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT session_id, feedback_id, target_id
           FROM session_mutes`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const value of Object.values(row)) {
        if (identifiers.has(String(value))) {
          remaining.add(String(value));
        }
      }
    }
    for (const [
      table,
      idColumn,
      bodyColumn,
    ] of [
      ["branch_contexts", "branch_context_id", "body_json"],
      ["correction_keys", "correction_key_id", "body_json"],
      [
        "correction_opportunities",
        "opportunity_id",
        "body_json",
      ],
      ["knowledge_candidates", "knowledge_id", "body_json"],
      ["learning_jobs", "job_id", "window_json"],
      ["learning_proposals", "proposal_id", "body_json"],
      ["work_episodes", "episode_id", "body_json"],
      ["evidence_links", "link_id", "body_json"],
      ["process_claims", "claim_id", "body_json"],
      ["feedback_events", "feedback_id", "body_json"],
      ["context_use_records", "request_id", "body_json"],
      ["metrics", "metric_id", "dimensions_json"],
    ] as const) {
      for (const row of this.#database
        .prepare(
          `SELECT ${idColumn} AS id, ${bodyColumn} AS body${table === "feedback_events" ? ", *" : ""}
             FROM ${table}`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]) {
        inspect(row.id, row.body);
        if (row.replacement_json != null) {
          inspect(row.id, row.replacement_json);
        }
      }
    }
    if (this.#hasEnrichments()) {
      for (const row of this.#database.prepare(
        "SELECT enrichment_id, deduplication_key, safe_envelope_json FROM raw_event_enrichments",
      ).all()) {
        inspect(row.enrichment_id, row.safe_envelope_json);
        inspect(row.deduplication_key);
      }
    }
    return [...remaining].sort();
  }

  public remainingDeletionIdentities(
    identities: readonly DeletionPlannedIdentity[],
  ): readonly DeletionPlannedIdentity[] {
    this.#assertNoRestoreBarrier();
    const remaining = new Map<string, DeletionPlannedIdentity>();
    const record = (identity: DeletionPlannedIdentity): void => {
      remaining.set(
        `${identity.identityType}\u0000${identity.identifier}`,
        identity,
      );
    };
    const inspectEnvelope = (envelope: CaptureEnvelope): void => {
      for (const identity of identities) {
        const present =
          identity.identityType === "deduplication"
            ? envelope.deduplicationKey === identity.identifier
            : identity.identityType === "event"
              ? (
                  envelope.event.eventId === identity.identifier ||
                  captureEvidenceReferences(envelope).includes(identity.identifier)
                )
              : identity.identityType === "session"
                ? envelope.event.sessionId === identity.identifier
                : false;
        if (present) {
          record(identity);
        }
      }
    };
    for (const envelope of this.episodeSourceEnvelopes()) {
      inspectEnvelope(envelope);
    }
    for (const row of this.#database.prepare("SELECT window_json FROM learning_jobs").all()) {
      for (const envelope of learningWindowSchema.parse(JSON.parse(String(row.window_json))).events) inspectEnvelope(envelope);
    }
    if (this.#hasEnrichments()) {
      for (const row of this.#database.prepare(
        "SELECT safe_envelope_json FROM raw_event_enrichments",
      ).all()) {
        inspectEnvelope(captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json))));
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT safe_envelope_json
           FROM parser_errors
          WHERE safe_envelope_json IS NOT NULL`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      const parsed = captureEnvelopeSchema.safeParse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      );
      if (parsed.success) {
        inspectEnvelope(parsed.data);
      }
    }
    for (const episode of this.workEpisodes()) {
      for (const identity of identities) {
        const present =
          identity.identityType === "episode"
            ? episode.episodeId === identity.identifier
            : identity.identityType === "event"
              ? episode.sourceEventIds.includes(identity.identifier)
              : identity.identityType === "session"
                ? episode.sessionIds.includes(identity.identifier)
                : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const association of this.episodeAssociations()) {
      for (const identity of identities) {
        const present =
          identity.identityType === "event"
            ? association.evidence.some((item) =>
                item.sourceEventIds.includes(identity.identifier),
              )
            : identity.identityType === "session"
              ? (
                  association.leftSessionId === identity.identifier ||
                  association.rightSessionId === identity.identifier
                )
              : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const correction of this.episodeGroupingCorrections()) {
      for (const identity of identities) {
        if (
          identity.identityType === "session" &&
          correction.sessionIds.includes(identity.identifier)
        ) {
          record(identity);
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT identity_type, canonical_value
           FROM identities`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      const identityType = String(row.identity_type).toLowerCase();
      const canonicalValue = String(row.canonical_value);
      for (const identity of identities) {
        const present =
          identityType.includes("alias")
            ? canonicalValue === identity.identifier
            : identity.identityType === "deduplication"
              ? (
                  identityType.includes("dedup") &&
                  canonicalValue === identity.identifier
                )
              : identity.identityType === "event"
                ? (
                    identityType.includes("event") &&
                    canonicalValue === identity.identifier
                  )
                : identity.identityType === "session"
                  ? (
                      identityType.includes("session") &&
                      canonicalValue === identity.identifier
                    )
                  : identity.identityType === "episode"
                    ? (
                        identityType.includes("episode") &&
                        canonicalValue === identity.identifier
                      )
                    : false;
        if (present) {
          record(identity);
        }
      }
    }
    for (const row of this.#database
      .prepare(
        `SELECT session_id
           FROM session_mutes`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[]) {
      for (const identity of identities) {
        if (
          identity.identityType === "session" &&
          String(row.session_id) === identity.identifier
        ) {
          record(identity);
        }
      }
    }
    return [...remaining.values()].sort(
      (left, right) =>
        left.identityType.localeCompare(right.identityType) ||
        left.identifier.localeCompare(right.identifier),
    );
  }

  public prepareDeletionCompletion(input: {
    readonly deletedDependentCount: number;
    readonly deletedQueueItemCount: number;
    readonly deletedSourceCount: number;
    readonly deletionId: string;
    readonly gateDigest: string;
    readonly propagationEvidenceId: string;
  }): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(input.deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${input.deletionId} is not active.`,
      );
    }
    const completing = deletionOperationSchema.parse({
      ...current,
      deletedDependentCount: input.deletedDependentCount,
      deletedQueueItemCount: input.deletedQueueItemCount,
      deletedSourceCount: input.deletedSourceCount,
      gateDigest: input.gateDigest,
      propagationEvidenceId: input.propagationEvidenceId,
      status: "completing",
    });
    this.#writeDeletionOperation(completing);
    return completing;
  }

  public completeDeletion(
    deletionId: string,
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(deletionId);
    if (
      current?.status !== "completing" ||
      current.gateDigest === undefined ||
      current.propagationEvidenceId === undefined ||
      current.plannedSourceIds === undefined
    ) {
      throw new Error(
        `Deletion operation ${deletionId} is not ready to complete.`,
      );
    }
    const completed = deletionOperationSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: current.attemptCount,
      blockedIdentityDigests: [
        ...new Map(
          [
            ...this.#typedDeletionIdentities(
              current.targetType,
              current.activeTargetId,
              current.plannedSourceIds,
            ),
            ...(
              current.targetType === "session" ||
              current.targetType === "episode"
                ? (
                    current.plannedAffectedSessionIds ?? []
                  ).map((identifier) => ({
                    identifier,
                    identityType: "session" as const,
                  }))
                : []
            ),
            ...(current.plannedQueueIdentities ?? []),
          ].map((identity) => {
            const tombstone = {
              digest: deletionIdentityDigest(
                identity.identityType,
                identity.identifier,
                this.#deletionIdentityKey,
              ),
              identityType: identity.identityType,
            };
            return [
              `${tombstone.identityType}\u0000${tombstone.digest}`,
              tombstone,
            ];
          }),
        ).values(),
      ].sort(
        (left, right) =>
          left.identityType.localeCompare(right.identityType) ||
          left.digest.localeCompare(right.digest),
      ),
      completedAt: this.#now().toISOString(),
      deletedDependentCount: current.deletedDependentCount,
      deletedQueueItemCount: current.deletedQueueItemCount,
      deletedSourceCount: current.deletedSourceCount,
      deletionId: current.deletionId,
      gateDigest: deletionIdentityDigest(
        "gate",
        current.gateDigest,
        this.#deletionIdentityKey,
      ),
      tombstoneKeyVerifier:
        this.#deletionIdentityKeyVerifier(),
      propagationEvidenceId: current.propagationEvidenceId,
      requestedAt: current.requestedAt,
      status: "completed",
      targetDigest: current.targetDigest,
      targetType: current.targetType,
    });
    this.#writeDeletionOperation(completed);
    return completed;
  }

  public deleteQueueArtifacts(
    queueItemIds: readonly string[],
  ): number {
    this.#assertNoRestoreBarrier();
    const ids = [
      ...new Set(
        queueItemIds
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
    if (ids.length === 0) {
      return 0;
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      let deleted = 0;
      for (const chunk of sqliteChunks(ids)) {
        const parameters = placeholders(chunk.length);
        for (const table of ["parser_errors", "queue_processing"] as const) {
          deleted += Number(this.#database.prepare(
            `DELETE FROM ${table} WHERE queue_item_id IN (${parameters})`,
          ).run(...chunk).changes);
        }
      }
      this.#database.exec("COMMIT;");
      return deleted;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public checkpointDeletionQueue(input: {
    readonly deletionId: string;
    readonly identities: readonly DeletionPlannedIdentity[];
    readonly queueItemIds: readonly string[];
  }): DeletionOperation {
    this.#assertNoRestoreBarrier();
    const current = this.deletionOperation(input.deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${input.deletionId} is not active.`,
      );
    }
    const updated = deletionOperationSchema.parse({
      ...current,
      plannedQueueItemIds: [
        ...new Set([
          ...(current.plannedQueueItemIds ?? []),
          ...input.queueItemIds,
        ]),
      ].sort(),
      plannedQueueIdentities: [
        ...new Map(
          [
            ...(current.plannedQueueIdentities ?? []),
            ...input.identities,
          ].map((identity) => [
            `${identity.identityType}\u0000${identity.identifier}`,
            identity,
          ]),
        ).values(),
      ].sort(
        (left, right) =>
          left.identityType.localeCompare(right.identityType) ||
          left.identifier.localeCompare(right.identifier),
      ),
      plannedSourceIds: [
        ...new Set([
          ...(current.plannedSourceIds ?? []),
          ...input.identities.map(
            (identity) => identity.identifier,
          ),
        ]),
      ].sort(),
    });
    this.#writeDeletionOperation(updated);
    return updated;
  }

  public failDeletion(
    deletionId: string,
    error: unknown,
  ): DeletionOperation {
    this.#assertNoRestoreBarrier();
    void error;
    const current = this.deletionOperation(deletionId);
    if (current?.status !== "running") {
      throw new Error(
        `Deletion operation ${deletionId} is not active.`,
      );
    }
    const failed = deletionOperationSchema.parse({
      ...current,
      completedAt: this.#now().toISOString(),
      error: "Deletion operation failed.",
      status: "failed",
    });
    this.#writeDeletionOperation(failed);
    return failed;
  }

  public deletionIdentityBlocked(
    identityType: DeletionIdentityType,
    identifier: string,
  ): boolean {
    return this.#deletionIdentitiesBlocked([
      {
        identifier,
        identityType,
      },
    ]);
  }

  #deletionIdentitiesBlocked(
    identities: readonly DeletionPlannedIdentity[],
  ): boolean {
    if (identities.length === 0) {
      return false;
    }
    const tombstones = this.#deletionTombstoneKeys();
    return identities.some((identity) =>
      tombstones.has(this.#deletionIdentityKeyFor(identity)),
    );
  }

  #deletionIdentityKeyFor(
    identity: DeletionPlannedIdentity,
  ): string {
    return `${identity.identityType}\u0000${deletionIdentityDigest(
      identity.identityType,
      identity.identifier,
      this.#deletionIdentityKey,
    )}`;
  }

  #deletionTombstoneKeys(): ReadonlySet<string> {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE status = 'completed'`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    const tombstones = new Set(
      rows.flatMap((row) =>
        deletionOperationSchema
          .parse(JSON.parse(String(row.body_json)) as unknown)
          .blockedIdentityDigests.map(
            (tombstone) =>
              `${tombstone.identityType}\u0000${tombstone.digest}`,
          ),
      ),
    );
    return tombstones;
  }

  #knowledgeDeletionBlocked(knowledgeId: string): boolean {
    this.#assertNoRestoreBarrier();
    const targetDigest = deletionIdentityDigest(
      "target",
      `knowledge:${knowledgeId}`,
      this.#deletionIdentityKey,
    );
    if (asNumber(this.#database.prepare("PRAGMA user_version").get()?.user_version) >= 11 &&
        this.#database.prepare("SELECT 1 FROM learning_suppressions WHERE target_digest=?").get(targetDigest)) return true;
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations
          WHERE status IN ('running', 'completing', 'completed')`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.some((row) => {
      const operation = deletionOperationSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      );
      return operation.targetType === "knowledge" &&
        operation.targetDigest === targetDigest;
    });
  }

  public ingestQueueItem(
    input: CaptureQueueItem,
  ): CanonicalIngestResult {
    this.#assertNoRestoreBarrier();
    const item = captureQueueItemSchema.parse(input);
    const parsedEnvelope = normalizedCaptureReferences(item.envelope);
    const resetCutoff = this.getRecordsResetCutoff();
    if (resetCutoff !== undefined && Date.parse(parsedEnvelope.event.timestamp) <= Date.parse(resetCutoff)) {
      return { deduplicationKey: parsedEnvelope.deduplicationKey, status: "duplicate" };
    }
    if (this.hasActiveDeletion()) {
      throw new Error(
        "Canonical ingestion is blocked by an active deletion.",
      );
    }
    if (
      this.#captureEnvelopeDeletionBlocked(parsedEnvelope)
    ) {
      return {
        deduplicationKey: parsedEnvelope.deduplicationKey,
        status: "duplicate",
      };
    }
    if (parsedEnvelope.event.sessionId === undefined) {
      const reason = "Capture envelope sessionId is required.";
      const placeholder = captureEnvelopeSchema.parse({
        ...parsedEnvelope,
        event: {
          ...parsedEnvelope.event,
          sessionId: "invalid-session-placeholder",
        },
      });
      const safeRejected = redactCaptureEnvelopeForPersistence(
        placeholder,
      ).envelope;
      const safeRejectedEvent = {
        ...safeRejected.event,
        eventId: parsedEnvelope.event.eventId,
      };
      Reflect.deleteProperty(safeRejectedEvent, "sessionId");
      const safeRejectedEnvelope = captureEnvelopeSchema.parse({
        ...safeRejected,
        deduplicationKey: parsedEnvelope.deduplicationKey,
        event: safeRejectedEvent,
        sourceEventId: parsedEnvelope.sourceEventId,
      });
      const recorded = this.#recordRejected(
        item,
        parsedEnvelope.deduplicationKey,
        "invalid_identity",
        reason,
        JSON.stringify(safeRejectedEnvelope),
      );
      return recorded
        ? {
            status: "rejected",
            deduplicationKey: parsedEnvelope.deduplicationKey,
            reason,
          }
        : {
            status: "duplicate",
            deduplicationKey: parsedEnvelope.deduplicationKey,
          };
    }
    const expectedDeduplicationKey =
      createCaptureDeduplicationKey({
        adapter: parsedEnvelope.event.adapter,
        adapterVersion: parsedEnvelope.event.adapterVersion,
        eventType: parsedEnvelope.event.eventType,
        sessionId: parsedEnvelope.event.sessionId,
        sourceEventId: parsedEnvelope.sourceEventId,
      });
    const redacted = redactCaptureEnvelopeForPersistence(
      parsedEnvelope,
    );
    const safe = {
      ...redacted,
      envelope: normalizedCaptureReferences(redacted.envelope),
    };
    const safeEnvelopeJson = JSON.stringify(safe.envelope);
    const safeDeduplicationKey = safe.envelope.event.sessionId === undefined
      ? undefined : createCaptureDeduplicationKey({
      adapter: safe.envelope.event.adapter,
      adapterVersion: safe.envelope.event.adapterVersion,
      eventType: safe.envelope.event.eventType,
      sessionId: safe.envelope.event.sessionId,
      sourceEventId: safe.envelope.sourceEventId,
    });
    if (
      parsedEnvelope.deduplicationKey !==
        expectedDeduplicationKey ||
      parsedEnvelope.event.eventId !==
        `event-${expectedDeduplicationKey}` ||
      safeDeduplicationKey !== expectedDeduplicationKey ||
      safe.envelope.deduplicationKey !== safeDeduplicationKey ||
      safe.envelope.event.eventId !== `event-${safeDeduplicationKey}`
    ) {
      const reason = "Capture envelope identity is inconsistent.";
      const recorded = this.#recordRejected(
        item,
        expectedDeduplicationKey,
        "invalid_identity",
        reason,
        safeEnvelopeJson,
      );
      return recorded
        ? {
            status: "rejected",
            deduplicationKey: expectedDeduplicationKey,
            reason,
          }
        : {
            status: "duplicate",
            deduplicationKey: expectedDeduplicationKey,
          };
    }

    const classification = classifyRawEvent(safe.envelope.event);
    const parseStatus =
      classification.status === "supported"
        ? "supported"
        : classification.status;
    const unsupportedReason =
      classification.status === "supported"
        ? undefined
        : classification.status === "unsupported_event_type"
          ? `Unsupported event type: ${classification.eventType}.`
          : classification.status ===
              "unsupported_adapter_version"
            ? `Unsupported adapter version: ${classification.adapterVersion}.`
            : `Invalid raw event: ${classification.status}.`;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      const currentResetCutoff = this.getRecordsResetCutoff();
      if (currentResetCutoff !== undefined && Date.parse(parsedEnvelope.event.timestamp) <= Date.parse(currentResetCutoff)) {
        this.#database.exec("ROLLBACK;");
        return { deduplicationKey: parsedEnvelope.deduplicationKey, status: "duplicate" };
      }
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Canonical ingestion is blocked by an active deletion.",
        );
      }
      if (
        this.#captureEnvelopeDeletionBlocked(parsedEnvelope) ||
        this.#captureEnvelopeDeletionBlocked(safe.envelope)
      ) {
        this.#database.exec("ROLLBACK;");
        return {
          deduplicationKey: parsedEnvelope.deduplicationKey,
          status: "duplicate",
        };
      }
      const now = this.#now().toISOString();
      const existing = this.#database
        .prepare(
          `SELECT delivery_count, parse_status
             FROM raw_events
            WHERE deduplication_key = ?`,
        )
        .get(expectedDeduplicationKey) as
        | Readonly<Record<string, unknown>>
        | undefined;
      if (existing !== undefined) {
        this.#database
          .prepare(
            `UPDATE raw_events
                SET delivery_count = delivery_count + 1,
                    last_seen_at = ?
              WHERE deduplication_key = ?`,
          )
          .run(now, expectedDeduplicationKey);
        this.#recordQueueProcessing(
          item,
          expectedDeduplicationKey,
          String(existing.parse_status) === "supported"
            ? "duplicate"
            : "unsupported",
          now,
        );
        this.#database.exec("COMMIT;");
        const existingParseStatus = String(
          existing.parse_status,
        );
        return existingParseStatus === "supported"
          ? {
              status: "duplicate",
              deduplicationKey: expectedDeduplicationKey,
            }
          : {
              status: "unsupported",
              deduplicationKey: expectedDeduplicationKey,
              reason: `Previously recorded parse status: ${existingParseStatus}.`,
            };
      }

      const event = safe.envelope.event;
      this.#database
        .prepare(
          `INSERT INTO raw_events (
             deduplication_key,
             event_id,
             source_event_id,
             schema_version,
             adapter,
             adapter_version,
             event_type,
             session_id,
             repo_id,
             branch,
             worktree,
             commit_sha,
             event_timestamp,
             trust,
             content_digest,
             result_digest,
             redaction_rule_version,
             parse_status,
             safe_envelope_json,
             storage_redaction_applied,
             first_seen_at,
             last_seen_at,
             delivery_count
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
           )`,
        )
        .run(
          expectedDeduplicationKey,
          event.eventId,
          safe.envelope.sourceEventId,
          safe.envelope.schemaVersion,
          event.adapter,
          event.adapterVersion,
          event.eventType,
          optionalText(event.sessionId),
          optionalText(event.repoId),
          optionalText(event.branch),
          optionalText(event.worktree),
          optionalText(event.commitSha),
          new Date(event.timestamp).toISOString(),
          event.trust,
          optionalText(safe.envelope.redaction.contentDigest),
          optionalText(event.resultDigest),
          safe.envelope.redaction.ruleVersion,
          parseStatus,
          safeEnvelopeJson,
          safe.redactionApplied ? 1 : 0,
          now,
          now,
        );
      this.#faultInjector?.("after_raw_event_insert");
      if (parseStatus === "supported") this.#markLearningEventChange(expectedDeduplicationKey);
      if (unsupportedReason !== undefined) {
        this.#insertParserError(
          item.queueItemId,
          expectedDeduplicationKey,
          classification.status,
          unsupportedReason,
          safeEnvelopeJson,
          now,
        );
      }
      this.#recordQueueProcessing(
        item,
        expectedDeduplicationKey,
        unsupportedReason === undefined
          ? "stored"
          : "unsupported",
        now,
      );
      this.#database.exec("COMMIT;");
      return unsupportedReason === undefined
        ? {
            status: "stored",
            deduplicationKey: expectedDeduplicationKey,
          }
        : {
            status: "unsupported",
            deduplicationKey: expectedDeduplicationKey,
            reason: unsupportedReason,
          };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public async deduplicationKeys(
    adapter: string,
    adapterVersion: string,
    sessionId: string,
  ): Promise<ReadonlySet<string>> {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT deduplication_key
           FROM raw_events
          WHERE adapter = ?
            AND adapter_version = ?
            AND session_id = ?`,
      )
      .all(adapter, adapterVersion, sessionId) as readonly Readonly<
      Record<string, unknown>
    >[];
    return new Set(
      rows.map((row) => String(row.deduplication_key)),
    );
  }

  public rawEvent(
    deduplicationKey: string,
  ): CanonicalRawEventRecord | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database
      .prepare(
        `SELECT adapter,
                adapter_version,
                deduplication_key,
                delivery_count,
                event_id,
                event_type,
                parse_status,
                safe_envelope_json,
                session_id,
                source_event_id
           FROM raw_events
          WHERE deduplication_key = ?`,
      )
      .get(deduplicationKey) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : {
          adapter: String(row.adapter),
          adapterVersion: String(row.adapter_version),
          deduplicationKey: String(row.deduplication_key),
          deliveryCount: asNumber(row.delivery_count),
          envelope: JSON.parse(
            String(row.safe_envelope_json),
          ) as CaptureEnvelope,
          eventId: String(row.event_id),
          eventType: String(row.event_type),
          parseStatus: String(row.parse_status),
          ...(row.session_id === null
            ? {}
            : {
                sessionId: String(row.session_id),
              }),
          sourceEventId: String(row.source_event_id),
        };
  }

  public rawEvents(): readonly CanonicalRawEventRecord[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT adapter,
                adapter_version,
                deduplication_key,
                delivery_count,
                last_seen_at,
                event_id,
                event_type,
                parse_status,
                safe_envelope_json,
                session_id,
                source_event_id
           FROM raw_events
          ORDER BY event_timestamp, deduplication_key`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) => ({
      adapter: String(row.adapter),
      adapterVersion: String(row.adapter_version),
      deduplicationKey: String(row.deduplication_key),
      deliveryCount: asNumber(row.delivery_count),
      lastSeenAt: String(row.last_seen_at),
      envelope: captureEnvelopeSchema.parse(
        JSON.parse(String(row.safe_envelope_json)) as unknown,
      ),
      eventId: String(row.event_id),
      eventType: String(row.event_type),
      parseStatus: String(row.parse_status),
      ...(row.session_id === null
        ? {}
        : {
            sessionId: String(row.session_id),
          }),
      sourceEventId: String(row.source_event_id),
    }));
  }

  public episodeSourceEnvelopes(): readonly CaptureEnvelope[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT safe_envelope_json
           FROM raw_events
          WHERE parse_status = 'supported'
          ORDER BY event_timestamp, deduplication_key`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return this.#effectiveEnvelopes(rows);
  }

  #effectiveEnvelopes(rows: readonly Readonly<Record<string, unknown>>[]): CaptureEnvelope[] {
    const originals = rows.map((row) => captureEnvelopeSchema.parse(
      JSON.parse(String(row.safe_envelope_json)) as unknown,
    ));
    if (originals.length === 0 || !this.#hasEnrichments()) return originals;
    const latest = new Map<string, Readonly<Record<string, unknown>>>();
    for (const chunk of sqliteChunks([...new Set(originals.map((item) => item.deduplicationKey))])) {
      for (const row of this.#database.prepare(
        "SELECT deduplication_key, original_digest, safe_envelope_json FROM raw_event_enrichments " +
        "WHERE deduplication_key IN (" + placeholders(chunk.length) + ") ORDER BY rowid",
      ).all(...chunk)) latest.set(String(row.deduplication_key), row);
    }
    return originals.map((original) => {
      const enrichment = latest.get(original.deduplicationKey);
      if (enrichment === undefined) return original;
      if (String(enrichment.original_digest) !== sha256(original)) {
        throw new InvalidCanonicalSchemaError("Event enrichment no longer matches its original evidence.");
      }
      return captureEnvelopeSchema.parse(JSON.parse(String(enrichment.safe_envelope_json)) as unknown);
    });
  }

  public effectiveRawEvent(
    deduplicationKey: string,
  ): CanonicalRawEventRecord | undefined {
    const original = this.rawEvent(deduplicationKey);
    return original === undefined ? undefined : {
      ...original,
      envelope: this.#effectiveEnvelope(original.envelope),
    };
  }

  #effectiveEnvelope(original: CaptureEnvelope): CaptureEnvelope {
    if (!this.#hasEnrichments()) {
      return original;
    }
    const row = this.#database.prepare(
      `SELECT original_digest, safe_envelope_json
         FROM raw_event_enrichments
        WHERE deduplication_key = ?
        ORDER BY rowid DESC LIMIT 1`,
    ).get(original.deduplicationKey) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (row === undefined) {
      return original;
    }
    if (String(row.original_digest) !== sha256(original)) {
      throw new InvalidCanonicalSchemaError("Event enrichment no longer matches its original evidence.");
    }
    return captureEnvelopeSchema.parse(
      JSON.parse(String(row.safe_envelope_json)) as unknown,
    );
  }

  #hasEnrichments(): boolean {
    return this.#database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'raw_event_enrichments'",
    ).get() !== undefined;
  }

  public enrichRawEvent(input: {
    readonly envelope: CaptureEnvelope;
    readonly sourceDigest: string;
  }): CanonicalEnrichmentResult {
    this.#assertNoRestoreBarrier();
    if (!/^[a-f0-9]{64}$/u.test(input.sourceDigest)) {
      throw new Error("A session-file source digest is required for enrichment.");
    }
    const supplied = normalizedCaptureReferences(redactCaptureEnvelopeForPersistence(
      captureEnvelopeSchema.parse(input.envelope),
    ).envelope);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion() || this.#captureEnvelopeDeletionBlocked(supplied)) {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "Deleted or deleting evidence cannot be enriched." };
      }
      const original = this.rawEvent(supplied.deduplicationKey);
      if (original === undefined || original.parseStatus !== "supported" || !this.#hasEnrichments()) {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "A supported original event is required." };
      }
      const withoutContent = (envelope: CaptureEnvelope): unknown => {
        const event = { ...normalizedCaptureReferences(envelope).event };
        Reflect.deleteProperty(event, "redactedArguments");
        Reflect.deleteProperty(event, "resultDigest");
        return JSON.parse(JSON.stringify({
          event, schemaVersion: envelope.schemaVersion, sourceEventId: envelope.sourceEventId,
        })) as unknown;
      };
      if (!isDeepStrictEqual(withoutContent(original.envelope), withoutContent(supplied))) {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "Enrichment cannot change event identity, trust, time, or metadata." };
      }
      const previous = this.#effectiveEnvelope(original.envelope);
      let content: unknown;
      let redactedArguments: unknown;
      let resultDigest: unknown;
      try {
        content = mergeMissingContent(previous.content, supplied.content);
        redactedArguments = mergeMissingContent(
          previous.event.redactedArguments, supplied.event.redactedArguments,
        );
        resultDigest = mergeMissingContent(previous.event.resultDigest, supplied.event.resultDigest);
      } catch {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "Enrichment cannot replace an already recorded fact." };
      }
      const effective = redactCaptureEnvelopeForPersistence(
        captureEnvelopeSchema.parse({
          ...original.envelope,
          ...(content === undefined ? {} : { content }),
          event: {
            ...original.envelope.event,
            ...(redactedArguments === undefined ? {} : { redactedArguments }),
            ...(resultDigest === undefined ? {} : { resultDigest }),
          },
          redaction: supplied.redaction,
        }),
      ).envelope;
      if (conflictingCaptureEvidence(effective)) {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "Enrichment contains conflicting capture evidence." };
      }
      if (this.#captureEnvelopeDeletionBlocked(effective)) {
        this.#database.exec("ROLLBACK;");
        return { status: "rejected", reason: "Enrichment references deleted evidence." };
      }
      if (isDeepStrictEqual({
        content: previous.content,
        arguments: previous.event.redactedArguments,
        result: previous.event.resultDigest,
      }, {
        content: effective.content,
        arguments: effective.event.redactedArguments,
        result: effective.event.resultDigest,
      })) {
        this.#database.exec("COMMIT;");
        return { status: "duplicate" };
      }
      const id = sha256({
        deduplicationKey: supplied.deduplicationKey,
        envelope: effective,
        sourceDigest: input.sourceDigest,
      });
      const observedAt = this.#now().toISOString();
      this.#database.prepare(
        `INSERT INTO raw_event_enrichments (
           enrichment_id, deduplication_key, source_digest,
           original_digest, safe_envelope_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id, supplied.deduplicationKey, input.sourceDigest,
        sha256(original.envelope), JSON.stringify(effective), observedAt,
      );
      this.#database.prepare(
        "UPDATE raw_events SET last_seen_at = ? WHERE deduplication_key = ?",
      ).run(observedAt, supplied.deduplicationKey);
      this.#markLearningEventChange(supplied.deduplicationKey);
      this.#database.exec("COMMIT;");
      return { status: "enriched" };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public rawEventsInRange(
    input: CanonicalTimeRange,
  ): CanonicalRangePage<CanonicalRawEventRecord> {
    this.#assertNoRestoreBarrier();
    const { since, until, limit, timeBasis } = rangeParameters(input);
    const timestampColumn = timeBasis === "observed" ? "last_seen_at" : "event_timestamp";
    // An observed cursor must not advance past an older write that has not committed.
    this.#database.exec(timeBasis === "observed" ? "BEGIN IMMEDIATE;" : "BEGIN;");
    try {
    this.#assertNoRestoreBarrier();
    const rows = this.#database.prepare(
      `SELECT deduplication_key AS id, ${timestampColumn} AS timestamp
         FROM raw_events
        WHERE ${timestampColumn} >= ? AND ${timestampColumn} < ?
          ${input.sessionId === undefined ? "" : "AND session_id = ?"}
          ${input.after === undefined ? "" : `AND (${timestampColumn}, deduplication_key) > (?, ?)`}
        ORDER BY ${timestampColumn}, deduplication_key LIMIT ?`,
    ).all(
      since, until,
      ...(input.sessionId === undefined ? [] : [input.sessionId]),
      ...(input.after === undefined ? [] : [new Date(input.after.timestamp).toISOString(), input.after.id]),
      limit + 1,
    ) as readonly Readonly<Record<string, unknown>>[];
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    const page: CanonicalRangePage<CanonicalRawEventRecord> = {
      records: selected.map((row) => {
        const record = this.effectiveRawEvent(String(row.id));
        if (record === undefined) {
          throw new InvalidCanonicalSchemaError("A selected raw event is missing from the canonical snapshot.");
        }
        return {
          ...record,
          ...(timeBasis === "observed" ? { lastSeenAt: String(row.timestamp) } : {}),
        };
      }),
      ...(rows.length <= limit || last === undefined ? {} : {
        next: { timestamp: String(last.timestamp), id: String(last.id) },
      }),
    };
    this.#database.exec("COMMIT;");
    return page;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public contextUseRecordsInRange(
    input: CanonicalTimeRange,
  ): CanonicalRangePage<ContextUseRecord> {
    this.#assertNoRestoreBarrier();
    const { since, until, limit, timeBasis } = rangeParameters(input);
    if (timeBasis === "observed" && !this.#hasObservedContextTimes()) {
      throw new Error("Observed context queries require the current canonical schema.");
    }
    const timestampColumn = timeBasis === "observed" ? "updated_at" : "created_at";
    const readPage = (): CanonicalRangePage<ContextUseRecord> => {
    const rows = this.#database.prepare(
      `SELECT request_id AS id, ${timestampColumn} AS timestamp, body_json
         FROM context_use_records
        WHERE ${timestampColumn} >= ? AND ${timestampColumn} < ?
          ${input.sessionId === undefined ? "" : "AND session_id = ?"}
          ${input.after === undefined ? "" : `AND (${timestampColumn}, request_id) > (?, ?)`}
        ORDER BY ${timestampColumn}, request_id LIMIT ?`,
    ).all(
      since, until,
      ...(input.sessionId === undefined ? [] : [input.sessionId]),
      ...(input.after === undefined ? [] : [new Date(input.after.timestamp).toISOString(), input.after.id]),
      limit + 1,
    ) as readonly Readonly<Record<string, unknown>>[];
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      records: selected.map((row) => contextUseRecordSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      )),
      ...(rows.length <= limit || last === undefined ? {} : {
        next: { timestamp: String(last.timestamp), id: String(last.id) },
      }),
    };
    };
    if (timeBasis === "event") return readPage();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      const page = readPage();
      this.#database.exec("COMMIT;");
      return page;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public replaceWorkEpisodeProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly associations: readonly EpisodeAssociation[];
    readonly corrections: readonly EpisodeGroupingCorrection[];
    readonly episodes: readonly WorkEpisode[];
  }): WorkEpisodeProjectionWriteResult {
    this.#assertNoRestoreBarrier();
    const associations = input.associations.map((association) =>
      episodeAssociationSchema.parse(association),
    );
    const episodes = input.episodes.map((episode) =>
      workEpisodeSchema.parse(episode),
    );
    const corrections = input.corrections.map((correction) =>
      episodeGroupingCorrectionSchema.parse(correction),
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Work Episode projection is blocked by an active deletion.",
        );
      }

      const projectionIdentities: DeletionPlannedIdentity[] = [
        ...episodes.flatMap((episode) => [
          {
            identifier: episode.episodeId,
            identityType: "episode" as const,
          },
          ...episode.sessionIds.map((identifier) => ({
            identifier,
            identityType: "session" as const,
          })),
          ...episode.sourceEventIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
        ]),
        ...associations.flatMap((association) => [
          {
            identifier: association.leftSessionId,
            identityType: "session" as const,
          },
          {
            identifier: association.rightSessionId,
            identityType: "session" as const,
          },
          ...association.evidence.flatMap(
            (item) =>
              item.sourceEventIds.map((identifier) => ({
                identifier,
                identityType: "event" as const,
              })),
          ),
        ]),
        ...corrections.flatMap((correction) =>
          correction.sessionIds.map((identifier) => ({
            identifier,
            identityType: "session" as const,
          })),
        ),
      ];
      if (
        this.#deletionIdentitiesBlocked(projectionIdentities)
      ) {
        throw new Error(
          "Work Episode projection contains a deleted identity.",
        );
      }
      const existingLinks = this.#database
        .prepare(
          `SELECT link_id, body_json
             FROM evidence_links`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const removeLink = this.#database.prepare(
        "DELETE FROM evidence_links WHERE link_id = ?",
      );
      for (const row of existingLinks) {
        let body: unknown;
        try {
          body = JSON.parse(String(row.body_json)) as unknown;
        } catch {
          continue;
        }
        if (
          episodeAssociationSchema.safeParse(body).success ||
          episodeGroupingCorrectionSchema.safeParse(body).success
        ) {
          removeLink.run(String(row.link_id));
        }
      }
      this.#database.exec("DELETE FROM work_episodes;");
      const insertAssociation = this.#database.prepare(
        `INSERT INTO evidence_links (
           link_id,
           schema_version,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertEpisode = this.#database.prepare(
        `INSERT INTO work_episodes (
           episode_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const association of associations) {
        insertAssociation.run(
          association.associationId,
          association.schemaVersion,
          JSON.stringify(association),
          sha256(association),
          association.createdAt,
        );
      }
      for (const correction of corrections) {
        insertAssociation.run(
          correction.correctionId,
          correction.schemaVersion,
          JSON.stringify(correction),
          sha256(correction),
          correction.timestamp,
        );
      }
      for (const episode of episodes) {
        insertEpisode.run(
          episode.episodeId,
          episode.schemaVersion,
          JSON.stringify(episode),
          sha256(episode),
          episode.startedAt,
          episode.lastActivityAt ?? episode.finishedAt ?? episode.startedAt,
        );
      }
      const episodeWindowsBySession = new Map<
        string,
        {
          readonly episodeId: string;
          readonly finishedAt: number;
          readonly startedAt: number;
        }[]
      >();
      for (const episode of episodes) {
        const window = {
          episodeId: episode.episodeId,
          finishedAt:
            episode.finishedAt === undefined
              ? Number.POSITIVE_INFINITY
              : Date.parse(episode.finishedAt),
          startedAt: Date.parse(episode.startedAt),
        };
        for (const sessionId of episode.sessionIds) {
          const windows =
            episodeWindowsBySession.get(sessionId) ?? [];
          windows.push(window);
          episodeWindowsBySession.set(sessionId, windows);
        }
      }
      const contextRows = new Map<
        string,
        Readonly<Record<string, unknown>>
      >();
      for (const row of this.#database
        .prepare(
          `SELECT request_id, body_json
             FROM context_use_records
            WHERE json_extract(body_json, '$.episodeId') IS NOT NULL`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]) {
        contextRows.set(String(row.request_id), row);
      }
      const episodeSessionIds = [
        ...new Set(
          episodes.flatMap((episode) => episode.sessionIds),
        ),
      ];
      if (episodeSessionIds.length > 0) {
        for (const chunk of sqliteChunks(episodeSessionIds)) {
          for (const row of this.#database
            .prepare(
              `SELECT request_id, body_json
                 FROM context_use_records
                WHERE session_id IN (${placeholders(
                  chunk.length,
                )})`,
            )
            .all(...chunk) as readonly Readonly<
            Record<string, unknown>
          >[]) {
            contextRows.set(String(row.request_id), row);
          }
        }
      }
      for (const row of contextRows.values()) {
        const record = contextUseRecordSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        );
        const createdAt = Date.parse(record.createdAt);
        const matchingEpisodes = (
          episodeWindowsBySession.get(record.sessionId) ?? []
        ).filter(
          (episode) =>
            createdAt >= episode.startedAt &&
            createdAt <= episode.finishedAt,
        );
        const projectedEpisodeId =
          matchingEpisodes.length === 1
            ? matchingEpisodes[0]?.episodeId
            : undefined;
        if (record.episodeId === projectedEpisodeId) {
          continue;
        }
        const {
          episodeId: previousEpisodeId,
          ...withoutEpisodeId
        } = record;
        void previousEpisodeId;
        const projected = contextUseRecordSchema.parse({
          ...withoutEpisodeId,
          ...(projectedEpisodeId === undefined
            ? {}
            : {
                episodeId: projectedEpisodeId,
              }),
        });
        this.#updateContextUseRecord(record, projected);
      }
      this.#database.exec("COMMIT;");
      return {
        associations: associations.length,
        corrections: corrections.length,
        episodes: episodes.length,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public replaceBranchContextProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly contexts: readonly BranchContext[];
  }): number {
    this.#assertNoRestoreBarrier();
    const contexts = input.contexts.map((context) =>
      branchContextSchema.parse({
        ...context,
        sourceEventIds: context.sourceEventIds.map(normalizedEventReference),
        recentVerificationEvidenceIds: context.recentVerificationEvidenceIds.map(normalizedEventReference),
      }),
    );
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Branch Context projection is blocked by an active deletion.",
        );
      }
      if (
        this.#deletionIdentitiesBlocked(
          contexts.flatMap((context) => [
            ...context.sourceEpisodeIds.map((identifier) => ({
              identifier,
              identityType: "episode" as const,
            })),
            ...[...context.sourceEventIds, ...context.recentVerificationEvidenceIds].map((identifier) => ({
              identifier,
              identityType: "event" as const,
            })),
          ]),
        )
      ) {
        throw new Error(
          "Branch Context projection contains a deleted identity.",
        );
      }
      this.#database.exec("DELETE FROM branch_contexts;");
      const insert = this.#database.prepare(
        `INSERT INTO branch_contexts (
           branch_context_id,
           repo_id,
           branch,
           head_sha,
           body_json,
           source_digest,
           updated_at,
           expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const context of contexts) {
        insert.run(
          context.branchContextId,
          context.repoId,
          context.branch,
          context.headSha,
          JSON.stringify(context),
          sha256(context),
          context.updatedAt,
          optionalText(context.expiresAt),
        );
      }
      this.#database.exec("COMMIT;");
      return contexts.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public branchContexts(): readonly BranchContext[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM branch_contexts
          ORDER BY repo_id, branch`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      branchContextSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public branchContextFor(input: {
    readonly branch: string;
    readonly headSha: string;
    readonly now?: Date;
    readonly repoId: string;
  }): BranchContext | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database
      .prepare(
        `SELECT body_json
           FROM branch_contexts
          WHERE repo_id = ?
            AND branch = ?`,
      )
      .get(input.repoId, input.branch) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const context = branchContextSchema.parse(
      JSON.parse(String(row.body_json)) as unknown,
    );
    if (
      context.headSha !== input.headSha ||
      (
        context.expiresAt !== undefined &&
        Date.parse(context.expiresAt) <=
          (input.now ?? this.#now()).getTime()
      ) ||
      this.#deletionIdentitiesBlocked([
        ...context.sourceEpisodeIds.map((identifier) => ({
          identifier,
          identityType: "episode" as const,
        })),
        ...[...context.sourceEventIds, ...context.recentVerificationEvidenceIds].map((identifier) => ({
          identifier,
          identityType: "event" as const,
        })),
      ])
    ) {
      return undefined;
    }
    return context;
  }

  public replaceCorrectionProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly correctionKeys: readonly CorrectionKey[];
    readonly opportunities: readonly CorrectionOpportunity[];
  }): CorrectionProjectionWriteResult {
    this.#assertNoRestoreBarrier();
    const correctionKeys = input.correctionKeys.map((key) =>
      correctionKeySchema.parse({
        ...key,
        sourceCorrectionEventIds: key.sourceCorrectionEventIds.map(normalizedEventReference),
        verificationEvidenceIds: key.verificationEvidenceIds.map(normalizedEventReference),
      }),
    );
    const opportunities = input.opportunities.map((opportunity) =>
      correctionOpportunitySchema.parse(opportunity),
    );
    const correctionKeyIds = new Set(
      correctionKeys.map((key) => key.correctionKeyId),
    );
    const missingKey = opportunities.find(
      (opportunity) =>
        !correctionKeyIds.has(opportunity.correctionKeyId),
    );
    if (missingKey !== undefined) {
      throw new Error(
        `Correction Opportunity ${missingKey.opportunityId} references an unknown Correction Key.`,
      );
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Correction projection is blocked by an active deletion.",
        );
      }
    const episodeIds = new Set(
      this.workEpisodes().map((episode) => episode.episodeId),
    );
    const missingEpisode = opportunities.find(
      (opportunity) => !episodeIds.has(opportunity.episodeId),
    );
    if (missingEpisode !== undefined) {
      throw new Error(
        `Correction Opportunity ${missingEpisode.opportunityId} references an unknown Work Episode.`,
      );
    }
    if (
      this.#deletionIdentitiesBlocked([
        ...correctionKeys.flatMap((key) => [
          ...key.sourceCorrectionEventIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
          ...key.verificationEvidenceIds.map((identifier) => ({
            identifier,
            identityType: "event" as const,
          })),
        ]),
        ...opportunities.map((opportunity) => ({
          identifier: opportunity.episodeId,
          identityType: "episode" as const,
        })),
      ])
    ) {
      throw new Error(
        "Correction projection contains a deleted identity.",
      );
    }
      this.#database.exec("DELETE FROM correction_opportunities;");
      this.#database.exec("DELETE FROM correction_key_sources;");
      this.#database.exec("DELETE FROM correction_keys;");
      const insertKey = this.#database.prepare(
        `INSERT INTO correction_keys (
           correction_key_id,
           schema_version,
           scope,
           scope_id,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertKeySource = this.#database.prepare(
        `INSERT INTO correction_key_sources (
           correction_key_id,
           source_event_id
         ) VALUES (?, ?)`,
      );
      for (const key of correctionKeys) {
        insertKey.run(
          key.correctionKeyId,
          key.schemaVersion,
          key.scope,
          optionalText(key.scopeId),
          JSON.stringify(key),
          sha256(key),
          key.createdAt,
        );
        for (
          const sourceEventId of
            new Set(key.sourceCorrectionEventIds)
        ) {
          insertKeySource.run(
            key.correctionKeyId,
            sourceEventId,
          );
        }
      }
      const insertOpportunity = this.#database.prepare(
        `INSERT INTO correction_opportunities (
           opportunity_id,
           schema_version,
           correction_key_id,
           episode_id,
           applicable,
           body_json,
           source_digest,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const opportunity of opportunities) {
        insertOpportunity.run(
          opportunity.opportunityId,
          opportunity.schemaVersion,
          opportunity.correctionKeyId,
          opportunity.episodeId,
          opportunity.applicable ? 1 : 0,
          JSON.stringify(opportunity),
          sha256(opportunity),
          opportunity.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return {
        correctionKeys: correctionKeys.length,
        opportunities: opportunities.length,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public correctionKeys(): readonly CorrectionKey[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM correction_keys
          ORDER BY correction_key_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      correctionKeySchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public correctionSourceEventIds(): ReadonlySet<string> {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT event_id
           FROM raw_events
          WHERE event_type = 'user.corrected'
            AND parse_status = 'supported'
          ORDER BY event_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return new Set(rows.map((row) => String(row.event_id)));
  }

  public correctionOpportunities(
    correctionKeyId?: string,
  ): readonly CorrectionOpportunity[] {
    this.#assertNoRestoreBarrier();
    return (
      this.#database
        .prepare(
          `SELECT body_json
             FROM correction_opportunities
            ORDER BY created_at, opportunity_id`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[]
    )
      .map((row) =>
        correctionOpportunitySchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        ),
      )
      .filter(
        (opportunity) =>
          correctionKeyId === undefined ||
          opportunity.correctionKeyId === correctionKeyId,
      );
  }

  public upsertKnowledgeCandidates(
    input: readonly KnowledgeCandidate[],
  ): number {
    this.#assertNoRestoreBarrier();
    const candidates = input.map(normalizedKnowledgeCandidate);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Knowledge persistence is blocked by an active deletion.",
        );
      }
      if (
        this.knowledgeCandidatesWithDeletedSources(candidates)
          .size > 0
      ) {
        throw new Error(
          "Knowledge candidate contains a deleted identity.",
        );
      }
      const forgotten = candidates.find((candidate) =>
        this.#knowledgeDeletionBlocked(candidate.knowledgeId) ||
        (candidate.supersedes !== undefined && this.#knowledgeDeletionBlocked(candidate.supersedes)),
      );
      if (forgotten !== undefined) {
        throw new Error(
          `Knowledge ${forgotten.knowledgeId} was forgotten and cannot be restored.`,
        );
      }
      const sourceEpisodeIds = new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEpisodeIds,
        ),
      );
      if (sourceEpisodeIds.size > 0) {
        const ids = [...sourceEpisodeIds];
        const existing = new Set(
          (
            this.#database
              .prepare(
                `SELECT episode_id
                   FROM work_episodes
                  WHERE episode_id IN (${placeholders(ids.length)})`,
              )
              .all(...ids) as readonly Readonly<
              Record<string, unknown>
            >[]
          ).map((row) => String(row.episode_id)),
        );
        const missing = ids.find((id) => !existing.has(id));
        if (missing !== undefined) {
          throw new Error(
            `Knowledge candidate references missing source Episode ${missing}.`,
          );
        }
      }
      const upsert = this.#database.prepare(
        `INSERT INTO knowledge_candidates (
           knowledge_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(knowledge_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           body_json = excluded.body_json,
           source_digest = excluded.source_digest,
           updated_at = excluded.updated_at`,
      );
      for (const candidate of this.#retainSupersededKnowledge(candidates)) {
        // Explicit upserts are not the automatic-expiry transition. An archived
        // record written here must not inherit permission to revive.
        if (asNumber(this.#database.prepare("PRAGMA user_version").get()?.user_version) >= 20) {
          this.#database.prepare("DELETE FROM learning_auto_expiry WHERE knowledge_id=?").run(candidate.knowledgeId);
          this.#database.prepare("DELETE FROM learning_relation_conflicts WHERE knowledge_id=?").run(candidate.knowledgeId);
        }
        upsert.run(
          candidate.knowledgeId,
          candidate.schemaVersion,
          JSON.stringify(candidate),
          sha256(candidate),
          candidate.createdAt,
          candidate.validatedAt ?? candidate.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return candidates.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public replaceCorrectionKnowledgeCandidates(input: {
    readonly allowDuringDeletion?: boolean;
    readonly candidates: readonly KnowledgeCandidate[];
  }): number {
    this.#assertNoRestoreBarrier();
    const candidates = input.candidates.map(
      normalizedKnowledgeCandidate,
    );
    const invalid = candidates.find(
      (candidate) =>
        !candidate.knowledgeId.startsWith(
          "correction-knowledge-",
        ) ||
        !candidate.topicKey.startsWith("correction:"),
    );
    if (invalid !== undefined) {
      throw new Error(
        "Correction Knowledge projection received a non-correction candidate.",
      );
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (
        this.hasActiveDeletion() &&
        input.allowDuringDeletion !== true
      ) {
        throw new Error(
          "Correction Knowledge projection is blocked by an active deletion.",
        );
      }
    if (
      this.knowledgeCandidatesWithDeletedSources(candidates)
        .size > 0
    ) {
      throw new Error(
        "Correction Knowledge contains a deleted identity.",
      );
    }
    const forgotten = candidates.find((candidate) =>
      this.#knowledgeDeletionBlocked(candidate.knowledgeId) ||
      (candidate.supersedes !== undefined && this.#knowledgeDeletionBlocked(candidate.supersedes)),
    );
    if (forgotten !== undefined) {
      throw new Error(
        `Knowledge ${forgotten.knowledgeId} was forgotten and cannot be restored.`,
      );
    }
    const sourceEpisodeIds = new Set(
      candidates.flatMap(
        (candidate) => candidate.sourceEpisodeIds,
      ),
    );
    if (sourceEpisodeIds.size > 0) {
      const ids = [...sourceEpisodeIds];
      const existing = new Set(
        (
          this.#database
            .prepare(
              `SELECT episode_id
                 FROM work_episodes
                WHERE episode_id IN (${placeholders(ids.length)})`,
            )
            .all(...ids) as readonly Readonly<
            Record<string, unknown>
          >[]
        ).map((row) => String(row.episode_id)),
      );
      const missing = ids.find((id) => !existing.has(id));
      if (missing !== undefined) {
        throw new Error(
          `Correction Knowledge references missing source Episode ${missing}.`,
        );
      }
    }
      const selected = new Set(
        candidates.map((candidate) => candidate.knowledgeId),
      );
      const existing = (
        this.#database
          .prepare(
            `SELECT knowledge_id
               FROM knowledge_candidates
              WHERE knowledge_id LIKE 'correction-knowledge-%'
                AND json_extract(body_json, '$.state') <> 'superseded'`,
          )
          .all() as readonly Readonly<Record<string, unknown>>[]
      ).map((row) => String(row.knowledge_id));
      const removed = existing.filter((id) => !selected.has(id));
      if (removed.length > 0) {
        this.#database
          .prepare(
            `DELETE FROM knowledge_candidates
              WHERE knowledge_id IN (${placeholders(removed.length)})`,
          )
          .run(...removed);
      }
      const upsert = this.#database.prepare(
        `INSERT INTO knowledge_candidates (
           knowledge_id,
           schema_version,
           body_json,
           source_digest,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(knowledge_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           body_json = excluded.body_json,
           source_digest = excluded.source_digest,
           updated_at = excluded.updated_at`,
      );
      for (const candidate of this.#retainSupersededKnowledge(candidates)) {
        upsert.run(
          candidate.knowledgeId,
          candidate.schemaVersion,
          JSON.stringify(candidate),
          sha256(candidate),
          candidate.createdAt,
          candidate.validatedAt ?? candidate.createdAt,
        );
      }
      this.#database.exec("COMMIT;");
      return candidates.length;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public knowledgeDeletionBlocked(knowledgeId: string): boolean {
    return this.#knowledgeDeletionBlocked(knowledgeId.trim());
  }

  #retainSupersededKnowledge(
    candidates: readonly KnowledgeCandidate[],
  ): readonly KnowledgeCandidate[] {
    const superseded = new Set(this.#database.prepare(
      "SELECT knowledge_id FROM knowledge_candidates WHERE json_extract(body_json, '$.state') = 'superseded'",
    ).all().map((row) => String(row.knowledge_id)));
    if (this.#hasReplacementReceipts()) {
      for (const row of this.#database.prepare(
        "SELECT json_extract(replacement_json, '$.previousKnowledgeId') AS id FROM feedback_events WHERE replacement_json IS NOT NULL",
      ).all()) {
        if (typeof row.id !== "string") {
          throw new Error("Confirmed-rule replacement receipt is invalid.");
        }
        superseded.add(row.id);
      }
    }
    return candidates.map((candidate) =>
      superseded.has(candidate.knowledgeId) && candidate.state !== "archived"
        ? { ...candidate, state: "superseded" as const }
        : candidate,
    );
  }

  #hasReplacementReceipts(): boolean {
    return asNumber(this.#database.prepare("PRAGMA user_version;").get()?.user_version) >= 9;
  }

  #hasObservedContextTimes(): boolean {
    return asNumber(this.#database.prepare("PRAGMA user_version;").get()?.user_version) >= 10;
  }

  #updateContextUseRecord(previous: ContextUseRecord, proposed: ContextUseRecord): void {
    if (
      proposed.requestId !== previous.requestId ||
      proposed.sessionId !== previous.sessionId ||
      proposed.createdAt !== previous.createdAt
    ) {
      throw new Error("Feedback cannot replace context request identity or time.");
    }
    const observesUpdates = this.#hasObservedContextTimes();
    const updatedAt = this.#now().toISOString();
    const updated = contextUseRecordSchema.parse({
      ...proposed,
      ...(observesUpdates ? { updatedAt } : {}),
    });
    const result = this.#database.prepare(
      `UPDATE context_use_records SET body_json = ?, source_digest = ?
         ${observesUpdates ? ", updated_at = ?" : ""}
       WHERE request_id = ? AND session_id = ?`,
    ).run(
      JSON.stringify(updated), sha256(updated),
      ...(observesUpdates ? [updatedAt] : []),
      previous.requestId, previous.sessionId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error("Feedback context request does not exist.");
    }
  }

  public removeKnowledgeCandidates(
    ids: readonly string[],
  ): number {
    this.#assertNoRestoreBarrier();
    const selected = [
      ...new Set(
        ids
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ];
    if (selected.length === 0) {
      return 0;
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      let removed = 0;
      for (const chunk of sqliteChunks(selected)) {
        removed += Number(this.#database.prepare(
          `DELETE FROM knowledge_candidates
            WHERE knowledge_id IN (${placeholders(chunk.length)})`,
        ).run(...chunk).changes);
      }
      this.#database.exec("COMMIT;");
      return removed;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public knowledgeCandidates(
    ids?: readonly string[],
  ): readonly KnowledgeCandidate[] {
    this.#assertNoRestoreBarrier();
    const selected =
      ids === undefined
        ? undefined
        : [
            ...new Set(
              ids
                .map((id) => id.trim())
                .filter((id) => id.length > 0),
            ),
          ];
    if (selected !== undefined && selected.length === 0) {
      return [];
    }
    const rows = this.#database
      .prepare(
        selected === undefined
          ? `SELECT body_json
               FROM knowledge_candidates
              ORDER BY created_at, knowledge_id`
          : `SELECT body_json
               FROM knowledge_candidates
              WHERE knowledge_id IN (${placeholders(
                selected.length,
              )})
              ORDER BY created_at, knowledge_id`,
      )
      .all(...(selected ?? [])) as readonly Readonly<
      Record<string, unknown>
    >[];
    return rows.map((row) =>
      knowledgeCandidateSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public knowledgeAdmissionEvidence(
    input: readonly KnowledgeCandidate[],
  ): CanonicalKnowledgeAdmissionEvidence {
    this.#assertNoRestoreBarrier();
    const candidates = input.map((candidate) =>
      knowledgeCandidateSchema.parse(candidate),
    );
    const knowledgeIds = [
      ...new Set(
        candidates.map((candidate) => candidate.knowledgeId),
      ),
    ];
    const sourceEpisodeIds = [
      ...new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEpisodeIds,
        ),
      ),
    ];
    const sourceEvidenceIds = [
      ...new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEvidenceIds.map(normalizedEventReference),
        ),
      ),
    ];
    const correctionKeyRows =
      new Map<string, Readonly<Record<string, unknown>>>();
    const envelopeRows =
      new Map<string, Readonly<Record<string, unknown>>>();
    const feedbackRows =
      new Map<string, Readonly<Record<string, unknown>>>();
    const contextRows =
      new Map<string, Readonly<Record<string, unknown>>>();
    const episodeRows =
      new Map<string, Readonly<Record<string, unknown>>>();
    for (const chunk of sqliteChunks(sourceEvidenceIds)) {
      for (const row of this.#database
        .prepare(
          `SELECT DISTINCT correction_keys.correction_key_id,
                           correction_keys.body_json
             FROM correction_key_sources
             JOIN correction_keys
               ON correction_keys.correction_key_id =
                  correction_key_sources.correction_key_id
            WHERE correction_key_sources.source_event_id IN (${placeholders(
              chunk.length,
            )})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        correctionKeyRows.set(
          String(row.correction_key_id),
          row,
        );
      }
      for (const row of this.#database
        .prepare(
          `SELECT deduplication_key, safe_envelope_json
             FROM raw_events
            WHERE parse_status = 'supported'
              AND event_id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        envelopeRows.set(String(row.deduplication_key), row);
      }
    }
    for (const chunk of sqliteChunks(knowledgeIds)) {
      for (const row of this.#database
        .prepare(
          `SELECT feedback_id, body_json
             FROM feedback_events
            WHERE json_extract(body_json, '$.targetType') = 'knowledge'
              AND json_extract(body_json, '$.targetId') IN (${placeholders(
              chunk.length,
            )})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        feedbackRows.set(String(row.feedback_id), row);
      }
    }
    const learningEvidence = candidates.some((entry) => entry.knowledgeId.startsWith("learning-knowledge-"));
    const counterSessions = new Set<string>();
    const counterRowsFor = (sessionId: string): readonly Readonly<Record<string, unknown>>[] => {
      if (counterSessions.has(sessionId)) return [];
      counterSessions.add(sessionId);
      return this.#database.prepare("SELECT deduplication_key,safe_envelope_json FROM raw_events WHERE parse_status='supported' AND session_id=? AND (" +
        "event_type IN ('change.reverted','tool.failed') OR json_extract(safe_envelope_json,'$.event.completionStatus')='failed' " +
        "OR (json_extract(safe_envelope_json,'$.event.exitCode') IS NOT NULL AND json_extract(safe_envelope_json,'$.event.exitCode')!=0) " +
        "OR json_extract(safe_envelope_json,'$.event.mcp.isError')=1 OR json_extract(safe_envelope_json,'$.event.mcp.resultType')='failure')").all(sessionId);
    };
    if (learningEvidence) {
      const sessions = new Map<string, { since: string; until: string; operations: Set<string> }>();
      for (const envelope of this.#effectiveEnvelopes([...envelopeRows.values()])) {
        const { sessionId, timestamp, operationId } = envelope.event;
        if (sessionId === undefined) continue;
        // The persisted ordering column is normalized UTC even when the exact
        // source timestamp retains an offset or different fractional precision.
        const orderedAt = new Date(timestamp).toISOString();
        const range = sessions.get(sessionId) ?? { since: orderedAt, until: orderedAt, operations: new Set<string>() };
        if (orderedAt < range.since) range.since = orderedAt;
        if (orderedAt > range.until) range.until = orderedAt;
        if (operationId !== undefined) range.operations.add(operationId);
        sessions.set(sessionId, range);
      }
      // Preserve negative evidence and competing operations without materializing
      // every ordinary tool result in the source session. The ancestor closure
      // below still loads every parent needed to validate these selected events.
      const select = "SELECT deduplication_key,safe_envelope_json FROM raw_events WHERE parse_status='supported' AND session_id=? AND ";
      const include = (rows: readonly Readonly<Record<string, unknown>>[]): void => {
        for (const row of rows) envelopeRows.set(String(row.deduplication_key), row);
      };
      for (const [sessionId, range] of sessions) {
        include(this.#database.prepare(select +
          "event_type='tool.started' AND event_timestamp>=? AND event_timestamp<=?").all(sessionId, range.since, range.until));
        include(this.#database.prepare(select +
          "trust='user' AND event_timestamp>=? AND event_timestamp<=?").all(sessionId, range.since, range.until));
        include(counterRowsFor(sessionId));
        for (const chunk of sqliteChunks([...range.operations])) {
          include(this.#database.prepare(select + "json_extract(safe_envelope_json,'$.event.operationId') IN (" +
            placeholders(chunk.length) + ")").all(sessionId, ...chunk));
        }
      }
    }
    const queriedProofIds = new Set(sourceEvidenceIds);
    const pendingProofIds = new Set<string>();
    const addProofReferences = (row: Readonly<Record<string, unknown>>): void => {
      const envelope = this.#effectiveEnvelope(
        captureEnvelopeSchema.parse(JSON.parse(String(row.safe_envelope_json))),
      );
      for (const reference of captureEvidenceReferences(envelope)) {
        pendingProofIds.add(reference);
      }
      if (envelope.event.sessionId !== undefined) {
        if (learningEvidence) {
          for (const counter of counterRowsFor(envelope.event.sessionId)) {
            const event = captureEnvelopeSchema.parse(JSON.parse(String(counter.safe_envelope_json)));
            pendingProofIds.add(event.event.eventId);
          }
        }
        for (const source of captureSdkSources(envelope)) {
          for (const referenced of this.#database.prepare(
            `SELECT event_id FROM raw_events WHERE adapter = ? AND adapter_version = ?
              AND session_id = ? AND source_event_id = ? AND event_type IN (${placeholders(source.eventTypes.length)})`,
          ).all(
            envelope.event.adapter, envelope.event.adapterVersion, envelope.event.sessionId,
            source.sourceEventId, ...source.eventTypes,
          )) {
            pendingProofIds.add(String(referenced.event_id));
          }
        }
      }
    };
    for (const row of envelopeRows.values()) {
      addProofReferences(row);
    }
    for (const row of correctionKeyRows.values()) {
      const key = correctionKeySchema.parse(JSON.parse(String(row.body_json)));
      for (const reference of key.verificationEvidenceIds) {
        pendingProofIds.add(normalizedEventReference(reference));
      }
    }
    for (const row of feedbackRows.values()) {
      const feedback = feedbackEventSchema.parse(JSON.parse(String(row.body_json)));
      for (const reference of feedback.resolvesEvidenceIds ?? []) {
        pendingProofIds.add(normalizedEventReference(reference));
      }
    }
    while (pendingProofIds.size > 0) {
      const references = [...pendingProofIds].filter((id) => !queriedProofIds.has(id));
      pendingProofIds.clear();
      for (const reference of references) {
        queriedProofIds.add(reference);
      }
      for (const chunk of sqliteChunks(references)) {
        for (const row of this.#database.prepare(
          `SELECT deduplication_key, safe_envelope_json FROM raw_events
            WHERE parse_status = 'supported' AND event_id IN (${placeholders(chunk.length)})`,
        ).all(...chunk)) {
          envelopeRows.set(String(row.deduplication_key), row);
          addProofReferences(row);
        }
        for (const row of this.#database.prepare(
          `SELECT DISTINCT correction_keys.correction_key_id, correction_keys.body_json
             FROM correction_key_sources JOIN correction_keys
               ON correction_keys.correction_key_id = correction_key_sources.correction_key_id
            WHERE correction_key_sources.source_event_id IN (${placeholders(chunk.length)})`,
        ).all(...chunk)) {
          correctionKeyRows.set(String(row.correction_key_id), row);
          const key = correctionKeySchema.parse(JSON.parse(String(row.body_json)));
          for (const reference of key.verificationEvidenceIds) {
            pendingProofIds.add(normalizedEventReference(reference));
          }
        }
      }
    }
    for (const chunk of sqliteChunks(sourceEpisodeIds)) {
      for (const row of this.#database
        .prepare(
          `SELECT request_id, body_json
             FROM context_use_records
            WHERE json_extract(body_json, '$.episodeId') IN (${placeholders(
              chunk.length,
            )})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        contextRows.set(String(row.request_id), row);
      }
      for (const row of this.#database
        .prepare(
          `SELECT episode_id, body_json
             FROM work_episodes
            WHERE episode_id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        episodeRows.set(String(row.episode_id), row);
      }
    }
    const envelopes = this.#effectiveEnvelopes([...envelopeRows.values()])
      .sort(
        (left, right) =>
          Date.parse(left.event.timestamp) -
            Date.parse(right.event.timestamp) ||
          left.event.eventId.localeCompare(right.event.eventId),
      );
    const selectedProposals = this.learningProposals(candidates.map((entry) => entry.knowledgeId));
    const selectedReceipts = this.learningReceipts(candidates.map((entry) => entry.knowledgeId));
    const peers = this.#learningShellPeers(selectedReceipts);
    return {
      learningProposals: [...new Map([...selectedProposals, ...peers.map((peer) => peer.proposal)].map((proposal) => [proposal.proposalId, proposal])).values()],
      learningReceipts: [...new Map([...selectedReceipts, ...peers.map((peer) => peer.receipt)].map((receipt) => [receipt.receiptId, receipt])).values()],
      contextUseRecords: [...contextRows.values(), ...((candidates.some((entry) => entry.knowledgeId.startsWith("learning-knowledge-")))
        ? [...new Set(envelopes.map((entry) => entry.event.sessionId).filter((id): id is string => id !== undefined))]
          .flatMap((id) => this.#database.prepare("SELECT request_id,body_json FROM context_use_records WHERE session_id=?").all(id))
        : [])]
        .map((row) =>
          contextUseRecordSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        )
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.requestId.localeCompare(right.requestId),
        ),
      correctionKeys: [...correctionKeyRows.values()]
        .map((row) =>
          correctionKeySchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        )
        .sort((left, right) =>
          left.correctionKeyId.localeCompare(right.correctionKeyId),
        ),
      correctionSourceEventIds: new Set(
        envelopes
          .filter(
            (envelope) =>
              envelope.event.eventType === "user.corrected",
          )
          .map((envelope) => envelope.event.eventId),
      ),
      envelopes,
      feedbackEvents: [...feedbackRows.values()]
        .map((row) =>
          feedbackEventSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        )
        .sort(
          (left, right) =>
            Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
            left.feedbackId.localeCompare(right.feedbackId),
        ),
      workEpisodes: [...episodeRows.values()]
        .map((row) =>
          workEpisodeSchema.parse(
            JSON.parse(String(row.body_json)) as unknown,
          ),
        )
        .sort(
          (left, right) =>
            Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
            left.episodeId.localeCompare(right.episodeId),
        ),
    };
  }

  public appendContextUseRecord(
    input: ContextUseRecord,
  ): boolean {
    this.#assertNoRestoreBarrier();
    const record = contextUseRecordSchema.parse(input);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Context use persistence is blocked by an active deletion.",
        );
      }
      if (
        this.#deletionIdentitiesBlocked([
          { identityType: "session", identifier: record.sessionId },
          ...(record.episodeId === undefined ? [] : [
            { identityType: "episode" as const, identifier: record.episodeId },
          ]),
        ]) ||
        [
          ...record.appliedKnowledgeIds,
          ...record.candidateKnowledgeIds,
          ...record.returnedKnowledgeIds,
        ].some((id) => {
          if (!id.startsWith("branch-context:")) {
            return this.#knowledgeDeletionBlocked(id.replace(/^knowledge:/u, ""));
          }
          const row = this.#database.prepare(
            "SELECT body_json FROM branch_contexts WHERE branch_context_id = ?",
          ).get(id.slice("branch-context:".length));
          if (row === undefined) return true;
          const context = branchContextSchema.parse(JSON.parse(String(row.body_json)));
          return this.#deletionIdentitiesBlocked([
            ...context.sourceEpisodeIds.map((identifier) => ({
              identifier, identityType: "episode" as const,
            })),
            ...[...context.sourceEventIds, ...context.recentVerificationEvidenceIds].map((identifier) => ({
              identifier, identityType: "event" as const,
            })),
          ]);
        })
      ) {
        throw new Error("Context use cannot restore a deleted identity.");
      }
      const observesUpdates = this.#hasObservedContextTimes();
      const updatedAt = this.#now().toISOString();
      const persisted = contextUseRecordSchema.parse({
        ...record,
        ...(observesUpdates ? { updatedAt } : {}),
      });
      const result = this.#database
        .prepare(
          `INSERT OR IGNORE INTO context_use_records (
             request_id,
             schema_version,
             session_id,
             body_json,
             source_digest,
             created_at${observesUpdates ? ", updated_at" : ""}
           ) VALUES (?, ?, ?, ?, ?, ?${observesUpdates ? ", ?" : ""})`,
        )
        .run(
          record.requestId,
          record.schemaVersion,
          record.sessionId,
          JSON.stringify(persisted),
          sha256(persisted),
          record.createdAt,
          ...(observesUpdates ? [updatedAt] : []),
        );
      this.#database.exec("COMMIT;");
      return Number(result.changes) === 1;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public contextUseRecords(
    sessionId?: string,
  ): readonly ContextUseRecord[] {
    this.#assertNoRestoreBarrier();
    const normalizedSessionId = sessionId?.trim();
    const rows = this.#database
      .prepare(
        normalizedSessionId === undefined
          ? `SELECT body_json
               FROM context_use_records
              ORDER BY created_at, request_id`
          : `SELECT body_json
               FROM context_use_records
              WHERE session_id = ?
              ORDER BY created_at, request_id`,
      )
      .all(...(
        normalizedSessionId === undefined
          ? []
          : [
              normalizedSessionId,
            ]
      )) as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      contextUseRecordSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public contextUseRecordsForEpisodes(
    episodeIds: readonly string[],
  ): readonly ContextUseRecord[] {
    this.#assertNoRestoreBarrier();
    const selected = [
      ...new Set(
        episodeIds
          .map((episodeId) => episodeId.trim())
          .filter((episodeId) => episodeId.length > 0),
      ),
    ];
    if (selected.length === 0) {
      return [];
    }
    const rows = new Map<
      string,
      Readonly<Record<string, unknown>>
    >();
    for (const chunk of sqliteChunks(selected)) {
      for (const row of this.#database
        .prepare(
          `SELECT request_id, body_json
             FROM context_use_records
            WHERE json_extract(body_json, '$.episodeId') IN (${placeholders(
              chunk.length,
            )})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        rows.set(String(row.request_id), row);
      }
    }
    return [...rows.values()]
      .map((row) =>
        contextUseRecordSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        ),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.requestId.localeCompare(right.requestId),
      );
  }

  public recordKnowledgeFeedback(input: {
    readonly contextRequestId?: string;
    readonly event: FeedbackEvent;
    readonly updateCandidate?: (
      candidate: KnowledgeCandidate,
    ) => KnowledgeCandidate;
    readonly updateContextUseRecord?: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): {
    readonly candidate: KnowledgeCandidate;
    readonly recorded: boolean;
  } {
    this.#assertNoRestoreBarrier();
    const event = normalizedFeedbackEvent(input.event);
    if (event.targetType !== "knowledge") {
      throw new Error(
        "Knowledge feedback must target Knowledge.",
      );
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.#deletionIdentitiesBlocked(feedbackResolutionIdentities(event))) {
        throw new Error("Feedback cannot reference deleted evidence.");
      }
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Knowledge feedback is blocked by an active deletion.",
        );
      }
      const existingRow = this.#database
        .prepare(
          `SELECT body_json
             FROM knowledge_candidates
            WHERE knowledge_id = ?`,
        )
        .get(event.targetId) as
        | Readonly<Record<string, unknown>>
        | undefined;
      if (existingRow === undefined) {
        throw new Error(
          `Knowledge feedback target ${event.targetId} does not exist.`,
        );
      }
      const existing = normalizedKnowledgeCandidate(
        JSON.parse(String(existingRow.body_json)) as KnowledgeCandidate,
      );
      const inserted = this.#database
        .prepare(
          `INSERT OR IGNORE INTO feedback_events (
             feedback_id,
             schema_version,
             body_json,
             source_digest,
             created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          event.feedbackId,
          event.schemaVersion,
          JSON.stringify(event),
          sha256(event),
          event.timestamp,
        );
      if (Number(inserted.changes) === 0) {
        const existingEventRow = this.#database
          .prepare(
            `SELECT body_json
               FROM feedback_events
              WHERE feedback_id = ?`,
          )
          .get(event.feedbackId) as Readonly<Record<string, unknown>>;
        const existingEvent = feedbackEventSchema.parse(
          JSON.parse(String(existingEventRow.body_json)) as unknown,
        );
        if (
          feedbackIntentDigest(existingEvent) !==
          feedbackIntentDigest(event)
        ) {
          throw new Error(
            "Feedback ID already exists with different content.",
          );
        }
        if (existingEvent.kind === "mute_session") {
          this.#upsertSessionMute(existingEvent);
        }
        this.#database.exec("COMMIT;");
        return {
          candidate: existing,
          recorded: false,
        };
      }
      if (event.kind === "mute_session") {
        this.#upsertSessionMute(event);
      }
      const proposedCandidate =
        input.updateCandidate === undefined
          ? existing
          : normalizedKnowledgeCandidate(
              input.updateCandidate(existing),
            );
      const candidate = this.#retainSupersededKnowledge([proposedCandidate])[0];
      if (candidate === undefined) {
        throw new InvalidCanonicalSchemaError("Knowledge feedback candidate is missing.");
      }
      if (
        candidate.knowledgeId !== event.targetId ||
        JSON.stringify(candidate.sourceEpisodeIds) !==
          JSON.stringify(existing.sourceEpisodeIds) ||
        JSON.stringify(candidate.sourceEvidenceIds) !==
          JSON.stringify(existing.sourceEvidenceIds)
      ) {
        throw new Error(
          "Knowledge feedback cannot replace identity or provenance.",
        );
      }
      if (input.updateCandidate !== undefined) {
        this.#database
          .prepare(
            `UPDATE knowledge_candidates
                SET schema_version = ?,
                    body_json = ?,
                    source_digest = ?,
                    updated_at = ?
              WHERE knowledge_id = ?`,
          )
          .run(
            candidate.schemaVersion,
            JSON.stringify(candidate),
            sha256(candidate),
            candidate.validatedAt ?? event.timestamp,
            candidate.knowledgeId,
          );
      }
      if (
        input.updateContextUseRecord !== undefined ||
        input.contextRequestId !== undefined ||
        this.#hasObservedContextTimes()
      ) {
        const contextRow = this.#database
          .prepare(
            `SELECT body_json
               FROM context_use_records
              WHERE request_id = ?`,
          )
          .get(input.contextRequestId ?? event.evidenceRef) as
          | Readonly<Record<string, unknown>>
          | undefined;
        if (
          contextRow === undefined &&
          (input.updateContextUseRecord !== undefined || input.contextRequestId !== undefined)
        ) {
          throw new Error(
            "Knowledge feedback context request does not exist.",
          );
        }
        if (contextRow !== undefined) {
          const previousRecord = contextUseRecordSchema.parse(
            JSON.parse(String(contextRow.body_json)) as unknown,
          );
          const updated = input.updateContextUseRecord?.(previousRecord) ?? previousRecord;
          this.#updateContextUseRecord(previousRecord, contextUseRecordSchema.parse(updated));
        }
      }
      this.#database.exec("COMMIT;");
      return {
        candidate,
        recorded: true,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public recordContextFeedback(input: {
    readonly contextRequestId: string;
    readonly event: FeedbackEvent;
    readonly updateContextUseRecord: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): { readonly recorded: boolean } {
    return this.recordBranchContextFeedback(input);
  }

  public replaceKnowledgeWithConfirmedRule(input: {
    readonly scopeChange?: { readonly previousScope: KnowledgeCandidate["scope"]; readonly previousScopeId?: string; readonly scope: KnowledgeCandidate["scope"]; readonly scopeId?: string };
    readonly previousKnowledgeId: string;
    readonly expectedDigest: string;
    readonly candidate: KnowledgeCandidate;
    readonly event: FeedbackEvent;
  }): { readonly candidate: KnowledgeCandidate; readonly recorded: boolean } {
    this.#assertNoRestoreBarrier();
    const previousKnowledgeId = input.previousKnowledgeId.trim();
    const candidate = normalizedKnowledgeCandidate(input.candidate);
    const event = normalizedFeedbackEvent(input.event);
    if (
      !/^[a-f0-9]{64}$/u.test(input.expectedDigest) ||
      event.targetType !== "knowledge" || event.targetId !== previousKnowledgeId ||
      event.source !== "user" || event.kind !== "confirm" ||
      candidate.knowledgeId === previousKnowledgeId ||
      !candidate.knowledgeId.startsWith("manual-knowledge-") ||
      !candidate.topicKey.startsWith("manual:") ||
      candidate.supersedes !== previousKnowledgeId ||
      candidate.evidenceTier !== "user_confirmed" ||
      candidate.evidenceMarks.length !== 1 || candidate.evidenceMarks[0] !== "user_confirmed" ||
      candidate.state !== "active" || candidate.expiresAt !== undefined ||
      candidate.appliesWhen.length === 0 || candidate.conflictsWith.length !== 0 ||
      candidate.sourceEpisodeIds.length !== 0 || candidate.sourceEvidenceIds.length !== 0 ||
      candidate.createdAt !== event.timestamp || candidate.validatedAt !== event.timestamp ||
      Object.values(candidate.utility).some((value) => value !== 0) ||
      Object.values(candidate.coverage).some((value) => value !== 0)
    ) {
      throw new Error("Replacement requires a new explicitly user-confirmed manual rule and matching audit feedback.");
    }
    if (!this.#hasReplacementReceipts()) {
      throw new Error("Atomic confirmed-rule replacement requires the current canonical schema.");
    }
    const receipt = {
      formatVersion: 1,
      previousKnowledgeId,
      replacementKnowledgeId: candidate.knowledgeId,
      expectedDigest: input.expectedDigest,
      candidateIntentDigest: confirmedRuleIntentDigest(candidate),
      ...(input.scopeChange ? { scopeChange: input.scopeChange } : {}),
    };
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error("Knowledge replacement is blocked by an active deletion.");
      }
      if (
        this.#knowledgeDeletionBlocked(previousKnowledgeId) ||
        this.#knowledgeDeletionBlocked(candidate.knowledgeId) ||
        this.#deletionIdentitiesBlocked(feedbackResolutionIdentities(event))
      ) {
        throw new Error("Knowledge replacement cannot restore forgotten Knowledge or deleted evidence.");
      }
      const previousRow = this.#database.prepare(
        "SELECT body_json FROM knowledge_candidates WHERE knowledge_id = ?",
      ).get(previousKnowledgeId);
      if (previousRow === undefined) {
        throw new Error("Knowledge replacement target does not exist.");
      }
      const previous = knowledgeCandidateSchema.parse(JSON.parse(String(previousRow.body_json)));
      const scopeReviewed = input.scopeChange !== undefined && input.scopeChange.previousScope === previous.scope &&
        input.scopeChange.previousScopeId === previous.scopeId && input.scopeChange.scope === candidate.scope &&
        input.scopeChange.scopeId === candidate.scopeId;
      if (
        ((!scopeReviewed) && (previous.scope !== candidate.scope || previous.scopeId !== candidate.scopeId)) ||
        (candidate.scope === "personal"
          ? candidate.scopeId !== undefined
          : candidate.scopeId === undefined || candidate.scopeId.trim().length === 0)
      ) {
        throw new Error("Knowledge replacement cannot change or omit the reviewed scope.");
      }
      if (this.knowledgeCandidatesWithDeletedSources([previous, candidate]).size > 0) {
        throw new Error("Knowledge replacement contains deleted evidence.");
      }
      const existingFeedback = this.#database.prepare(
        "SELECT body_json, replacement_json FROM feedback_events WHERE feedback_id = ?",
      ).get(event.feedbackId);
      const existingReplacement = this.#database.prepare(
        "SELECT body_json FROM knowledge_candidates WHERE knowledge_id = ?",
      ).get(candidate.knowledgeId);
      if (existingFeedback !== undefined) {
        if (
          existingFeedback.replacement_json === null ||
          sha256(JSON.parse(String(existingFeedback.replacement_json))) !== sha256(receipt) ||
          feedbackIntentDigest(feedbackEventSchema.parse(JSON.parse(String(existingFeedback.body_json)))) !== feedbackIntentDigest(event) ||
          existingReplacement === undefined
        ) {
          throw new Error("Replacement feedback ID already exists with different or incomplete content.");
        }
        const recorded = knowledgeCandidateSchema.parse(JSON.parse(String(existingReplacement.body_json)));
        if (
          recorded.supersedes !== previousKnowledgeId ||
          recorded.scope !== candidate.scope || recorded.scopeId !== candidate.scopeId ||
          !["superseded", "archived"].includes(previous.state)
        ) {
          throw new Error("Recorded Knowledge replacement changed; review it again.");
        }
        this.#database.exec("COMMIT;");
        return { candidate: recorded, recorded: false };
      }
      if (existingReplacement !== undefined) {
        throw new Error("Replacement Knowledge ID already exists without matching audit feedback.");
      }
      if (sha256(previous) !== input.expectedDigest) {
        throw new Error("Knowledge changed after review. Review it again before confirming.");
      }
      if (previous.state === "superseded") {
        throw new Error("Knowledge was already superseded; review its replacement instead.");
      }
      if (this.knowledgeCandidatesWithUnavailableSources([previous]).size > 0) {
        throw new Error("Knowledge replacement target has unavailable source evidence.");
      }
      const superseded = knowledgeCandidateSchema.parse({ ...previous, state: "superseded" });
      this.#database.prepare(
        `INSERT INTO knowledge_candidates (
           knowledge_id, schema_version, body_json, source_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.knowledgeId, candidate.schemaVersion, JSON.stringify(candidate),
        sha256(candidate), candidate.createdAt, event.timestamp,
      );
      this.#database.prepare(
        "UPDATE knowledge_candidates SET body_json = ?, source_digest = ?, updated_at = ? WHERE knowledge_id = ?",
      ).run(JSON.stringify(superseded), sha256(superseded), event.timestamp, previousKnowledgeId);
      this.#database.prepare(
        `INSERT INTO feedback_events (
           feedback_id, schema_version, body_json, source_digest, created_at, replacement_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        event.feedbackId, event.schemaVersion, JSON.stringify(event),
        sha256(event), event.timestamp, JSON.stringify(receipt),
      );
      this.#database.exec("COMMIT;");
      return { candidate, recorded: true };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public recordBranchContextFeedback(input: {
    readonly event: FeedbackEvent;
    readonly contextRequestId?: string;
    readonly updateContextUseRecord?: (
      record: ContextUseRecord,
    ) => ContextUseRecord;
  }): { readonly recorded: boolean } {
    this.#assertNoRestoreBarrier();
    const event = normalizedFeedbackEvent(input.event);
    if (event.targetType !== "branch_context") {
      throw new Error("Branch Context feedback must target Branch Context.");
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.#deletionIdentitiesBlocked(feedbackResolutionIdentities(event))) {
        throw new Error("Feedback cannot reference deleted evidence.");
      }
      if (this.hasActiveDeletion()) {
        throw new Error("Branch Context feedback is blocked by an active deletion.");
      }
      const row = this.#database.prepare(
        "SELECT body_json FROM branch_contexts WHERE branch_context_id = ?",
      ).get(event.targetId);
      if (row === undefined) {
        throw new Error("Branch Context feedback target does not exist.");
      }
      const context = branchContextSchema.parse(JSON.parse(String(row.body_json)));
      if (this.#deletionIdentitiesBlocked([
        ...context.sourceEpisodeIds.map((identifier) => ({
          identifier, identityType: "episode" as const,
        })),
        ...[...context.sourceEventIds, ...context.recentVerificationEvidenceIds].map((identifier) => ({
          identifier, identityType: "event" as const,
        })),
      ])) {
        throw new Error("Branch Context feedback target contains deleted evidence.");
      }
      const existing = this.#database.prepare(
        "SELECT body_json FROM feedback_events WHERE feedback_id = ?",
      ).get(event.feedbackId);
      if (existing !== undefined) {
        const recorded = feedbackEventSchema.parse(JSON.parse(String(existing.body_json)));
        if (feedbackIntentDigest(recorded) !== feedbackIntentDigest(event)) {
          throw new Error("Feedback ID already exists with different content.");
        }
        this.#database.exec("COMMIT;");
        return { recorded: false };
      }
      const requestId = input.contextRequestId ?? event.evidenceRef;
      const requestRow = this.#database.prepare(
        "SELECT body_json FROM context_use_records WHERE request_id = ?",
      ).get(requestId);
      if (requestRow === undefined) {
        throw new Error("Branch Context feedback requires a recorded context request.");
      }
      const request = contextUseRecordSchema.parse(JSON.parse(String(requestRow.body_json)));
      if (
        !request.returnedKnowledgeIds.includes(`branch-context:${event.targetId}`) ||
        this.deletionIdentityBlocked("session", request.sessionId)
      ) {
        throw new Error("Branch Context was not returned by the recorded request.");
      }
      this.#database.prepare(
        `INSERT INTO feedback_events (
           feedback_id, schema_version, body_json, source_digest, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(event.feedbackId, event.schemaVersion, JSON.stringify(event), sha256(event), event.timestamp);
      if (input.updateContextUseRecord !== undefined || this.#hasObservedContextTimes()) {
        const updated = input.updateContextUseRecord?.(request) ?? request;
        this.#updateContextUseRecord(request, contextUseRecordSchema.parse(updated));
      }
      this.#database.exec("COMMIT;");
      return { recorded: true };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  public feedbackEvents(
    targetId?: string,
  ): readonly FeedbackEvent[] {
    this.#assertNoRestoreBarrier();
    const normalizedTargetId = targetId?.trim();
    const rows = this.#database
      .prepare(
        normalizedTargetId === undefined
          ? `SELECT body_json
               FROM feedback_events
              ORDER BY created_at, feedback_id`
          : `SELECT body_json
               FROM feedback_events
              WHERE json_extract(body_json, '$.targetId') = ?
              ORDER BY created_at, feedback_id`,
      )
      .all(...(
        normalizedTargetId === undefined
          ? []
          : [
              normalizedTargetId,
            ]
      )) as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) =>
      feedbackEventSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      ),
    );
  }

  public sessionMuted(sessionId: string): boolean {
    this.#assertNoRestoreBarrier();
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) {
      return false;
    }
    return this.#database
      .prepare(
        `SELECT 1
           FROM session_mutes
          WHERE session_id = ?`,
      )
      .get(normalizedSessionId) !== undefined;
  }

  #upsertSessionMute(event: FeedbackEvent): void {
    this.#database
      .prepare(
        `INSERT INTO session_mutes (
           feedback_id,
           session_id,
           target_id,
           created_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(feedback_id) DO UPDATE SET
           target_id = excluded.target_id,
           session_id = excluded.session_id,
           created_at = excluded.created_at`,
      )
      .run(
        event.feedbackId,
        event.evidenceRef,
        event.targetId,
        event.timestamp,
      );
  }

  public knowledgeCandidatesWithDeletedSources(
    input: readonly KnowledgeCandidate[],
  ): ReadonlySet<string> {
    const candidates = input.map((candidate) =>
      knowledgeCandidateSchema.parse(candidate),
    );
    const tombstones = this.#deletionTombstoneKeys();
    return new Set(
      candidates.flatMap((candidate) => {
        const evidenceIdentities: DeletionPlannedIdentity[] = [];
        for (const identifier of candidate.sourceEvidenceIds) {
          if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
            evidenceIdentities.push({
              identifier: identifier.toLowerCase(),
              identityType: "event",
            });
          } else if (/^[a-f0-9]{64}$/iu.test(identifier)) {
            evidenceIdentities.push({
              identifier: identifier.toLowerCase(),
              identityType: "deduplication",
            });
          }
        }
        const identities: DeletionPlannedIdentity[] = [
          ...candidate.sourceEpisodeIds.map((identifier) => ({
            identifier,
            identityType: "episode" as const,
          })),
          ...evidenceIdentities,
        ];
        return identities.some((identity) =>
          tombstones.has(this.#deletionIdentityKeyFor(identity)),
        )
          ? [candidate.knowledgeId]
          : [];
      }),
    );
  }

  public knowledgeCandidatesWithUnavailableSources(
    input: readonly KnowledgeCandidate[],
  ): ReadonlySet<string> {
    const candidates = input.map((candidate) =>
      knowledgeCandidateSchema.parse(candidate),
    );
    const unavailable = new Set(
      this.knowledgeCandidatesWithDeletedSources(candidates),
    );
    const sourceEpisodeIds = [
      ...new Set(
        candidates.flatMap(
          (candidate) => candidate.sourceEpisodeIds,
        ),
      ),
    ];
    if (sourceEpisodeIds.length === 0) {
      return unavailable;
    }
    const existing = new Set<string>();
    for (const chunk of sqliteChunks(sourceEpisodeIds)) {
      for (const row of this.#database
        .prepare(
          `SELECT episode_id
             FROM work_episodes
            WHERE episode_id IN (${placeholders(chunk.length)})`,
        )
        .all(...chunk) as readonly Readonly<
        Record<string, unknown>
      >[]) {
        existing.add(String(row.episode_id));
      }
    }
    for (const candidate of candidates) {
      if (
        candidate.sourceEpisodeIds.some(
          (episodeId) => !existing.has(episodeId),
        )
      ) {
        unavailable.add(candidate.knowledgeId);
      }
    }
    return unavailable;
  }

  public episodeAssociations(): readonly EpisodeAssociation[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM evidence_links
          ORDER BY link_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.flatMap((row) => {
      let body: unknown;
      try {
        body = JSON.parse(String(row.body_json)) as unknown;
      } catch {
        return [];
      }
      const parsed = episodeAssociationSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
  }

  public episodeGroupingCorrections():
  readonly EpisodeGroupingCorrection[] {
  this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM evidence_links
          ORDER BY created_at, link_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.flatMap((row) => {
      let body: unknown;
      try {
        body = JSON.parse(String(row.body_json)) as unknown;
      } catch {
        return [];
      }
      const parsed = episodeGroupingCorrectionSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
  }

  public workEpisodes(): readonly WorkEpisode[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM work_episodes
          ORDER BY created_at, episode_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows
      .map((row) =>
        workEpisodeSchema.parse(
          JSON.parse(String(row.body_json)) as unknown,
        ),
      )
      .sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.episodeId.localeCompare(right.episodeId),
      );
  }

  public parserErrors(): readonly CanonicalParserErrorRecord[] {
    this.#assertNoRestoreBarrier();
    const rows = this.#database
      .prepare(
        `SELECT error_kind, message, queue_item_id
           FROM parser_errors
          ORDER BY parser_error_id`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    return rows.map((row) => ({
      errorKind: String(row.error_kind),
      message: String(row.message),
      queueItemId: String(row.queue_item_id),
    }));
  }

  public queueProcessing(
    queueItemId: string,
  ): QueueProcessingRecord | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database
      .prepare(
        `SELECT queue_item_id, status
           FROM queue_processing
          WHERE queue_item_id = ?`,
      )
      .get(queueItemId) as
      | Readonly<Record<string, unknown>>
      | undefined;
    return row === undefined
      ? undefined
      : {
          queueItemId: String(row.queue_item_id),
          status: String(row.status),
        };
  }

  #typedDeletionIdentities(
    targetType: DeletionTargetType,
    targetId: string | undefined,
    identifiers: readonly string[],
  ): readonly DeletionPlannedIdentity[] {
    const typed = new Map<string, DeletionPlannedIdentity>();
    const add = (
        identityType: DeletionIdentityType,
        identifier: string,
    ): void => {
        typed.set(
          `${identityType}\u0000${identifier}`,
          {
            identifier,
            identityType,
          },
        );
    };
    if (targetId !== undefined) {
        if (targetType === "episode") {
          add("episode", targetId);
        } else if (targetType === "session") {
          add("session", targetId);
        }
    }
    for (const identifier of identifiers) {
        if (/^event-[a-f0-9]{64}$/iu.test(identifier)) {
          add("event", identifier.toLowerCase());
        } else if (/^[a-f0-9]{64}$/iu.test(identifier)) {
          add("deduplication", identifier.toLowerCase());
        }
    }
    return [...typed.values()];
  }

  #validateDeletionIdentityKey(): void {
    const expectedVerifier = this.#deletionIdentityKeyVerifier();
    const rows = this.#database
      .prepare(
        `SELECT body_json
           FROM deletion_operations`,
      )
      .all() as readonly Readonly<Record<string, unknown>>[];
    for (const row of rows) {
      const operation = deletionOperationSchema.parse(
        JSON.parse(String(row.body_json)) as unknown,
      );
      if (operation.tombstoneKeyVerifier !== expectedVerifier) {
        throw new InvalidCanonicalSchemaError(
          "Canonical deletion identity key does not match tombstones.",
        );
      }
    }
  }

  #deletionIdentityKeyVerifier(): string {
    return deletionIdentityDigest(
      "key",
      "provenloop-deletion-tombstone-key",
      this.#deletionIdentityKey,
    );
  }

  #advanceRecordsResetGeneration(): void {
    if (this.#path === ":memory:") return;
    const generation = randomUUID();
    const target = `${this.#path}.restore.generation`;
    const temporary = `${target}.${generation}.pending`;
    let handle: number | undefined;
    try {
      handle = openSync(temporary, "wx");
      writeFileSync(handle, generation, "utf8");
      fsyncSync(handle);
      closeSync(handle); handle = undefined;
      this.#faultInjector?.("before_reset_generation_publish");
      renameSync(temporary, target);
      this.#generation = generation;
    } finally {
      if (handle !== undefined) closeSync(handle);
      try { unlinkSync(temporary); } catch { /* A failed pre-publication file is covered by the caller's reset recovery. */ }
    }
  }

  public contextUseRecord(requestId: string): ContextUseRecord | undefined {
    this.#assertNoRestoreBarrier();
    const row = this.#database.prepare("SELECT body_json FROM context_use_records WHERE request_id = ?").get(requestId);
    return row === undefined ? undefined : contextUseRecordSchema.parse(JSON.parse(String(row.body_json)));
  }

  #assertNoRestoreBarrier(): void {
    if (this.#path === ":memory:") {
      return;
    }
    if (!this.#allowRecordsReset && existsSync(resolve(dirname(this.#path), "records-reset.pending.json"))) {
      throw new Error("Canonical storage is blocked while record reset is pending. Complete record reset before continuing.");
    }
    if (existsSync(`${this.#path}.restore.lock`)) {
      throw new Error(
        "Canonical writes are blocked by an active restore.",
      );
    }
    if (
      readOptionalText(`${this.#path}.restore.generation`) !== this.#generation ||
      readOptionalText(`${this.#path}.deletion.key`) !== this.#deletionIdentityKey
    ) {
      throw new StaleCanonicalStoreError();
    }
  }

  #writeDeletionOperation(operation: DeletionOperation): void {
    this.#database
        .prepare(
          `UPDATE deletion_operations
              SET status = ?,
                  body_json = ?,
                  updated_at = ?
            WHERE deletion_id = ?`,
        )
        .run(
          operation.status,
          JSON.stringify(operation),
          operation.completedAt ?? this.#now().toISOString(),
          operation.deletionId,
        );
  }

  #captureEnvelopeDeletionBlocked(
    envelope: CaptureEnvelope,
  ): boolean {
    const sourceAlias = captureSourceAlias(envelope);
    return this.#deletionIdentitiesBlocked([
        {
          identifier: envelope.deduplicationKey,
          identityType: "deduplication" as const,
        },
        {
          identifier: envelope.event.eventId,
          identityType: "event" as const,
        },
        ...(sourceAlias === undefined ? [] : [{
          identifier: sourceAlias, identityType: "event" as const,
        }]),
        ...(envelope.event.sessionId === undefined
          ? []
          : [
              {
                identifier: envelope.event.sessionId,
                identityType: "session" as const,
              },
            ]),
        ...captureEvidenceReferences(envelope).map((identifier) => ({
          identifier,
          identityType: "event" as const,
        })),
    ]);
  }

  #recordRejected(
    item: CaptureQueueItem,
    deduplicationKey: string,
    errorKind: string,
    message: string,
    safeEnvelopeJson: string | undefined,
  ): boolean {
    const now = this.#now().toISOString();
    const safeEnvelope = safeEnvelopeJson === undefined
      ? undefined
      : captureEnvelopeSchema.parse(JSON.parse(safeEnvelopeJson));
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      if (this.hasActiveDeletion()) {
        throw new Error(
          "Canonical ingestion is blocked by an active deletion.",
        );
      }
      if (
        this.#captureEnvelopeDeletionBlocked(item.envelope) ||
        (safeEnvelope !== undefined && this.#captureEnvelopeDeletionBlocked(safeEnvelope)) ||
        this.deletionIdentityBlocked(
          "deduplication",
          deduplicationKey,
        )
      ) {
        this.#database.exec("ROLLBACK;");
        return false;
      }
      this.#insertParserError(
        item.queueItemId,
        deduplicationKey,
        errorKind,
        message,
        safeEnvelopeJson,
        now,
      );
      this.#recordQueueProcessing(
        item,
        deduplicationKey,
        "rejected",
        now,
        message,
      );
      this.#database.exec("COMMIT;");
      return true;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #insertParserError(
    queueItemId: string,
    deduplicationKey: string,
    errorKind: string,
    message: string,
    safeEnvelopeJson: string | undefined,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO parser_errors (
           queue_item_id,
           deduplication_key,
           error_kind,
           message,
           safe_envelope_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        queueItemId,
        deduplicationKey,
        errorKind,
        sanitizeDiagnostic(message),
        optionalText(safeEnvelopeJson),
        createdAt,
      );
  }

  #recordQueueProcessing(
    item: CaptureQueueItem,
    deduplicationKey: string,
    status: string,
    processedAt: string,
    lastError?: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO queue_processing (
           queue_item_id,
           deduplication_key,
           status,
           attempt_count,
           failure_count,
           last_error,
           processed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(queue_item_id) DO UPDATE SET
           deduplication_key = excluded.deduplication_key,
           status = excluded.status,
           attempt_count = excluded.attempt_count,
           failure_count = excluded.failure_count,
           last_error = excluded.last_error,
           processed_at = excluded.processed_at`,
      )
      .run(
        item.queueItemId,
        deduplicationKey,
        status,
        item.attemptCount,
        item.failureCount,
        optionalText(lastError),
        processedAt,
      );
  }

  #applyMigrations(
    migrations: readonly SqliteMigration[],
  ): void {
    const latestVersion =
      migrations.at(-1)?.version ?? 0;
    // Validate current stores under a read snapshot. Only real migrations need
    // the writer lock; they recheck the version after acquiring it below.
    this.#database.exec("BEGIN;");
    try {
      this.#assertNoRestoreBarrier();
      const currentVersion = asNumber(this.#database.prepare("PRAGMA user_version;").get()?.user_version);
      if (currentVersion > latestVersion) {
        throw new UnsupportedDatabaseVersionError(currentVersion, latestVersion);
      }
      if (currentVersion === latestVersion) {
        CanonicalSqliteStore.#assertCanonicalSchema(this.#database, latestVersion, migrations);
        this.#database.exec("COMMIT;");
        return;
      }
      if (currentVersion > 0 && !this.#allowSchemaMigration) {
        throw new CanonicalMigrationRequiredError(currentVersion, latestVersion);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#assertNoRestoreBarrier();
      const currentVersionRow = this.#database
        .prepare("PRAGMA user_version;")
        .get() as Readonly<Record<string, unknown>>;
      const currentVersion = asNumber(
        currentVersionRow.user_version,
      );
      if (currentVersion > latestVersion) {
        throw new UnsupportedDatabaseVersionError(
          currentVersion,
          latestVersion,
        );
      }
      if (
        currentVersion > 0 && currentVersion < latestVersion &&
        !this.#allowSchemaMigration
      ) {
        throw new CanonicalMigrationRequiredError(currentVersion, latestVersion);
      }
      for (const migration of migrations) {
        if (migration.version <= currentVersion) {
          continue;
        }
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            `INSERT INTO schema_migrations(version, applied_at)
             VALUES (?, ?)`,
          )
          .run(migration.version, this.#now().toISOString());
        this.#database.exec(
          `PRAGMA user_version = ${migration.version};`,
        );
      }
      CanonicalSqliteStore.#assertCanonicalSchema(
        this.#database,
        latestVersion,
        migrations,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  #validateMigrations(
    migrations: readonly SqliteMigration[],
  ): void {
    if (
      migrations.length === 0 ||
      migrations.some(
        (migration, index) => migration.version !== index + 1,
      )
    ) {
      throw new InvalidMigrationPlanError();
    }
  }

  static #assertCanonicalSchema(
    database: DatabaseSync,
    expectedVersion: number,
    migrations: readonly SqliteMigration[],
  ): void {
    try {
      const applicableMigrations = migrations.filter(
        (migration) => migration.version <= expectedVersion,
      );
      const migrationRows = database
        .prepare(
          `SELECT version
             FROM schema_migrations
            ORDER BY version`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const migrationVersions = migrationRows.map((row) =>
        asNumber(row.version),
      );
      const expectedMigrations = Array.from(
        {
          length: expectedVersion,
        },
        (_value, index) => index + 1,
      );
      if (
        JSON.stringify(migrationVersions) !==
        JSON.stringify(expectedMigrations)
      ) {
        throw new InvalidCanonicalSchemaError(
          "SQLite migration ledger is incomplete.",
        );
      }

      const requiredTables = [
        ...(expectedVersion >= 16 ? ["record_reset"] : []),
        ...(expectedVersion >= 8 ? ["raw_event_enrichments"] : []),
        ...(expectedVersion >= 2 ? ["branch_contexts"] : []),
        ...(expectedVersion >= 3 ? ["knowledge_candidates"] : []),
        ...(expectedVersion >= 4 ? ["context_use_records"] : []),
        ...(expectedVersion >= 5 ? ["session_mutes"] : []),
        ...(expectedVersion >= 6
          ? [
              "correction_keys",
              "correction_opportunities",
            ]
          : []),
        ...(expectedVersion >= 7
          ? [
              "correction_key_sources",
            ]
          : []),
        "deletion_operations",
        "evaluation_runs",
        "evidence_links",
        "feedback_events",
        "identities",
        "metrics",
        "parser_errors",
        "process_claims",
        "queue_processing",
        "raw_events",
        "schema_migrations",
        "work_episodes",
      ];
      const tableRows = database
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const tables = new Set(
        tableRows.map((row) => String(row.name)),
      );
      const missingTable = requiredTables.find(
        (table) => !tables.has(table),
      );
      if (missingTable !== undefined) {
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical table ${missingTable} is missing.`,
        );
      }
      const tableList = database
        .prepare("PRAGMA table_list;")
        .all() as readonly Readonly<Record<string, unknown>>[];
      const strictTables = new Set(
        tableList
          .filter((row) => asNumber(row.strict) === 1)
          .map((row) => String(row.name)),
      );
      const nonStrictTable = requiredTables.find(
        (table) => !strictTables.has(table),
      );
      if (nonStrictTable !== undefined) {
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical table ${nonStrictTable} is not STRICT.`,
        );
      }
      for (const table of requiredTables) {
        const foreignKeys = database
          .prepare(
            `PRAGMA foreign_key_list(${sqliteIdentifier(table)});`,
          )
          .all();
        if (foreignKeys.length > 0) {
          throw new InvalidCanonicalSchemaError(
            `SQLite canonical table ${table} has undeclared foreign keys.`,
          );
        }
      }
      const declaredObjectRows = database
        .prepare(
          `SELECT name, sql, type
             FROM sqlite_master
            WHERE sql IS NOT NULL
              AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      const declaredObjectSql = new Map(
        declaredObjectRows.map((row) => [
          `${String(row.type)}:${String(row.name)}`,
          normalizeSchemaSql(row.sql),
        ]),
      );
      const expectedObjectSql =
        createExpectedCanonicalObjectSql(applicableMigrations);
      if (declaredObjectSql.size !== expectedObjectSql.size) {
        throw new InvalidCanonicalSchemaError(
          "SQLite canonical schema contains undeclared objects.",
        );
      }
      for (const [key, expectedSql] of expectedObjectSql) {
        if (declaredObjectSql.get(key) !== expectedSql) {
          throw new InvalidCanonicalSchemaError(
            `SQLite canonical object ${key} does not match the declared schema.`,
          );
        }
      }
      const behaviorObjects = database
        .prepare(
          `SELECT name, type
             FROM sqlite_master
            WHERE type IN ('trigger', 'view')`,
        )
        .all() as readonly Readonly<Record<string, unknown>>[];
      if (behaviorObjects.length > 0) {
        const object = behaviorObjects[0];
        throw new InvalidCanonicalSchemaError(
          `SQLite canonical schema contains undeclared ${String(object?.type)} ${String(object?.name)}.`,
        );
      }

      for (const [table, expectedColumns] of Object.entries(
        RUNTIME_SCHEMA_COLUMNS,
      )) {
        if (
          (table === "raw_event_enrichments" && expectedVersion < 8) ||
          (table === "branch_contexts" && expectedVersion < 2) ||
          (
            table === "knowledge_candidates" &&
            expectedVersion < 3
          ) ||
          (
            table === "context_use_records" &&
            expectedVersion < 4
          ) ||
          (
            table === "session_mutes" &&
            expectedVersion < 5
          ) ||
          (
            (
              table === "correction_keys" ||
              table === "correction_opportunities"
            ) &&
            expectedVersion < 6
          ) ||
          (
            table === "correction_key_sources" &&
            expectedVersion < 7
          )
        ) {
          continue;
        }
        CanonicalSqliteStore.#assertTableColumns(
          database,
          table,
          expectedColumns.filter(([name]) =>
            !(table === "feedback_events" && expectedVersion < 9 && name === "replacement_json") &&
            !(table === "context_use_records" && expectedVersion < 10 && name === "updated_at"),
          ),
        );
      }
      for (const [table, expectedIndexes] of Object.entries(
        RUNTIME_SCHEMA_INDEXES,
      )) {
        if (
          (table === "raw_event_enrichments" && expectedVersion < 8) ||
          (table === "branch_contexts" && expectedVersion < 2) ||
          (
            table === "knowledge_candidates" &&
            expectedVersion < 3
          ) ||
          (
            table === "context_use_records" &&
            expectedVersion < 4
          ) ||
          (
            table === "session_mutes" &&
            expectedVersion < 5
          ) ||
          (
            (
              table === "correction_keys" ||
              table === "correction_opportunities"
            ) &&
            expectedVersion < 6
          ) ||
          (
            table === "correction_key_sources" &&
            expectedVersion < 7
          )
        ) {
          continue;
        }
        const versionedIndexes = expectedIndexes.filter(
                (index) =>
                  !(
                    "name" in index &&
                    (
                      (expectedVersion < 7 && (
                        index.name === "context_use_episode" ||
                        index.name === "feedback_events_target" ||
                        index.name === "raw_events_event_id"
                      )) ||
                      (expectedVersion < 8 && (
                        index.name === "raw_events_time" ||
                        index.name === "context_use_time"
                      )) ||
                      (expectedVersion < 12 && (
                        index.name === "raw_events_learning_context" ||
                        index.name === "raw_events_learning_prompts"
                      )) ||
                      (expectedVersion < 14 && index.name === "raw_events_learning_agents") ||
                      (expectedVersion < 21 && ["raw_events_session_type", "raw_events_operation", "raw_events_counterevidence"].includes(index.name)) ||
                      (expectedVersion < 22 && ["context_use_retrieval_mode", "knowledge_discovery_metadata"].includes(index.name)) ||
                      (expectedVersion < 10 && (
                        index.name === "raw_events_observed" ||
                        index.name === "context_use_observed"
                      ))
                    )
                  ),
              );
        CanonicalSqliteStore.#assertIndexAllowlist(
          database,
          table,
          versionedIndexes,
        );
      }
    } catch (error) {
      if (error instanceof InvalidCanonicalSchemaError) {
        throw error;
      }
      throw new InvalidCanonicalSchemaError(
        "SQLite canonical schema validation failed.",
        {
          cause: error,
        },
      );
    }
  }

  static #assertTableColumns(
    database: DatabaseSync,
    table: string,
    expectedColumns: readonly [
      string,
      ExpectedSqliteColumn["type"],
      boolean,
      boolean,
    ][],
  ): void {
    const rows = database
      .prepare(`PRAGMA table_xinfo(${sqliteIdentifier(table)});`)
      .all() as readonly Readonly<Record<string, unknown>>[];
    if (rows.length !== expectedColumns.length) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} has an unexpected column count.`,
      );
    }
    expectedColumns.forEach(
      ([name, type, notNull, primaryKey], index) => {
        const row = rows[index];
        if (
          row === undefined ||
          String(row.name) !== name ||
          String(row.type).toUpperCase() !== type ||
          Boolean(asNumber(row.notnull)) !== notNull ||
          Boolean(asNumber(row.pk)) !== primaryKey ||
          asNumber(row.hidden) !== 0
        ) {
          throw new InvalidCanonicalSchemaError(
            `SQLite table ${table} column ${name} is incompatible.`,
          );
        }
      },
    );
  }

  static #assertIndexAllowlist(
    database: DatabaseSync,
    table: string,
    expectedIndexes: readonly ExpectedSqliteIndex[],
  ): void {
    const indexes = database
      .prepare(`PRAGMA index_list(${sqliteIdentifier(table)});`)
      .all() as readonly Readonly<Record<string, unknown>>[];
    if (indexes.length !== expectedIndexes.length) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} has undeclared indexes.`,
      );
    }
    const unmatched = [
      ...expectedIndexes,
    ];
    for (const index of indexes) {
      const name = String(index.name);
      const columns = database
        .prepare(`PRAGMA index_xinfo(${sqliteIdentifier(name)});`)
        .all() as readonly Readonly<Record<string, unknown>>[];
      const keyColumns = columns.filter(
        (column) => asNumber(column.key) === 1,
      );
      const actualColumns = keyColumns.map((column) =>
        String(column.name),
      );
      const matchIndex = unmatched.findIndex(
        (expected) =>
          asNumber(index.partial) === Number(expected.partial ?? false) &&
          expected.origin === String(index.origin) &&
          (
            expected.unique ?? true
          ) === (asNumber(index.unique) === 1) &&
          (
            expected.name === undefined ||
            expected.name === name
          ) &&
          JSON.stringify(expected.columns) ===
            JSON.stringify(actualColumns) &&
        keyColumns.every(
          (column) =>
            asNumber(column.desc) === 0 &&
            String(column.coll).toUpperCase() === "BINARY",
        ),
      );
      if (matchIndex === -1) {
        throw new InvalidCanonicalSchemaError(
          `SQLite table ${table} index ${name} is undeclared.`,
        );
      }
      unmatched.splice(matchIndex, 1);
    }
    if (unmatched.length > 0) {
      throw new InvalidCanonicalSchemaError(
        `SQLite table ${table} is missing declared indexes.`,
      );
    }
  }

  static #assertRestorableBackup(
    database: DatabaseSync,
    migrations: readonly SqliteMigration[],
  ): void {
    const latestVersion = migrations.at(-1)?.version ?? 0;
    const versionRow = database
      .prepare("PRAGMA user_version;")
      .get() as Readonly<Record<string, unknown>>;
    const version = asNumber(versionRow.user_version);
    if (version === 0 || version > latestVersion) {
      throw new InvalidCanonicalSchemaError(
        `SQLite backup version ${version} is not the current canonical version ${latestVersion}.`,
      );
    }
    CanonicalSqliteStore.#assertCanonicalSchema(
      database,
      version,
      migrations,
    );
  }

  static #ignoreMissing(error: unknown): void {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  static async #removeDatabaseFiles(path: string): Promise<void> {
    await Promise.all(
      [
        path,
        `${path}.deletion.key`,
        `${path}.manifest.json`,
        `${path}-shm`,
        `${path}-wal`,
      ].map((file) =>
        unlink(file).catch(CanonicalSqliteStore.#ignoreMissing),
      ),
    );
  }
}
