import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isUpgradeMaintenanceActive } from "@provenloop/platform-windows";

import {
  assertCopilotAdapterDataRoot,
  readCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import {
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

import { recordLocalObservationBatch } from "./observation-summary.js";

const INITIAL_TIME = "1970-01-01T00:00:00.000Z";

interface PageCursor {
  readonly timestamp: string;
  readonly id: string;
}

interface ObservationCursor {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly since: string;
  readonly until?: string;
  readonly eventsAfter?: PageCursor;
  readonly contextsAfter?: PageCursor;
  readonly eventsComplete: boolean;
  readonly contextsComplete: boolean;
}

export interface CollectLocalObservationsOptions {
  readonly dataRoot: string;
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface CollectLocalObservationsResult {
  readonly status: "recorded" | "busy" | "disabled" | "deletion_in_progress";
  readonly events: number;
  readonly contextUses: number;
  readonly pending: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissing = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const validTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));

const parsePageCursor = (value: unknown): PageCursor | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !validTime(value.timestamp) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 4_096
  ) {
    throw new Error("Invalid local observation page cursor.");
  }
  return { timestamp: value.timestamp, id: value.id };
};

const readCursor = async (
  path: string,
  generation: string,
): Promise<ObservationCursor> => {
  let value: unknown;
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) {
        throw new Error("Local observation cursor exceeds its size limit.");
      }
      value = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    value = undefined;
  }
  if (value === undefined) {
    return {
      schemaVersion: 1,
      generation,
      since: INITIAL_TIME,
      eventsComplete: false,
      contextsComplete: false,
    };
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    !validTime(value.since) ||
    (value.until !== undefined && !validTime(value.until)) ||
    typeof value.eventsComplete !== "boolean" ||
    typeof value.contextsComplete !== "boolean"
  ) {
    throw new Error("Invalid local observation cursor.");
  }
  if (value.generation !== generation) {
    return {
      schemaVersion: 1,
      generation,
      since: INITIAL_TIME,
      eventsComplete: false,
      contextsComplete: false,
    };
  }
  const eventsAfter = parsePageCursor(value.eventsAfter);
  const contextsAfter = parsePageCursor(value.contextsAfter);
  return {
    schemaVersion: 1,
    generation,
    since: value.since,
    ...(value.until === undefined ? {} : { until: value.until }),
    ...(eventsAfter === undefined ? {} : { eventsAfter }),
    ...(contextsAfter === undefined ? {} : { contextsAfter }),
    eventsComplete: value.eventsComplete,
    contextsComplete: value.contextsComplete,
  };
};

const writeCursor = async (
  path: string,
  cursor: ObservationCursor,
): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(JSON.stringify(cursor), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const readGeneration = async (database: string): Promise<string> => {
  try {
    const value = await readFile(`${database}.restore.generation`, "utf8");
    if (value.length === 0 || value.length > 256) {
      throw new Error("Invalid canonical restore generation.");
    }
    return value;
  } catch (error) {
    if (isMissing(error)) {
      return "initial";
    }
    throw error;
  }
};

export const collectLocalObservations = async (
  options: CollectLocalObservationsOptions,
): Promise<CollectLocalObservationsResult> => {
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 2;
  if (
    !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000 ||
    !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10
  ) {
    throw new RangeError("Observation collection requires bounded page limits.");
  }
  const empty = {
    events: 0,
    contextUses: 0,
    pending: false,
  };
  const now = options.now?.() ?? new Date();
  if (await isUpgradeMaintenanceActive(paths.root)) return { status: "busy", ...empty };
  const initialState = await readCopilotAdapterState(paths.adapterState, now);
  if (initialState.installed !== true ||
      !initialState.capabilities.worker.enabled) {
    return { status: "disabled", ...empty };
  }
  await assertCopilotAdapterDataRoot(paths);
  const lease = await new WindowsNamedPipeLeaseProvider(
    await resolveWindowsProvenLoopLeaseName(paths.root, "observations"),
  ).tryAcquire();
  if (lease === undefined) {
    return { status: "busy", ...empty };
  }
  try {
    if (await isUpgradeMaintenanceActive(paths.root)) return { status: "busy", ...empty };
    const state = await readCopilotAdapterState(paths.adapterState, now);
    if (state.installed !== true || !state.capabilities.worker.enabled) {
      return { status: "disabled", ...empty };
    }
    const store = new CanonicalSqliteStore(paths.database, {
      busyTimeoutMs: 250,
    });
    try {
      if (store.hasActiveDeletion()) {
        return { status: "deletion_in_progress", ...empty };
      }
      const cursorPath = join(paths.data, "observation-cursor.json");
      const generation = await readGeneration(paths.database);
      const cursor = await readCursor(cursorPath, generation);
      const until = cursor.until ?? now.toISOString();
      if (Date.parse(until) < Date.parse(cursor.since)) {
        throw new Error("The observation clock moved behind its checkpoint.");
      }
      if (until === cursor.since) {
        return { status: "recorded", ...empty };
      }
      let eventsAfter = cursor.eventsAfter;
      let contextsAfter = cursor.contextsAfter;
      let eventsComplete = cursor.eventsComplete;
      let contextsComplete = cursor.contextsComplete;
      let events = 0;
      let contextUses = 0;
      for (let page = 0; page < maxPages; page += 1) {
        if (store.hasActiveDeletion()) {
          return { status: "deletion_in_progress", events, contextUses, pending: true };
        }
        const range = {
          since: cursor.since,
          until,
          limit: pageSize,
          timeBasis: "observed" as const,
        };
        const rawPage = eventsComplete ? undefined : store.rawEventsInRange({
          ...range,
          ...(eventsAfter === undefined ? {} : { after: eventsAfter }),
        });
        const contextPage = contextsComplete ? undefined : store.contextUseRecordsInRange({
          ...range,
          ...(contextsAfter === undefined ? {} : { after: contextsAfter }),
        });
        const envelopes = rawPage?.records.map((record) => record.envelope) ?? [];
        const contexts = contextPage?.records ?? [];
        if (envelopes.length > 0 || contexts.length > 0) {
          await recordLocalObservationBatch({
            dataRoot: paths.root,
            events: envelopes,
            contextUseRecords: contexts,
            contextCoverage: "partial",
          });
        }
        events += envelopes.length;
        contextUses += contexts.length;
        if (rawPage !== undefined) {
          eventsAfter = rawPage.next;
          eventsComplete = rawPage.next === undefined;
        }
        if (contextPage !== undefined) {
          contextsAfter = contextPage.next;
          contextsComplete = contextPage.next === undefined;
        }
        if (eventsComplete && contextsComplete) {
          break;
        }
      }
      const complete = eventsComplete && contextsComplete;
      await writeCursor(cursorPath, complete ? {
        schemaVersion: 1,
        generation,
        since: until,
        eventsComplete: false,
        contextsComplete: false,
      } : {
        schemaVersion: 1,
        generation,
        since: cursor.since,
        until,
        ...(eventsAfter === undefined ? {} : { eventsAfter }),
        ...(contextsAfter === undefined ? {} : { contextsAfter }),
        eventsComplete,
        contextsComplete,
      });
      return { status: "recorded", events, contextUses, pending: !complete };
    } finally {
      store.close();
    }
  } finally {
    await lease.release();
  }
};

// Callers hold the "observations" lease while deleting canonical source data.
export const invalidateLocalObservationProjection = async (
  dataRoot: string,
): Promise<void> => {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await rm(join(paths.evaluation, "observations"), {
    recursive: true,
    force: true,
  });
  await rm(join(paths.data, "observation-cursor.json"), { force: true });
};
