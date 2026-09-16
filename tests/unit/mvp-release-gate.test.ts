import { describe, expect, it } from "vitest";

import {
  evaluateMvpReleaseReadiness,
  mvpReleaseExitCode,
  mvpReleaseEvidenceSchema,
  type MvpAutomatedReadiness,
  type MvpReleaseEvidence,
} from "@provenloop/evaluation";

const automated = (): MvpAutomatedReadiness => ({
  codeVersions: [
    "version-1",
    "version-1",
    "version-1",
  ],
  evaluationBinding: {
    codeVersion: "version-1",
    datasets: {
      branchContinuation: {
        datasetId: "branch-continuation",
        datasetVersion: 1,
      },
      correctionRecurrence: {
        datasetId: "correction-recurrence",
        datasetVersion: 1,
      },
      workEpisodeAssociation: {
        datasetId: "work-episode-association",
        datasetVersion: 1,
      },
    },
    executableDigest: "e".repeat(64),
    subgateDigests: {
      m0: "a".repeat(64),
      m1: "b".repeat(64),
      m2: "c".repeat(64),
    },
  },
  eventProcessIntegrityPassed: true,
  m0Status: "pass",
  m1Status: "pass",
  m2Status: "pass",
  negativeTriggerCaseCount: 6,
  outcomeSuccessDelta: 0,
  outcomeSuccessThreshold: -0.02,
  rollbackTargetValid: true,
  safetyRecoveryPassed: true,
});

const evidence = (): MvpReleaseEvidence => ({
  conditionalCanary: {
    expiresAt: "2026-10-01T00:00:00.000Z",
    targetIds: [
      "repo-design-partner",
    ],
    targetType: "repository",
  },
  evidenceVersion: 1,
  evaluation: automated().evaluationBinding,
  guardrails: {
    crossRepositoryLeakageCount: 0,
    deletionPropagationFailureCount: 0,
    secretLeakageCount: 0,
    severeHarmCount: 0,
    unsupportedCompletionClaimCount: 0,
  },
  observationWindow: {
    endsAt: "2026-09-14T00:00:00.000Z",
    observedThrough: "2026-09-15T00:00:00.000Z",
  },
  owner: "release-owner",
  reviewId: "review-1",
  reviewedAt: "2026-09-15T00:00:00.000Z",
  rollback: {
    resolvedCommitSha: "d".repeat(40),
    target: "release-previous",
    verified: true,
  },
  shadow: {
    completedAt: "2026-09-15T00:00:00.000Z",
    runId: "shadow-1",
    status: "pass",
  },
  worstCaseReview: {
    allHarmReviewed: true,
    allWrongInjectionsReviewed: true,
    completed: true,
    reviewedCaseIds: Array.from(
      {
        length: 10,
      },
      (_, index) => `case-${index + 1}`,
    ),
  },
});

describe("MVP release readiness", () => {
  it("does not turn complete attestations and synthetic regression into field-effect proof", () => {
    const readiness = evaluateMvpReleaseReadiness({
      automated: automated(),
      evidence: evidence(),
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });

    expect(readiness).toMatchObject({
      decision: "no_go",
    });
    expect(
      readiness.checks.find((check) => check.checkId === "field-effect-evidence")?.status,
    ).toBe("blocked");
    expect(readiness.limitations).toContain(
      "Synthetic regression results are not observed user benefits or controlled field effects.",
    );
  });

  it("records restricted research scope without pretending field effects were evaluated", () => {
    const readiness = evaluateMvpReleaseReadiness({
      automated: automated(),
      evidence: evidence(),
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "research",
    });

    expect(readiness.decision).toBe("no_go");
    expect(readiness.checks.find((check) => check.checkId === "conditional-canary")?.status).toBe("pass");
  });

  it("returns No-Go for missing review evidence or hard guardrail failures", () => {
    const missing = evaluateMvpReleaseReadiness({
      automated: automated(),
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });
    const severeHarm = evaluateMvpReleaseReadiness({
      automated: automated(),
      evidence: {
        ...evidence(),
        guardrails: {
          ...evidence().guardrails,
          severeHarmCount: 1,
        },
      },
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });

    expect(missing.decision).toBe("no_go");
    expect(
      missing.checks.some((check) => check.status === "blocked"),
    ).toBe(true);
    expect(severeHarm.decision).toBe("no_go");
    expect(
      severeHarm.checks.find(
        (check) => check.checkId === "zero-severe-harm",
      )?.status,
    ).toBe("fail");
  });

  it("rejects stale evaluation bindings and invalid rollback targets", () => {
    const stale = evaluateMvpReleaseReadiness({
      automated: automated(),
      evidence: {
        ...evidence(),
        evaluation: {
          ...evidence().evaluation,
          codeVersion: "older-version",
        },
      },
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });
    const rollback = evaluateMvpReleaseReadiness({
      automated: {
        ...automated(),
        rollbackTargetValid: false,
      },
      evidence: evidence(),
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });

    expect(stale.decision).toBe("no_go");
    expect(
      stale.checks.find(
        (check) =>
          check.checkId === "evaluation-evidence-binding",
      )?.status,
    ).toBe("fail");
    expect(rollback.decision).toBe("no_go");
    expect(
      rollback.checks.find(
        (check) => check.checkId === "rollback",
      )?.status,
    ).toBe("fail");
  });

  it("rejects future observations and preserves infrastructure exit codes", () => {
    const futureObservation = evaluateMvpReleaseReadiness({
      automated: automated(),
      evidence: {
        ...evidence(),
        observationWindow: {
          endsAt: "2026-09-14T00:00:00.000Z",
          observedThrough: "2099-01-01T00:00:00.000Z",
        },
      },
      now: new Date("2026-09-20T00:00:00.000Z"),
      releaseTarget: "stable",
    });

    expect(futureObservation.decision).toBe("no_go");
    expect(
      futureObservation.checks.find(
        (check) => check.checkId === "observation-window",
      )?.status,
    ).toBe("fail");
    expect(mvpReleaseExitCode([
      0,
      3,
      0,
    ], "no_go")).toBe(3);
    expect(mvpReleaseExitCode([
      0,
      2,
      0,
    ], "no_go")).toBe(2);
  });

  it("validates Shadow evidence and safe report fields", () => {
    expect(() =>
      mvpReleaseEvidenceSchema.parse({
        ...evidence(),
        shadow: {
          status: "pass",
        },
      }),
    ).toThrow("requires runId and completedAt");
    expect(() =>
      mvpReleaseEvidenceSchema.parse({
        ...evidence(),
        owner: "![remote](https://example.invalid)",
      }),
    ).toThrow();
    expect(() =>
      mvpReleaseEvidenceSchema.parse({
        ...evidence(),
        worstCaseReview: {
          ...evidence().worstCaseReview,
          reviewedCaseIds: Array.from(
            {
              length: 10,
            },
            () => "duplicate-case",
          ),
        },
      }),
    ).toThrow("must be unique");
    expect(() =>
      mvpReleaseEvidenceSchema.parse({
        ...evidence(),
        conditionalCanary: {
          expiresAt: "2026-10-01T00:00:00.000Z",
          targetIds: [],
          targetType: "repository",
        },
      }),
    ).toThrow();
    expect(() =>
      mvpReleaseEvidenceSchema.parse({
        ...evidence(),
        conditionalCanary: {
          expiresAt: "2026-10-01T00:00:00.000Z",
          targetIds: [
            "global-production",
          ],
          targetType: "repository",
        },
      }),
    ).toThrow();
  });
});
