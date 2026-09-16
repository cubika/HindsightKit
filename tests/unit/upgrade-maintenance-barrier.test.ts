import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginUpgradeMaintenance, isUpgradeMaintenanceActive, waitForMaintenanceLease } from "@provenloop/platform-windows";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("upgrade maintenance barrier", () => {
  it("concurrent status probes cannot masquerade as an upgrade or leave a stale barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "upgrade-barrier-")); roots.push(root);
    expect(await Promise.all(Array.from({ length: 20 }, () => isUpgradeMaintenanceActive(root)))).toEqual(Array(20).fill(false));
    const maintenance = await beginUpgradeMaintenance(root);
    try {
      expect(await Promise.all(Array.from({ length: 20 }, () => isUpgradeMaintenanceActive(root)))).toEqual(Array(20).fill(true));
      await expect(beginUpgradeMaintenance(root)).rejects.toThrow("already active");
    } finally { await maintenance.release(); }
    expect(await isUpgradeMaintenanceActive(root)).toBe(false);
  });
  it("waits for a busy resource, keeps its lease, and reports a bounded timeout", async () => {
    let calls = 0; let released = false;
    const lease = await waitForMaintenanceLease({ tryAcquire: async () => ++calls === 3 ? { release: async () => { released = true; } } : undefined }, Date.now() + 1000, "MCP call");
    expect(calls).toBe(3); expect(released).toBe(false);
    await lease.release(); expect(released).toBe(true);
    await expect(waitForMaintenanceLease({ tryAcquire: async () => undefined }, Date.now() - 1, "MCP call")).rejects.toThrow("timed out waiting for MCP call");
  });
});
