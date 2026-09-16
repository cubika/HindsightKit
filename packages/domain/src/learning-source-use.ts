import { learningProposalSource, type CaptureEnvelope, type ContextUseRecord, type KnowledgeCandidate, type RuleProposal } from "@provenloop/contracts";
import { assessLearningRetention } from "./learning-retention.js";
import { sha256 } from "./digest.js";
import { validAgentLearningSource } from "./agent-learning-source.js";
import { isInternalWorkSource } from "./work-source.js";
import { containsPotentialSecret } from "./redaction.js";
import { hasAcceptedLearningDistillation, validLearningDiscoveryMetadata } from "./learning-distillation.js";

export interface LearningSourceUse {
  readonly mode: "convention" | "reference";
  readonly proposal: RuleProposal;
  readonly sources: readonly { eventId: string; quote: string; role: "user" | "tool" }[];
  readonly worktree: string;
  readonly commitSha?: string;
  readonly researchSummary?: string;
  readonly distilledLesson?: string;
}

/** Eligibility for quoted conventions and references; never an execution-verification receipt. */
export const learningSourceUse = (
  candidate: KnowledgeCandidate,
  proposals: readonly RuleProposal[],
  envelopes: readonly CaptureEnvelope[],
  contextUseRecords: readonly ContextUseRecord[] = [],
): LearningSourceUse | undefined => {
  if (candidate.state !== "candidate" || candidate.evidenceTier !== "inferred" || candidate.scope !== "repository" ||
      !candidate.scopeId || candidate.conflictsWith.length > 0) return undefined;
  const byId = new Map(envelopes.map((entry) => [entry.event.eventId, entry]));
  for (const proposal of proposals) {
    if (proposal.knowledgeId !== candidate.knowledgeId || proposal.predicate || proposal.shellPredicate ||
        !["convention", "reference"].includes(proposal.retention?.kind ?? "") ||
        candidate.content !== proposal.rule || sha256(candidate.appliesWhen) !== sha256([proposal.trigger]) ||
        sha256(candidate.nonApplicability) !== sha256(proposal.exclusions) ||
        candidate.sourceEvidenceIds.length !== proposal.sourceDigests.length) continue;
    const source = learningProposalSource(proposal);
    const anchor = byId.get(source.eventId);
    if (!anchor?.event.worktree || !anchor.event.sessionId || anchor.event.repoId !== candidate.scopeId) continue;
    const events: CaptureEnvelope[] = [];
    for (const reference of proposal.sourceDigests) {
      const event = byId.get(reference.eventId);
      if (!event || isInternalWorkSource(event.event) || !candidate.sourceEvidenceIds.includes(reference.eventId) || sha256(event) !== reference.digest ||
          event.event.repoId !== candidate.scopeId || event.event.worktree !== anchor.event.worktree ||
          event.event.sessionId !== anchor.event.sessionId) break;
      events.push(event);
    }
    if (events.length !== proposal.sourceDigests.length) continue;
    if (proposal.userSource && (anchor.event.trust !== "user" || anchor.event.eventType !== "prompt.submitted" ||
        !anchor.content?.message?.includes(proposal.userSource.quote))) continue;
    if (proposal.agentSource && !validAgentLearningSource(proposal, events)) continue;
    const decision = assessLearningRetention(proposal, events, { repoId: candidate.scopeId, worktree: anchor.event.worktree });
    if (!decision.retain || !decision.reusable) continue;
    const end = Math.max(...events.map((entry) => Date.parse(entry.event.timestamp)));
    if (contextUseRecords.some((record) => record.sessionId === anchor.event.sessionId &&
        Date.parse(record.createdAt) <= end && record.returnedKnowledgeIds.some((id) =>
          id === candidate.knowledgeId || id === `knowledge:${candidate.knowledgeId}`))) continue;
    const mode = proposal.retention?.kind;
    const distilled = hasAcceptedLearningDistillation(proposal, proposal.sourceDigests);
    if (candidate.discovery && (!distilled || sha256(candidate.discovery) !== sha256(proposal.discovery) ||
        !validLearningDiscoveryMetadata(proposal, events))) continue;
    if (mode === "convention" && proposal.userSource) {
      const original = anchor.content?.message;
      // Keep exceptions outside the extractor's selected span. Long messages need deliberate review.
      if (!original || (!distilled && original.length > 2048)) continue;
      return { mode, proposal, worktree: anchor.event.worktree,
        ...(distilled ? { distilledLesson: proposal.rule } : {}),
        sources: [{ ...proposal.userSource, quote: distilled ? proposal.userSource.quote : original, role: "user" }] };
    }
    if (mode === "reference") {
      const quotes = (proposal.supportingSources ?? proposal.agentSource?.evidenceSources ?? [])
        .filter((quote) => byId.get(quote.eventId)?.event.trust === "tool");
      if (quotes.length === 0 || quotes.some((quote) => containsPotentialSecret(quote.quote))) continue;
      const versions = new Set(quotes.map((quote) => byId.get(quote.eventId)?.event.commitSha));
      // Preserve the observed revision so retrieval can distinguish current and changed code.
      if (versions.size !== 1 || versions.has(undefined)) continue;
      const commitSha = [...versions][0];
      if (!commitSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commitSha)) continue;
      if (proposal.agentSource?.kind === "research" && containsPotentialSecret(proposal.rule)) continue;
      return { mode, proposal, worktree: anchor.event.worktree, ...(commitSha ? { commitSha } : {}),
        ...(distilled ? { distilledLesson: proposal.rule } : proposal.agentSource?.kind === "research" ? { researchSummary: proposal.rule } : {}),
        sources: quotes.map((quote) => ({ ...quote, role: "tool" })) };
    }
  }
  return undefined;
};
