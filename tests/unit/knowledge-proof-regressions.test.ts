import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  type CaptureEnvelope,
  type ContextUseRecord,
  type FeedbackEvent,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  CorrectionCaptureBuilder,
  createCaptureEnvelope,
  formatExplicitCorrectionMessage,
  KnowledgeAdmissionPolicy,
  KnowledgeLifecycleBuilder,
  WorkEpisodeBuilder,
  type CaptureEventInput,
} from "@provenloop/domain";
import { verificationFixture } from "./domain-proof-fixture.js";

const timestamp = (minute: number) =>
  new Date(Date.parse("2026-09-01T00:00:00.000Z") + minute * 60_000).toISOString();

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a projected regression fixture.");
  }
  return value;
};

const event = (
  id: string,
  minute: number,
  eventType: string,
  extra: Partial<CaptureEventInput> = {},
) => createCaptureEnvelope({
  adapter: "copilot-cli",
  adapterVersion: "1.0.82-0",
  branch: "main",
  eventType,
  repoId: "repo-1",
  sessionId: "session-1",
  sourceEventId: id,
  timestamp: timestamp(minute),
  trust: eventType === "user.corrected" || eventType === "prompt.submitted" ? "user" : "tool",
  worktree: "C:\\repo",
  ...extra,
});

const correction = (id = "correction", minute = 1) => event(id, minute, "user.corrected", {
  content: {
    message: formatExplicitCorrectionMessage({
      expectedBehavior: "Redact account identifiers",
      scope: "repository",
      trigger: "logging",
      violatedConstraint: "Do not expose accounts in logs",
    }),
  },
});

const source = () => {
  const corrected = correction();
  const verified = event("verification", 3, "test.completed", { completionStatus: "succeeded" });
  const proof = verificationFixture(corrected, verified);
  return {
    correction: corrected,
    operation: proof.operation,
    verification: proof.verification,
    envelopes: [
      event("prompt", 0, "prompt.submitted", { content: { message: "logging" } }),
      corrected,
      proof.operation,
      proof.verification,
    ],
  };
};

const project = (
  envelopes: readonly CaptureEnvelope[],
  feedbackEvents: readonly FeedbackEvent[] = [],
  contextUseRecords: readonly ContextUseRecord[] = [],
  knowledgeCandidates: readonly KnowledgeCandidate[] = [],
) => {
  const workEpisodes = new WorkEpisodeBuilder().build(envelopes).episodes;
  const corrections = new CorrectionCaptureBuilder().build({
    contextUseRecords,
    envelopes,
    knowledgeCandidates,
    workEpisodes,
  });
  const input = {
    contextUseRecords,
    correctionKeys: corrections.correctionKeys,
    correctionOpportunities: corrections.opportunities,
    envelopes,
    feedbackEvents,
    workEpisodes,
  };
  return { corrections, input, ...new KnowledgeLifecycleBuilder().build(input) };
};

const feedback = (
  targetId: string,
  minute: number,
  kind: FeedbackEvent["kind"],
  extra: Partial<FeedbackEvent> & { resolvesEvidenceIds?: string[] } = {},
): FeedbackEvent => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  evidenceRef: `control-${minute}`,
  feedbackId: `feedback-${minute}`,
  kind,
  source: "user",
  targetId,
  targetType: "knowledge",
  timestamp: timestamp(minute),
  ...extra,
});

