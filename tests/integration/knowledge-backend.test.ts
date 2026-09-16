import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type EvidenceTier,
  type KnowledgeCandidate,
  type Scope,
} from "@provenloop/contracts";
import {
  DeletionService,
  WorkEpisodeProjector,
} from "@provenloop/host";
import {
  resolveWindowsProvenLoopLeaseName,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  CanonicalKnowledgeRetriever,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
  knowledgeProjectionFromCandidate,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-knowledge-backend-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

const backendIdentifier = (identifier: string): string =>
  identifier.startsWith("knowledge:")
    ? identifier.slice("knowledge:".length)
    : identifier;

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

const candidate = (input: {
  readonly content?: string;
  readonly evidenceTier?: EvidenceTier;
  readonly expiresAt?: string;
  readonly id: string;
  readonly scope?: Scope;
  readonly scopeId?: string;
  readonly sourceEpisodeIds?: readonly string[];
  readonly sourceEvidenceIds?: readonly string[];
  readonly state?: KnowledgeCandidate["state"];
}): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "Running package validation.",
  ],
  conflictsWith: [],
  content:
    input.content ??
    "Run package validation with npm test before merging.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: "2026-08-30T00:00:00.000Z",
  evidenceMarks: [
    "externally_verified",
  ],
  evidenceTier: input.evidenceTier ?? "externally_verified",
  ...(input.expiresAt === undefined
    ? {}
    : {
        expiresAt: input.expiresAt,
      }),
  importance: 1,
  kind: "procedural",
  knowledgeId: input.id,
  nonApplicability: [
    "Skip when editing migration manifests.",
  ],
  scope: input.scope ?? "repository",
  ...(input.scopeId === undefined
    ? {}
    : {
        scopeId: input.scopeId,
      }),
  sourceEpisodeIds: [
    ...(input.sourceEpisodeIds ?? []),
  ],
  sourceEvidenceIds: [
    ...(input.sourceEvidenceIds ?? [
      `evidence-${input.id}`,
    ]),
  ],
  state: input.state ?? "active",
  topicKey: `topic-${input.id}`,
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-08-30T00:00:00.000Z",
});

