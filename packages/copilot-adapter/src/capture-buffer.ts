import type { CaptureEventInput } from "@provenloop/domain";
import {
  sha256,
  stableJson,
} from "@provenloop/domain";
import { boundedCaptureQuality, newCaptureQuality } from "./capture-evidence.js";

export type CaptureBufferOfferStatus =
  | "accepted"
  | "degraded"
  | "dropped";

export interface CaptureBufferOfferResult {
  readonly status: CaptureBufferOfferStatus;
}

export interface CaptureGap {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly branch?: string;
  readonly commitSha?: string;
  readonly contentOmittedCount: number;
  readonly contextMixed: boolean;
  readonly droppedEventCount: number;
  readonly firstSourceEventId: string;
  readonly firstTimestamp: string;
  readonly gapId: string;
  readonly lastSourceEventId: string;
  readonly lastTimestamp: string;
  readonly reasons: readonly (
    | "buffer_byte_limit"
    | "buffer_item_limit"
  )[];
  readonly repoId?: string;
  readonly sessionId: string;
  readonly worktree?: string;
}

export interface BoundedCaptureBufferOptions {
  readonly maxGapBytes: number;
  readonly maxGapContexts: number;
  readonly maxBytes: number;
  readonly maxItems: number;
}

interface BufferedCaptureEvent {
  readonly bytes: number;
  readonly value: CaptureEventInput;
}

export class InvalidCaptureBufferConfigurationError extends Error {
  public override readonly name =
    "InvalidCaptureBufferConfigurationError";

  public constructor(option: string) {
    super(`Capture buffer option ${option} must be a positive integer.`);
  }
}

const positiveInteger = (
  value: number,
  option: string,
): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidCaptureBufferConfigurationError(option);
  }
  return value;
};

const minimumInteger = (
  value: number,
  minimum: number,
  option: string,
): number => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new InvalidCaptureBufferConfigurationError(option);
  }
  return value;
};

const estimateBytes = (value: CaptureEventInput): number =>
  Buffer.byteLength(stableJson(value), "utf8");

const metadataOnly = (
  {
    content,
    ...metadata
  }: CaptureEventInput,
): CaptureEventInput => {
  if (content === undefined) {
    return metadata;
  }
  const quality = metadata.captureQuality ?? newCaptureQuality();
  const degraded = {
    ...metadata,
    contentDigest: sha256(content),
    captureQuality: boundedCaptureQuality({
      ...quality,
      omittedFields: [...new Set(["content", ...quality.omittedFields])],
    }),
  };
  return degraded;
};

const sameCaptureContext = (
  left: CaptureGap,
  right: CaptureGap,
): boolean =>
  left.adapter === right.adapter &&
  left.adapterVersion === right.adapterVersion &&
  left.branch === right.branch &&
  left.commitSha === right.commitSha &&
  left.repoId === right.repoId &&
  left.sessionId === right.sessionId &&
  left.worktree === right.worktree;

export class BoundedCaptureBuffer {
  #bytes = 0;
  #gapBytes = 0;
  readonly #gaps: CaptureGap[] = [];
  readonly #items: BufferedCaptureEvent[] = [];
  readonly #maxGapBytes: number;
  readonly #maxGapContexts: number;
  readonly #maxBytes: number;
  readonly #maxItems: number;

