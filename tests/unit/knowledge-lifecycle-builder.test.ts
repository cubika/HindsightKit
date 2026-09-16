import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type CorrectionKey,
  type CorrectionOpportunity,
  type FeedbackEvent,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  KnowledgeLifecycleBuilder,
  createCaptureEnvelope,
} from "@provenloop/domain";
import { proofEnvelopes } from "./domain-proof-fixture.js";

const envelope = (
  sourceEventId: string,
  timestamp: string,
  eventType: string,
  input: {
    readonly completionStatus?: "failed" | "succeeded";
    readonly parentEventId?: string;
    readonly trust?: "system" | "tool" | "user";
  } = {},
): CaptureEnvelope =>
  createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: "feat/testing",
    ...(input.completionStatus === undefined
      ? {}
      : {
          completionStatus: input.completionStatus,
        }),
    eventType,
    ...(input.parentEventId === undefined
      ? {}
      : {
          parentEventId: input.parentEventId,
        }),
    repoId: "repo-1",
    sessionId: "session-test",
    sourceEventId,
    timestamp,
    trust: input.trust ?? "system",
    worktree: "C:\\repo",
  });

const key = (input: {
  readonly correctionEventIds: readonly string[];
  readonly correctionKeyId: string;
  readonly createdAt: string;
  readonly expectedBehavior?: string;
  readonly verificationEvidenceIds?: readonly string[];
}): CorrectionKey => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  correctionKeyId: input.correctionKeyId,
  createdAt: input.createdAt,
  expectedBehavior:
    input.expectedBehavior ?? "Run the targeted Vitest command",
  scope: "repository",
  scopeId: "repo-1",
  sourceCorrectionEventIds: [
    ...input.correctionEventIds,
  ],
  subsystem: "test-runner",
  taskFamily: "testing",
  trigger: "package validation",
  verificationEvidenceIds: [
    ...(input.verificationEvidenceIds ?? []),
  ],
  violatedConstraint:
    "Inspect package scripts before choosing a test runner",
});

const episode = (input: {
  readonly episodeId: string;
  readonly sourceEventIds: readonly string[];
  readonly startedAt: string;
}): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [],
  episodeId: input.episodeId,
  finishedAt: new Date(
    Date.parse(input.startedAt) + 60_000,
  ).toISOString(),
  goal: "Run package validation",
  issueIds: [],
  outcome: "success",
  outcomeEvidenceIds: [],
  outcomeQualification: "qualified",
  outcomeQualifiedAt: new Date(
    Date.parse(input.startedAt) + 60_000,
  ).toISOString(),
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    input.episodeId,
  ],
  sourceEventIds: [
    ...input.sourceEventIds,
  ],
  startedAt: input.startedAt,
});

const opportunity = (input: {
  readonly applied?: boolean;
  readonly correctionKeyId: string;
  readonly episodeId: string;
  readonly opportunityId: string;
  readonly outcomeKnown?: boolean;
  readonly repeated?: boolean;
}): CorrectionOpportunity => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  applicable: true,
  correctionKeyId: input.correctionKeyId,
  correctionRepeated: input.repeated ?? false,
  createdAt: "2026-09-03T00:00:00.000Z",
  episodeId: input.episodeId,
  knowledgeAppliedBeforeCorrection: input.applied ?? false,
  knowledgeAvailableBeforeCorrection: input.applied ?? false,
  opportunityId: input.opportunityId,
  outcomeKnown: input.outcomeKnown ?? false,
});

const feedback = (input: {
  readonly feedbackId: string;
  readonly kind: FeedbackEvent["kind"];
  readonly scopeChange?: FeedbackEvent["scopeChange"];
  readonly source?: FeedbackEvent["source"];
  readonly targetId: string;
  readonly timestamp: string;
}): FeedbackEvent => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  evidenceRef: `control:${input.feedbackId}`,
  feedbackId: input.feedbackId,
  kind: input.kind,
  ...(input.scopeChange === undefined
    ? {}
    : {
        scopeChange: input.scopeChange,
      }),
  source: input.source ?? "user",
  targetId: input.targetId,
  targetType: "knowledge",
  timestamp: input.timestamp,
});

