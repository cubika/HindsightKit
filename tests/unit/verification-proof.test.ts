import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type FeedbackEvent } from "@provenloop/contracts";
import {
  createCaptureEnvelope,
  directKnowledgeCounterevidence,
  knowledgeEvidenceState,
  type CaptureEventInput,
} from "@provenloop/domain";
import {
  boundVerificationOperation,
  independentlyVerifiedCorrections,
  verificationOutcome,
} from "../../packages/domain/src/verification-proof.js";
import { verificationFixture } from "./domain-proof-fixture.js";

const event = (id: string, minute: number, extra: Partial<CaptureEventInput> = {}) =>
  createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    eventType: "user.corrected",
    repoId: "repo-1",
    sessionId: "session-1",
    sourceEventId: id,
    timestamp: `2026-09-01T00:0${minute}:00.000Z`,
    trust: "user",
    worktree: "C:\\repo",
    ...extra,
  });

const source = () => {
  const correction = event("correction", 0);
  const proof = verificationFixture(correction, event("verification", 2, {
    completionStatus: "succeeded",
    eventType: "verification.completed",
    trust: "tool",
  }));
  const envelopes = [correction, proof.operation, proof.verification];
  return {
    ...proof,
    correction,
    envelopes,
    eventsById: new Map(envelopes.map((item) => [item.event.eventId, item])),
  };
};

