import type {
  CaptureEnvelope,
  FeedbackEvent,
} from "@provenloop/contracts";

import {
  boundVerificationOperation,
  sameVerificationWorkspace,
  trustedExecution,
  verificationBinding,
  verificationOutcome,
} from "./verification-proof.js";

export const directKnowledgeCounterevidence = (
  envelopes: readonly CaptureEnvelope[],
  sourceEvidenceIds: ReadonlySet<string>,
  createdAt: string,
): readonly CaptureEnvelope[] => {
  const eventsById = new Map(envelopes.map((item) => [item.event.eventId, item]));
  return envelopes.filter((envelope) => {
    if (
      !trustedExecution(envelope) ||
      Date.parse(envelope.event.timestamp) < Date.parse(createdAt) ||
      (
        envelope.event.eventType !== "change.reverted" &&
        verificationOutcome(envelope) !== "failed"
      )
    ) {
      return false;
    }
    let child = envelope;
    const visited = new Set<string>();
    while (child.event.parentEventId !== undefined) {
      const parent = eventsById.get(child.event.parentEventId);
      if (
        parent === undefined ||
        visited.has(parent.event.eventId) ||
        !sameVerificationWorkspace(parent, child) ||
        Date.parse(parent.event.timestamp) > Date.parse(child.event.timestamp)
      ) {
        break;
      }
      if (sourceEvidenceIds.has(parent.event.eventId)) {
        return true;
      }
      if (
        !trustedExecution(parent) ||
        (parent.event.eventType !== "change.reverted" && verificationOutcome(parent) !== "failed")
      ) {
        break;
      }
      visited.add(parent.event.eventId);
      child = parent;
    }
    const binding = verificationBinding(envelope);
    const correction = binding === undefined
      ? undefined
      : eventsById.get(binding.correctionEventId);
    return correction !== undefined &&
      sourceEvidenceIds.has(correction.event.eventId) &&
      boundVerificationOperation(correction, envelope, eventsById) !== undefined;
  });
};

export interface KnowledgeEvidenceState {
  readonly archived: boolean;
  readonly unresolvedEvidenceIds: readonly string[];
}

export const knowledgeEvidenceState = (input: {
  readonly counters: readonly CaptureEnvelope[];
  readonly createdAt: string;
  readonly feedbackEvents: readonly FeedbackEvent[];
  readonly knowledgeId: string;
}): KnowledgeEvidenceState => {
  const pending = new Map<string, { readonly archived: boolean; readonly timestamp: string }>();
  const timeline = [
    ...input.counters.map((counter) => ({
      id: counter.event.eventId,
      timestamp: counter.event.timestamp,
      counter,
      feedback: undefined,
    })),
    ...input.feedbackEvents
      .filter((feedback) =>
        feedback.targetType === "knowledge" &&
        feedback.targetId === input.knowledgeId &&
        Date.parse(feedback.timestamp) >= Date.parse(input.createdAt),
      )
      .map((feedback) => ({
        id: feedback.feedbackId,
        timestamp: feedback.timestamp,
        counter: undefined,
        feedback,
      })),
  ].sort((left, right) =>
    Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
    left.id.localeCompare(right.id),
  );
  for (const item of timeline) {
    const feedback = item.feedback;
    if (feedback === undefined) {
      pending.set(item.id, { archived: false, timestamp: item.timestamp });
    } else if (["correct", "conflict", "weaken", "stale", "revoke"].includes(feedback.kind)) {
      pending.set(item.id, {
        archived: feedback.kind === "stale" || feedback.kind === "revoke",
        timestamp: item.timestamp,
      });
    } else if (feedback.kind === "confirm" && feedback.source === "user") {
      for (const evidenceId of feedback.resolvesEvidenceIds ?? []) {
        const unresolved = pending.get(evidenceId);
        if (
          unresolved !== undefined &&
          Date.parse(unresolved.timestamp) < Date.parse(feedback.timestamp)
        ) {
          pending.delete(evidenceId);
        }
      }
    }
  }
  return {
    archived: [...pending.values()].some((item) => item.archived),
    unresolvedEvidenceIds: [...pending.keys()].sort(),
  };
};
