import type {
  CaptureEnvelope,
  ContextUseRecord,
  CorrectionKey,
  CorrectionOpportunity,
  KnowledgeCandidate,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  CorrectionCaptureBuilder,
  type CorrectionCaptureBuildResult,
} from "@provenloop/domain";

export interface CorrectionCaptureProjectionStore {
  contextUseRecords(): readonly ContextUseRecord[];
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  hasActiveDeletion(): boolean;
  knowledgeCandidates(): readonly KnowledgeCandidate[];
  replaceCorrectionProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly correctionKeys: readonly CorrectionKey[];
    readonly opportunities: readonly CorrectionOpportunity[];
  }): {
    readonly correctionKeys: number;
    readonly opportunities: number;
  };
  workEpisodes(): readonly WorkEpisode[];
}

export interface CorrectionCaptureProjectorOptions {
  readonly builder?: CorrectionCaptureBuilder;
  readonly store: CorrectionCaptureProjectionStore;
}

export interface CorrectionCaptureProjectionResult
extends CorrectionCaptureBuildResult {
  readonly persistedCorrectionKeys: number;
  readonly persistedOpportunities: number;
}

export interface CorrectionCaptureRebuildOptions {
  readonly allowDuringDeletion?: boolean;
  readonly envelopes?: readonly CaptureEnvelope[];
}

export class CorrectionCaptureProjector {
  readonly #builder: CorrectionCaptureBuilder;
  readonly #store: CorrectionCaptureProjectionStore;

  public constructor(options: CorrectionCaptureProjectorOptions) {
    this.#builder = options.builder ?? new CorrectionCaptureBuilder();
    this.#store = options.store;
  }

  public rebuild(
    options: CorrectionCaptureRebuildOptions = {},
  ): CorrectionCaptureProjectionResult {
    if (
      this.#store.hasActiveDeletion() &&
      options.allowDuringDeletion !== true
    ) {
      throw new Error(
        "Correction capture projection is blocked by an active deletion.",
      );
    }
    const result = this.#builder.build({
      contextUseRecords: this.#store.contextUseRecords(),
      envelopes: options.envelopes ?? this.#store.episodeSourceEnvelopes(),
      knowledgeCandidates: this.#store.knowledgeCandidates(),
      workEpisodes: this.#store.workEpisodes(),
    });
    const persisted = this.#store.replaceCorrectionProjection({
      ...(options.allowDuringDeletion === true
        ? {
            allowDuringDeletion: true,
          }
        : {}),
      correctionKeys: result.correctionKeys,
      opportunities: result.opportunities,
    });
    return {
      ...result,
      persistedCorrectionKeys: persisted.correctionKeys,
      persistedOpportunities: persisted.opportunities,
    };
  }
}
