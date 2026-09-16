import { describe, expect, it } from "vitest";

import {
  adapterCapabilitySchema,
  branchContextSchema,
  contextUseRecordSchema,
  correctionKeySchema,
  correctionOpportunitySchema,
  CURRENT_SCHEMA_VERSION,
  deletionOperationSchema,
  EVALUATION_EXIT_CODES,
  episodeAssociationSchema,
  episodeGroupingCorrectionSchema,
  evidenceLedgerEntrySchema,
  feedbackEventSchema,
  gateResultSchema,
  knowledgeCandidateSchema,
  outcomeEvidenceLinkSchema,
  processClaimSchema,
  PROVENLOOP_CAPABILITIES,
  provenLoopCapabilitySchema,
  rawEventSchema,
  replaySpecSchema,
  requirementManifestSchema,
  workEpisodeSchema,
} from "@provenloop/contracts";

interface RuntimeSchema {
  safeParse(input: unknown): {
    readonly success: boolean;
  };
}

const timestamp = "2026-08-29T00:00:00.000Z";

const validCases: readonly {
  readonly input: unknown;
  readonly name: string;
  readonly schema: RuntimeSchema;
}[] = [
  {
    name: "AdapterCapability",
    schema: adapterCapabilitySchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      captureTransport: "extension-session-events",
      sessionFileParser: "events-jsonl-v1",
      sessionFileVersions: [
        1,
      ],
      sourceEventTypes: [
        "user.message",
      ],
      status: "supported",
    },
  },
  {
    name: "RawEvent",
    schema: rawEventSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      eventId: "event-1",
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      timestamp,
      trust: "user",
    },
  },
  {
    name: "WorkEpisode",
    schema: workEpisodeSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      episodeId: "episode-1",
      goal: "Create contracts.",
      branches: [
        "feat/batch1-contracts",
      ],
      sessionIds: [
        "session-1",
      ],
      commitIds: [],
      pullRequestIds: [],
      issueIds: [],
      startedAt: timestamp,
      outcome: "unknown",
      outcomeQualification: "open",
      outcomeEvidenceIds: [],
      correctionEventIds: [],
      associationConfidence: 0.9,
      associationEvidenceIds: [
        "association-evidence-1",
      ],
      sourceEventIds: [
        "event-1",
      ],
    },
  },
  {
    name: "DeletionOperation",
    schema: deletionOperationSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      attemptCount: 1,
      deletionId: "deletion-1",
      targetType: "source",
      targetDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      status: "completed",
      requestedAt: timestamp,
      completedAt: timestamp,
      deletedSourceCount: 1,
      deletedDependentCount: 2,
      deletedQueueItemCount: 1,
      gateDigest:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      propagationEvidenceId: "deletion-1:propagation:abcdef0123456789",
      tombstoneKeyVerifier: "1".repeat(64),
    },
  },
  {
    name: "EpisodeAssociation",
    schema: episodeAssociationSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      associationId: "association-1",
      leftSessionId: "session-1",
      rightSessionId: "session-2",
      status: "associated",
      confidence: 0.95,
      createdAt: timestamp,
      evidence: [
        {
          evidenceId: "association-evidence-1",
          signal: "branch",
          sourceEventIds: [
            "event-1",
            "event-2",
          ],
          weight: 0.75,
          detail: "Both Sessions used branch feature/contracts.",
        },
      ],
      correctionIds: [],
    },
  },
  {
    name: "EpisodeGroupingCorrection",
    schema: episodeGroupingCorrectionSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      correctionId: "correction-1",
      action: "split",
      sessionIds: [
        "session-1",
        "session-2",
      ],
      reason: "The Sessions addressed different incidents.",
      timestamp,
    },
  },
  {
    name: "BranchContext",
    schema: branchContextSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      branchContextId: "branch-context-1",
      repoId: "repo-1",
      branch: "feat/batch1-contracts",
      headSha: "abc123",
      acceptedDecisions: [],
      explicitConstraints: [],
      implementationState: [
        "Shared schemas are in progress.",
      ],
      unfinishedItems: [],
      recentVerificationEvidenceIds: [],
      sourceEpisodeIds: [
        "episode-1",
      ],
      sourceEventIds: [
        "event-1",
      ],
      updatedAt: timestamp,
    },
  },
  {
    name: "CorrectionKey",
    schema: correctionKeySchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      correctionKeyId: "correction-key-1",
      scope: "repository",
      scopeId: "repo-1",
      violatedConstraint: "Used the wrong test runner.",
      expectedBehavior: "Inspect package scripts before selecting a runner.",
      trigger: "Run repository tests.",
      sourceCorrectionEventIds: [
        "event-1",
      ],
      verificationEvidenceIds: [
        "evidence-1",
      ],
      createdAt: timestamp,
    },
  },
  {
    name: "OutcomeEvidenceLink",
    schema: outcomeEvidenceLinkSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      linkId: "link-1",
      episodeId: "episode-1",
      evidenceId: "evidence-1",
      kind: "test",
      strength: "direct",
      supportingEvidenceIds: [],
      state: "accepted",
      createdAt: timestamp,
    },
  },
  {
    name: "KnowledgeCandidate",
    schema: knowledgeCandidateSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      knowledgeId: "knowledge-1",
      topicKey: "repository-test-runner",
      kind: "procedural",
      scope: "repository",
      scopeId: "repo-1",
      content: "Use the package test script.",
      appliesWhen: [
        "Running repository tests.",
      ],
      nonApplicability: [],
      sourceEpisodeIds: [
        "episode-1",
      ],
      sourceEvidenceIds: [
        "evidence-1",
      ],
      evidenceMarks: [
        "externally_verified",
      ],
      evidenceTier: "externally_verified",
      importance: 1,
      utility: {
        applied: 0,
        helpful: 0,
        harmful: 0,
      },
      coverage: {
        applicableOpportunities: 0,
        observedOutcomes: 0,
      },
      state: "candidate",
      conflictsWith: [],
      createdAt: timestamp,
    },
  },
  {
    name: "FeedbackEvent",
    schema: feedbackEventSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      feedbackId: "feedback-1",
      targetType: "knowledge",
      targetId: "knowledge-1",
      kind: "confirm",
      source: "user",
      evidenceRef: "evidence-1",
      timestamp,
    },
  },
  {
    name: "ProcessClaim",
    schema: processClaimSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      claimId: "claim-1",
      episodeId: "episode-1",
      kind: "tested",
      requiredParticipantIds: [],
      availabilityEvidenceIds: [],
      invocationIds: [
        "invocation-1",
      ],
      requiredEvidence: [
        "command.succeeded",
      ],
      evidenceIds: [
        "evidence-1",
      ],
      status: "verified",
      createdAt: timestamp,
      verifiedAt: timestamp,
    },
  },
  {
    name: "ContextUseRecord",
    schema: contextUseRecordSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
      candidateKnowledgeIds: [
        "knowledge-1",
      ],
      returnedKnowledgeIds: [
        "knowledge-1",
      ],
      appliedKnowledgeIds: [],
      renderedTokens: 42,
      latencyMs: 5,
      createdAt: timestamp,
    },
  },
  {
    name: "CorrectionOpportunity",
    schema: correctionOpportunitySchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      opportunityId: "opportunity-1",
      correctionKeyId: "correction-key-1",
      episodeId: "episode-1",
      applicable: true,
      knowledgeAvailableBeforeCorrection: true,
      knowledgeAppliedBeforeCorrection: false,
      correctionRepeated: false,
      outcomeKnown: false,
      createdAt: timestamp,
    },
  },
  {
    name: "RequirementManifest",
    schema: requirementManifestSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      requirementId: "PROCESS-CLAIM-001",
      milestone: "M0",
      statement: "Completion claims require invocation evidence.",
      scope: "workflow",
      replaySpecIds: [
        "spec-1",
      ],
      verifierIds: [
        "claim-execution-consistency",
      ],
      requiredEvidence: [
        "invocation completion",
      ],
      releaseGate: "hard",
    },
  },
  {
    name: "ReplaySpec",
    schema: replaySpecSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      specId: "spec-1",
      requirementId: "PROCESS-CLAIM-001",
      inputEvents: [
        "fixture://events.jsonl",
      ],
      frozenEnvironment: "local-fixture-v1",
      expectedGate: "fail",
      expectedEvidence: [
        "claim.declared",
      ],
    },
  },
  {
    name: "EvidenceLedgerEntry",
    schema: evidenceLedgerEntrySchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ledgerEntryId: "ledger-entry-1",
      runId: "run-1",
      eventId: "event-1",
      actorId: "actor-1",
      status: "observed",
      timestamp,
    },
  },
  {
    name: "GateResult",
    schema: gateResultSchema,
    input: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      gateId: "gate-1",
      status: "pass",
      evidenceIds: [
        "ledger-entry-1",
      ],
      message: "Required evidence is present.",
    },
  },
];

describe.each(validCases)("$name schema", ({ input, schema }) => {
  it("accepts a valid version 1 value", () => {
    expect(schema.safeParse(input).success).toBe(true);
  });
});

describe("evaluation exit codes", () => {
  it("matches the frozen public contract", () => {
    expect(EVALUATION_EXIT_CODES).toEqual({
      gatesPassed: 0,
      gateFailed: 1,
      invalidInput: 2,
      infrastructureError: 3,
    });
  });

  describe("adapter lifecycle contract", () => {
    it("freezes the operational capability names", () => {
      expect(PROVENLOOP_CAPABILITIES).toEqual([
        "capture",
        "worker",
        "retrieval",
        "correction_learning",
        "outcome_learning",
        "retrospective",
        "playbook",
        "external_research",
      ]);
      expect(provenLoopCapabilitySchema.safeParse("capture").success).toBe(
        true,
      );
      expect(provenLoopCapabilitySchema.safeParse("unknown").success).toBe(
        false,
      );
    });
  });
});