describe("SQLite FTS Knowledge backend", () => {
  it("indexes, searches, gets, removes, rebuilds, and reports health", async () => {
    const backend = new SqliteFtsKnowledgeBackend(":memory:");
    try {
      const packageKnowledge = knowledgeProjectionFromCandidate(
        candidate({
          id: "package-tests",
          scopeId: "repo-1",
        }),
      );
      const migrationKnowledge = knowledgeProjectionFromCandidate(
        candidate({
          content:
            "Apply database migration validation before restoring backups.",
          id: "migration-validation",
          scopeId: "repo-1",
        }),
      );

      await backend.index([
        packageKnowledge,
        migrationKnowledge,
      ]);
      await expect(
        backend.search({
          limit: 3,
          text: "npm test",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          knowledgeId: "package-tests",
        }),
      ]);
      await expect(backend.get("package-tests")).resolves.toMatchObject({
        content: packageKnowledge.content,
        knowledgeId: "package-tests",
      });
      await expect(
        backend.search({
          limit: 3,
          text: "migration manifests",
        }),
      ).resolves.toEqual([]);

      await backend.remove([
        "package-tests",
      ]);
      await expect(backend.get("package-tests")).resolves.toBeUndefined();

      await backend.rebuild({
        records: [
          packageKnowledge,
        ],
      });
      await expect(backend.get("migration-validation"))
        .resolves.toBeUndefined();
      await expect(backend.health()).resolves.toEqual({
        fts5Available: true,
        quickCheck: "ok",
        recordCount: 1,
        status: "healthy",
      });
    } finally {
      await backend.closeAsync();
    }
  });

  it("keeps file-backed FTS healthy after updating one of many records", async () => {
    const root = await createTemporaryDirectory();
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const candidates = Array.from(
        {
          length: 30,
        },
        (_, index) =>
          knowledgeProjectionFromCandidate(
            candidate({
              content:
                `Run package validation for fixture ${index}.`,
              id: `fixture-${index}`,
              scopeId: `repo-${index}`,
            }),
          ),
      );
      await backend.rebuild({
        records: candidates,
      });
      await expect(
        backend.searchWithTimeout?.(
          {
            limit: 3,
            text: "fixture 0",
          },
          1_000,
        ),
      ).resolves.toHaveLength(1);

      const first = candidates[0];
      if (first === undefined) {
        throw new Error("Expected a Knowledge projection.");
      }
      await backend.index([
        {
          ...first,
          content: "Run corrected package validation for fixture 0.",
        },
      ]);

      await expect(
        backend.healthWithTimeout?.(1_000),
      ).resolves.toMatchObject({
        quickCheck: "ok",
        status: "healthy",
      });
      await expect(
        backend.searchWithTimeout?.(
          {
            limit: 3,
            text: "corrected fixture 0",
          },
          1_000,
        ),
      ).resolves.toHaveLength(1);
    } finally {
      await backend.closeAsync();
    }
  });

  it("rechecks canonical scope, lifecycle, evidence, and deletion", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const active = candidate({
        id: "active-repository",
        scopeId: "repo-1",
      });
      const wrongRepository = candidate({
        id: "wrong-repository",
        scopeId: "repo-2",
      });
      const inactive = candidate({
        id: "inactive",
        scopeId: "repo-1",
        state: "candidate",
      });
      const inferred = candidate({
        evidenceTier: "inferred",
        id: "inferred",
        scopeId: "repo-1",
      });
      const expired = candidate({
        expiresAt: "2026-08-01T00:00:00.000Z",
        id: "expired",
        scopeId: "repo-1",
      });
      store.upsertKnowledgeCandidates([
        active,
        wrongRepository,
        inactive,
        inferred,
        expired,
      ]);
      const projection = new KnowledgeProjectionManager({
        backend,
        store,
      });
      await expect(projection.rebuild()).resolves.toBe(5);
      const retriever = new CanonicalKnowledgeRetriever({
        backend,
        store,
      });

      await expect(
        retriever.search({
          limit: 3,
          now: new Date("2026-08-31T00:00:00.000Z"),
          repositoryScopeId: "repo-1",
          text: "package validation",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            knowledgeId: "active-repository",
          }),
        }),
      ]);

      const updatedActive = candidate({
        content: "Use the new-only-token validation workflow.",
        id: active.knowledgeId,
        scopeId: "repo-1",
      });
      store.upsertKnowledgeCandidates([
        updatedActive,
      ]);
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "npm test",
        }),
      ).resolves.toEqual([]);
      await projection.rebuild();
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "new-only-token",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            content: updatedActive.content,
          }),
        }),
      ]);

      store.removeKnowledgeCandidates([
        active.knowledgeId,
      ]);
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "package validation",
        }),
      ).resolves.toEqual([]);
      await expect(projection.rebuild()).resolves.toBe(4);
      await expect(backend.get(active.knowledgeId))
        .resolves.toBeUndefined();

      const deletedEventId = `event-${"a".repeat(64)}`;
      const deletedSource = candidate({
        id: "deleted-source",
        scopeId: "repo-1",
        sourceEvidenceIds: [
          deletedEventId.toUpperCase(),
        ],
      });
      store.upsertKnowledgeCandidates([
        deletedSource,
      ]);
      await projection.rebuild();
      await expect(backend.get(deletedSource.knowledgeId))
        .resolves.toBeDefined();
      const queue = new WindowsCaptureQueue(join(root, "queue"));
      await queue.initialize();
      const deletion = await new DeletionService({
        knowledgeProjection: {
          acquireLease: async () => ({
            release: async () => undefined,
          }),
          rebuild: async () => {
            await projection.rebuild();
          },
          remainingIdentifiers: async (identifiers) => {
            const remaining: string[] = [];
            for (const identifier of identifiers) {
              if (
                await backend.get(
                  backendIdentifier(identifier),
                ) !== undefined
              ) {
                remaining.push(identifier);
              }
            }
            return remaining;
          },
        },
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-knowledge-source",
        targetId: deletedEventId,
        targetType: "source",
      });
      expect(deletion.gate.status).toBe("pass");
      await expect(backend.get(deletedSource.knowledgeId))
        .resolves.toBeUndefined();

      const episodeId = "episode-deleted-knowledge";
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            associationConfidence: 1,
            associationEvidenceIds: [],
            branches: [
              "feat/knowledge",
            ],
            commitIds: [],
            correctionEventIds: [],
            episodeId,
            goal: "Test Knowledge deletion propagation.",
            issueIds: [],
            outcome: "unknown",
            outcomeEvidenceIds: [],
            outcomeQualification: "open",
            pullRequestIds: [],
            repoId: "repo-1",
            sessionIds: [
              "session-deleted-knowledge",
            ],
            sourceEventIds: [],
            startedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
      });
      const episodeKnowledge = candidate({
        id: "episode-source",
        scopeId: "repo-1",
        sourceEpisodeIds: [
          episodeId,
        ],
        sourceEvidenceIds: [],
      });
      store.upsertKnowledgeCandidates([
        episodeKnowledge,
      ]);
      const operation = store.beginDeletion(
        {
          targetId: "session-deleted-knowledge",
          targetType: "session",
        },
        "delete-knowledge-episode",
      );
      const mutation = store.deleteCanonicalTarget(
        operation.deletionId,
        {
          targetId: "session-deleted-knowledge",
          targetType: "session",
        },
      );
      expect(mutation.dependentIds).toContain(
        `knowledge:${episodeKnowledge.knowledgeId}`,
      );
      store.prepareDeletionCompletion({
        deletedDependentCount: mutation.dependentIds.length,
        deletedQueueItemCount: 0,
        deletedSourceCount: mutation.sourceIds.length,
        deletionId: operation.deletionId,
        gateDigest: "b".repeat(64),
        propagationEvidenceId:
          "delete-knowledge-episode:propagation:1:evidence",
      });
      store.completeDeletion(operation.deletionId);
      expect(() =>
        store.upsertKnowledgeCandidates([
          episodeKnowledge,
        ]),
      ).toThrow("missing source Episode");

      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "package validation",
        }),
      ).resolves.toEqual([]);
      expect(() =>
        store.upsertKnowledgeCandidates([
          deletedSource,
        ]),
      ).toThrow("contains a deleted identity");
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("continues paging until an eligible scoped result is found", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const wrongScope = Array.from({
        length: 20,
      }, (_value, index) =>
        candidate({
          content: "Use pagination-token for validation.",
          id: `a-wrong-${String(index).padStart(2, "0")}`,
          scopeId: "repo-2",
        }),
      );
      const valid = candidate({
        content: "Use pagination-token for validation.",
        id: "z-valid",
        scopeId: "repo-1",
      });
      store.upsertKnowledgeCandidates([
        ...wrongScope,
        valid,
      ]);
      const projection = new KnowledgeProjectionManager({
        backend,
        store,
      });
      await projection.rebuild();
      const retriever = new CanonicalKnowledgeRetriever({
        backend,
        store,
      });

      await expect(
        retriever.search({
          limit: 1,
          repositoryScopeId: "repo-1",
          text: "pagination-token",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            knowledgeId: valid.knowledgeId,
          }),
        }),
      ]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("fails closed when a source Episode projection disappears", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const episodeId = "episode-source-availability";
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            associationConfidence: 1,
            associationEvidenceIds: [],
            branches: [
              "feat/knowledge",
            ],
            commitIds: [],
            correctionEventIds: [],
            episodeId,
            goal: "Test source availability.",
            issueIds: [],
            outcome: "unknown",
            outcomeEvidenceIds: [],
            outcomeQualification: "open",
            pullRequestIds: [],
            repoId: "repo-1",
            sessionIds: [
              "session-source-availability",
            ],
            sourceEventIds: [],
            startedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
      });
      const knowledge = candidate({
        content: "Use episode-continuity-token for this workflow.",
        id: "source-availability",
        scopeId: "repo-1",
        sourceEpisodeIds: [
          episodeId,
        ],
      });
      store.upsertKnowledgeCandidates([
        knowledge,
      ]);
      const projection = new KnowledgeProjectionManager({
        backend,
        store,
      });
      await projection.rebuild();
      const retriever = new CanonicalKnowledgeRetriever({
        backend,
        store,
      });
      await expect(
        retriever.search({
          limit: 1,
          repositoryScopeId: "repo-1",
          text: "episode-continuity-token",
        }),
      ).resolves.toHaveLength(1);

      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [],
      });
      await expect(
        retriever.search({
          limit: 1,
          repositoryScopeId: "repo-1",
          text: "episode-continuity-token",
        }),
      ).resolves.toEqual([]);
      await expect(projection.rebuild()).resolves.toBe(0);
      await expect(backend.get(knowledge.knowledgeId))
        .resolves.toBeUndefined();
      const queue = new WindowsCaptureQueue(join(root, "queue"));
      await queue.initialize();
      const deletion = await new DeletionService({
        knowledgeProjection: {
          acquireLease: async () => ({
            release: async () => undefined,
          }),
          rebuild: async () => {
            await projection.rebuild();
          },
          remainingIdentifiers: async (identifiers) => {
            const remaining: string[] = [];
            for (const identifier of identifiers) {
              if (
                await backend.get(
                  backendIdentifier(identifier),
                ) !== undefined
              ) {
                remaining.push(identifier);
              }
            }
            return remaining;
          },
        },
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-missing-episode-source",
        targetId: episodeId,
        targetType: "episode",
      });
      expect(deletion.gate.status).toBe("pass");
      expect(store.knowledgeCandidates()).toEqual([]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("serializes deletion against worker projection rebuilds", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    try {
      const eventId = `event-${"c".repeat(64)}`;
      const knowledge = candidate({
        content: "Use serialized-deletion-token.",
        id: "serialized-deletion",
        scopeId: "repo-1",
        sourceEvidenceIds: [
          eventId,
        ],
      });
      store.upsertKnowledgeCandidates([
        knowledge,
      ]);
      const projection = new KnowledgeProjectionManager({
        backend,
        store,
      });
      await projection.rebuild();
      const leaseName = await resolveWindowsProvenLoopLeaseName(
        root,
        "knowledge-projection",
      );
      const provider = new WindowsNamedPipeLeaseProvider(
        leaseName,
      );
      const heldLease = await provider.tryAcquire();
      if (heldLease === undefined) {
        throw new Error("Expected the projection lease.");
      }
      let completed = false;
      const deletion = new DeletionService({
        knowledgeProjection: {
          acquireLease: async () => {
            let lease = await provider.tryAcquire();
            while (lease === undefined) {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 5);
              });
              lease = await provider.tryAcquire();
            }
            return lease;
          },
          rebuild: async () => {
            await projection.rebuild();
          },
          remainingIdentifiers: async (identifiers) => {
            const remaining: string[] = [];
            for (const identifier of identifiers) {
              if (
                await backend.get(
                  backendIdentifier(identifier),
                ) !== undefined
              ) {
                remaining.push(identifier);
              }
            }
            return remaining;
          },
        },
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-serialized-knowledge",
        targetId: eventId,
        targetType: "source",
      }).finally(() => {
        completed = true;
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(completed).toBe(false);
      expect(store.knowledgeCandidates()).toHaveLength(1);
      await heldLease.release();
      await expect(deletion).resolves.toMatchObject({
        gate: {
          status: "pass",
        },
      });
      await expect(backend.get(knowledge.knowledgeId))
        .resolves.toBeUndefined();
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("recovers missing Episode provenance for source deletion", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    try {
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/knowledge-source-delete",
        content: {
          message: "Create source-backed Knowledge.",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-knowledge-source-delete",
        sourceEventId: "knowledge-source-delete",
        timestamp: "2026-08-30T00:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(item).status).toBe("stored");
      const episode = new WorkEpisodeProjector({
        store,
      }).rebuild().episodes[0];
      if (episode === undefined) {
        throw new Error("Expected a source Episode.");
      }
      const knowledge = candidate({
        content: "Use source-delete-token.",
        id: "source-delete",
        scopeId: "repo-1",
        sourceEpisodeIds: [
          episode.episodeId,
        ],
        sourceEvidenceIds: [
          item.envelope.event.eventId,
        ],
      });
      store.upsertKnowledgeCandidates([
        knowledge,
      ]);
      const projection = new KnowledgeProjectionManager({
        backend,
        store,
      });
      await projection.rebuild();
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [],
      });

      const deletion = await new DeletionService({
        knowledgeProjection: {
          acquireLease: async () => ({
            release: async () => undefined,
          }),
          rebuild: async () => {
            await projection.rebuild();
          },
          remainingIdentifiers: async (identifiers) => {
            const remaining: string[] = [];
            for (const identifier of identifiers) {
              if (
                await backend.get(
                  backendIdentifier(identifier),
                ) !== undefined
              ) {
                remaining.push(identifier);
              }
            }
            return remaining;
          },
        },
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-source-backed-knowledge",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });

      expect(deletion.gate.status).toBe("pass");
      expect(store.knowledgeCandidates()).toEqual([]);
      await expect(backend.get(knowledge.knowledgeId))
        .resolves.toBeUndefined();
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });
});
