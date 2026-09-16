import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  runCli,
} from "@provenloop/cli";
import {
  EvidenceLedgerWriter,
} from "@provenloop/evaluation";
import {
  createCaptureEnvelope,
  sha256,
} from "@provenloop/domain";
import {
  DeletionPropagationGateError,
  DeletionService,
  WorkEpisodeProjector,
} from "@provenloop/host";
import {
  CaptureQueueDeletionInProgressError,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-deletion-"),
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

describe("deletion propagation", () => {
  it("deletes source evidence, queue items, and dependent projections before success", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "canonical.db");
    const queueRoot = join(root, "queue");
    let sequence = 0;
    const queue = new WindowsCaptureQueue(queueRoot, {
      idGenerator: () => `queue-${sequence += 1}`,
    });
    await queue.initialize();
    const store = new CanonicalSqliteStore(databasePath);
    try {
      const targetInput = {
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete",
        content: {
          message: "Implement source deletion",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-1",
        sourceEventId: "shared-source-event-id",
        timestamp: "2026-08-30T00:00:00.000Z",
        trust: "user" as const,
      };
      const targetItem = await queue.enqueue(targetInput);
      expect(store.ingestQueueItem(targetItem).status).toBe("stored");
      const deletionTargetId = targetItem.envelope.event.eventId;
      const childItem = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete",
        eventType: "tool.completed",
        parentEventId: deletionTargetId,
        repoId: "repo-1",
        sessionId: "session-1",
        sourceEventId: "child-source",
        timestamp: "2026-08-30T00:05:00.000Z",
        trust: "tool",
      });
      expect(store.ingestQueueItem(childItem).status).toBe("stored");
      const contentMentionItem = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete",
        content: {
          message: deletionTargetId,
        },
        eventType: "agent.message",
        repoId: "repo-1",
        sessionId: "session-3",
        sourceEventId: "content-mention",
        timestamp: "2026-08-30T00:06:00.000Z",
        trust: "model",
      });
      expect(store.ingestQueueItem(contentMentionItem).status).toBe(
        "stored",
      );
      const survivorItem = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/delete",
        eventType: "agent.message",
        repoId: "repo-1",
        sessionId: "session-1",
        sourceEventId: "session-survivor",
        content: { message: "Source deletion retains unrelated work in this session." },
        timestamp: "2026-08-30T00:07:00.000Z",
        trust: "model",
      });
      expect(store.ingestQueueItem(survivorItem).status).toBe(
        "stored",
      );
      const retainedItem = await queue.enqueue({
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          branch: "feat/delete",
          content: {
            message: "Continue source deletion",
          },
          eventType: "prompt.submitted",
          repoId: "repo-1",
          sessionId: "session-2",
          sourceEventId: "shared-source-event-id",
          timestamp: "2026-08-30T00:10:00.000Z",
          trust: "user" as const,
      });
      expect(store.ingestQueueItem(retainedItem).status).toBe("stored");
      const crashTemporaryPath = join(
        queueRoot,
        ".queue-crash-remnant.tmp",
      );
      const unrelatedQueueTemporaryPath = join(
        queueRoot,
        ".queue-unrelated-remnant.tmp",
      );
      const unrelatedSourceTemporaryPath = join(
        queueRoot,
        ".source-unrelated-remnant.tmp",
      );
      const orphanIndexPath = join(
        queueRoot,
        `.source-${targetItem.envelope.deduplicationKey}.idx`,
      );
      await writeFile(
        crashTemporaryPath,
        JSON.stringify(childItem),
        "utf8",
      );
      await writeFile(
        unrelatedQueueTemporaryPath,
        JSON.stringify(retainedItem),
        "utf8",
      );
      await writeFile(
        unrelatedSourceTemporaryPath,
        `${retainedItem.queueItemId}\n`,
        "utf8",
      );
      await writeFile(
        orphanIndexPath,
        "missing-queue-item\n",
        "utf8",
      );
      const initialProjection = new WorkEpisodeProjector({
        store,
      }).rebuild();
      expect(initialProjection.episodes).toHaveLength(1);
      const initialEpisodeId =
        initialProjection.episodes[0]?.episodeId;
      if (initialEpisodeId === undefined) {
        throw new Error("Expected an initial Work Episode.");
      }
      const database = new DatabaseSync(databasePath);
      try {
        database
          .prepare(
            `INSERT INTO evidence_links (
               link_id,
               schema_version,
               body_json,
               source_digest,
               created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "dependent-link",
            1,
            JSON.stringify({
              sourceId: deletionTargetId,
            }),
            "a".repeat(64),
            "2026-08-30T00:00:00.000Z",
          );
        database
          .prepare(
            `INSERT INTO identities (
               identity_id,
               identity_type,
               canonical_value,
               source_digest,
               created_at
             ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?),
                      (?, ?, ?, ?, ?)`,
          )
          .run(
            "identity-a",
            "event",
            deletionTargetId,
            "c".repeat(64),
            "2026-08-30T00:00:00.000Z",
            "identity-b",
            "alias",
            "identity-a",
            "d".repeat(64),
            "2026-08-30T00:00:00.000Z",
            "identity-deduplication",
            "deduplication",
            targetItem.envelope.deduplicationKey,
            "e".repeat(64),
            "2026-08-30T00:00:00.000Z",
          );
        database
          .prepare(
            `INSERT INTO process_claims (
               claim_id,
               schema_version,
               body_json,
               source_digest,
               created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "dependent-claim",
            1,
            JSON.stringify({
              claimId: "dependent-claim",
              episodeId: initialEpisodeId,
            }),
            "b".repeat(64),
            "2026-08-30T00:00:00.000Z",
          );
      } finally {
        database.close();
      }
      const ledger = new EvidenceLedgerWriter(
        join(root, "deletion-ledger.jsonl"),
      );
      await ledger.initialize();
      const result = await new DeletionService({
        queue,
        recordEvidence: async (entry) => {
          await ledger.append([
            entry,
          ]);
        },
        store,
      }).delete({
        deletionId: "deletion-source-1",
        targetId: deletionTargetId,
        targetType: "source",
      });

      expect(result).toMatchObject({
        gate: {
          status: "pass",
        },
        operation: {
          deletionId: "deletion-source-1",
          status: "completed",
          targetType: "source",
        },
        remainingIds: [],
      });
      expect(result.deletedDependentIds).toContain(
        "dependent-link",
      );
      expect(result.deletedDependentIds).toContain(
        "dependent-claim",
      );
      expect(result.deletedDependentIds).toEqual(
        expect.arrayContaining([
          "identity-a",
          "identity-b",
          "identity-deduplication",
        ]),
      );
      expect(result.deletedQueueItemIds).toContain("queue-1");
      expect(result.deletedQueueItemIds).toContain("queue-2");
      expect(result.deletedQueueItemIds).not.toContain("queue-3");
      expect(result.deletedQueueItemIds).not.toContain("queue-4");
      expect(result.deletedQueueItemIds).not.toContain("queue-5");
      await expect(access(crashTemporaryPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(orphanIndexPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(unrelatedQueueTemporaryPath)).resolves.toBe(
        undefined,
      );
      await expect(access(unrelatedSourceTemporaryPath)).resolves.toBe(
        undefined,
      );
      expect(
        await queue.remainingIdentifiers(
          new Set(result.deletedSourceIds),
        ),
      ).toEqual([]);
      expect(
        store.remainingIdentifiers(
          new Set([
            ...result.deletedSourceIds,
            ...result.deletedDependentIds,
          ]),
        ),
      ).toEqual([]);
      expect(store.workEpisodes()).toHaveLength(1);
      expect(store.workEpisodes()[0]?.episodeId).toBe(
        initialEpisodeId,
      );
      expect(store.hasActiveDeletion()).toBe(false);
      expect(
        await readFile(ledger.path, "utf8"),
      ).toContain('"status":"deletion.completed"');
      await expect(
        queue.enqueueIfSourceAbsent(targetInput),
      ).resolves.toEqual({
        status: "duplicate",
      });
      expect(store.ingestQueueItem(targetItem).status).toBe(
        "duplicate",
      );
      const lateChildInput = {
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "tool.completed",
        parentEventId: deletionTargetId,
        sessionId: "session-late-child",
        sourceEventId: "late-child",
        timestamp: "2026-08-30T01:00:00.000Z",
        trust: "tool" as const,
      };
      await expect(
        queue.enqueueIfSourceAbsent(lateChildInput),
      ).resolves.toEqual({
        status: "duplicate",
      });
      const isolatedQueue = new WindowsCaptureQueue(
        join(root, "isolated-queue"),
        {
          idGenerator: () => "isolated-late-child",
        },
      );
      await isolatedQueue.initialize();
      const lateChild = await isolatedQueue.enqueue(
        lateChildInput,
      );
      expect(store.ingestQueueItem(lateChild).status).toBe(
        "duplicate",
      );
      const laterSameSession = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "agent.message",
        repoId: "repo-1",
        sessionId: "session-1",
        sourceEventId: "same-session-after-source-deletion",
        timestamp: "2026-08-30T01:05:00.000Z",
        trust: "model",
      });
      expect(store.ingestQueueItem(laterSameSession).status).toBe(
        "stored",
      );
      expect(() =>
        store.replaceWorkEpisodeProjection({
          associations: initialProjection.associations,
          corrections: [],
          episodes: initialProjection.episodes,
        }),
      ).toThrow("contains a deleted identity");

      const tombstone = new DatabaseSync(databasePath, {
        readOnly: true,
      });
      try {
        const row = tombstone
          .prepare(
            `SELECT body_json
               FROM deletion_operations
              WHERE deletion_id = ?`,
          )
          .get("deletion-source-1") as Readonly<
          Record<string, unknown>
        >;
        const body = String(row.body_json);
        expect(body).not.toContain(deletionTargetId);
        expect(body).toContain('"status":"completed"');
        const operation = JSON.parse(body) as Readonly<
          Record<string, unknown>
        >;
        expect(operation.targetDigest).not.toBe(
          sha256({
            targetId: deletionTargetId,
            targetType: "source",
          }),
        );
        expect(
          (
            operation.blockedIdentityDigests as readonly Readonly<
            Record<string, unknown>
          >[]
          ).map((tombstone) => tombstone.digest),
        ).not.toContain(
          sha256({
            deletionIdentity: deletionTargetId,
          }),
        );
      } finally {
        tombstone.close();
      }
      const tombstoneFiles = await readdir(
        join(queueRoot, ".deletion", "tombstones"),
      );
      expect(tombstoneFiles).not.toContain(
        sha256({
          deletionIdentity: deletionTargetId,
        }),
      );
    } finally {
      store.close();
    }
  });

  it("blocks ordinary Episode rebuilds while deletion is active", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const operation = store.beginDeletion(
        {
          targetId:
            "event-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          targetType: "source",
        },
        "deletion-active",
      );
      expect(() =>
        new WorkEpisodeProjector({
          store,
        }).rebuild(),
      ).toThrow("blocked by an active deletion");
      expect(
        store.failDeletion(
          operation.deletionId,
          "intentional cleanup",
        ).status,
      ).toBe("failed");
      expect(store.hasActiveDeletion()).toBe(true);
    } finally {
      store.close();
    }
  });

  it("deletes rejected parser payloads that have no raw-event row", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-rejected",
    });
    await queue.initialize();
    const queued = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-rejected",
      sourceEventId: "source-rejected",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const invalidEvent = {
      ...queued.envelope.event,
      eventId: "invalid-event-id",
    };
    const rejected = {
      ...queued,
      envelope: {
        ...queued.envelope,
        event: invalidEvent,
      },
    };
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(rejected).status).toBe(
        "rejected",
      );
      expect(store.parserErrors()).toHaveLength(1);
      await queue.deleteByIdentifiers(
        new Set([
          queued.envelope.event.eventId,
        ]),
      );
      expect(await queue.list()).toEqual([]);
      const ledger = new EvidenceLedgerWriter(
        join(root, "ledger.jsonl"),
      );
      await ledger.initialize();

      const result = await new DeletionService({
        queue,
        recordEvidence: async (entry) => {
          await ledger.append([
            entry,
          ]);
        },
        store,
      }).delete({
        deletionId: "delete-rejected",
        targetId: "session-rejected",
        targetType: "session",
      });

      expect(result.gate.status).toBe("pass");
      expect(store.parserErrors()).toEqual([]);
      expect(
        await queue.remainingIdentifiers(
          new Set(result.deletedSourceIds),
        ),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("resumes an Episode deletion after queue cleanup fails", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-resume",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-resume",
      sourceEventId: "source-resume",
      content: { message: "Implement retryable episode deletion." },
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      const episode = new WorkEpisodeProjector({
        store,
      }).rebuild().episodes[0];
      if (episode === undefined) {
        throw new Error("Expected an Episode to delete.");
      }
      let failQueueDelete = true;
      const failingQueue = {
        activeDeletionBarrier: () =>
          queue.activeDeletionBarrier(),
        beginDeletionBarrier: (deletionId: string) =>
          queue.beginDeletionBarrier(deletionId),
        blockIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["blockIdentities"]
          >[0],
        ) => queue.blockIdentities(identities),
        deleteByIdentifiers: (
          identifiers: ReadonlySet<string>,
          options?: Parameters<
            WindowsCaptureQueue["deleteByIdentifiers"]
          >[1],
        ) => {
          if (failQueueDelete) {
            failQueueDelete = false;
            return queue
              .deleteByIdentifiers(identifiers, options)
              .then(() =>
                Promise.reject(
                  new Error(
                    "intentional queue deletion failure",
                  ),
                ),
              );
          }
          return queue.deleteByIdentifiers(identifiers, options);
        },
        endDeletionBarrier: (deletionId: string) =>
          queue.endDeletionBarrier(deletionId),
        remainingIdentifiers: (
          identifiers: ReadonlySet<string>,
        ) => queue.remainingIdentifiers(identifiers),
        remainingIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["remainingIdentities"]
          >[0],
        ) => queue.remainingIdentities(identities),
      };
      const evidence: string[] = [];
      await expect(
        new DeletionService({
          queue: failingQueue,
          recordEvidence: async (entry) => {
            evidence.push(entry.status);
          },
          store,
        }).delete({
          deletionId: "delete-episode-resume",
          targetId: episode.episodeId,
          targetType: "episode",
        }),
      ).rejects.toThrow("intentional queue deletion failure");
      expect(
        store.deletionOperation("delete-episode-resume"),
      ).toMatchObject({
        status: "failed",
        plannedQueueItemIds: [
          "queue-resume",
        ],
        plannedSourceIds: expect.arrayContaining([
          item.envelope.event.eventId,
        ]),
      });
      expect(() => store.ingestQueueItem(item)).toThrow(
        "blocked by an active deletion",
      );
      const checkpointedQueueTemporaryPath = join(
        queue.root,
        ".queue-queue-resume-crash.tmp",
      );
      const checkpointedSourceTemporaryPath = join(
        queue.root,
        ".source-queue-resume-crash.tmp",
      );
      await writeFile(
        checkpointedQueueTemporaryPath,
        "partial",
        "utf8",
      );
      await writeFile(
        checkpointedSourceTemporaryPath,
        "queue-resume\n",
        "utf8",
      );

      const resumed = await new DeletionService({
        queue,
        recordEvidence: async (entry) => {
          evidence.push(entry.status);
        },
        store,
      }).delete({
        deletionId: "ignored-new-id",
        targetId: episode.episodeId,
        targetType: "episode",
      });

      expect(resumed.operation).toMatchObject({
        deletedQueueItemCount: 1,
        deletionId: "delete-episode-resume",
        status: "completed",
      });
      expect(resumed.deletedQueueItemIds).toEqual([
        "queue-resume",
      ]);
      expect(resumed.gate.status).toBe("pass");
      expect(await queue.list()).toEqual([]);
      await expect(
        access(checkpointedQueueTemporaryPath),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(checkpointedSourceTemporaryPath),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const isolatedQueue = new WindowsCaptureQueue(
        join(root, "isolated-episode-queue"),
        {
          idGenerator: () => "isolated-episode-item",
        },
      );
      await isolatedQueue.initialize();
      const recreatedSessionItem = await isolatedQueue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-resume",
        sourceEventId: "source-after-episode-deletion",
        timestamp: "2026-08-30T01:00:00.000Z",
        trust: "user",
      });
      expect(
        store.ingestQueueItem(recreatedSessionItem).status,
      ).toBe("duplicate");
      expect(evidence).toEqual([
        "deletion.propagation.checked",
        "deletion.completed",
      ]);
    } finally {
      store.close();
    }
  });

  it("deletes all canonical evidence for sessions in an Episode", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-episode-scope-${sequence += 1}`,
    });
    await queue.initialize();
    const supported = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-episode-scope",
      sourceEventId: "episode-supported-source",
      content: { message: "Investigate episode deletion scope." },
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const unsupported = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.70-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-episode-scope",
      sourceEventId: "episode-unsupported-source",
      timestamp: "2026-08-30T00:01:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(supported).status).toBe("stored");
      expect(store.ingestQueueItem(unsupported).status).toBe(
        "unsupported",
      );
      const episode = new WorkEpisodeProjector({
        store,
      }).rebuild().episodes[0];
      if (episode === undefined) {
        throw new Error("Expected an Episode to delete.");
      }

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-episode-session-scope",
        targetId: episode.episodeId,
        targetType: "episode",
      });

      expect(
        store.rawEvent(unsupported.envelope.deduplicationKey),
      ).toBeUndefined();
      const isolatedQueue = new WindowsCaptureQueue(
        join(root, "isolated-episode-scope"),
        {
          idGenerator: () => "isolated-episode-scope-item",
        },
      );
      await isolatedQueue.initialize();
      const recreated = await isolatedQueue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-episode-scope",
        sourceEventId: "episode-recreated-source",
        timestamp: "2026-08-30T01:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(recreated).status).toBe(
        "duplicate",
      );
    } finally {
      store.close();
    }
  });

  it("recovers a missing Episode projection before deleting its evidence", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-missing-episode",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      branch: "feat/missing-episode",
      content: {
        message: "Implement missing Episode recovery.",
      },
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-missing-episode",
      sourceEventId: "source-missing-episode",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      const episode = new WorkEpisodeProjector({
        store,
      }).rebuild().episodes[0];
      if (episode === undefined) {
        throw new Error("Expected an Episode.");
      }
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [],
      });

      const result = await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-missing-episode",
        targetId: episode.episodeId,
        targetType: "episode",
      });

      expect(result.gate.status).toBe("pass");
      expect(
        store.rawEvent(item.envelope.deduplicationKey),
      ).toBeUndefined();
      expect(store.workEpisodes()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("does not expand Episode deletion into a dependency child session", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-episode-child-${sequence += 1}`,
    });
    await queue.initialize();
    const target = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-episode-parent",
      sourceEventId: "episode-parent-source",
      content: { message: "Inspect dependencies without expanding deletion scope." },
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const child = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.70-0",
      eventType: "tool.completed",
      parentEventId: target.envelope.event.eventId,
      repoId: "repo-1",
      sessionId: "session-episode-child",
      sourceEventId: "episode-child-source",
      timestamp: "2026-08-30T00:01:00.000Z",
      trust: "tool",
    });
    const unrelated = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.70-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-episode-child",
      sourceEventId: "episode-child-unrelated",
      timestamp: "2026-08-30T00:02:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(target).status).toBe("stored");
      expect(store.ingestQueueItem(child).status).toBe(
        "unsupported",
      );
      expect(store.ingestQueueItem(unrelated).status).toBe(
        "unsupported",
      );
      const episode = new WorkEpisodeProjector({
        store,
      }).rebuild().episodes[0];
      if (episode === undefined) {
        throw new Error("Expected an Episode to delete.");
      }

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-episode-child-scope",
        targetId: episode.episodeId,
        targetType: "episode",
      });

      expect(
        store.rawEvent(child.envelope.deduplicationKey),
      ).toBeUndefined();
      expect(
        store.rawEvent(unrelated.envelope.deduplicationKey),
      ).toBeDefined();
      const isolatedQueue = new WindowsCaptureQueue(
        join(root, "isolated-child-session"),
        {
          idGenerator: () => "isolated-child-session-item",
        },
      );
      await isolatedQueue.initialize();
      const future = await isolatedQueue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-episode-child",
        sourceEventId: "episode-child-future",
        timestamp: "2026-08-30T01:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(future).status).toBe("stored");
    } finally {
      store.close();
    }
  });

  it("repairs completion evidence without repeating a completed deletion", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-evidence-repair",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-evidence-repair",
      sourceEventId: "source-evidence-repair",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      let failCompletionEvidence = true;
      await expect(
        new DeletionService({
          queue,
          recordEvidence: async (entry) => {
            if (
              entry.status === "deletion.completed" &&
              failCompletionEvidence
            ) {
              failCompletionEvidence = false;
              throw new Error("intentional completion evidence failure");
            }
          },
          store,
        }).delete({
          deletionId: "delete-evidence-repair",
          targetId: item.envelope.event.eventId,
          targetType: "source",
        }),
      ).rejects.toThrow("intentional completion evidence failure");
      expect(
        store.deletionOperation("delete-evidence-repair"),
      ).toMatchObject({
        status: "completing",
      });

      await queue.beginDeletionBarrier(
        "delete-evidence-repair",
      );
      const recoveredEvidence: string[] = [];
      const recovered = await new DeletionService({
        queue,
        recordEvidence: async (entry) => {
          recoveredEvidence.push(entry.status);
        },
        store,
      }).delete({
        deletionId: "ignored-repair-id",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });

      expect(recovered.operation.deletionId).toBe(
        "delete-evidence-repair",
      );
      expect(recoveredEvidence).toEqual([
        "deletion.completed",
      ]);
      expect(await queue.list()).toEqual([]);
      await expect(
        queue.enqueue({
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          eventType: "prompt.submitted",
          sessionId: "session-after-repair",
          sourceEventId: "source-after-repair",
          timestamp: "2026-08-30T02:00:00.000Z",
          trust: "user",
        }),
      ).resolves.toMatchObject({
        state: "pending",
      });
    } finally {
      store.close();
    }
  });

  it("records distinct propagation evidence for a failed Gate retry", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-gate-retry",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-gate-retry",
      sourceEventId: "source-gate-retry",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const ledger = new EvidenceLedgerWriter(
      join(root, "retry-ledger.jsonl"),
    );
    await ledger.initialize();
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      let forceRemaining = true;
      const failingGateQueue = {
        activeDeletionBarrier: () =>
          queue.activeDeletionBarrier(),
        beginDeletionBarrier: (deletionId: string) =>
          queue.beginDeletionBarrier(deletionId),
        blockIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["blockIdentities"]
          >[0],
        ) => queue.blockIdentities(identities),
        deleteByIdentifiers: (
          identifiers: ReadonlySet<string>,
          options?: Parameters<
            WindowsCaptureQueue["deleteByIdentifiers"]
          >[1],
        ) => queue.deleteByIdentifiers(identifiers, options),
        endDeletionBarrier: (deletionId: string) =>
          queue.endDeletionBarrier(deletionId),
        remainingIdentifiers: (
          identifiers: ReadonlySet<string>,
        ) => queue.remainingIdentifiers(identifiers),
        remainingIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["remainingIdentities"]
          >[0],
        ) => {
          if (forceRemaining) {
            forceRemaining = false;
            return Promise.resolve([
              {
                identifier: item.envelope.event.eventId,
                identityType: "event" as const,
              },
            ]);
          }
          return queue.remainingIdentities(identities);
        },
      };
      const recordEvidence = async (
        entry: Parameters<EvidenceLedgerWriter["appendIfAbsent"]>[0][number],
      ): Promise<void> => {
        await ledger.appendIfAbsent([
          entry,
        ]);
      };
      await expect(
        new DeletionService({
          queue: failingGateQueue,
          recordEvidence,
          store,
        }).delete({
          deletionId: "delete-gate-retry",
          targetId: item.envelope.event.eventId,
          targetType: "source",
        }),
      ).rejects.toBeInstanceOf(DeletionPropagationGateError);

      const completed = await new DeletionService({
        queue,
        recordEvidence,
        store,
      }).delete({
        deletionId: "ignored-gate-retry-id",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });
      expect(completed.operation.status).toBe("completed");
      const entries = (await readFile(ledger.path, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) =>
          JSON.parse(line) as Readonly<Record<string, unknown>>,
        );
      const propagation = entries.filter(
        (entry) =>
          entry.status === "deletion.propagation.checked",
      );
      expect(propagation).toHaveLength(2);
      expect(
        new Set(
          propagation.map((entry) => entry.ledgerEntryId),
        ).size,
      ).toBe(2);
      expect(entries.at(-1)).toMatchObject({
        status: "deletion.completed",
      });
    } finally {
      store.close();
    }
  });

  it("blocks new queue and canonical ingestion while deletion is active", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-active-${sequence += 1}`,
    });
    await queue.initialize();
    const pending = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-active",
      sourceEventId: "source-active",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const operation = store.beginDeletion(
        {
          targetId: pending.envelope.event.eventId,
          targetType: "source",
        },
        "delete-active",
      );
      await queue.beginDeletionBarrier(operation.deletionId);
      expect(
        await queue.claimNext("worker-during-deletion"),
      ).toBeUndefined();
      expect(
        await queue.recoverExpiredClaims(),
      ).toEqual([]);
      await expect(
        queue.enqueue({
          adapter: "copilot-cli",
          adapterVersion: "1.0.82-0",
          eventType: "prompt.submitted",
          sessionId: "session-new",
          sourceEventId: "source-new",
          timestamp: "2026-08-30T00:01:00.000Z",
          trust: "user",
        }),
      ).rejects.toBeInstanceOf(
        CaptureQueueDeletionInProgressError,
      );
      expect(() => store.ingestQueueItem(pending)).toThrow(
        "blocked by an active deletion",
      );
      store.failDeletion(
        operation.deletionId,
        "intentional cleanup",
      );
      await queue.endDeletionBarrier(operation.deletionId);
    } finally {
      store.close();
    }
  });

  it("prevents concurrent execution of the same deletion operation", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => "queue-concurrent",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-concurrent",
      sourceEventId: "source-concurrent",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      let releaseDelete: (() => void) | undefined;
      let markDeleteStarted: (() => void) | undefined;
      const deleteStarted = new Promise<void>((resolve) => {
        markDeleteStarted = resolve;
      });
      const deleteReleased = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const delayedQueue = {
        activeDeletionBarrier: () =>
          queue.activeDeletionBarrier(),
        beginDeletionBarrier: (deletionId: string) =>
          queue.beginDeletionBarrier(deletionId),
        blockIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["blockIdentities"]
          >[0],
        ) => queue.blockIdentities(identities),
        deleteByIdentifiers: async (
          identifiers: ReadonlySet<string>,
        ) => {
          markDeleteStarted?.();
          await deleteReleased;
          return queue.deleteByIdentifiers(identifiers);
        },
        endDeletionBarrier: (deletionId: string) =>
          queue.endDeletionBarrier(deletionId),
        remainingIdentifiers: (
          identifiers: ReadonlySet<string>,
        ) => queue.remainingIdentifiers(identifiers),
        remainingIdentities: (
          identities: Parameters<
            WindowsCaptureQueue["remainingIdentities"]
          >[0],
        ) => queue.remainingIdentities(identities),
      };
      const first = new DeletionService({
        queue: delayedQueue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-concurrent",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });
      await deleteStarted;

      await expect(
        new DeletionService({
          queue,
          recordEvidence: async () => undefined,
          store,
        }).delete({
          deletionId: "delete-concurrent-second",
          targetId: item.envelope.event.eventId,
          targetType: "source",
        }),
      ).rejects.toThrow("already executing");
      releaseDelete?.();
      await expect(first).resolves.toMatchObject({
        operation: {
          status: "completed",
        },
      });
    } finally {
      store.close();
    }
  });

  it("blocks recreated sessions and pre-deleted event identities", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-tombstone-${sequence += 1}`,
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-tombstone",
      sourceEventId: "source-tombstone",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const recordEvidence = async (): Promise<void> => undefined;
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      await new DeletionService({
        queue,
        recordEvidence,
        store,
      }).delete({
        deletionId: "delete-session-tombstone",
        targetId: "session-tombstone",
        targetType: "session",
      });
      const recreatedSessionInput = {
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        sessionId: "session-tombstone",
        sourceEventId: "source-new",
        timestamp: "2026-08-30T01:00:00.000Z",
        trust: "user" as const,
      };
      await expect(
        queue.enqueueIfSourceAbsent(recreatedSessionInput),
      ).resolves.toEqual({
        status: "duplicate",
      });
      const isolatedSessionQueue = new WindowsCaptureQueue(
        join(root, "isolated-session"),
        {
          idGenerator: () => "isolated-session-item",
        },
      );
      await isolatedSessionQueue.initialize();
      const recreatedSession = await isolatedSessionQueue.enqueue(
        recreatedSessionInput,
      );
      expect(store.ingestQueueItem(recreatedSession).status).toBe(
        "duplicate",
      );

      const futureInput = {
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        sessionId: "future-session",
        sourceEventId: "future-source",
        timestamp: "2026-08-30T02:00:00.000Z",
        trust: "user" as const,
      };
      const futureEnvelope = createCaptureEnvelope(futureInput);
      await queue.beginDeletionBarrier(
        "delete-session-tombstone",
      );
      await new DeletionService({
        queue,
        recordEvidence,
        store,
      }).delete({
        deletionId: "delete-future-event",
        targetId: futureEnvelope.event.eventId.toUpperCase(),
        targetType: "source",
      });
      await expect(
        queue.enqueueIfSourceAbsent(futureInput),
      ).resolves.toEqual({
        status: "duplicate",
      });
      const isolatedFutureQueue = new WindowsCaptureQueue(
        join(root, "isolated-future"),
        {
          idGenerator: () => "isolated-future-item",
        },
      );
      await isolatedFutureQueue.initialize();
      const futureItem = await isolatedFutureQueue.enqueue(
        futureInput,
      );
      expect(store.ingestQueueItem(futureItem).status).toBe(
        "duplicate",
      );
    } finally {
      store.close();
    }
  });

  it("keeps identity namespaces separate during source deletion", async () => {
    const root = await createTemporaryDirectory();
    let sequence = 0;
    const queue = new WindowsCaptureQueue(join(root, "queue"), {
      idGenerator: () => `queue-namespace-${sequence += 1}`,
    });
    await queue.initialize();
    const target = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "ordinary-session",
      sourceEventId: "namespace-target",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const collision = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: target.envelope.event.eventId,
      sourceEventId: "namespace-collision",
      timestamp: "2026-08-30T00:01:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(target).status).toBe("stored");
      expect(store.ingestQueueItem(collision).status).toBe(
        "stored",
      );
      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-namespace-target",
        targetId: target.envelope.event.eventId,
        targetType: "source",
      });

      expect(await queue.list()).toEqual([
        expect.objectContaining({
          queueItemId: collision.queueItemId,
        }),
      ]);
      expect(
        store.rawEvent(collision.envelope.deduplicationKey),
      ).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("fails closed when the queue tombstone key is lost or replaced", async () => {
    const root = await createTemporaryDirectory();
    const queueRoot = join(root, "queue");
    const queue = new WindowsCaptureQueue(queueRoot, {
      idGenerator: () => "queue-key-loss",
    });
    await queue.initialize();
    const input = {
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      sessionId: "session-key-loss",
      sourceEventId: "source-key-loss",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user" as const,
    };
    const item = await queue.enqueue(input);
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-key-loss",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });
      const keyPath = join(
        queueRoot,
        ".deletion",
        "identity.key",
      );
      await rm(keyPath);
      await expect(
        queue.enqueueIfSourceAbsent(input),
      ).rejects.toThrow("identity key is missing");
      await writeFile(keyPath, "f".repeat(64), "utf8");
      await expect(
        queue.enqueueIfSourceAbsent(input),
      ).rejects.toThrow("does not match tombstones");
    } finally {
      store.close();
    }
  });

  it("fails closed when an incomplete deletion loses its canonical key", async () => {
    const root = await createTemporaryDirectory();
    const databasePath = join(root, "canonical.db");
    const store = new CanonicalSqliteStore(databasePath);
    store.beginDeletion(
      {
        targetId:
          "event-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        targetType: "source",
      },
      "delete-incomplete-key-loss",
    );
    store.close();

    const keyPath = `${databasePath}.deletion.key`;
    await rm(keyPath);
    expect(() =>
      new CanonicalSqliteStore(databasePath),
    ).toThrow("deletion identity key is missing");

    await writeFile(keyPath, "f".repeat(64), "utf8");
    expect(() =>
      new CanonicalSqliteStore(databasePath),
    ).toThrow("does not match tombstones");
  });

  it("exposes source deletion through the operational CLI without echoing the target", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    await Promise.all([
      mkdir(paths.data, {
        recursive: true,
      }),
      mkdir(paths.queue, {
        recursive: true,
      }),
    ]);
    await writeFile(
      paths.rootMarker,
      JSON.stringify({
        product: "ProvenLoop",
        root: paths.root,
        schemaVersion: 1,
      }),
      "utf8",
    );
    const queue = new WindowsCaptureQueue(paths.queue, {
      idGenerator: () => "queue-cli-delete",
    });
    await queue.initialize();
    const item = await queue.enqueue({
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      eventType: "prompt.submitted",
      repoId: "repo-1",
      sessionId: "session-1",
      sourceEventId: "source-cli-delete",
      timestamp: "2026-08-30T00:00:00.000Z",
      trust: "user",
    });
    const store = new CanonicalSqliteStore(paths.database);
    try {
      expect(store.ingestQueueItem(item).status).toBe("stored");
    } finally {
      store.close();
    }
    const logs: string[] = [];
    const errors: string[] = [];

    await expect(
      runCli(
        [
          "delete",
          "--source",
          item.envelope.event.eventId,
          "--data-root",
          dataRoot,
        ],
        {
          error: (message) => errors.push(message),
          log: (message) => logs.push(message),
        },
      ),
    ).resolves.toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(item.envelope.event.eventId);
    const restarted = new CanonicalSqliteStore(paths.database);
    try {
      expect(
        restarted.episodeSourceEnvelopes(),
      ).toEqual([]);
      expect(
        restarted.hasActiveDeletion(),
      ).toBe(false);
    } finally {
      restarted.close();
    }
  });
});
