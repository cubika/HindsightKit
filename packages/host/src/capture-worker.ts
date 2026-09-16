import type {
  CaptureQueueItem,
  CaptureQueueState,
} from "@provenloop/contracts";
import type {
  CaptureQueueClaim,
  ProcessLease,
  ProcessLeaseProvider,
} from "@provenloop/platform-windows";
import type {
  CanonicalIngestResult,
} from "@provenloop/storage-sqlite";

import type {
  CaptureWorkerAdmission,
  CaptureWorkerPressureReason,
} from "./worker-circuit-breaker.js";

export interface CaptureWorkerQueue {
  acknowledge(
    claim: CaptureQueueClaim,
  ): Promise<CaptureQueueItem>;
  claimNext(
    claimOwnerId: string,
  ): Promise<CaptureQueueItem | undefined>;
  deadLetter(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem>;
  recoverExpiredClaims(): Promise<readonly CaptureQueueItem[]>;
  retry(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem>;
  retryAfterCommit(
    claim: CaptureQueueClaim,
    error: unknown,
  ): Promise<CaptureQueueItem>;
}

export interface CaptureWorkerStore {
  ingestQueueItem(item: CaptureQueueItem): CanonicalIngestResult;
}

export interface CaptureWorkerOptions {
  readonly admission?: () =>
    | CaptureWorkerAdmission
    | Promise<CaptureWorkerAdmission>;
  readonly batchSize: number;
  readonly enabled?: () => boolean | Promise<boolean>;
  readonly lease: ProcessLeaseProvider;
  readonly onCanonicalMutationPending?: () => Promise<void>;
  readonly queue: CaptureWorkerQueue;
  readonly store: CaptureWorkerStore;
  readonly workerId: string;
  readonly yieldControl?: () => Promise<void>;
}

export type CaptureWorkerRunResult =
  | {
      readonly reasons?: readonly CaptureWorkerPressureReason[];
      readonly status:
        | "circuit_open"
        | "disabled"
        | "lease_unavailable";
    }
  | {
      readonly acknowledged: number;
      readonly deadLettered: number;
      readonly duplicates: number;
      readonly failed: number;
      readonly circuitOpenReasons:
        readonly CaptureWorkerPressureReason[];
      readonly recoveredClaims: number;
      readonly retried: number;
      readonly status: "completed";
      readonly stored: number;
      readonly unsupported: number;
      readonly quarantinedItems?: number;
    };

export class InvalidCaptureWorkerConfigurationError extends Error {
  public override readonly name =
    "InvalidCaptureWorkerConfigurationError";

  public constructor(field: string) {
    super(`Capture worker ${field} is invalid.`);
  }
}

const defaultYieldControl = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const claimFromItem = (
  item: Extract<CaptureQueueItem, { readonly state: "claimed" }>,
): CaptureQueueClaim => ({
  attemptCount: item.attemptCount,
  claimOwnerId: item.claimOwnerId,
  queueItemId: item.queueItemId,
});

const queuePressureOnly = (
  admission: CaptureWorkerAdmission,
): boolean =>
  !admission.allowed &&
  admission.reasons.length === 1 &&
  admission.reasons[0] === "queue";

export class CaptureWorker {
  readonly #batchSize: number;
  readonly #admission: () =>
    | CaptureWorkerAdmission
    | Promise<CaptureWorkerAdmission>;
  readonly #enabled: () => boolean | Promise<boolean>;
  readonly #lease: ProcessLeaseProvider;
  readonly #onCanonicalMutationPending: () => Promise<void>;
  readonly #queue: CaptureWorkerQueue;
  readonly #store: CaptureWorkerStore;
  readonly #workerId: string;
  readonly #yieldControl: () => Promise<void>;

  public constructor(options: CaptureWorkerOptions) {
    if (
      !Number.isInteger(options.batchSize) ||
      options.batchSize <= 0
    ) {
      throw new InvalidCaptureWorkerConfigurationError("batchSize");
    }
    if (options.workerId.trim().length === 0) {
      throw new InvalidCaptureWorkerConfigurationError("workerId");
    }
    this.#batchSize = options.batchSize;
    this.#admission =
      options.admission ??
      (() => ({
        allowed: true,
        reasons: [],
      }));
    this.#enabled = options.enabled ?? (() => true);
    this.#lease = options.lease;
    this.#onCanonicalMutationPending =
      options.onCanonicalMutationPending ?? (() => Promise.resolve());
    this.#queue = options.queue;
    this.#store = options.store;
    this.#workerId = options.workerId.trim();
    this.#yieldControl =
      options.yieldControl ?? defaultYieldControl;
  }

  public async runOnce(): Promise<CaptureWorkerRunResult> {
    if (!await this.#enabled()) {
      return {
        status: "disabled",
      };
    }
    const admission = await this.#admission();
    if (!admission.allowed && !queuePressureOnly(admission)) {
      return {
        status: "circuit_open",
        reasons: admission.reasons,
      };
    }
    const lease = await this.#lease.tryAcquire();
    if (lease === undefined) {
      return {
        status: "lease_unavailable",
      };
    }
    return this.#runWithLease(lease);
  }

  async #runWithLease(
    lease: ProcessLease,
  ): Promise<CaptureWorkerRunResult> {
    let acknowledged = 0;
    let deadLettered = 0;
    let circuitOpenReasons:
      readonly CaptureWorkerPressureReason[] = [];
    let duplicates = 0;
    let failed = 0;
    let retried = 0;
    let stored = 0;
    let unsupported = 0;
    try {
      const recoveredClaims =
        (await this.#queue.recoverExpiredClaims()).length;
      for (let index = 0; index < this.#batchSize; index += 1) {
        if (!await this.#enabled()) {
          break;
        }
        const admission = await this.#admission();
        if (!admission.allowed) {
          if (queuePressureOnly(admission)) {
            circuitOpenReasons = admission.reasons;
          } else {
            circuitOpenReasons = admission.reasons;
            break;
          }
        }
        const item = await this.#queue.claimNext(this.#workerId);
        if (item === undefined) {
          break;
        }
        if (item.state !== "claimed") {
          throw new Error(
            `Queue returned ${item.state} from claimNext.`,
          );
        }
        const claim = claimFromItem(item);
        let result: CanonicalIngestResult;
        try {
          await this.#onCanonicalMutationPending();
          result = this.#store.ingestQueueItem(item);
        } catch (error) {
          failed += 1;
          const next = await this.#queue.retry(claim, error);
          if (next.state === "dead-letter") {
            deadLettered += 1;
          } else {
            retried += 1;
          }
          await this.#yieldControl();
          continue;
        }

        switch (result.status) {
          case "stored":
            stored += 1;
            try {
              await this.#queue.acknowledge(claim);
              acknowledged += 1;
            } catch (error) {
              failed += 1;
              await this.#queue.retryAfterCommit(claim, error);
              retried += 1;
            }
            break;
          case "duplicate":
            duplicates += 1;
            try {
              await this.#queue.acknowledge(claim);
              acknowledged += 1;
            } catch (error) {
              failed += 1;
              await this.#queue.retryAfterCommit(claim, error);
              retried += 1;
            }
            break;
          case "unsupported":
            unsupported += 1;
            try {
              await this.#queue.deadLetter(claim, result.reason);
              deadLettered += 1;
            } catch (error) {
              failed += 1;
              await this.#queue.retryAfterCommit(claim, error);
              retried += 1;
            }
            break;
          case "rejected":
            failed += 1;
            try {
              await this.#queue.deadLetter(claim, result.reason);
              deadLettered += 1;
            } catch (error) {
              await this.#queue.retryAfterCommit(claim, error);
              retried += 1;
            }
            break;
        }
        await this.#yieldControl();
      }
      return {
        status: "completed",
        acknowledged,
        circuitOpenReasons,
        deadLettered,
        duplicates,
        failed,
        recoveredClaims,
        retried,
        stored,
        unsupported,
      };
    } finally {
      await lease.release();
    }
  }
}

export const terminalQueueState = (
  state: CaptureQueueState,
): boolean =>
  state === "acknowledged" || state === "dead-letter";