describe("Correction proof regression chain", () => {
  it("accepts an explicit operation proof and persists its operation in the proof chain", () => {
    const material = source();
    const result = project(material.envelopes);
    expect(result.candidates[0]).toMatchObject({
      evidenceTier: "externally_verified",
      state: "active",
    });
    expect(result.admissionDecisions[0]?.admitted).toBe(true);
    expect(result.candidates[0]?.sourceEvidenceIds).toContain(material.operation.event.eventId);
  });

  it("never upgrades on a nearby unrelated successful test even when Episodes are merged", () => {
    const result = project([
      correction(),
      event("docs-prompt", 10, "prompt.submitted", {
        content: { message: "Translate onboarding handbook" },
        sessionId: "session-docs",
      }),
      event("docs-test", 11, "test.completed", {
        completionStatus: "succeeded",
        sessionId: "session-docs",
      }),
    ]);
    expect(result.input.workEpisodes).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ evidenceTier: "inferred", state: "candidate" });
    expect(result.corrections.correctionKeys[0]?.verificationEvidenceIds).toEqual([]);
  });

  it.each([
    { repoId: "repo-2" },
    { worktree: "C:\\other-worktree" },
    { worktree: undefined },
    { sessionId: "session-other" },
    { repositoryState: "unknown" as const },
    { repositoryState: "known_outside_repo" as const },
  ])("rejects explicit bindings with a different or unknown workspace/session: %j", (patch) => {
    const material = source();
    const result = project(material.envelopes.map((item) =>
      item.event.eventId === material.verification.event.eventId
        ? { ...item, event: { ...item.event, ...patch } }
        : item,
    ));
    expect(result.candidates[0]?.state).toBe("candidate");
    expect(result.corrections.correctionKeys[0]?.verificationEvidenceIds).toEqual([]);
  });

  it("requires the operation parent chain, not an asserted binding alone", () => {
    const material = source();
    const result = project([
      ...material.envelopes.map((item) =>
        item.event.eventId === material.operation.event.eventId
          ? { ...item, event: { ...item.event, parentEventId: "unrelated-prompt" } }
          : item,
      ),
    ]);
    expect(result.candidates[0]?.state).toBe("candidate");
  });

  it("does not count two corrections followed by one test as repeated evidence", () => {
    const first = correction("first", 1);
    const second = correction("second", 2);
    const proof = verificationFixture(second, event("one-test", 4, "test.completed", {
      completionStatus: "succeeded",
    }));
    const result = project([first, second, proof.operation, proof.verification]);
    expect(result.candidates[0]?.evidenceMarks).not.toContain("repeated_evidence");
    expect(result.admissionDecisions[0]?.reasons).toContain("unverified_correction_occurrence");
    expect(result.candidates[0]?.state).toBe("candidate");
  });

  it.each(["test.completed", "build.completed", "verification.completed"])(
    "keeps later %s failures disputed despite an earlier confirmation",
    (eventType) => {
      const material = source();
      const candidate = required(project(material.envelopes).candidates[0]);
      const counter = event("failure", 5, eventType, {
        exitCode: 1,
        parentEventId: material.verification.event.eventId,
      });
      const result = project(
        [...material.envelopes, counter],
        [feedback(candidate.knowledgeId, 4, "confirm")],
      );
      expect(result.candidates[0]).toMatchObject({
        evidenceTier: "disputed",
        state: "disputed",
        validatedAt: timestamp(5),
      });
      const decision = new KnowledgeAdmissionPolicy().evaluate({
        ...result.input,
        candidate: { ...required(result.candidates[0]), state: "active", evidenceTier: "externally_verified" },
        correctionSourceEventIds: new Set([material.correction.event.eventId]),
      });
      expect(decision.reasons).toContain("unresolved_counterevidence");
      expect(decision.admitted).toBe(false);
    },
  );

  it("requires a later user resolution of the exact counterevidence and does not resolve future failures", () => {
    const material = source();
    const candidate = required(project(material.envelopes).candidates[0]);
    const counter = event("failure", 5, "verification.completed", {
      completionStatus: "failed",
      parentEventId: material.verification.event.eventId,
    });
    const envelopes = [...material.envelopes, counter];
    expect(project(envelopes, [feedback(candidate.knowledgeId, 6, "confirm")]).candidates[0]?.state)
      .toBe("disputed");
    const resolve = feedback(candidate.knowledgeId, 6, "confirm", {
      resolvesEvidenceIds: [counter.event.eventId],
    });
    expect(project(envelopes, [resolve]).candidates[0]?.state).toBe("active");
    expect(project(envelopes, [{ ...resolve, source: "analyzer" }]).candidates[0]?.state).toBe("disputed");
    const later = event("later-failure", 7, "test.completed", {
      completionStatus: "failed",
      parentEventId: material.verification.event.eventId,
    });
    expect(project([...envelopes, later], [resolve]).candidates[0]?.state).toBe("disputed");
  });

  it("does not reopen revoked knowledge with an ordinary confirmation", () => {
    const material = source();
    const candidate = required(project(material.envelopes).candidates[0]);
    const revoked = feedback(candidate.knowledgeId, 5, "revoke");
    const confirmed = feedback(candidate.knowledgeId, 6, "confirm");
    const result = project(material.envelopes, [revoked, confirmed]);
    expect(result.candidates[0]).toMatchObject({ state: "archived", expiresAt: timestamp(5) });
  });

  it("does not let late feedback supersede a newer behavior, but accepts a newly verified correction", () => {
    const material = source();
    const previousId = required(project(material.envelopes).candidates[0]).knowledgeId;
    const revised = event("revised", 5, "user.corrected", {
      content: { message: formatExplicitCorrectionMessage({
        expectedBehavior: "Use opaque trace identifiers",
        scope: "repository",
        trigger: "logging",
        violatedConstraint: "Do not expose accounts in logs",
      }) },
    });
    const proof = verificationFixture(revised, event("revised-test", 7, "test.completed", {
      completionStatus: "succeeded",
    }));
    const envelopes = [...material.envelopes, revised, proof.operation, proof.verification];
    const confirmed = project(envelopes, [feedback(previousId, 9, "confirm")]);
    expect(confirmed.candidates.find((candidate) => candidate.knowledgeId === previousId)?.state)
      .toBe("superseded");
    expect(confirmed.candidates.find((candidate) => candidate.content === "Use opaque trace identifiers")?.state)
      .toBe("active");

    const restored = correction("restored", 10);
    const restoredProof = verificationFixture(restored, event("restored-test", 12, "test.completed", {
      completionStatus: "succeeded",
    }));
    const result = project([...envelopes, restored, restoredProof.operation, restoredProof.verification]);
    expect(result.candidates.find((candidate) => candidate.knowledgeId === previousId)?.state)
      .toBe("active");
  });

  it("keeps user confirmation distinct from execution verification", () => {
    const material = correction();
    const candidate = required(project([material]).candidates[0]);
    const result = project([material], [feedback(candidate.knowledgeId, 5, "confirm")]);
    expect(result.candidates[0]).toMatchObject({
      evidenceMarks: ["user_confirmed"],
      evidenceTier: "user_confirmed",
      state: "candidate",
    });
  });

  it("does not call a failed, unrepeated opportunity helpful or harmful", () => {
    const material = source();
    const previous = project(material.envelopes).candidates;
    const next = [
      ...material.envelopes,
      event("next-prompt", 43_200, "prompt.submitted", {
        branch: "next",
        content: { message: "logging" },
        sessionId: "session-next",
      }),
      event("next-failure", 43_210, "test.completed", {
        branch: "next",
        completionStatus: "failed",
        sessionId: "session-next",
      }),
    ];
    const nextEpisode = required(project(next).input.workEpisodes.find((episode) =>
      episode.sessionIds.includes("session-next"),
    ));
    const previousId = required(previous[0]).knowledgeId;
    const use: ContextUseRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [previousId],
      candidateKnowledgeIds: [],
      createdAt: timestamp(43_205),
      episodeId: nextEpisode.episodeId,
      latencyMs: 1,
      renderedTokens: 10,
      requestId: "next-request",
      returnedKnowledgeIds: [previousId],
      sessionId: "session-next",
    };
    const result = project(next, [], [use], previous);
    expect(result.corrections.opportunities[0]).toMatchObject({
      correctionRepeated: false,
      knowledgeAppliedBeforeCorrection: true,
      outcomeKnown: true,
    });
    expect(result.candidates[0]?.utility).toEqual({ applied: 1, helpful: 0, harmful: 0 });
    const explicit = project(next, [
      feedback(previousId, 43_211, "strengthen", { evidenceRef: use.requestId }),
    ], [use], previous);
    expect(explicit.candidates[0]?.utility).toEqual({ applied: 1, helpful: 1, harmful: 0 });
  });
});
