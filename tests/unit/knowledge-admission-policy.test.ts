import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type ContextUseRecord,
  type CorrectionKey,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  KnowledgeAdmissionPolicy,
} from "@provenloop/domain";
import { proofEnvelopes, verificationFixture } from "./domain-proof-fixture.js";

const envelope = (
  sourceEventId: string,
  timestamp: string,
  eventType: string,
  trust: "model" | "system" | "tool" | "user",
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

const correction = envelope(
  "event-correction",
  "2026-09-01T00:00:00.000Z",
  "user.corrected",
  "user",
);

const verification = (
  trust: "model" | "system" | "tool" | "user" = "tool",
): CaptureEnvelope =>
  envelope(
    "event-verification",
    "2026-09-01T00:10:00.000Z",
    "test.completed",
    trust,
    "succeeded",
  );

const key = (): CorrectionKey => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  correctionKeyId: "correction-package-validation",
  createdAt: correction.event.timestamp,
  expectedBehavior: "Run the targeted Vitest command.",
  scope: "repository",
  scopeId: "repo-1",
  sourceCorrectionEventIds: [
    correction.event.eventId,
  ],
  subsystem: "test-runner",
  taskFamily: "testing",
  trigger: "package validation",
  verificationEvidenceIds: [
    verification().event.eventId,
  ],
  violatedConstraint:
    "Inspect package scripts before choosing a test runner.",
});

const candidate = (
  input: {
    readonly scope?: KnowledgeCandidate["scope"];
    readonly scopeId?: string;
    readonly sourceEpisodeIds?: readonly string[];
    readonly sourceEvidenceIds?: readonly string[];
  } = {},
): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "package validation",
    "Task Family: testing",
  ],
  conflictsWith: [
    "knowledge-conflict",
  ],
  content: "Run the targeted Vitest command.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: correction.event.timestamp,
  evidenceMarks: [
    "externally_verified",
  ],
  evidenceTier: "externally_verified",
  importance: 1,
  kind: "procedural",
  knowledgeId: "knowledge-package-validation",
  nonApplicability: [
    "The repository explicitly uses Jest.",
  ],
  scope: input.scope ?? "repository",
  ...(input.scopeId === undefined &&
  (input.scope ?? "repository") === "personal"
    ? {}
    : {
        scopeId: input.scopeId ?? "repo-1",
      }),
  sourceEpisodeIds: [
    ...(input.sourceEpisodeIds ?? [
      "episode-1",
    ]),
  ],
  sourceEvidenceIds: [
    ...(
      input.sourceEvidenceIds ?? [
        correction.event.eventId,
        verification().event.eventId,
        verificationFixture(correction, verification()).operation.event.eventId,
      ]
    ),
  ],
  state: "active",
  supersedes: "knowledge-previous",
  topicKey: "testing:test-runner:package-validation",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: verification().event.timestamp,
});

const episode = (
  verificationEvent: CaptureEnvelope = verification(),
): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [
    correction.event.eventId,
  ],
  episodeId: "episode-1",
  finishedAt: verificationEvent.event.timestamp,
  goal: "Run package validation",
  issueIds: [],
  outcome: "success",
  outcomeEvidenceIds: [
    verificationEvent.event.eventId,
  ],
  outcomeQualification: "qualified",
  outcomeQualifiedAt: verificationEvent.event.timestamp,
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    "session-1",
  ],
  sourceEventIds: [
    correction.event.eventId,
    verificationEvent.event.eventId,
  ],
  startedAt: correction.event.timestamp,
});

const evaluate = (input: {
  readonly candidate?: KnowledgeCandidate;
  readonly contextUseRecords?: readonly ContextUseRecord[];
  readonly feedbackEvents?: readonly FeedbackEvent[];
  readonly verificationEvent?: CaptureEnvelope;
  readonly workEpisodes?: readonly WorkEpisode[];
}) => {
  const verificationEvent = input.verificationEvent ?? verification();
  return new KnowledgeAdmissionPolicy().evaluate({
    candidate: input.candidate ?? candidate(),
    contextUseRecords: input.contextUseRecords ?? [],
    correctionKeys: [
      key(),
    ],
    correctionSourceEventIds: new Set([
      correction.event.eventId,
    ]),
    envelopes: proofEnvelopes([
      correction,
      verificationEvent,
    ], [[correction, verificationEvent]]),
    feedbackEvents: input.feedbackEvents ?? [],
    workEpisodes: input.workEpisodes ?? [
      episode(verificationEvent),
    ],
  });
};

