import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type KnowledgeCandidate,
  type WorkEpisode,
} from "@provenloop/contracts";
import {
  CorrectionCaptureProjector,
  KnowledgeLifecycleProjector,
} from "@provenloop/host";
import { WindowsCaptureQueue } from "@provenloop/platform-windows";
import {
  CanonicalKnowledgeRetriever,
  ContextRetrievalService,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-knowledge-lifecycle-"),
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

const correctionMessage = [
  "Violated Constraint: Inspect package scripts before choosing a test runner",
  "Expected Behavior: Run the targeted Vitest command",
  "Trigger: package validation",
  "Task Family: testing",
  "Subsystem: test-runner",
  "Scope: repository",
].join("\n");

const workEpisode = (
  sourceEventIds: readonly string[],
): WorkEpisode => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  associationConfidence: 1,
  associationEvidenceIds: [],
  branches: [
    "feat/testing",
  ],
  commitIds: [],
  correctionEventIds: [
    sourceEventIds[0] ?? "",
  ].filter((value) => value.length > 0),
  episodeId: "episode-correction",
  finishedAt: "2026-09-01T00:30:00.000Z",
  goal: "Run package validation",
  issueIds: [],
  outcome: "success",
  outcomeEvidenceIds: [
    sourceEventIds[1] ?? "",
  ].filter((value) => value.length > 0),
  outcomeQualification: "censored",
  observationWindowEndsAt: "2026-09-15T00:20:00.000Z",
  pullRequestIds: [],
  repoId: "repo-1",
  sessionIds: [
    "session-correction",
  ],
  sourceEventIds: [
    ...sourceEventIds,
  ],
  startedAt: "2026-09-01T00:00:00.000Z",
});

const manualKnowledge = (): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "Editing documentation",
  ],
  conflictsWith: [],
  content: "Keep examples concise.",
  coverage: {
    applicableOpportunities: 0,
    observedOutcomes: 0,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  evidenceMarks: [
    "user_confirmed",
  ],
  evidenceTier: "user_confirmed",
  importance: 1,
  kind: "procedural",
  knowledgeId: "manual-knowledge-docs",
  nonApplicability: [],
  scope: "repository",
  scopeId: "repo-1",
  sourceEpisodeIds: [],
  sourceEvidenceIds: [],
  state: "active",
  topicKey: "manual:docs",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-09-01T00:00:00.000Z",
});

const seedLifecycle = async (
  root: string,
  store: CanonicalSqliteStore,
): Promise<KnowledgeCandidate> => {
  let sequence = 0;
  const queue = new WindowsCaptureQueue(join(root, "queue"), {
    idGenerator: () => `queue-${sequence += 1}`,
  });
  await queue.initialize();
  const correction = await queue.enqueue({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: "feat/testing",
    content: {
      message: correctionMessage,
    },
    eventType: "user.corrected",
    repoId: "repo-1",
    sessionId: "session-correction",
    sourceEventId: "correction",
    timestamp: "2026-09-01T00:10:00.000Z",
    trust: "user",
    worktree: "C:\\repo",
  });
  const operation = await queue.enqueue({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: "feat/testing",
    eventType: "tool.started",
    content: { toolArguments: { command: "npm test -- --run tests\\logging.test.ts" } },
    operationId: "verify-correction",
    parentEventId: correction.envelope.event.eventId,
    repoId: "repo-1",
    sessionId: "session-correction",
    sourceEventId: "verification-start",
    timestamp: "2026-09-01T00:15:00.000Z",
    toolName: "powershell",
    trust: "tool",
    worktree: "C:\\repo",
  });
  const verification = await queue.enqueue({
    adapter: "copilot-cli",
    adapterVersion: "1.0.82-0",
    branch: "feat/testing",
    completionStatus: "succeeded",
    eventType: "test.completed",
    operationId: "verify-correction",
    parentEventId: operation.envelope.event.eventId,
    repoId: "repo-1",
    sessionId: "session-correction",
    sourceEventId: "verification",
    timestamp: "2026-09-01T00:20:00.000Z",
    trust: "tool",
    worktree: "C:\\repo",
    verificationBinding: {
      correctionEventId: correction.envelope.event.eventId,
      operationEventId: operation.envelope.event.eventId,
    },
  });
  for (const item of [
    correction,
    operation,
    verification,
  ]) {
    expect(store.ingestQueueItem(item).status).toBe("stored");
  }
  store.replaceWorkEpisodeProjection({
    associations: [],
    corrections: [],
    episodes: [
      workEpisode([
        correction.envelope.event.eventId,
        operation.envelope.event.eventId,
        verification.envelope.event.eventId,
      ]),
    ],
  });
  new CorrectionCaptureProjector({
    store,
  }).rebuild();
  const lifecycle = new KnowledgeLifecycleProjector({
    store,
  }).rebuild();
  const candidate = lifecycle.candidates[0];
  if (candidate === undefined) {
    throw new Error("Expected correction-derived Knowledge.");
  }
  return candidate;
};

