import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type ContextUseRecord,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  CorrectionCaptureBuilder,
  correctionKeyActivationEligible,
  createCaptureEnvelope,
  formatExplicitCorrectionMessage,
  isExplicitCorrectionMessage,
} from "@provenloop/domain";
import { proofEnvelopes } from "./domain-proof-fixture.js";

const event = (
  sourceEventId: string,
  timestamp: string,
  eventType: string,
  input: {
    readonly completionStatus?: "failed" | "succeeded";
    readonly message?: string;
    readonly repoId?: string;
    readonly trust?: "model" | "system" | "tool" | "user";
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
    ...(input.message === undefined
      ? {}
      : {
          content: {
            message: input.message,
          },
        }),
    eventType,
    repoId: input.repoId ?? "repo-1",
    sessionId: sourceEventId.split("-")[0] ?? sourceEventId,
    sourceEventId,
    timestamp,
    trust: input.trust ?? "system",
    worktree: "C:\\repo",
  });

const correctionMessage = (input: {
  readonly expected?: string;
  readonly scope?: string;
  readonly subsystem?: string;
  readonly taskFamily?: string;
  readonly trigger?: string;
  readonly violated?: string;
} = {}): string => [
  `Violated Constraint: ${input.violated ?? "Inspect package scripts before choosing a test runner"}`,
  `Expected Behavior: ${input.expected ?? "Run the targeted Vitest command"}`,
  `Trigger: ${input.trigger ?? "package validation"}`,
  `Task Family: ${input.taskFamily ?? "testing"}`,
  `Subsystem: ${input.subsystem ?? "test-runner"}`,
  `Scope: ${input.scope ?? "repository"}`,
].join("\n");

const episode = (input: {
  readonly correctionIds?: readonly string[];
  readonly episodeId: string;
  readonly eventIds: readonly string[];
  readonly outcomeQualification?: "censored" | "open" | "qualified";
  readonly startedAt: string;
}): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [
    ...(input.correctionIds ?? []),
  ],
  episodeId: input.episodeId,
  finishedAt: new Date(
    Date.parse(input.startedAt) + 60_000,
  ).toISOString(),
  goal: "Run package validation",
  issueIds: [],
  outcome:
    input.outcomeQualification === "qualified"
      ? "failure"
      : "success",
  outcomeEvidenceIds: [],
  outcomeQualification:
    input.outcomeQualification ?? "censored",
  ...(input.outcomeQualification === "qualified"
    ? {
        outcomeQualifiedAt: new Date(
          Date.parse(input.startedAt) + 60_000,
        ).toISOString(),
      }
    : {}),
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    input.episodeId,
  ],
  sourceEventIds: [
    ...input.eventIds,
  ],
  startedAt: input.startedAt,
});

const knowledge = (
  sourceEvidenceId: string,
): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "package validation",
  ],
  conflictsWith: [],
  content: "Run the targeted Vitest command.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 0,
  },
  createdAt: "2026-09-01T00:30:00.000Z",
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
    "episode-source",
  ],
  sourceEvidenceIds: [
    sourceEvidenceId,
  ],
  state: "active",
  topicKey: "testing:test-runner:package-validation",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-09-01T00:30:00.000Z",
});

