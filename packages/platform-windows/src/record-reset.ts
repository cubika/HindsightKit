import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

export const recordsResetPendingPath = (dataRoot: string): string =>
  resolve(dataRoot, "data", "records-reset.pending.json");

// An incomplete or malformed journal is still a barrier. Recovery owns parsing.
export const isRecordsResetPending = async (dataRoot: string): Promise<boolean> => {
  try { await lstat(recordsResetPendingPath(dataRoot)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
