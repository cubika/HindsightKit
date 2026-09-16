import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type CorrectionKey,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import {
  CanonicalKnowledgeRetriever,
  knowledgeProjectionFromCandidate,
  type KnowledgeBackend,
  type KnowledgeRecord,
} from "@provenloop/retrieval";
import { proofEnvelopes, verificationFixture } from "./domain-proof-fixture.js";

const candidate = (
  sourceEvidenceIds: readonly string[],
): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "package validation",
  ],
  conflictsWith: [],
  content: "Run the targeted Vitest command.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  evidenceMarks: [
    "externally_verified",
  ],
  evidenceTier: "externally_verified",
  importance: 1,
  kind: "procedural",
  knowledgeId: "knowledge-package-validation",
  nonApplicability: [],
  scope: "repository",
  scopeId: "repo-1",
  sourceEpisodeIds: [
    "episode-1",
  ],
  sourceEvidenceIds: [
    ...sourceEvidenceIds,
  ],
  state: "active",
  topicKey: "testing:test-runner:package-validation",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-09-01T00:00:00.000Z",
});

const correctionKey = (
  verificationEvidenceIds: readonly string[],
): CorrectionKey => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  correctionKeyId: "correction-package-validation",
  createdAt: "2026-09-01T00:00:00.000Z",
  expectedBehavior: "Run the targeted Vitest command.",
  scope: "repository",
  scopeId: "repo-1",
  sourceCorrectionEventIds: [
    correctionEnvelope.event.eventId,
  ],
  subsystem: "test-runner",
  taskFamily: "testing",
  trigger: "package validation",
  verificationEvidenceIds: [
    ...verificationEvidenceIds,
  ],
  violatedConstraint:
    "Inspect package scripts before choosing a test runner.",
});

const envelope = (
  sourceEventId: string,
  timestamp: string,
  eventType: string,
  trust: "tool" | "user",
  completionStatus?: "succeeded",
): CaptureEnvelope =>
  createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: "feat/testing",
    ...(completionStatus === undefined
      ? {}
      : {
          completionStatus,
        }),
    eventType,
    repoId: "repo-1",
    sessionId: "session-1",
    sourceEventId,
    timestamp,
    trust,
    worktree: "C:\\repo",
  });

const correctionEnvelope = envelope(
  "event-correction",
  "2026-09-01T00:00:00.000Z",
  "user.corrected",
  "user",
);
const verificationEnvelope = envelope(
  "event-verification",
  "2026-09-01T00:10:00.000Z",
  "test.completed",
  "tool",
  "succeeded",
);
const episode: WorkEpisode = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [
    correctionEnvelope.event.eventId,
  ],
  episodeId: "episode-1",
  finishedAt: "2026-09-01T00:10:00.000Z",
  goal: "Run package validation",
  issueIds: [],
  outcome: "success",
  outcomeEvidenceIds: [
    verificationEnvelope.event.eventId,
  ],
  outcomeQualification: "qualified",
  outcomeQualifiedAt: "2026-09-01T00:10:00.000Z",
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    "session-1",
  ],
  sourceEventIds: [
    correctionEnvelope.event.eventId,
    verificationEnvelope.event.eventId,
    verificationFixture(
      correctionEnvelope,
      verificationEnvelope,
    ).operation.event.eventId,
  ],
  startedAt: "2026-09-01T00:00:00.000Z",
};

const backendFor = (
  knowledge: KnowledgeCandidate,
): KnowledgeBackend => {
  const projection = knowledgeProjectionFromCandidate(knowledge);
  const record: KnowledgeRecord = {
    ...projection,
    score: 1,
  };
  return {
    get: async () => record,
    health: async () => ({
      fts5Available: true,
      quickCheck: "ok",
      recordCount: 1,
      status: "healthy",
    }),
    index: async () => undefined,
    rebuild: async () => undefined,
    remove: async () => undefined,
    search: async () => [
      record,
    ],
  };
};

describe("CanonicalKnowledgeRetriever correction admission", () => {
  it("rejects correction-based Knowledge until its key is verified", async () => {
    const knowledge = candidate([
      correctionEnvelope.event.eventId,
      verificationEnvelope.event.eventId,
      verificationFixture(
        correctionEnvelope,
        verificationEnvelope,
      ).operation.event.eventId,
    ]);
    let keys: readonly CorrectionKey[] = [];
    const retriever = new CanonicalKnowledgeRetriever({
      backend: backendFor(knowledge),
      store: {
        knowledgeAdmissionEvidence: () => ({
          contextUseRecords: [],
          correctionKeys: keys,
          correctionSourceEventIds: new Set([
            correctionEnvelope.event.eventId,
          ]),
          envelopes: proofEnvelopes([
            correctionEnvelope,
            verificationEnvelope,
          ], [[correctionEnvelope, verificationEnvelope]]),
          feedbackEvents: [],
          workEpisodes: [
            episode,
          ],
        }),
        knowledgeCandidates: () => [
          knowledge,
        ],
        knowledgeCandidatesWithUnavailableSources: () => new Set(),
      },
    });
    const query = {
      limit: 3,
      repositoryScopeId: "repo-1",
      text: "package validation",
    };

    await expect(retriever.search(query)).resolves.toEqual([]);

    keys = [
      correctionKey([]),
    ];
    await expect(retriever.search(query)).resolves.toEqual([]);

    keys = [
      correctionKey([
        verificationEnvelope.event.eventId,
      ]),
    ];
    await expect(retriever.search(query)).resolves.toMatchObject([
      {
        candidate: knowledge,
        score: 1,
      },
    ]);
  });

  it("does not affect Knowledge without correction sources", async () => {
    const knowledge = candidate([
      "event-independent-evidence",
    ]);
    const retriever = new CanonicalKnowledgeRetriever({
      backend: backendFor(knowledge),
      store: {
        knowledgeAdmissionEvidence: () => ({
          contextUseRecords: [],
          correctionKeys: [
            correctionKey([]),
          ],
          correctionSourceEventIds: new Set([
            correctionEnvelope.event.eventId,
          ]),
          envelopes: [],
          feedbackEvents: [],
          workEpisodes: [],
        }),
        knowledgeCandidates: () => [
          knowledge,
        ],
        knowledgeCandidatesWithUnavailableSources: () => new Set(),
      },
    });

    await expect(
      retriever.search({
        limit: 3,
        repositoryScopeId: "repo-1",
        text: "package validation",
      }),
    ).resolves.toHaveLength(1);
  });
});
