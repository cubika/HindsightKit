import {
  sanitizeDiagnostic,
  type CaptureEventInput,
} from "@provenloop/domain";

import {
  BoundedCaptureBuffer,
  captureGapEvent,
  type CaptureBufferOfferResult,
} from "./capture-buffer.js";

export interface CaptureQueueSink {
  enqueue(
    input: CaptureEventInput,
    options?: {
      readonly environment?: Readonly<
        Record<string, string | undefined>
      >;
    },
  ): Promise<unknown>;
  enqueueIfSourceAbsent?(
    input: CaptureEventInput,
    options?: {
      readonly environment?: Readonly<
        Record<string, string | undefined>
      >;
    },
  ): Promise<{
    readonly status: "duplicate" | "enqueued";
  }>;
}

export type CaptureHealthState =
  | "degraded"
  | "healthy"
  | "stopped";

export interface CaptureWriterStatus {
  readonly bufferedBytes: number;
  readonly bufferedItems: number;
  readonly degradedEvents: number;
  readonly droppedEvents: number;
  readonly lastError?: string;
  readonly pendingGap: boolean;
  readonly persistedEvents: number;
  readonly persistedGaps: number;
  readonly receivedEvents: number;
  readonly state: CaptureHealthState;
  readonly writeFailures: number;
}

export interface AsyncCaptureWriterOptions {
  readonly buffer: BoundedCaptureBuffer;
  readonly onError?: (safeError: string) => void;
  readonly queue: CaptureQueueSink;
  readonly retryDelayMs: number;
}

export class InvalidCaptureWriterConfigurationError extends Error {
  public override readonly name =
    "InvalidCaptureWriterConfigurationError";

  public constructor() {
    super("Capture writer retryDelayMs must be a positive integer.");
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export class AsyncCaptureWriter {
  readonly #buffer: BoundedCaptureBuffer;
  #degradedEvents = 0;
  #draining = false;
  #droppedEvents = 0;
  #lastError: string | undefined;
  readonly #onError: ((safeError: string) => void) | undefined;
  #persistedEvents = 0;
  #persistedGaps = 0;
  readonly #queue: CaptureQueueSink;
  #receivedEvents = 0;
  readonly #retryDelayMs: number;
  #retryTimer: NodeJS.Timeout | undefined;
  #scheduled = false;
  #closing = false;
  #stopped = false;
  #writeFailures = 0;

  public constructor(options: AsyncCaptureWriterOptions) {
    if (
      !Number.isInteger(options.retryDelayMs) ||
      options.retryDelayMs <= 0
    ) {
      throw new InvalidCaptureWriterConfigurationError();
    }
    this.#buffer = options.buffer;
    this.#onError = options.onError;
    this.#queue = options.queue;
    this.#retryDelayMs = options.retryDelayMs;
  }

  public submit(value: CaptureEventInput): CaptureBufferOfferResult {
    this.#receivedEvents += 1;
    if (this.#closing || this.#stopped) {
      this.#droppedEvents += 1;
      return {
        status: "dropped",
      };
    }
    const result = this.#buffer.offer(value);
    if (result.status === "degraded") {
      this.#degradedEvents += 1;
    } else if (result.status === "dropped") {
      this.#droppedEvents += 1;
    }
    this.#scheduleDrain();
    return result;
  }

  public status(): CaptureWriterStatus {
    return {
      bufferedBytes: this.#buffer.byteCount,
      bufferedItems: this.#buffer.itemCount,
      degradedEvents: this.#degradedEvents,
      droppedEvents: this.#droppedEvents,
      ...(this.#lastError === undefined
        ? {}
        : {
            lastError: this.#lastError,
          }),
      pendingGap: this.#buffer.pendingGap !== undefined,
      persistedEvents: this.#persistedEvents,
      persistedGaps: this.#persistedGaps,
      receivedEvents: this.#receivedEvents,
      state: this.#stopped
        ? "stopped"
        : this.#lastError === undefined && this.#droppedEvents === 0 && this.#degradedEvents === 0
          ? "healthy"
          : "degraded",
      writeFailures: this.#writeFailures,
    };
  }

  public async flush(timeoutMs: number): Promise<boolean> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Capture flush timeout must be positive.");
    }
    if (this.#buffer.hasWork) {
      this.#scheduleDrain(true);
    }
    const deadline = Date.now() + timeoutMs;
    while (
      (this.#draining || this.#scheduled || this.#buffer.hasWork) &&
      Date.now() < deadline
    ) {
      await delay(Math.min(10, Math.max(1, deadline - Date.now())));
      if (this.#buffer.hasWork) {
        this.#scheduleDrain(true);
      }
    }
    return (
      !this.#draining &&
      !this.#scheduled &&
      !this.#buffer.hasWork
    );
  }

  public async stop(timeoutMs: number): Promise<boolean> {
    this.#closing = true;
    const flushed = await this.flush(timeoutMs);
    this.#stopped = true;
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    return flushed;
  }

  #scheduleDrain(immediate = false): void {
    if (
      this.#stopped ||
      (
        this.#closing &&
        !immediate
      ) ||
      this.#draining ||
      this.#scheduled
    ) {
      return;
    }
    if (immediate && this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    } else if (this.#retryTimer !== undefined) {
      return;
    }
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#stopped) {
      return;
    }
    this.#draining = true;
    let failed = false;
    try {
      while (!this.#stopped) {
        const next = this.#buffer.peek();
        if (next !== undefined) {
          if (this.#queue.enqueueIfSourceAbsent === undefined) {
            await this.#queue.enqueue(next);
          } else {
            await this.#queue.enqueueIfSourceAbsent(next);
          }
          this.#buffer.shift();
          this.#persistedEvents += 1;
          this.#lastError = undefined;
          continue;
        }

        const gap = this.#buffer.takeGap();
        if (gap === undefined) {
          break;
        }
        try {
          const gapEvent = captureGapEvent(gap);
          if (this.#queue.enqueueIfSourceAbsent === undefined) {
            await this.#queue.enqueue(gapEvent);
          } else {
            await this.#queue.enqueueIfSourceAbsent(gapEvent);
          }
          this.#persistedGaps += 1;
          this.#lastError = undefined;
        } catch (error) {
          this.#buffer.restoreGap(gap);
          throw error;
        }
      }
    } catch (error) {
      failed = true;
      this.#writeFailures += 1;
      this.#lastError = sanitizeDiagnostic(error);
      try {
        this.#onError?.(this.#lastError);
      } catch {
        // Diagnostics cannot interrupt queue retry.
      }
    } finally {
      this.#draining = false;
    }

    if (failed && !this.#stopped) {
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = undefined;
        this.#scheduleDrain();
      }, this.#retryDelayMs);
    } else if (this.#buffer.hasWork) {
      this.#scheduleDrain();
    }
  }
}
