import type {
  BranchContext,
  CaptureEnvelope,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  BranchContextBuilder,
} from "@provenloop/domain";

export interface BranchContextProjectionStore {
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  hasActiveDeletion(): boolean;
  replaceBranchContextProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly contexts: readonly BranchContext[];
  }): number;
  workEpisodes(): readonly WorkEpisode[];
}

export interface BranchContextProjectorOptions {
  readonly builder?: BranchContextBuilder;
  readonly store: BranchContextProjectionStore;
}

export interface BranchContextProjectionResult {
  readonly contexts: readonly BranchContext[];
  readonly persistedContexts: number;
}

export interface BranchContextRebuildOptions {
  readonly allowDuringDeletion?: boolean;
  readonly envelopes?: readonly CaptureEnvelope[];
}

export class BranchContextProjector {
  readonly #builder: BranchContextBuilder;
  readonly #store: BranchContextProjectionStore;

  public constructor(options: BranchContextProjectorOptions) {
    this.#builder = options.builder ?? new BranchContextBuilder();
    this.#store = options.store;
  }

  public rebuild(
    options: BranchContextRebuildOptions = {},
  ): BranchContextProjectionResult {
    if (
      this.#store.hasActiveDeletion() &&
      options.allowDuringDeletion !== true
    ) {
      throw new Error(
        "Branch Context projection is blocked by an active deletion.",
      );
    }
    const contexts = this.#builder.build(
      options.envelopes ?? this.#store.episodeSourceEnvelopes(),
      this.#store.workEpisodes(),
    );
    return {
      contexts,
      persistedContexts:
        this.#store.replaceBranchContextProjection({
          ...(options.allowDuringDeletion === true
            ? {
                allowDuringDeletion: true,
              }
            : {}),
          contexts,
        }),
    };
  }
}
