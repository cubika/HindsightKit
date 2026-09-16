import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", () => ({ rename: vi.fn() }));
import { rename } from "node:fs/promises";
import { replaceFileAtomically } from "../../packages/copilot-adapter/src/atomic-rename.js";
const move = vi.mocked(rename);
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe("SYS-04 bounded atomic replacement", () => {
  it.skipIf(process.platform !== "win32")("retries transient sharing failures without deleting the destination", async () => {
    vi.useFakeTimers();
    move.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" })).mockResolvedValue(undefined);
    const pending = replaceFileAtomically("owned.tmp", "state.json");
    await vi.runAllTimersAsync(); await pending;
    expect(move).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenNthCalledWith(2, "owned.tmp", "state.json");
  });
  it.skipIf(process.platform !== "win32")("rejects persistent failure after five attempts within 150 ms of backoff", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("busy"), { code: "EBUSY" });
    move.mockRejectedValue(error);
    const pending = replaceFileAtomically("owned.tmp", "state.json").catch((reason: unknown) => reason);
    await vi.runAllTimersAsync(); expect(await pending).toBe(error);
    expect(move).toHaveBeenCalledTimes(5);
  });
  it("does not retry a missing source or report success", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" }); move.mockRejectedValue(error);
    await expect(replaceFileAtomically("missing.tmp", "state.json")).rejects.toBe(error);
    expect(move).toHaveBeenCalledTimes(1);
  });
});