describe("Deterministic proof primitives", () => {
  it("requires both captured operation identity and correction ancestry", () => {
    const input = source();
    expect(boundVerificationOperation(input.correction, input.verification, input.eventsById))
      .toEqual(input.operation);
    expect(boundVerificationOperation(
      input.correction,
      { ...input.verification, event: { ...input.verification.event, operationId: "other-call" } },
      input.eventsById,
    )).toBeUndefined();
    const withoutOperation = new Map(input.eventsById);
    withoutOperation.delete(input.operation.event.eventId);
    expect(boundVerificationOperation(input.correction, input.verification, withoutOperation))
      .toBeUndefined();
    const omittedTarget = new Map(input.eventsById);
    omittedTarget.set(input.operation.event.eventId, {
      ...input.operation,
      event: {
        ...input.operation.event,
        redactedArguments: { kind: "object", status: "omitted_in_callback" },
      },
    });
    expect(boundVerificationOperation(input.correction, input.verification, omittedTarget))
      .toBeUndefined();
  });

  it("normalizes Windows workspace spelling but does not accept unknown or other worktrees", () => {
    const input = source();
    const candidate = (worktree: string | undefined) => ({
      ...input.verification,
      event: { ...input.verification.event, worktree },
    });
    expect(boundVerificationOperation(input.correction, candidate("c:/REPO/"), input.eventsById))
      .toEqual(input.operation);
    expect(boundVerificationOperation(input.correction, candidate(undefined), input.eventsById))
      .toBeUndefined();
    expect(boundVerificationOperation(input.correction, candidate("C:\\repo-next"), input.eventsById))
      .toBeUndefined();
    expect(boundVerificationOperation(input.correction, {
      ...input.verification,
      redaction: { ...input.verification.redaction, redactedPaths: ["event.worktree"] },
    }, input.eventsById)).toBeUndefined();
  });

  it.each(["unknown", "known_outside_repo"] as const)(
    "rejects explicit repository state %s even when stale repository strings remain",
    (repositoryState) => {
      const input = source();
      for (const selected of [input.correction, input.operation, input.verification]) {
        const envelopes = input.envelopes.map((item) =>
          item.event.eventId === selected.event.eventId
            ? { ...item, event: { ...item.event, repositoryState } }
            : item,
        );
        const byId = new Map(envelopes.map((item) => [item.event.eventId, item]));
        const correction = byId.get(input.correction.event.eventId);
        const verification = byId.get(input.verification.event.eventId);
        if (correction === undefined || verification === undefined) {
          throw new Error("Expected the complete proof fixture.");
        }
        expect(boundVerificationOperation(correction, verification, byId)).toBeUndefined();
      }
    },
  );

  it("does not let a known top-level identity override unknown evidence provenance", () => {
    const input = source();
    expect(boundVerificationOperation(input.correction, {
      ...input.verification,
      event: {
        ...input.verification.event,
        repositoryState: "known_repo",
        evidence: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          kind: "command_verification",
          repositoryState: "unknown",
        },
      },
    }, input.eventsById)).toBeUndefined();
    expect(boundVerificationOperation(input.correction, {
      ...input.verification,
      event: {
        ...input.verification.event,
        repositoryState: "known_repo",
        evidence: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          kind: "command_verification",
          repositoryState: "known_repo",
        },
      },
    }, input.eventsById)).toEqual(input.operation);
  });

  it("counts a reused operation only once even when represented by different event IDs", () => {
    const first = source();
    const secondCorrection = event("second-correction", 3);
    const second = verificationFixture(secondCorrection, event("second-verification", 5, {
      completionStatus: "succeeded",
      eventType: "test.completed",
      trust: "tool",
    }));
    const reusedOperation = {
      ...second.operation,
      event: { ...second.operation.event, operationId: first.operation.event.operationId },
    };
    const reusedVerification = {
      ...second.verification,
      event: { ...second.verification.event, operationId: first.operation.event.operationId },
    };
    const envelopes = [...first.envelopes, secondCorrection, reusedOperation, reusedVerification];
    expect(independentlyVerifiedCorrections(
      [first.correction, secondCorrection],
      [first.verification, reusedVerification],
      new Map(envelopes.map((item) => [item.event.eventId, item])),
    )).toHaveLength(1);
  });

  it("recognizes failures symmetrically and never treats a model claim as execution evidence", () => {
    for (const eventType of ["test.completed", "build.completed", "verification.completed"]) {
      expect(verificationOutcome(event("failed", 4, {
        completionStatus: "succeeded",
        eventType,
        exitCode: 1,
        trust: "tool",
      }))).toBe("failed");
      expect(verificationOutcome(event("claim", 4, {
        completionStatus: "succeeded",
        eventType,
        trust: "model",
      }))).toBe("unknown");
      expect(verificationOutcome(event("cancelled", 4, {
        completionStatus: "cancelled",
        eventType,
        exitCode: 1,
        trust: "tool",
      }))).toBe("unknown");
    }
  });

  it("recognizes direct counterevidence only in the original workspace", () => {
    const input = source();
    const failure = event("failed", 4, {
      eventType: "verification.completed",
      exitCode: 1,
      parentEventId: input.verification.event.eventId,
      trust: "tool",
    });
    const ids = new Set([input.verification.event.eventId]);
    expect(directKnowledgeCounterevidence(
      [...input.envelopes, failure], ids, input.correction.event.timestamp,
    )).toEqual([failure]);
    expect(directKnowledgeCounterevidence([
      ...input.envelopes,
      { ...failure, event: { ...failure.event, repoId: "other-repo" } },
    ], ids, input.correction.event.timestamp)).toEqual([]);
  });

  it("replays explicit resolutions chronologically without resolving future evidence", () => {
    const counter = event("failure", 4, { eventType: "test.completed", trust: "tool", exitCode: 1 });
    const confirm: FeedbackEvent = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      evidenceRef: "user-confirmation",
      feedbackId: "confirm",
      kind: "confirm",
      source: "user",
      targetId: "knowledge-1",
      targetType: "knowledge",
      timestamp: event("old", 3).event.timestamp,
    };
    const input = {
      counters: [counter],
      createdAt: event("created", 0).event.timestamp,
      feedbackEvents: [confirm],
      knowledgeId: "knowledge-1",
    };
    expect(knowledgeEvidenceState(input).unresolvedEvidenceIds).toEqual([counter.event.eventId]);
    const resolve = {
      ...confirm,
      resolvesEvidenceIds: [counter.event.eventId],
      timestamp: event("resolved", 5).event.timestamp,
    };
    expect(knowledgeEvidenceState({ ...input, feedbackEvents: [resolve] }).unresolvedEvidenceIds)
      .toEqual([]);
    expect(knowledgeEvidenceState({
      ...input,
      feedbackEvents: [{ ...resolve, timestamp: counter.event.timestamp }],
    }).unresolvedEvidenceIds).toEqual([counter.event.eventId]);
    const later = event("future", 6, { eventType: "test.completed", trust: "tool", exitCode: 1 });
    expect(knowledgeEvidenceState({
      ...input, counters: [counter, later], feedbackEvents: [resolve],
    }).unresolvedEvidenceIds).toEqual([later.event.eventId]);
  });
});
