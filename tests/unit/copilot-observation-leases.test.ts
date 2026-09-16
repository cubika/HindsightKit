import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CopilotCliAdapter } from "@provenloop/copilot-adapter";
import {
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore, DEFAULT_SQLITE_MIGRATIONS } from "@provenloop/storage-sqlite";

import {
  createDefaultCopilotAdapterState,
  writeCopilotAdapterState,
} from "../../packages/copilot-adapter/src/operational-state.js";

const roots: string[] = [];
type Lease = NonNullable<Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>>;

const acquire = async (name: string): Promise<Lease> => {
  const lease = await new WindowsNamedPipeLeaseProvider(name).tryAcquire();
  if (lease === undefined) throw new Error("Expected an available test lease.");
  return lease;
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-observation-lease-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(join(root, "data-root"));
  await mkdir(dirname(paths.database), { recursive: true });
  await writeFile(paths.rootMarker, JSON.stringify({
    product: "ProvenLoop", schemaVersion: 1, root: paths.root,
  }));
  const state = createDefaultCopilotAdapterState(new Date("2026-09-01T00:00:00.000Z"));
  await writeCopilotAdapterState(paths.adapterState, {
    ...state, installed: true, marketplaceRegistered: true,
    pluginEnabled: true, pluginInstalled: true,
    capabilities: { ...state.capabilities, capture: { enabled: true }, worker: { enabled: true } },
  });
  const legacy = new CanonicalSqliteStore(paths.database, {
    migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, -1),
  });
  legacy.close();
  const run = vi.fn(async () => { throw new Error("Synthetic command failure"); });
  const adapter = new CopilotCliAdapter({
    dataRoot: paths.root, copilotHome: join(root, "copilot-home"),
    commandRunner: { run }, platform: "win32", environment: {}, upgradeDrainTimeoutMs: 80,
  });
  return {
    adapter, paths, run,
    names: [
      await resolveWindowsCaptureWorkerLeaseName(paths.root),
      await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection"),
      await resolveWindowsProvenLoopLeaseName(paths.root, "observations"),
    ] as const,
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Copilot observation lifecycle leases", () => {
  it.each(["upgrade", "purge"] as const)(
    "excludes active database work before %s mutates installation data",
    async (operation) => {
      const { adapter, paths, names, run } = await fixture();
      const invoke = () => operation === "upgrade" ? adapter.upgrade() : adapter.uninstall({ purge: true });
      let worker: Lease | undefined;
      let projection: Lease | undefined;
      let observations: Lease | undefined;
      try {
        worker = await acquire(names[0]);
        projection = await acquire(names[1]);
        observations = await acquire(names[2]);
        await expect(invoke()).rejects.toThrow(operation === "upgrade" ? "waiting for capture worker" : "capture worker is active");
        await worker.release();
        worker = undefined;
        if (operation === "upgrade") {
          await expect(invoke()).rejects.toThrow("waiting for observation collector");
          await observations.release(); observations = undefined;
          await expect(invoke()).rejects.toThrow("waiting for MCP retrieval");
          await projection.release(); projection = undefined;
        } else {
          await expect(invoke()).rejects.toThrow("retrieval, deletion");
          await projection.release(); projection = undefined;
          await expect(invoke()).rejects.toThrow("observation collector is active");
        }
        expect(run).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(paths.adapterState, "utf8")).installed).toBe(true);
        const previousMigration = DEFAULT_SQLITE_MIGRATIONS.at(-2);
        if (previousMigration === undefined) throw new Error("Expected a previous schema migration.");
        expect(CanonicalSqliteStore.databaseVersion(paths.database))
          .toBe(previousMigration.version);
        await expect(access(paths.rootMarker)).resolves.toBeUndefined();
        for (const name of names.slice(0, 2)) await (await acquire(name)).release();
      } finally {
        await observations?.release();
        await projection?.release();
        await worker?.release();
      }
    },
  );

  it.each(["upgrade", "purge"] as const)(
    "keeps observations excluded through %s and releases all earlier leases if observation release fails",
    async (operation) => {
      const { adapter, names, run } = await fixture();
      const heldDuringProbe: boolean[] = [];
      run.mockImplementation(async () => {
        const competing = await new WindowsNamedPipeLeaseProvider(names[2]).tryAcquire();
        heldDuringProbe.push(competing === undefined);
        await competing?.release();
        throw new Error("Synthetic command failure");
      });
      const released: number[] = [];
      const observationPosition = operation === "upgrade" ? 5 : 4;
      const acquiredCount = operation === "upgrade" ? 6 : 4;
      let attempts = 0;
      const tryAcquire = WindowsNamedPipeLeaseProvider.prototype.tryAcquire;
      const spy = vi.spyOn(WindowsNamedPipeLeaseProvider.prototype, "tryAcquire")
        .mockImplementation(async function (this: WindowsNamedPipeLeaseProvider) {
          const position = ++attempts;
          const lease = await tryAcquire.call(this);
          if (lease === undefined || position > acquiredCount) return lease;
          return {
            ...lease,
            release: async () => {
              await lease.release();
              released.push(position);
              if (position === observationPosition) throw new Error("Injected observation release failure");
            },
          };
        });
      try {
        await expect(operation === "upgrade" ? adapter.upgrade() : adapter.uninstall({ purge: true }))
          .rejects.toThrow("Injected observation release failure");
        expect(heldDuringProbe.length).toBeGreaterThan(0);
        expect(heldDuringProbe.every(Boolean)).toBe(true);
        expect(released).toEqual(operation === "upgrade" ? [3, 5, 6, 4, 2, 1] : [4, 3, 2, 1]);
      } finally {
        spy.mockRestore();
      }
      for (const name of names) await (await acquire(name)).release();
    },
  );
});
