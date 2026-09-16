import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "@provenloop/cli";
import { KnowledgeControlService } from "@provenloop/host";
import {
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
  type ProcessLease,
} from "@provenloop/platform-windows";
import {
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

describe("deletion and observation projection exclusion", () => {
  it("holds projection then observations before deleting and invalidates only derived observations", async () => {
    const root = await mkdtemp(join(process.cwd(), ".r4-deletion-observations-"));
    const paths = resolveWindowsProvenLoopPaths(root);
    let store: CanonicalSqliteStore | undefined;
    let backend: SqliteFtsKnowledgeBackend | undefined;
    let observationsLease: ProcessLease | undefined;
    let deletion: Promise<number> | undefined;
    try {
      await mkdir(paths.data, { recursive: true });
      await writeFile(paths.rootMarker, JSON.stringify({
        product: "ProvenLoop",
        root: paths.root,
        schemaVersion: 1,
      }), "utf8");
      store = new CanonicalSqliteStore(paths.database);
      backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
      const projection = new KnowledgeProjectionManager({ backend, store });
      const service = new KnowledgeControlService({
        store,
        projection: {
          acquireLease: async () => ({ release: async () => undefined }),
          rebuild: () => projection.rebuild().then(() => undefined),
        },
      });
      const removed = await service.remember({
        content: "Run focused tests for one component.",
        appliesWhen: ["Changing code."],
        scope: "personal",
      });
      const retained = await service.remember({
        content: "Run focused tests for another component.",
        appliesWhen: ["Changing code."],
        scope: "personal",
      });
      if (removed.candidate === undefined || retained.candidate === undefined) {
        throw new Error("Expected two independent rules.");
      }
      await backend.closeAsync();
      backend = undefined;
      const observationDirectory = join(paths.evaluation, "observations");
      const observationFile = join(observationDirectory, "snapshot.json");
      const cursor = join(paths.data, "observation-cursor.json");
      await mkdir(observationDirectory, { recursive: true });
      await writeFile(observationFile, '{"derived":true}', "utf8");
      await writeFile(cursor, '{"watermark":1}', "utf8");
      observationsLease = await new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(root, "observations"),
      ).tryAcquire();
      if (observationsLease === undefined) {
        throw new Error("Expected the fixture to own the observation collector lease.");
      }
      const errors: string[] = [];
      let finished = false;
      deletion = runCli(["forget", removed.candidate.knowledgeId, "--data-root", root], {
        log: () => undefined,
        error: (message) => { errors.push(message); },
      });
      void deletion.then(() => { finished = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const projectionProbe = await new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(root, "knowledge-projection"),
      ).tryAcquire();
      await projectionProbe?.release();
      expect(projectionProbe).toBeUndefined();
      expect(finished).toBe(false);
      expect(store.knowledgeCandidates([removed.candidate.knowledgeId])).toHaveLength(1);
      expect(store.hasActiveDeletion()).toBe(false);
      await expect(access(observationFile)).resolves.toBeUndefined();
      await expect(access(cursor)).resolves.toBeUndefined();

      await observationsLease.release();
      observationsLease = undefined;
      expect(await deletion, errors.join("\n")).toBe(0);
      expect(store.knowledgeCandidates([removed.candidate.knowledgeId])).toEqual([]);
      expect(store.knowledgeCandidates([retained.candidate.knowledgeId])).toHaveLength(1);
      await expect(access(observationDirectory)).rejects.toThrow();
      await expect(access(cursor)).rejects.toThrow();
      await expect(access(paths.database)).resolves.toBeUndefined();
    } finally {
      await observationsLease?.release();
      await deletion;
      await backend?.closeAsync();
      store?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
