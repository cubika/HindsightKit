import {
  knowledgeCandidateSchema,
  type KnowledgeCandidate,
  type RuleProposal,
  type DiscoveryProfile,
} from "@provenloop/contracts";
import { buildDiscoveryProfile, containsPotentialSecret, DISCOVERY_VOCABULARY_VERSION, hasAcceptedLearningDistillation, sha256, validateDiscoveryProfile } from "@provenloop/domain";

import type {
  CanonicalKnowledgeStore,
  KnowledgeBackend,
  KnowledgeProjection,
} from "./types.js";
import { AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS } from "./types.js";

const reviewedProposals = (candidate: KnowledgeCandidate, proposals: readonly RuleProposal[]): readonly RuleProposal[] =>
  proposals.filter((proposal) =>
    proposal.knowledgeId === candidate.knowledgeId && proposal.rule === candidate.content &&
    sha256([proposal.trigger]) === sha256(candidate.appliesWhen) && sha256(proposal.exclusions) === sha256(candidate.nonApplicability) &&
    sha256(proposal.discovery ?? null) === sha256(candidate.discovery ?? null) &&
    proposal.sourceDigests.length === candidate.sourceEvidenceIds.length &&
    proposal.sourceDigests.every((source) => candidate.sourceEvidenceIds.includes(source.eventId)) &&
    hasAcceptedLearningDistillation(proposal, proposal.sourceDigests),
  );

export const reviewedRetrievalScope = (
  candidate: KnowledgeCandidate, proposals: readonly RuleProposal[],
): RuleProposal["retrievalScope"] => {
  const scopes = reviewedProposals(candidate, proposals).flatMap((proposal) => proposal.retrievalScope &&
    !proposal.retrievalScope.excludedTasks.some(containsPotentialSecret) ? [proposal.retrievalScope] : []);
  return scopes.length ? { excludedTasks: [...new Set(scopes.flatMap((scope) => scope.excludedTasks))].sort() } : undefined;
};

export const knowledgeProjectionFromCandidate = (
  input: KnowledgeCandidate,
  proposals: readonly RuleProposal[] = [],
  enrichment?: DiscoveryProfile,
): KnowledgeProjection => {
  const candidate = knowledgeCandidateSchema.parse(input);
  const acceptedEnrichment = enrichment && validateDiscoveryProfile(candidate, enrichment) ? enrichment : undefined;
  const reviewed = reviewedProposals(candidate, proposals);
  const retrievalScope = reviewedRetrievalScope(candidate, reviewed);
  const queryTerms = reviewed.flatMap((proposal) => {
    if (!proposal.queryTerms) return [];
    const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();
    const quotes = [proposal.userSource?.quote, proposal.agentSource?.quote,
      ...(proposal.supportingSources ?? []).map((source) => source.quote),
      ...(proposal.agentSource?.evidenceSources ?? []).map((source) => source.quote),
    ].filter((quote): quote is string => quote !== undefined).map(normalize);
    return [...proposal.queryTerms.include, ...proposal.queryTerms.exclude].every((term) =>
      !containsPotentialSecret(term) && quotes.some((quote) => quote.includes(normalize(term))))
      ? [proposal.queryTerms] : [];
  });
  const searchAliases = [...new Set([
    ...reviewed.flatMap((proposal) => proposal.canonicalKey && !containsPotentialSecret(proposal.canonicalKey) ? [proposal.canonicalKey] : []),
    ...queryTerms.flatMap((terms) => terms.include),
  ])].sort();
  const searchExclusions = [...new Set(queryTerms.flatMap((terms) => terms.exclude))].sort();
  // This is a cheap discovery filter, not an evidence-admission certificate.
  // Candidate conventions/references still require the canonical source review.
  const retrievalMetadata = {
    discoveryVersion: DISCOVERY_VOCABULARY_VERSION,
    scope: candidate.scope,
    ...(candidate.scopeId === undefined ? {} : { scopeId: candidate.scopeId }),
    eligible: (candidate.scope === "personal" || candidate.scopeId !== undefined) &&
      (candidate.state === "candidate" || (candidate.state === "active" &&
        AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS.has(candidate.evidenceTier))),
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
  };
  return {
    ...(acceptedEnrichment ? { discoveryProfile: acceptedEnrichment } : candidate.state === "active" || reviewed.length > 0 ? { discoveryProfile: buildDiscoveryProfile(candidate, candidate.discovery, reviewed[0]?.distillation ? {
      reviewedBy: reviewed[0].distillation.reviewer.provider + "/" + reviewed[0].distillation.reviewer.model,
      reviewVersion: reviewed[0].distillation.reviewer.version,
    } : {}) } : {}),
    appliesWhen: candidate.appliesWhen,
    content: candidate.content,
    knowledgeId: candidate.knowledgeId,
    nonApplicability: candidate.nonApplicability,
    projectionVersion: 1,
    retrievalMetadata,
    // Search hints affect discovery and filtering; bind both to the reviewed canonical state.
    sourceDigest: searchAliases.length || searchExclusions.length || retrievalScope ? sha256({ candidate,
      ...(searchAliases.length ? { searchAliases } : {}), ...(searchExclusions.length ? { searchExclusions } : {}),
      ...(retrievalScope ? { retrievalScope } : {}),
    }) : sha256(candidate),
    ...(searchAliases.length ? { searchAliases } : {}),
    ...(searchExclusions.length ? { searchExclusions } : {}),
    topicKey: candidate.topicKey,
  };
};

export class KnowledgeProjectionManager {
  readonly #backend: KnowledgeBackend;
  readonly #store: CanonicalKnowledgeStore;

  public constructor(options: {
    readonly backend: KnowledgeBackend;
    readonly store: CanonicalKnowledgeStore;
  }) {
    this.#backend = options.backend;
    this.#store = options.store;
  }

  public async rebuild(): Promise<number> {
    return this.#publish(false);
  }

  public async synchronize(): Promise<number> {
    return this.#publish(true);
  }

  async #publish(incremental: boolean): Promise<number> {
    const candidates = this.#store.knowledgeCandidates();
    const deleted = this.#store
      .knowledgeCandidatesWithUnavailableSources(candidates);
    const available = candidates.filter((candidate) => !deleted.has(candidate.knowledgeId));
    const proposalsById = new Map<string, RuleProposal[]>();
    for (const proposal of this.#store.learningProposals?.(available.map((candidate) => candidate.knowledgeId)) ?? []) {
      const entries = proposalsById.get(proposal.knowledgeId) ?? [];
      entries.push(proposal); proposalsById.set(proposal.knowledgeId, entries);
    }
    const enrichment = this.#store.discoveryProfiles?.(available);
    const records = available.map((candidate) => knowledgeProjectionFromCandidate(candidate, proposalsById.get(candidate.knowledgeId), enrichment?.get(candidate.knowledgeId)));
    if (incremental && this.#backend.synchronize !== undefined) {
      await this.#backend.synchronize({ records });
    } else {
      await this.#backend.rebuild({ records });
    }
    return records.length;
  }
}
