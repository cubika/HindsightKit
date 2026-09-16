import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createDefaultCopilotAdapterState,
  setPersistedCapability,
  writeCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import {
  completeM0DailyAcceptance,
  runCaptureWorkerOnce,
  startM0DailyAcceptance,
} from "@provenloop/cli";
import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-daily-acceptance-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("M0 daily acceptance", () => {
  it.each([
    { allowed: true, status: "pass" },
    { allowed: false, status: "incomplete" },
  ] as const)("creates bounded privacy-safe $status reports and prevents overlapping runs", async ({ allowed, status }) => {
    const root = await createTemporaryDirectory();
    const dataRoot = resolve(join(root, "data-root"));
    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    const now = new Date("2026-09-02T00:00:00.000Z");
    await mkdir(dataRoot, {
      recursive: true,
    });
    await writeFile(
      paths.rootMarker,
      `${JSON.stringify({
        product: "ProvenLoop",
        root: dataRoot,
        schemaVersion: 1,
      })}\n`,
      "utf8",
    );
    await writeCopilotAdapterState(
      paths.adapterState,
      setPersistedCapability(
        { ...createDefaultCopilotAdapterState(now), installed: true },
        "worker",
        { enabled: true },
        now,
      ),
    );
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    new CanonicalSqliteStore(paths.database).close();
    const sessionRoot = join(root, "sessions");
    const copilotHome = join(root, "copilot-home");
    await Promise.all([
      mkdir(sessionRoot),
      mkdir(copilotHome),
    ]);

    const started = await startM0DailyAcceptance({
      adapter: {
        doctor: async () => ({
          adapter: "copilot-cli",
          checkedAt: now.toISOString(),
          checks: [],
          providerStatus: "unverified",
          status: "degraded",
        }),
        status: async () => ({
          capabilities: {
            adapter: "copilot-cli",
            capabilities: [],
            compatibility: "supported",
            installedVersion: "1.0.82-0",
          },
          dataRoot,
          installed: true,
          marketplaceRegistered: true,
          pluginEnabled: true,
          pluginInstalled: true,
        }),
      },
      copilotHome,
      dataRoot,
      now: () => now,
      sessionRoot,
    });
    await expect(
      startM0DailyAcceptance({
        adapter: {
          doctor: async () => ({
            adapter: "copilot-cli",
            checkedAt: now.toISOString(),
            checks: [],
            status: "degraded",
          }),
          status: async () => ({
            capabilities: {
              adapter: "copilot-cli",
              capabilities: [],
              compatibility: "supported",
            },
            dataRoot,
            installed: true,
            marketplaceRegistered: true,
            pluginEnabled: true,
            pluginInstalled: true,
          }),
        },
        copilotHome,
        dataRoot,
        now: () => now,
        sessionRoot,
      }),
    ).rejects.toThrow("Another M0 daily acceptance run is active.");

    const completed = await completeM0DailyAcceptance({
      adapter: {
        doctor: async () => ({
          adapter: "copilot-cli",
          checkedAt: now.toISOString(),
          checks: [],
          providerStatus: "unverified",
          status: "degraded",
        }),
        status: async () => ({
          capabilities: {
            adapter: "copilot-cli",
            capabilities: [],
            compatibility: "supported",
            installedVersion: "1.0.82-0",
          },
          dataRoot,
          installed: true,
          marketplaceRegistered: true,
          pluginEnabled: true,
          pluginInstalled: true,
        }),
      },
      dataRoot,
      drainTimeoutMs: 5_000,
      now: () => new Date("2026-09-02T01:00:00.000Z"),
    }, {
      runWorker: (options) => runCaptureWorkerOnce({
        ...options,
        admission: () => ({ allowed, reasons: allowed ? [] : ["cpu"] }),
      }),
    });

    expect(completed).toMatchObject({
      runDirectory: started.runDirectory,
      runId: started.runId,
      status,
    });
    for (const name of [
      "capture-metrics.json",
      "environment.json",
      "final-health.json",
      "guardrails.json",
      "reconciliation.json",
      "report.json",
      "report.md",
      "run.json",
    ]) {
      await expect(
        access(join(completed.runDirectory, name)),
      ).resolves.toBeUndefined();
    }
    const report = await readFile(completed.reportPath, "utf8");
    expect(JSON.parse(report)).toMatchObject({
      status,
      evidenceKind: "observational",
      observationCompleted: allowed,
      releaseReadiness: "not_evaluated",
    });
    expect(JSON.parse(await readFile(
      join(completed.runDirectory, "guardrails.json"),
      "utf8",
    ))).toMatchObject({
      foregroundBlockingFailureCount: null,
      missingRequiredEventCount: null,
      malformedEventCount: 0,
      reconciliationFailureCount: 0,
      crossRepositoryLeakageCount: null,
      deletionPropagationFailureCount: null,
    });
    expect(report).not.toContain("Prompt");
    expect(report).not.toContain("tool arguments");
    const retainedRun = await readFile(
      join(completed.runDirectory, "run.json"),
      "utf8",
    );
    expect(retainedRun).not.toContain(dataRoot);
    expect(retainedRun).not.toContain(sessionRoot);
    await expect(
      access(join(paths.evaluation, "m0-daily", "active.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
