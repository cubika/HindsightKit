import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectLocalObservations,
  invalidateLocalObservationProjection,
  readLocalObservationSummary,
} from "@provenloop/cli";
import {
  createDefaultCopilotAdapterState,
  writeCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import { createCaptureEnvelope } from "@provenloop/domain";
import {
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

import { PROVENLOOP_CODE_VERSION } from "../../packages/cli/src/release-metadata.js";

const roots: string[] = [];
const sourceTime = "2026-09-04T12:00:00.000Z";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const installedRoot = async (now: Date) => {
  const root = await mkdtemp(join(tmpdir(), "provenloop-observer-"));
  roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root);
  await mkdir(paths.data);
  await writeFile(paths.rootMarker, JSON.stringify({
    schemaVersion: 1,
    product: "ProvenLoop",
    root,
  }));
  const initial = createDefaultCopilotAdapterState(now);
  await writeCopilotAdapterState(paths.adapterState, {
    ...initial,
    installed: true,
    pluginEnabled: true,
    pluginInstalled: true,
    marketplaceRegistered: true,
    capabilities: {
      ...initial.capabilities,
      worker: { enabled: true },
      retrieval: { enabled: true },
    },
  });
  return paths;
};

const queueItem = (id: string, timestamp: string) => ({
  schemaVersion: 1 as const,
  attemptCount: 0,
  failureCount: 0,
  queueItemId: `queue-${id}`,
  state: "pending" as const,
  createdAt: timestamp,
  updatedAt: timestamp,
  envelope: createCaptureEnvelope({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    eventType: "prompt.submitted",
    sourceEventId: id,
    sessionId: "session-observed",
    repoId: "repo-observed",
    timestamp: sourceTime,
    trust: "user",
    content: { message: "Private project details must never appear in summaries." },
  }),
});

describe("automatic observation collector", () => {
  it("does not initialize an uninstalled data root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "provenloop-observer-disabled-"));
    roots.push(parent);
    const root = join(parent, "not-installed");
    expect(await collectLocalObservations({ dataRoot: root })).toMatchObject({
      status: "disabled",
      events: 0,
      contextUses: 0,
    });
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checkpoints bounded pages and catches late events and feedback on older requests", async () => {
    let now = new Date("2026-09-05T00:01:00.000Z");
    const paths = await installedRoot(now);
    const store = new CanonicalSqliteStore(paths.database, { now: () => now });
    try {
      store.replaceBranchContextProjection({ contexts: [{
        schemaVersion: 1,
        acceptedDecisions: [],
        branch: "main",
        branchContextId: "branch-observed",
        explicitConstraints: [],
        headSha: "a".repeat(40),
        implementationState: ["Recorded work"],
        recentVerificationEvidenceIds: [],
        repoId: "repo-observed",
        sourceEpisodeIds: [],
        sourceEventIds: [],
        unfinishedItems: [],
        updatedAt: sourceTime,
      }] });
      for (const id of ["a", "b", "c"]) {
        store.ingestQueueItem(queueItem(id, now.toISOString()));
        store.appendContextUseRecord({
          schemaVersion: 1,
          appliedKnowledgeIds: [],
          candidateKnowledgeIds: [],
          codeVersion: PROVENLOOP_CODE_VERSION,
          createdAt: sourceTime,
          latencyMs: 2,
          renderedTokens: 20,
          requestId: `request-${id}`,
          returnedKnowledgeIds: ["branch-context:branch-observed"],
          retrievalStatus: "provided",
          repoId: "repo-observed",
          sessionId: "session-observed",
        });
      }
      now = new Date("2026-09-05T00:02:00.000Z");
      const options = {
        dataRoot: paths.root,
        now: () => now,
        pageSize: 1,
        maxPages: 1,
      };
      expect(await collectLocalObservations(options)).toMatchObject({
        status: "recorded",
        events: 1,
        contextUses: 1,
        pending: true,
      });
      await collectLocalObservations(options);
      expect(await collectLocalObservations(options)).toMatchObject({
        events: 1,
        contextUses: 1,
        pending: false,
      });
      let summaries = await readLocalObservationSummary({
        dataRoot: paths.root,
        date: sourceTime.slice(0, 10),
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        observedEventCount: 3,
        retrieval: { providedCount: 3, explicitlyAdoptedCount: 0 },
        outcome: "unknown",
      });
      now = new Date("2026-09-05T00:03:00.000Z");
      store.ingestQueueItem(queueItem("late", now.toISOString()));
      store.recordBranchContextFeedback({
        contextRequestId: "request-a",
        event: {
          schemaVersion: 1,
          evidenceRef: "request-a",
          feedbackId: "feedback-later",
          kind: "strengthen",
          source: "user",
          targetId: "branch-observed",
          targetType: "branch_context",
          timestamp: now.toISOString(),
        },
        updateContextUseRecord: (record) => ({
          ...record,
          feedback: "helpful",
          appliedKnowledgeIds: ["branch-context:branch-observed"],
        }),
      });
      now = new Date("2026-09-05T00:04:00.000Z");
      expect(await collectLocalObservations(options)).toMatchObject({
        events: 1,
        contextUses: 1,
        pending: false,
      });
      summaries = await readLocalObservationSummary({
        dataRoot: paths.root,
        date: sourceTime.slice(0, 10),
      });
      expect(summaries[0]).toMatchObject({
        observedEventCount: 4,
        lastObservedAt: "2026-09-05T00:03:00.000Z",
        retrieval: {
          providedCount: 3,
          feedbackCount: 1,
          explicitlyAdoptedCount: 1,
        },
        controlledEffect: "not_established",
      });
      expect(JSON.stringify(summaries)).not.toContain("Private project");
      expect(JSON.stringify(summaries)).not.toContain("repo-observed");
      expect(await collectLocalObservations(options)).toMatchObject({
        events: 0,
        contextUses: 0,
      });
      const lease = await new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(paths.root, "observations"),
      ).tryAcquire();
      expect(lease).toBeDefined();
      try {
        expect(await collectLocalObservations(options)).toMatchObject({
          status: "busy",
        });
        await invalidateLocalObservationProjection(paths.root);
      } finally {
        await lease?.release();
      }
      expect(await readLocalObservationSummary({
        dataRoot: paths.root,
        date: sourceTime.slice(0, 10),
      })).toEqual([]);
      await collectLocalObservations({ ...options, pageSize: 100 });
      expect((await readLocalObservationSummary({
        dataRoot: paths.root,
        date: sourceTime.slice(0, 10),
      }))[0]?.observedEventCount).toBe(4);
    } finally {
      store.close();
    }
  });

  it("reports a corrupt checkpoint rather than assuming collection succeeded", async () => {
    const now = new Date("2026-09-05T00:01:00.000Z");
    const paths = await installedRoot(now);
    new CanonicalSqliteStore(paths.database).close();
    await writeFile(join(paths.data, "observation-cursor.json"), "{\"invalid\":true}");
    await expect(collectLocalObservations({
      dataRoot: paths.root,
      now: () => now,
    })).rejects.toThrow("Invalid local observation cursor");
  });
});