  public constructor(options: BoundedCaptureBufferOptions) {
    this.#maxGapBytes = minimumInteger(
      options.maxGapBytes,
      4_096,
      "maxGapBytes",
    );
    this.#maxGapContexts = positiveInteger(
      options.maxGapContexts,
      "maxGapContexts",
    );
    this.#maxBytes = positiveInteger(options.maxBytes, "maxBytes");
    this.#maxItems = positiveInteger(options.maxItems, "maxItems");
  }

  public get byteCount(): number {
    return this.#bytes + this.#gapBytes;
  }

  public get hasWork(): boolean {
    return this.#items.length > 0 || this.#gaps.length > 0;
  }

  public get itemCount(): number {
    return this.#items.length;
  }

  public get pendingGap(): CaptureGap | undefined {
    return this.#gaps[0];
  }

  public offer(value: CaptureEventInput): CaptureBufferOfferResult {
    const bytes = estimateBytes(value);
    const reasons = this.#overflowReasons(bytes);
    if (reasons.length === 0) {
      this.#push(value, bytes);
      return {
        status: "accepted",
      };
    }

    const degraded = metadataOnly(value);
    const degradedBytes = estimateBytes(degraded);
    const degradedReasons = this.#overflowReasons(degradedBytes);
    const accepted = degradedReasons.length === 0;
    this.#recordGap(
      value,
      [
        ...new Set([
          ...reasons,
          ...degradedReasons,
        ]),
      ],
      value.content === undefined ? 0 : 1,
      accepted ? 0 : 1,
    );
    if (accepted) {
      this.#push(degraded, degradedBytes);
      return {
        status: "degraded",
      };
    }
    return {
      status: "dropped",
    };
  }

  public peek(): CaptureEventInput | undefined {
    return this.#items[0]?.value;
  }

  public shift(): CaptureEventInput | undefined {
    const item = this.#items.shift();
    if (item === undefined) {
      return undefined;
    }
    this.#bytes -= item.bytes;
    return item.value;
  }

  public takeGap(): CaptureGap | undefined {
    const gap = this.#gaps.shift();
    if (gap !== undefined) {
      this.#gapBytes -= estimateGapBytes(gap);
    }
    return gap;
  }

  public restoreGap(gap: CaptureGap): void {
    const gapBytes = estimateGapBytes(gap);
    if (
      this.#gaps.length < this.#maxGapContexts &&
      this.#gapBytes + gapBytes <= this.#maxGapBytes
    ) {
      this.#gaps.unshift(gap);
      this.#gapBytes += gapBytes;
      return;
    }
    const current = this.#gaps[0];
    if (current === undefined) {
      this.#gaps.unshift(gap);
      this.#gapBytes = gapBytes;
      return;
    }
    const mixed = mergeMixedGap(gap, current);
    this.#gapBytes -= estimateGapBytes(current);
    this.#gaps[0] = mixed;
    this.#gapBytes += estimateGapBytes(mixed);
  }

  #overflowReasons(
    nextBytes: number,
  ): (
    | "buffer_byte_limit"
    | "buffer_item_limit"
  )[] {
    const reasons: (
      | "buffer_byte_limit"
      | "buffer_item_limit"
    )[] = [];
    if (this.#items.length >= this.#maxItems) {
      reasons.push("buffer_item_limit");
    }
    if (this.#bytes + nextBytes > this.#maxBytes) {
      reasons.push("buffer_byte_limit");
    }
    return reasons;
  }

  #push(value: CaptureEventInput, bytes: number): void {
    this.#items.push({
      bytes,
      value,
    });
    this.#bytes += bytes;
  }

  #recordGap(
    value: CaptureEventInput,
    reasons: readonly (
      | "buffer_byte_limit"
      | "buffer_item_limit"
    )[],
    contentOmittedCount: number,
    droppedEventCount: number,
  ): void {
    const gap: CaptureGap = {
      adapter: value.adapter,
      adapterVersion: value.adapterVersion,
      ...(value.branch === undefined
        ? {}
        : {
            branch: value.branch,
          }),
      ...(value.commitSha === undefined
        ? {}
        : {
            commitSha: value.commitSha,
          }),
      contentOmittedCount,
      contextMixed: false,
      droppedEventCount,
      firstSourceEventId: value.sourceEventId,
      firstTimestamp: value.timestamp,
      gapId: sha256({
        adapter: value.adapter,
        adapterVersion: value.adapterVersion,
        firstSourceEventId: value.sourceEventId,
        sessionId: value.sessionId,
      }),
      lastSourceEventId: value.sourceEventId,
      lastTimestamp: value.timestamp,
      reasons,
      ...(value.repoId === undefined
        ? {}
        : {
            repoId: value.repoId,
          }),
      sessionId: value.sessionId,
      ...(value.worktree === undefined
        ? {}
        : {
            worktree: value.worktree,
          }),
    };
    const previous = this.#gaps.at(-1);
    if (
      previous === undefined ||
      !sameCaptureContext(previous, gap)
    ) {
      const gapBytes = estimateGapBytes(gap);
      if (
        this.#gaps.length < this.#maxGapContexts &&
        this.#gapBytes + gapBytes <= this.#maxGapBytes
      ) {
        this.#gaps.push(gap);
        this.#gapBytes += gapBytes;
        return;
      }
      const mixedGap = mergeMixedGap(previous, gap);
      if (previous === undefined) {
        this.#gaps.push(mixedGap);
        this.#gapBytes = estimateGapBytes(mixedGap);
        return;
      }
      this.#gapBytes -= estimateGapBytes(previous);
      this.#gaps[this.#gaps.length - 1] = mixedGap;
      this.#gapBytes += estimateGapBytes(mixedGap);
      return;
    }
    const aggregated = {
      ...previous,
      contentOmittedCount:
        previous.contentOmittedCount + contentOmittedCount,
      droppedEventCount:
        previous.droppedEventCount + droppedEventCount,
      lastSourceEventId: value.sourceEventId,
      lastTimestamp: value.timestamp,
      reasons: [
        ...new Set([
          ...previous.reasons,
          ...reasons,
        ]),
      ],
    };
    this.#gapBytes -= estimateGapBytes(previous);
    this.#gaps[this.#gaps.length - 1] = aggregated;
    this.#gapBytes += estimateGapBytes(aggregated);
  }

}

