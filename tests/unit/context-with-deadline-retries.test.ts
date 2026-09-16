import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contextWithDeadlineRetries } from "../fixtures/context-with-deadline-retries.js";

type Context = Readonly<Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("test-only context deadline retries", () => {
  it("returns successful context unchanged without another request", async () => {
    const context = { status: "ok", requestId: "success", items: [{ id: "knowledge-1" }] };
    const request = vi.fn<() => Promise<Context>>().mockResolvedValue(context);

    expect(await contextWithDeadlineRetries(request)).toBe(context);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "Retrieval deadline expired while resolving repository identity.",
    "Retrieval deadline expired before database initialization.",
    "Retrieval deadline expired during database initialization.",
    "Retrieval deadline expired while waiting for the Session lock.",
    "Retrieval timed out.",
    "Knowledge retrieval timed out.",
    "Knowledge backend read timed out.",
  ].flatMap((detail) => [detail, `Error: ${detail}`]))("retries only the documented deadline after a bounded pause: %s", async (statusDetail) => {
    const context = { status: "ok", requestId: "success", items: [{ id: "knowledge-1" }] };
    const request = vi.fn<() => Promise<Context>>()
      .mockResolvedValueOnce({ status: "degraded", statusDetail, requestId: "timeout", items: [] })
      .mockResolvedValue(context);

    const result = contextWithDeadlineRetries(request);
    await vi.advanceTimersByTimeAsync(49);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toBe(context);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: "degraded", statusDetail: "Trusted session/workspace identity is unavailable or being refreshed. No context was retrieved." },
    { status: "degraded", statusDetail: "Retrieval capability is disabled." },
    { status: "degraded", statusDetail: "Context use record could not be persisted." },
    { status: "degraded", statusDetail: "Knowledge backend is unhealthy: corrupt." },
    { status: "degraded", statusDetail: "Retrieval is unavailable while deletion or projection maintenance is active." },
    { status: "degraded", statusDetail: "Malformed input: deadline is not a supported field." },
    { status: "degraded", statusDetail: "Unknown identity: repository named timed out is unavailable." },
    { status: "degraded", statusDetail: "Unexpected deadline failure." },
    { status: "degraded", statusDetail: "Error: Unknown identity: repository named timed out is unavailable." },
    { status: "degraded" },
    { status: "degraded", statusDetail: 150 },
    { status: "ok", statusDetail: "Retrieval timed out." },
    { status: "muted", statusDetail: "Retrieval timed out." },
    { status: "error", statusDetail: "Retrieval timed out." },
    { isError: true, content: [{ type: "text", text: "Malformed input: deadline." }] },
  ])("does not retry functional failures or other statuses: %j", async (context) => {
    const request = vi.fn<() => Promise<Context>>().mockResolvedValue(context);

    expect(await contextWithDeadlineRetries(request)).toBe(context);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates request errors without retrying even if they mention a timeout", async () => {
    const error = new Error("Malformed request: Retrieval timed out.");
    const request = vi.fn<() => Promise<Context>>().mockRejectedValue(error);

    await expect(contextWithDeadlineRetries(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at a functional failure after a transient deadline", async () => {
    const failure = { status: "degraded", statusDetail: "Context use record could not be persisted." };
    const request = vi.fn<() => Promise<Context>>()
      .mockResolvedValueOnce({ status: "degraded", statusDetail: "Retrieval timed out." })
      .mockResolvedValueOnce(failure)
      .mockResolvedValue({ status: "ok" });

    const result = contextWithDeadlineRetries(request);
    await vi.runAllTimersAsync();

    expect(await result).toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns the fifth persistent degradation unchanged so the success assertion still fails", async () => {
    const request = vi.fn<() => Promise<Context>>();
    const responses = Array.from({ length: 5 }, (_, index) => ({
      status: "degraded",
      statusDetail: "Retrieval timed out.",
      requestId: `timeout-${index + 1}`,
      items: [],
      latencyMs: 150,
    }));
    for (const response of responses) {
      request.mockResolvedValueOnce(response);
    }

    const result = contextWithDeadlineRetries(request);
    await vi.runAllTimersAsync();

    const context = await result;
    expect(context).toBe(responses[4]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => expect(context, JSON.stringify(context)).toMatchObject({ status: "ok" }))
      .toThrow("timeout-5");
  });

  it("accepts a genuinely successful response on the fifth and final attempt", async () => {
    const context = { status: "ok", requestId: "success-5", items: [{ id: "knowledge-1" }] };
    const request = vi.fn<() => Promise<Context>>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      request.mockResolvedValueOnce({ status: "degraded", statusDetail: "Retrieval timed out." });
    }
    request.mockResolvedValue(context);

    const result = contextWithDeadlineRetries(request);
    await vi.runAllTimersAsync();

    expect(await result).toBe(context);
    expect(request).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
