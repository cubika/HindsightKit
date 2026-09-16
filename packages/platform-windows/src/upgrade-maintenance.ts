import { createConnection } from "node:net";
import { resolveWindowsProvenLoopLeaseName } from "./operational-paths.js";
import { isRecordsResetPending } from "./record-reset.js";
import { WindowsNamedPipeLeaseProvider, windowsNamedPipePath, type ProcessLease, type ProcessLeaseProvider } from "./process-lease.js";

// A live lease needs no persistent marker recovery after the installer exits.
export const beginUpgradeMaintenance = async (dataRoot: string): Promise<ProcessLease> => {
  const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(dataRoot, "upgrade-maintenance")).tryAcquire();
  if (!lease) throw new Error("An upgrade maintenance operation is already active.");
  return lease;
};

export const isUpgradeMaintenanceActive = async (dataRoot: string): Promise<boolean> => {
  if (await isRecordsResetPending(dataRoot)) return true;
  const path = windowsNamedPipePath(await resolveWindowsProvenLoopLeaseName(dataRoot, "upgrade-maintenance"));
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Upgrade maintenance status timed out.")); }, 100);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
};

export const waitForMaintenanceLease = async (provider: ProcessLeaseProvider, deadline: number, label: string): Promise<ProcessLease> => {
  if (!Number.isFinite(deadline)) throw new RangeError("Invalid upgrade drain deadline.");
  while (true) {
    const lease = await provider.tryAcquire();
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Upgrade maintenance timed out waiting for ${label}; no migration was started. Retry when the operation finishes.`);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
};
