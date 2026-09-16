export const CAPTURE_WORKER_PRESSURE_REASONS = [
  "cpu",
  "disk",
  "memory",
  "provider_errors",
  "queue",
] as const;

export type CaptureWorkerPressureReason =
  typeof CAPTURE_WORKER_PRESSURE_REASONS[number];

export interface CaptureWorkerPressureSnapshot {
  readonly consecutiveProviderErrors: number;
  readonly cpuPercent: number;
  readonly freeDiskBytes: number;
  readonly memoryBytes: number;
  readonly queueDepth: number;
}

export interface CaptureWorkerPressureThresholds {
  readonly maxConsecutiveProviderErrors: number;
  readonly maxCpuPercent: number;
  readonly maxMemoryBytes: number;
  readonly maxQueueDepth: number;
  readonly minFreeDiskBytes: number;
}

export interface CaptureWorkerAdmission {
  readonly allowed: boolean;
  readonly reasons: readonly CaptureWorkerPressureReason[];
}

export class InvalidWorkerPressureThresholdError extends Error {
  public override readonly name =
    "InvalidWorkerPressureThresholdError";

  public constructor(field: string) {
    super(`Worker pressure threshold ${field} is invalid.`);
  }
}

const positiveFinite = (
  value: number,
  field: string,
): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidWorkerPressureThresholdError(field);
  }
  return value;
};

export class CaptureWorkerCircuitBreaker {
  readonly #thresholds: CaptureWorkerPressureThresholds;

  public constructor(thresholds: CaptureWorkerPressureThresholds) {
    this.#thresholds = {
      maxConsecutiveProviderErrors: positiveFinite(
        thresholds.maxConsecutiveProviderErrors,
        "maxConsecutiveProviderErrors",
      ),
      maxCpuPercent: positiveFinite(
        thresholds.maxCpuPercent,
        "maxCpuPercent",
      ),
      maxMemoryBytes: positiveFinite(
        thresholds.maxMemoryBytes,
        "maxMemoryBytes",
      ),
      maxQueueDepth: positiveFinite(
        thresholds.maxQueueDepth,
        "maxQueueDepth",
      ),
      minFreeDiskBytes: positiveFinite(
        thresholds.minFreeDiskBytes,
        "minFreeDiskBytes",
      ),
    };
  }

  public evaluate(
    snapshot: CaptureWorkerPressureSnapshot,
  ): CaptureWorkerAdmission {
    const reasons: CaptureWorkerPressureReason[] = [];
    if (snapshot.cpuPercent >= this.#thresholds.maxCpuPercent) {
      reasons.push("cpu");
    }
    if (snapshot.freeDiskBytes <= this.#thresholds.minFreeDiskBytes) {
      reasons.push("disk");
    }
    if (snapshot.memoryBytes >= this.#thresholds.maxMemoryBytes) {
      reasons.push("memory");
    }
    if (
      snapshot.consecutiveProviderErrors >=
      this.#thresholds.maxConsecutiveProviderErrors
    ) {
      reasons.push("provider_errors");
    }
    if (snapshot.queueDepth >= this.#thresholds.maxQueueDepth) {
      reasons.push("queue");
    }
    return {
      allowed: reasons.length === 0,
      reasons,
    };
  }
}
