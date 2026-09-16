import { describe, expect, it } from "vitest";

import {
  CaptureWorkerCircuitBreaker,
} from "@provenloop/host";

describe("capture worker circuit breaker", () => {
  it("reports every active pressure reason deterministically", () => {
    const breaker = new CaptureWorkerCircuitBreaker({
      maxConsecutiveProviderErrors: 3,
      maxCpuPercent: 80,
      maxMemoryBytes: 1_000,
      maxQueueDepth: 100,
      minFreeDiskBytes: 500,
    });

    expect(
      breaker.evaluate({
        consecutiveProviderErrors: 3,
        cpuPercent: 80,
        freeDiskBytes: 500,
        memoryBytes: 1_000,
        queueDepth: 100,
      }),
    ).toEqual({
      allowed: false,
      reasons: [
        "cpu",
        "disk",
        "memory",
        "provider_errors",
        "queue",
      ],
    });
    expect(
      breaker.evaluate({
        consecutiveProviderErrors: 0,
        cpuPercent: 10,
        freeDiskBytes: 10_000,
        memoryBytes: 100,
        queueDepth: 1,
      }),
    ).toEqual({
      allowed: true,
      reasons: [],
    });
  });
});