describe("Knowledge lifecycle projection", () => {
  it("preserves manual Knowledge and rebuilds state from feedback", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        manualKnowledge(),
      ]);
      const automatic = await seedLifecycle(root, store);
      expect(store.knowledgeCandidates()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            knowledgeId: "manual-knowledge-docs",
            state: "active",
          }),
          expect.objectContaining({
            knowledgeId: automatic.knowledgeId,
            evidenceTier: "externally_verified",
            state: "active",
          }),
        ]),
      );
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const retriever = new CanonicalKnowledgeRetriever({
        backend,
        store,
      });
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "Vitest",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            knowledgeId: automatic.knowledgeId,
          }),
        }),
      ]);
      const feedback: FeedbackEvent = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: "control:feedback-correct",
        feedbackId: "feedback-correct",
        kind: "correct",
        reason: "The guidance failed in a later applicable task.",
        source: "user",
        targetId: automatic.knowledgeId,
        targetType: "knowledge",
        timestamp: "2026-09-02T00:00:00.000Z",
      };
      store.recordKnowledgeFeedback({
        event: feedback,
        updateCandidate: (candidate) => ({
          ...candidate,
          evidenceTier: "disputed",
          state: "disputed",
          validatedAt: feedback.timestamp,
        }),
      });
      store.upsertKnowledgeCandidates([
        {
          ...automatic,
          evidenceTier: "externally_verified",
          state: "active",
        },
      ]);

      const rebuilt = new KnowledgeLifecycleProjector({
        store,
      }).rebuild();
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const replayed = rebuilt.candidates.find(
        (candidate) =>
          candidate.knowledgeId === automatic.knowledgeId,
      );

      expect(replayed).toMatchObject({
        evidenceTier: "disputed",
        state: "disputed",
        utility: {
          applied: 1,
          harmful: 1,
        },
        validatedAt: feedback.timestamp,
      });
      expect(
        store.knowledgeCandidates([
          "manual-knowledge-docs",
        ])[0],
      ).toEqual(manualKnowledge());
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "Vitest",
        }),
      ).resolves.toEqual([]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("does not resurrect forgotten correction Knowledge", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const automatic = await seedLifecycle(root, store);
      const deletion = store.beginDeletion(
        {
          targetId: automatic.knowledgeId,
          targetType: "knowledge",
        },
        "delete-correction-knowledge",
      );
      store.deleteCanonicalTarget(
        deletion.deletionId,
        {
          targetId: automatic.knowledgeId,
          targetType: "knowledge",
        },
      );

      const rebuilt = new KnowledgeLifecycleProjector({
        store,
      }).rebuild({
        allowDuringDeletion: true,
      });

      expect(rebuilt.candidates).toEqual([]);
      expect(rebuilt.suppressedForgottenKnowledgeIds).toEqual([
        automatic.knowledgeId,
      ]);
      expect(
        store.knowledgeCandidates([
          automatic.knowledgeId,
        ]),
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("fails retrieval closed after same-Episode self recall", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const automatic = await seedLifecycle(root, store);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      await expect(
        new ContextRetrievalService({
          backend,
          idGenerator: () => "context-self-recall",
          now: () => new Date("2026-09-01T00:15:00.000Z"),
          store,
        }).context({
          cwd: root,
          prompt: "Run package validation with Vitest",
          repoId: "repo-1",
          sessionId: "session-correction",
          tokenBudget: 1_200,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            id: automatic.knowledgeId,
            kind: "knowledge",
          },
        ],
        status: "ok",
      });
      expect(
        store.contextUseRecords("session-correction")[0]?.episodeId,
      ).toBeUndefined();
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: store.workEpisodes(),
      });
      expect(
        store.contextUseRecords("session-correction")[0]?.episodeId,
      ).toBe("episode-correction");

      expect(
        store.knowledgeAdmissionEvidence([
          automatic,
        ]).contextUseRecords,
      ).toHaveLength(1);
      await expect(
        new CanonicalKnowledgeRetriever({
          backend,
          store,
        }).search({
          limit: 3,
          repositoryScopeId: "repo-1",
          text: "Vitest",
        }),
      ).resolves.toEqual([]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });
});
