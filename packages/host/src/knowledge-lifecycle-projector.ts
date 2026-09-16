import type {
  CaptureEnvelope,
  ContextUseRecord,
  CorrectionKey,
  CorrectionOpportunity,
  FeedbackEvent,
  KnowledgeCandidate,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  KnowledgeLifecycleBuilder,
  type KnowledgeAdmissionDecision,
} from "@provenloop/domain";

export interface KnowledgeLifecycleProjectionStore {
  contextUseRecordsForEpisodes(
    episodeIds: readonly string[],
  ): readonly ContextUseRecord[];
  correctionKeys(): readonly CorrectionKey[];
  correctionOpportunities(): readonly CorrectionOpportunity[];
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  feedbackEvents(): readonly FeedbackEvent[];
  hasActiveDeletion(): boolean;
  knowledgeDeletionBlocked(knowledgeId: string): boolean;
  replaceCorrectionKnowledgeCandidates(input: {
    readonly allowDuringDeletion?: boolean;
    readonly candidates: readonly KnowledgeCandidate[];
  }): number;
  workEpisodes(): readonly WorkEpisode[];
}

export interface KnowledgeLifecycleProjectorOptions {
  readonly builder?: KnowledgeLifecycleBuilder;
  readonly store: KnowledgeLifecycleProjectionStore;
}

export interface KnowledgeLifecycleProjectionResult {
  readonly admissionDecisions: readonly KnowledgeAdmissionDecision[];
  readonly candidates: readonly KnowledgeCandidate[];
  readonly persistedCandidates: number;
  readonly suppressedForgottenKnowledgeIds: readonly string[];
}

export interface KnowledgeLifecycleRebuildOptions {
  readonly allowDuringDeletion?: boolean;
  readonly envelopes?: readonly CaptureEnvelope[];
}

export class KnowledgeLifecycleProjector {
  readonly #builder: KnowledgeLifecycleBuilder;
  readonly #store: KnowledgeLifecycleProjectionStore;

  public constructor(options: KnowledgeLifecycleProjectorOptions) {
    this.#builder = options.builder ?? new KnowledgeLifecycleBuilder();
    this.#store = options.store;
  }

  public rebuild(
    options: KnowledgeLifecycleRebuildOptions = {},
  ): KnowledgeLifecycleProjectionResult {
    if (
      this.#store.hasActiveDeletion() &&
      options.allowDuringDeletion !== true
    ) {
      throw new Error(
        "Knowledge lifecycle projection is blocked by an active deletion.",
      );
    }
    const correctionKeys = this.#store.correctionKeys();
    const workEpisodes = this.#store.workEpisodes();
    const correctionEvidenceIds = new Set(
      correctionKeys.flatMap((key) => [
        ...key.sourceCorrectionEventIds,
        ...key.verificationEvidenceIds,
      ]),
    );
    const sourceEpisodeIds = workEpisodes
      .filter((episode) =>
        episode.sourceEventIds.some((eventId) =>
          correctionEvidenceIds.has(eventId),
        ),
      )
      .map((episode) => episode.episodeId);
    const built = this.#builder.build({
      contextUseRecords:
        this.#store.contextUseRecordsForEpisodes(sourceEpisodeIds),
      correctionKeys,
      correctionOpportunities:
        this.#store.correctionOpportunities(),
      envelopes: options.envelopes ?? this.#store.episodeSourceEnvelopes(),
      feedbackEvents: this.#store.feedbackEvents(),
      workEpisodes,
    });
    const suppressedForgottenKnowledgeIds = built.candidates
      .filter((candidate) =>
        this.#store.knowledgeDeletionBlocked(candidate.knowledgeId),
      )
      .map((candidate) => candidate.knowledgeId)
      .sort();
    const candidates = built.candidates.filter(
      (candidate) =>
        !suppressedForgottenKnowledgeIds.includes(
          candidate.knowledgeId,
        ),
    );
    const candidateIds = new Set(
      candidates.map((candidate) => candidate.knowledgeId),
    );
    return {
      admissionDecisions: built.admissionDecisions.filter(
        (item) => candidateIds.has(item.knowledgeId),
      ),
      candidates,
      persistedCandidates:
        this.#store.replaceCorrectionKnowledgeCandidates({
          ...(options.allowDuringDeletion === true
            ? {
                allowDuringDeletion: true,
              }
            : {}),
          candidates,
        }),
      suppressedForgottenKnowledgeIds,
    };
  }
}