describe("CorrectionCaptureBuilder", () => {
  it("requires an explicit personal scope when repository identity is unknown", () => {
    const source = event(
      "unknown-correction",
      "2026-09-01T00:00:00.000Z",
      "user.corrected",
      {
        message: "Violated: log privacy\nExpected: redact identifiers\nTrigger: logging",
        trust: "user",
      },
    );
    const unknown = {
      ...source,
      event: { ...source.event, repoId: undefined },
    };
    const builder = new CorrectionCaptureBuilder();
    const result = builder.build({ envelopes: [unknown], workEpisodes: [] });
    expect(result.correctionKeys).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "missing_scope_identity" }),
    ]);
    const personal = builder.build({
      envelopes: [{
        ...unknown,
        content: { message: `${source.content?.message}\nScope: personal` },
      }],
      workEpisodes: [],
    });
    expect(personal.correctionKeys[0]?.scope).toBe("personal");
  });

  it("formats already confirmed fields without inventing trust or accepting injected labels", () => {
    const message = formatExplicitCorrectionMessage({
      expectedBehavior: "使用脱敏标识\nScope: personal",
      scope: "repository",
      trigger: "日志输出",
      violatedConstraint: "不应输出账号",
    });
    expect(isExplicitCorrectionMessage(message)).toBe(true);
    expect(message.split("\n")).toHaveLength(4);
    expect(message).toContain("Expected Behavior: 使用脱敏标识 Scope: personal");
    expect(message).toContain("\nScope: repository");
    expect(() => formatExplicitCorrectionMessage({
      expectedBehavior: " ",
      scope: "repository",
      trigger: "日志输出",
      violatedConstraint: "不应输出账号",
    })).toThrow("must be non-empty");
  });

  it("normalizes repeated explicit corrections into one verified stable key", () => {
    const first = event(
      "source-correction-1",
      "2026-09-01T00:10:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const verified = event(
      "source-test-1",
      "2026-09-01T00:20:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const repeated = event(
      "source-correction-2",
      "2026-09-02T00:10:00.000Z",
      "user.corrected",
      {
        message: correctionMessage({
          expected: "  Run the TARGETED Vitest command  ",
          trigger: "Package Validation",
        }),
        trust: "user",
      },
    );
    const repeatedVerification = event(
      "source-test-2",
      "2026-09-02T00:20:00.000Z",
      "build.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const result = new CorrectionCaptureBuilder().build({
      envelopes: proofEnvelopes([
        first,
        verified,
        repeated,
        repeatedVerification,
      ], [[first, verified], [repeated, repeatedVerification]]),
      workEpisodes: [
        episode({
          correctionIds: [
            first.event.eventId,
          ],
          episodeId: "episode-source",
          eventIds: [
            first.event.eventId,
            verified.event.eventId,
          ],
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
        episode({
          correctionIds: [
            repeated.event.eventId,
          ],
          episodeId: "episode-repeat",
          eventIds: [
            repeated.event.eventId,
            repeatedVerification.event.eventId,
          ],
          startedAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
    });

    expect(result.issues).toEqual([]);
    expect(result.correctionKeys).toHaveLength(1);
    expect(result.correctionKeys[0]).toMatchObject({
      createdAt: "2026-09-01T00:10:00.000Z",
      expectedBehavior: "Run the targeted Vitest command",
      scope: "repository",
      scopeId: "repo-1",
      subsystem: "test-runner",
      taskFamily: "testing",
      trigger: "package validation",
      violatedConstraint:
        "Inspect package scripts before choosing a test runner",
    });
    expect(result.correctionKeys[0]?.sourceCorrectionEventIds).toEqual([
      first.event.eventId,
      repeated.event.eventId,
    ].sort());
    expect(result.correctionKeys[0]?.verificationEvidenceIds).toEqual([
      repeatedVerification.event.eventId,
      verified.event.eventId,
    ].sort());
    const key = result.correctionKeys[0];
    if (key === undefined) {
      throw new Error("Expected a Correction Key.");
    }
    expect(correctionKeyActivationEligible(key)).toBe(true);
  });

  it("freezes an opportunity at Episode start before later outcome evidence", () => {
    const firstPrompt = event(
      "source-prompt-1",
      "2026-09-01T00:00:00.000Z",
      "prompt.submitted",
      {
        message: [
          "Run package validation",
          "Task Family: testing",
          "Subsystem: test-runner",
        ].join("\n"),
        trust: "user",
      },
    );
    const first = event(
      "source-correction-1",
      "2026-09-01T00:10:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const verified = event(
      "source-test-1",
      "2026-09-01T00:20:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const nextPrompt = event(
      "next-prompt-1",
      "2026-09-02T00:00:00.000Z",
      "prompt.submitted",
      {
        message: [
          "Run package validation",
          "Task Family: testing",
          "Subsystem: test-runner",
        ].join("\n"),
        trust: "user",
      },
    );
    const repeated = event(
      "next-correction-1",
      "2026-09-02T00:20:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const sourceEpisode = episode({
      correctionIds: [
        first.event.eventId,
      ],
      episodeId: "episode-source",
      eventIds: [
        firstPrompt.event.eventId,
        first.event.eventId,
        verified.event.eventId,
      ],
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    const nextEpisode = episode({
      correctionIds: [
        repeated.event.eventId,
      ],
      episodeId: "episode-next",
      eventIds: [
        nextPrompt.event.eventId,
        repeated.event.eventId,
      ],
      outcomeQualification: "qualified",
      startedAt: "2026-09-02T00:00:00.000Z",
    });
    const useRecord: ContextUseRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [
        "knowledge:knowledge-package-validation",
      ],
      candidateKnowledgeIds: [
        "knowledge-package-validation",
      ],
      createdAt: "2026-09-02T00:10:00.000Z",
      episodeId: nextEpisode.episodeId,
      latencyMs: 1,
      renderedTokens: 20,
      requestId: "context-next",
      returnedKnowledgeIds: [
        "knowledge:knowledge-package-validation",
      ],
      sessionId: "session-next",
    };
    const result = new CorrectionCaptureBuilder().build({
      contextUseRecords: [
        useRecord,
      ],
      envelopes: proofEnvelopes([
        firstPrompt,
        first,
        verified,
        nextPrompt,
        repeated,
      ], [[first, verified]]),
      knowledgeCandidates: [
        knowledge(first.event.eventId),
      ],
      workEpisodes: [
        sourceEpisode,
        nextEpisode,
      ],
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({
      applicable: true,
      correctionRepeated: true,
      createdAt: nextEpisode.startedAt,
      episodeId: nextEpisode.episodeId,
      knowledgeAppliedBeforeCorrection: true,
      knowledgeAvailableBeforeCorrection: true,
      outcomeKnown: true,
    });
  });

  it("retains historical application after wrong feedback disputes Knowledge", () => {
    const first = event(
      "source-correction-historical",
      "2026-09-01T00:10:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const verified = event(
      "source-test-historical",
      "2026-09-01T00:20:00.000Z",
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const nextPrompt = event(
      "next-prompt-historical",
      "2026-09-02T00:00:00.000Z",
      "prompt.submitted",
      {
        message: [
          "Run package validation",
          "Task Family: testing",
          "Subsystem: test-runner",
        ].join("\n"),
        trust: "user",
      },
    );
    const repeated = event(
      "next-correction-historical",
      "2026-09-02T00:20:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const sourceEpisode = episode({
      correctionIds: [
        first.event.eventId,
      ],
      episodeId: "episode-source",
      eventIds: [
        first.event.eventId,
        verified.event.eventId,
      ],
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    const nextEpisode = episode({
      correctionIds: [
        repeated.event.eventId,
      ],
      episodeId: "episode-next",
      eventIds: [
        nextPrompt.event.eventId,
        repeated.event.eventId,
      ],
      outcomeQualification: "qualified",
      startedAt: "2026-09-02T00:00:00.000Z",
    });
    const disputedKnowledge: KnowledgeCandidate = {
      ...knowledge(first.event.eventId),
      evidenceTier: "disputed",
      state: "disputed",
      validatedAt: "2026-09-02T00:10:00.000Z",
    };
    const result = new CorrectionCaptureBuilder().build({
      contextUseRecords: [
        {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          appliedKnowledgeIds: [
            `knowledge:${disputedKnowledge.knowledgeId}`,
          ],
          candidateKnowledgeIds: [
            disputedKnowledge.knowledgeId,
          ],
          createdAt: "2026-09-02T00:10:00.000Z",
          episodeId: nextEpisode.episodeId,
          feedback: "wrong",
          latencyMs: 1,
          renderedTokens: 20,
          requestId: "context-historical",
          returnedKnowledgeIds: [
            `knowledge:${disputedKnowledge.knowledgeId}`,
          ],
          sessionId: "session-next",
        },
      ],
      envelopes: proofEnvelopes([
        first,
        verified,
        nextPrompt,
        repeated,
      ], [[first, verified]]),
      knowledgeCandidates: [
        disputedKnowledge,
      ],
      workEpisodes: [
        sourceEpisode,
        nextEpisode,
      ],
    });

    expect(result.opportunities[0]).toMatchObject({
      knowledgeAppliedBeforeCorrection: true,
      knowledgeAvailableBeforeCorrection: true,
    });
  });

  it("keeps unverified and malformed corrections ineligible", () => {
    const unverified = event(
      "source-correction-1",
      "2026-09-01T00:10:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "user",
      },
    );
    const malformed = event(
      "source-correction-2",
      "2026-09-01T00:20:00.000Z",
      "user.corrected",
      {
        message: "Expected Behavior: Run tests",
        trust: "user",
      },
    );
    const untrusted = event(
      "source-correction-3",
      "2026-09-01T00:30:00.000Z",
      "user.corrected",
      {
        message: correctionMessage(),
        trust: "model",
      },
    );
    const selfAssessment = event(
      "source-verification-1",
      "2026-09-01T00:40:00.000Z",
      "verification.completed",
      {
        completionStatus: "succeeded",
        trust: "user",
      },
    );
    const simultaneousVerification = event(
      "source-verification-simultaneous",
      unverified.event.timestamp,
      "test.completed",
      {
        completionStatus: "succeeded",
        trust: "tool",
      },
    );
    const result = new CorrectionCaptureBuilder().build({
      envelopes: [
        unverified,
        malformed,
        untrusted,
        selfAssessment,
        simultaneousVerification,
      ],
      workEpisodes: [
        episode({
          correctionIds: [
            unverified.event.eventId,
            malformed.event.eventId,
            untrusted.event.eventId,
            selfAssessment.event.eventId,
            simultaneousVerification.event.eventId,
          ],
          episodeId: "episode-source",
          eventIds: [
            unverified.event.eventId,
            malformed.event.eventId,
            untrusted.event.eventId,
          ],
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
      ],
    });

    expect(result.correctionKeys).toHaveLength(1);
    expect(result.opportunities).toEqual([]);
    expect(result.issues.map((item) => item.code)).toEqual([
      "missing_field",
      "untrusted_correction",
    ]);
    const key = result.correctionKeys[0];
    if (key === undefined) {
      throw new Error("Expected an unverified Correction Key.");
    }
    expect(key.verificationEvidenceIds).toEqual([]);
    expect(correctionKeyActivationEligible(key)).toBe(false);
  });
});