const estimateGapBytes = (gap: CaptureGap): number =>
  Buffer.byteLength(stableJson(gap), "utf8");

const mergeMixedGap = (
  previous: CaptureGap | undefined,
  next: CaptureGap,
): CaptureGap => ({
  adapter: previous?.adapter ?? next.adapter,
  adapterVersion: previous?.adapterVersion ?? next.adapterVersion,
  contentOmittedCount:
    (previous?.contentOmittedCount ?? 0) +
    next.contentOmittedCount,
  contextMixed: true,
  droppedEventCount:
    (previous?.droppedEventCount ?? 0) +
    next.droppedEventCount,
  firstSourceEventId:
    previous?.firstSourceEventId ?? next.firstSourceEventId,
  firstTimestamp: previous?.firstTimestamp ?? next.firstTimestamp,
  gapId: previous?.gapId ?? next.gapId,
  lastSourceEventId: next.lastSourceEventId,
  lastTimestamp: next.lastTimestamp,
  reasons: [
    ...new Set([
      ...(previous?.reasons ?? []),
      ...next.reasons,
    ]),
  ],
  sessionId: previous?.sessionId ?? next.sessionId,
});

export const captureGapEvent = (
  gap: CaptureGap,
): CaptureEventInput => ({
  adapter: gap.adapter,
  adapterVersion: gap.adapterVersion,
  ...(gap.branch === undefined ? {} : { branch: gap.branch }),
  ...(gap.commitSha === undefined
    ? {}
    : {
        commitSha: gap.commitSha,
      }),
  content: {
    toolArguments: {
      contentOmittedCount: gap.contentOmittedCount,
      contextMixed: gap.contextMixed,
      droppedEventCount: gap.droppedEventCount,
      firstSourceEventId: gap.firstSourceEventId,
      lastSourceEventId: gap.lastSourceEventId,
      reasons: gap.reasons,
    },
  },
  eventType: "capture_gap",
  ...(gap.repoId === undefined ? {} : { repoId: gap.repoId }),
  sessionId: gap.sessionId,
  sourceEventId: `capture-gap-${gap.gapId}`,
  timestamp: gap.lastTimestamp,
  trust: "system",
  ...(gap.worktree === undefined
    ? {}
    : {
        worktree: gap.worktree,
      }),
});