describe("KnowledgeAdmissionPolicy", () => {
  it("admits deterministic evidence and preserves applicability and proof", () => {
    const knowledge = candidate();
    const result = evaluate({
      candidate: knowledge,
    });

    expect(result).toMatchObject({
      admitted: true,
      applicability: {
        appliesWhen: knowledge.appliesWhen,
        nonApplicability: knowledge.nonApplicability,
        scope: "repository",
        scopeId: "repo-1",
      },
      conflictsWith: knowledge.conflictsWith,
      proofChain: {
        correctionKeyIds: [
          "correction-package-validation",
        ],
        sourceEpisodeIds: knowledge.sourceEpisodeIds,
        sourceEvidenceIds: knowledge.sourceEvidenceIds,
      },
      reasons: [],
      supersedes: "knowledge-previous",
    });
  });

  it("rejects model or user self-assessment as verification evidence", () => {
    for (const trust of [
      "model",
      "user",
    ] as const) {
      const result = evaluate({
        verificationEvent: verification(trust),
      });

      expect(result.admitted).toBe(false);
      expect(result.reasons).toContain(
        "untrusted_verification_evidence",
      );
    }
  });

  it("rejects unpaired verification evidence", () => {
    const result = evaluate({
      workEpisodes: [],
    });

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain(
      "unpaired_verification_evidence",
    );
  });

  it("requires verification to be strictly later than correction", () => {
    const simultaneous = envelope(
      "event-verification-simultaneous",
      correction.event.timestamp,
      "test.completed",
      "tool",
      "succeeded",
    );
    const simultaneousKey: CorrectionKey = {
      ...key(),
      verificationEvidenceIds: [
        simultaneous.event.eventId,
      ],
    };
    const knowledge = candidate({
      sourceEvidenceIds: [
        correction.event.eventId,
        simultaneous.event.eventId,
      ],
    });
    const result = new KnowledgeAdmissionPolicy().evaluate({
      candidate: knowledge,
      contextUseRecords: [],
      correctionKeys: [
        simultaneousKey,
      ],
      correctionSourceEventIds: new Set([
        correction.event.eventId,
      ]),
      envelopes: [
        correction,
        simultaneous,
      ],
      feedbackEvents: [],
      workEpisodes: [
        episode(simultaneous),
      ],
    });

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain(
      "unpaired_verification_evidence",
    );
  });

  it("rejects verification after the same Knowledge was recalled", () => {
    const recalled: ContextUseRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [
        "knowledge:knowledge-package-validation",
      ],
      candidateKnowledgeIds: [],
      createdAt: "2026-09-01T00:05:00.000Z",
      episodeId: "episode-1",
      latencyMs: 1,
      renderedTokens: 10,
      requestId: "context-use-1",
      returnedKnowledgeIds: [
        "knowledge-package-validation",
      ],
      sessionId: "session-1",
    };
    const result = evaluate({
      contextUseRecords: [
        recalled,
      ],
    });

    expect(result.admitted).toBe(false);
    expect(result.reasons).toContain(
      "recalled_knowledge_evidence",
    );
  });

  it("starts the recall window at the paired Episode correction", () => {
    const laterCorrection = envelope(
      "event-correction-later",
      "2026-09-02T00:10:00.000Z",
      "user.corrected",
      "user",
    );
    const laterVerification = envelope(
      "event-verification-later",
      "2026-09-02T00:20:00.000Z",
      "test.completed",
      "tool",
      "succeeded",
    );
    const repeatedKey: CorrectionKey = {
      ...key(),
      sourceCorrectionEventIds: [
        correction.event.eventId,
        laterCorrection.event.eventId,
      ],
      verificationEvidenceIds: [
        verification().event.eventId,
        laterVerification.event.eventId,
      ],
    };
    const knowledge = candidate({
      sourceEpisodeIds: [
        "episode-1",
        "episode-2",
      ],
      sourceEvidenceIds: [
        correction.event.eventId,
        verification().event.eventId,
        laterCorrection.event.eventId,
        laterVerification.event.eventId,
        verificationFixture(correction, verification()).operation.event.eventId,
        verificationFixture(laterCorrection, laterVerification).operation.event.eventId,
      ],
    });
    const earlierRecall: ContextUseRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [],
      candidateKnowledgeIds: [
        knowledge.knowledgeId,
      ],
      createdAt: "2026-09-02T00:05:00.000Z",
      episodeId: "episode-2",
      latencyMs: 1,
      renderedTokens: 10,
      requestId: "context-before-later-correction",
      returnedKnowledgeIds: [
        knowledge.knowledgeId,
      ],
      sessionId: "session-2",
    };
    const laterEpisode: WorkEpisode = {
      ...episode(laterVerification),
      correctionEventIds: [
        laterCorrection.event.eventId,
      ],
      episodeId: "episode-2",
      sessionIds: [
        "session-2",
      ],
      sourceEventIds: [
        laterCorrection.event.eventId,
        laterVerification.event.eventId,
      ],
      startedAt: "2026-09-02T00:00:00.000Z",
    };
    const result = new KnowledgeAdmissionPolicy().evaluate({
      candidate: knowledge,
      contextUseRecords: [
        earlierRecall,
      ],
      correctionKeys: [
        repeatedKey,
      ],
      correctionSourceEventIds: new Set([
        correction.event.eventId,
        laterCorrection.event.eventId,
      ]),
      envelopes: proofEnvelopes([
        correction,
        verification(),
        laterCorrection,
        laterVerification,
      ], [[correction, verification()], [laterCorrection, laterVerification]]),
      feedbackEvents: [],
      workEpisodes: [
        episode(),
        laterEpisode,
      ],
    });

    expect(result.admitted).toBe(true);
    expect(result.reasons).not.toContain(
      "recalled_knowledge_evidence",
    );
  });

  it("requires explicit user feedback for scope broadening", () => {
    const personal = candidate({
      scope: "personal",
    });
    const automatedScope: FeedbackEvent = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      evidenceRef: "analyzer:scope",
      feedbackId: "feedback-automated-scope",
      kind: "set_scope",
      scopeChange: {
        scope: "personal",
      },
      source: "analyzer",
      targetId: personal.knowledgeId,
      targetType: "knowledge",
      timestamp: "2026-09-01T00:20:00.000Z",
    };
    const userScope: FeedbackEvent = {
      ...automatedScope,
      evidenceRef: "user:scope",
      feedbackId: "feedback-user-scope",
      source: "user",
    };

    expect(
      evaluate({
        candidate: personal,
        feedbackEvents: [
          automatedScope,
        ],
      }).reasons,
    ).toContain("scope_mismatch");
    expect(
      evaluate({
        candidate: personal,
        feedbackEvents: [
          userScope,
        ],
      }).admitted,
    ).toBe(true);
  });
});