describe("KnowledgeLifecycleBuilder", () => {
  it("aggregates repeated evidence by stable topic and explains its tier", () => {
    const correctionOne = envelope(
      "correction-one",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const correctionTwo = envelope(
      "correction-two",
      "2026-09-02T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const verificationOne = envelope(
      "verification-one",
      "2026-09-01T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const verificationTwo = envelope(
      "verification-two",
      "2026-09-02T00:10:00.000Z",
      "build.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const correctionKey = key({
      correctionEventIds: [
        correctionOne.event.eventId,
        correctionTwo.event.eventId,
      ],
      correctionKeyId: "correction-testing",
      createdAt: correctionOne.event.timestamp,
      verificationEvidenceIds: [
        verificationOne.event.eventId,
        verificationTwo.event.eventId,
      ],
    });
    const result = new KnowledgeLifecycleBuilder().build({
      correctionKeys: [
        correctionKey,
      ],
      correctionOpportunities: [
        opportunity({
          applied: true,
          correctionKeyId: correctionKey.correctionKeyId,
          episodeId: "episode-opportunity",
          opportunityId: "opportunity-helpful",
          outcomeKnown: true,
        }),
      ],
      envelopes: proofEnvelopes([
        correctionOne,
        correctionTwo,
        verificationOne,
        verificationTwo,
      ], [[correctionOne, verificationOne], [correctionTwo, verificationTwo]]),
      feedbackEvents: [],
      workEpisodes: [
        episode({
          episodeId: "episode-one",
          sourceEventIds: [
            correctionOne.event.eventId,
            verificationOne.event.eventId,
          ],
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
        episode({
          episodeId: "episode-two",
          sourceEventIds: [
            correctionTwo.event.eventId,
            verificationTwo.event.eventId,
          ],
          startedAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      content: "Run the targeted Vitest command",
      coverage: {
        applicableOpportunities: 1,
        observedOutcomes: 1,
      },
      evidenceMarks: [
        "externally_verified",
        "repeated_evidence",
      ],
      evidenceTier: "repeated_evidence",
      scope: "repository",
      scopeId: "repo-1",
      state: "active",
      utility: {
        applied: 1,
        harmful: 0,
        helpful: 0,
      },
    });
    expect(result.candidates[0]?.sourceEpisodeIds).toEqual([
      "episode-one",
      "episode-two",
    ]);
  });

  it("keeps unverified Knowledge as an inferred candidate", () => {
    const correction = envelope(
      "correction-unverified",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const result = new KnowledgeLifecycleBuilder().build({
      correctionKeys: [
        key({
          correctionEventIds: [
            correction.event.eventId,
          ],
          correctionKeyId: "correction-unverified",
          createdAt: correction.event.timestamp,
        }),
      ],
      correctionOpportunities: [],
      envelopes: [
        correction,
      ],
      feedbackEvents: [],
      workEpisodes: [
        episode({
          episodeId: "episode-unverified",
          sourceEventIds: [
            correction.event.eventId,
          ],
          startedAt: correction.event.timestamp,
        }),
      ],
    });

    expect(result.candidates[0]).toMatchObject({
      evidenceMarks: [],
      evidenceTier: "inferred",
      state: "candidate",
    });
  });

  it("does not reuse stale verification for a later correction", () => {
    const firstCorrection = envelope(
      "correction-first-verified",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const verification = envelope(
      "verification-before-repeat",
      "2026-09-01T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const laterCorrection = envelope(
      "correction-later-unverified",
      "2026-09-01T00:20:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const result = new KnowledgeLifecycleBuilder().build({
      correctionKeys: [
        key({
          correctionEventIds: [
            firstCorrection.event.eventId,
            laterCorrection.event.eventId,
          ],
          correctionKeyId: "correction-stale-verification",
          createdAt: firstCorrection.event.timestamp,
          verificationEvidenceIds: [
            verification.event.eventId,
          ],
        }),
      ],
      correctionOpportunities: [],
      envelopes: proofEnvelopes([
        firstCorrection,
        verification,
        laterCorrection,
      ], [[firstCorrection, verification]]),
      feedbackEvents: [],
      workEpisodes: [
        episode({
          episodeId: "episode-first-verified",
          sourceEventIds: [
            firstCorrection.event.eventId,
            verification.event.eventId,
          ],
          startedAt: firstCorrection.event.timestamp,
        }),
        episode({
          episodeId: "episode-later-unverified",
          sourceEventIds: [
            laterCorrection.event.eventId,
          ],
          startedAt: laterCorrection.event.timestamp,
        }),
      ],
    });

    expect(result.candidates[0]).toMatchObject({
      evidenceMarks: [
        "externally_verified",
      ],
      evidenceTier: "externally_verified",
      state: "candidate",
    });
    expect(result.admissionDecisions[0]?.reasons).toContain(
      "unverified_correction_occurrence",
    );
  });

  it("supersedes older verified behavior within one topic", () => {
    const oldCorrection = envelope(
      "correction-old",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const oldVerification = envelope(
      "verification-old",
      "2026-09-01T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const newCorrection = envelope(
      "correction-new",
      "2026-09-02T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const newVerification = envelope(
      "verification-new",
      "2026-09-02T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const result = new KnowledgeLifecycleBuilder().build({
      correctionKeys: [
        key({
          correctionEventIds: [
            oldCorrection.event.eventId,
          ],
          correctionKeyId: "correction-old",
          createdAt: oldCorrection.event.timestamp,
          expectedBehavior: "Run the full Jest suite",
          verificationEvidenceIds: [
            oldVerification.event.eventId,
          ],
        }),
        key({
          correctionEventIds: [
            newCorrection.event.eventId,
          ],
          correctionKeyId: "correction-new",
          createdAt: newCorrection.event.timestamp,
          expectedBehavior: "Run the targeted Vitest command",
          verificationEvidenceIds: [
            newVerification.event.eventId,
          ],
        }),
      ],
      correctionOpportunities: [],
      envelopes: proofEnvelopes([
        oldCorrection,
        oldVerification,
        newCorrection,
        newVerification,
      ], [[oldCorrection, oldVerification], [newCorrection, newVerification]]),
      feedbackEvents: [],
      workEpisodes: [
        episode({
          episodeId: "episode-old",
          sourceEventIds: [
            oldCorrection.event.eventId,
            oldVerification.event.eventId,
          ],
          startedAt: oldCorrection.event.timestamp,
        }),
        episode({
          episodeId: "episode-new",
          sourceEventIds: [
            newCorrection.event.eventId,
            newVerification.event.eventId,
          ],
          startedAt: newCorrection.event.timestamp,
        }),
      ],
    });
    const oldCandidate = result.candidates.find(
      (candidate) => candidate.content === "Run the full Jest suite",
    );
    const newCandidate = result.candidates.find(
      (candidate) =>
        candidate.content === "Run the targeted Vitest command",
    );

    expect(oldCandidate).toMatchObject({
      state: "superseded",
    });
    expect(newCandidate).toMatchObject({
      state: "active",
      supersedes: oldCandidate?.knowledgeId,
    });
    expect(newCandidate?.conflictsWith).toContain(
      oldCandidate?.knowledgeId,
    );
  });

  it("disputes direct counterevidence and deterministically replays feedback", () => {
    const correction = envelope(
      "correction-counter",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const verification = envelope(
      "verification-counter",
      "2026-09-01T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const counter = envelope(
      "counter-failure",
      "2026-09-02T00:00:00.000Z",
      "test.completed",
      {
        completionStatus: "failed",
        parentEventId: verification.event.eventId,
        trust: "tool",
      },
    );
    const correctionKey = key({
      correctionEventIds: [
        correction.event.eventId,
      ],
      correctionKeyId: "correction-counter",
      createdAt: correction.event.timestamp,
      verificationEvidenceIds: [
        verification.event.eventId,
      ],
    });
    const builder = new KnowledgeLifecycleBuilder();
    const baseInput = {
      correctionKeys: [
        correctionKey,
      ],
      correctionOpportunities: [],
      envelopes: proofEnvelopes([
        correction,
        verification,
        counter,
      ], [[correction, verification]]),
      feedbackEvents: [],
      workEpisodes: [],
    };
    const disputed = builder.build(baseInput).candidates[0];
    if (disputed === undefined) {
      throw new Error("Expected disputed Knowledge.");
    }
    expect(disputed).toMatchObject({
      evidenceTier: "disputed",
      state: "disputed",
      validatedAt: counter.event.timestamp,
    });
    expect(disputed.sourceEvidenceIds).toContain(
      counter.event.eventId,
    );
    const replayed = builder.build({
      ...baseInput,
      feedbackEvents: [
        feedback({
          feedbackId: "feedback-stale",
          kind: "stale",
          targetId: disputed.knowledgeId,
          timestamp: "2026-09-04T00:00:00.000Z",
        }),
        feedback({
          feedbackId: "feedback-confirm",
          kind: "confirm",
          targetId: disputed.knowledgeId,
          timestamp: "2026-09-03T00:00:00.000Z",
        }),
      ],
    }).candidates[0];

    expect(replayed).toMatchObject({
      expiresAt: "2026-09-04T00:00:00.000Z",
      state: "archived",
      validatedAt: "2026-09-04T00:00:00.000Z",
    });
  });

  it("only applies explicit user scope changes", () => {
    const correction = envelope(
      "correction-scope",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        trust: "user",
      },
    );
    const verification = envelope(
      "verification-scope",
      "2026-09-01T00:10:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const correctionKey = key({
      correctionEventIds: [
        correction.event.eventId,
      ],
      correctionKeyId: "correction-scope",
      createdAt: correction.event.timestamp,
      verificationEvidenceIds: [
        verification.event.eventId,
      ],
    });
    const workEpisode = episode({
      episodeId: "episode-scope",
      sourceEventIds: [
        correction.event.eventId,
        verification.event.eventId,
      ],
      startedAt: correction.event.timestamp,
    });
    const builder = new KnowledgeLifecycleBuilder();
    const baseInput = {
      correctionKeys: [
        correctionKey,
      ],
      correctionOpportunities: [],
      envelopes: proofEnvelopes([
        correction,
        verification,
      ], [[correction, verification]]),
      feedbackEvents: [],
      workEpisodes: [
        workEpisode,
      ],
    };
    const knowledgeId = builder.build(baseInput).candidates[0]?.knowledgeId;
    if (knowledgeId === undefined) {
      throw new Error("Expected correction Knowledge.");
    }
    const scopeFeedback = {
      feedbackId: "feedback-scope",
      kind: "set_scope" as const,
      scopeChange: {
        scope: "personal" as const,
      },
      targetId: knowledgeId,
      timestamp: "2026-09-01T00:20:00.000Z",
    };
    const automated = builder.build({
      ...baseInput,
      feedbackEvents: [
        feedback({
          ...scopeFeedback,
          source: "analyzer",
        }),
      ],
    }).candidates[0];
    const explicit = builder.build({
      ...baseInput,
      feedbackEvents: [
        feedback({
          ...scopeFeedback,
          source: "user",
        }),
      ],
    }).candidates[0];

    expect(automated).toMatchObject({
      scope: "repository",
      scopeId: "repo-1",
      state: "active",
      validatedAt: verification.event.timestamp,
    });
    expect(explicit).toMatchObject({
      scope: "personal",
      state: "active",
    });
    expect(explicit).not.toHaveProperty("scopeId");
  });
});
