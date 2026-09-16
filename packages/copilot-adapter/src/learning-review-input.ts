import type { LearningComparisonCandidate, LearningWindow, RuleProposalInput } from "@provenloop/contracts";
import { learningDiscoverySourceContext } from "@provenloop/domain";
import { LearningInputBudgetError, LEARNING_REQUEST_MAX_BYTES, LEARNING_REQUEST_MAX_CHARACTERS } from "./learning-input.js";

/** All spans have already passed extraction-view and canonical source validation. */
export const prepareLearningReviewInput = (
  window: LearningWindow, proposals: readonly RuleProposalInput[],
  priorKnowledge: readonly LearningComparisonCandidate[], instructions: string,
): string => {
  const anchors = new Set(proposals.map((proposal) => proposal.userSource?.eventId ?? proposal.agentSource?.eventId));
  const sourceContext = window.events.filter((entry) => anchors.has(entry.event.eventId)).map((entry) => ({
    eventId: entry.event.eventId, role: entry.event.trust, text: entry.content?.message,
  }));
  const citations = [...new Map(proposals.flatMap((proposal) => [
    ...(proposal.userSource ? [proposal.userSource] : proposal.agentSource ? [{ eventId: proposal.agentSource.eventId, quote: proposal.agentSource.quote }] : []),
    ...(proposal.supportingSources ?? []), ...(proposal.agentSource?.evidenceSources ?? []),
  ]).map((source) => [JSON.stringify(source), source])).values()];
  // Do not repeat full anchor quotations inside every proposal and then excerpt
  // that same anchor again. The complete message remains visible exactly once.
  const compact = proposals.map((proposal, index) => {
    const { userSource, agentSource, supportingSources: _supportingSources, ...meaning } = proposal;
    void _supportingSources;
    return { index, proposal: meaning, sourceRole: userSource ? "user" : "agent",
      anchorEventId: userSource?.eventId ?? agentSource?.eventId,
      citedEventIds: [...new Set([...(proposal.supportingSources ?? []), ...(agentSource?.evidenceSources ?? [])].map((source) => source.eventId))],
    };
  });
  const prompt = instructions + JSON.stringify({ repoId: window.repoId, worktree: window.worktree, origin: window.origin ?? "user",
    proposals: compact, sourceContext, citations, priorKnowledge,
    ...(proposals.some((proposal) => proposal.discovery?.sourceReferences?.length) ? {
      sourceMetadata: learningDiscoverySourceContext(proposals, window.events),
    } : {}),
    evidenceLimit: "Only captured anchors and validated cited passages are shown; do not infer absent proof or expand scope.",
  });
  if (Buffer.byteLength(prompt, "utf8") > LEARNING_REQUEST_MAX_BYTES || prompt.length > LEARNING_REQUEST_MAX_CHARACTERS) throw new LearningInputBudgetError();
  return prompt;
};
