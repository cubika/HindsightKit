import type {
  CaptureEnvelope,
  EpisodeAssociation,
  EpisodeGroupingCorrection,
  WorkEpisode,
} from "@provenloop/contracts";
import {
  CommitAncestryIndex,
  WorkEpisodeBuilder,
  commitAncestryEdgesFromEnvelopes,
  type WorkEpisodeBuildResult,
} from "@provenloop/domain";

export interface WorkEpisodeProjectionStore {
  episodeSourceEnvelopes(): readonly CaptureEnvelope[];
  episodeGroupingCorrections(): readonly EpisodeGroupingCorrection[];
  hasActiveDeletion(): boolean;
  replaceWorkEpisodeProjection(input: {
    readonly allowDuringDeletion?: boolean;
    readonly associations: readonly EpisodeAssociation[];
    readonly corrections: readonly EpisodeGroupingCorrection[];
    readonly episodes: readonly WorkEpisode[];
  }): {
    readonly associations: number;
    readonly corrections: number;
    readonly episodes: number;
  };
}

export interface WorkEpisodeProjectorOptions {
  readonly builder?: WorkEpisodeBuilder;
  readonly store: WorkEpisodeProjectionStore;
}

export interface WorkEpisodeProjectionResult
extends WorkEpisodeBuildResult {
  readonly persistedAssociations: number;
  readonly persistedCorrections: number;
  readonly persistedEpisodes: number;
}

export interface WorkEpisodeRebuildOptions {
  readonly allowDuringDeletion?: boolean;
  readonly envelopes?: readonly CaptureEnvelope[];
  readonly associationMode?: "all" | "sparse" | "connected";
}

export class WorkEpisodeProjector {
  readonly #builder: WorkEpisodeBuilder | undefined;
  readonly #store: WorkEpisodeProjectionStore;

  public constructor(options: WorkEpisodeProjectorOptions) {
    this.#builder = options.builder;
    this.#store = options.store;
  }

  public rebuild(
    corrections?: readonly EpisodeGroupingCorrection[],
    options: WorkEpisodeRebuildOptions = {},
  ): WorkEpisodeProjectionResult {
    if (
      this.#store.hasActiveDeletion() &&
      options.allowDuringDeletion !== true
    ) {
      throw new Error(
        "Work Episode projection is blocked by an active deletion.",
      );
    }
    const storedCorrections =
      this.#store.episodeGroupingCorrections();
    const effectiveCorrections =
      corrections === undefined
        ? storedCorrections
        : [
            ...new Map(
              [
                ...storedCorrections,
                ...corrections,
              ].map((correction) => [
                correction.correctionId,
                correction,
              ]),
            ).values(),
          ].sort(
            (left, right) =>
              Date.parse(left.timestamp) -
                Date.parse(right.timestamp) ||
              left.correctionId.localeCompare(right.correctionId),
          );
    const envelopes = options.envelopes ?? this.#store.episodeSourceEnvelopes();
    const builder =
      this.#builder ??
      new WorkEpisodeBuilder({
        ...(options.associationMode === undefined ? {} : { associationMode: options.associationMode }),
        commitAncestry: new CommitAncestryIndex(
          commitAncestryEdgesFromEnvelopes(envelopes),
        ),
      });
    const result = builder.build(
      envelopes,
      effectiveCorrections,
    );
    const persisted = this.#store.replaceWorkEpisodeProjection({
      ...(options.allowDuringDeletion === true
        ? {
            allowDuringDeletion: true,
          }
        : {}),
      associations: result.associations,
      corrections: effectiveCorrections,
      episodes: result.episodes,
    });
    return {
      ...result,
      persistedAssociations: persisted.associations,
      persistedCorrections: persisted.corrections,
      persistedEpisodes: persisted.episodes,
    };
  }
}
