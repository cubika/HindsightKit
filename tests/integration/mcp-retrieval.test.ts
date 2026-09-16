import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  type ContextUseRecord,
  type KnowledgeCandidate,
  type Scope,
} from "@provenloop/contracts";
import {
  BranchContextProjector,
  DeletionService,
  WorkEpisodeProjector,
} from "@provenloop/host";
import {
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import {
  ContextRetrievalService as BaseContextRetrievalService,
  KnowledgeProjectionManager,
  MAX_CONTEXT_TOKENS,
  SqliteFtsKnowledgeBackend,
  branchScopeIdFor,
  estimateRenderedTokens,
  knowledgeProjectionFromCandidate,
  type ContextFeedbackAction,
  type KnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

class ContextRetrievalService extends BaseContextRetrievalService {
  public override feedback(
    request: Parameters<BaseContextRetrievalService["feedback"]>[0],
  ) {
    return super.feedback({
      source: "user",
      userReportedApplied:
        request.action === "helpful" || request.action === "wrong",
      ...request,
    });
  }
}

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-mcp-retrieval-"),
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

const candidate = (input: {
  readonly content?: string;
  readonly evidenceTier?: KnowledgeCandidate["evidenceTier"];
  readonly id: string;
  readonly nonApplicability?: readonly string[];
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
    `Use ${input.id} guidance for package validation.`,
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: "2026-08-31T00:00:00.000Z",
  evidenceMarks: [
    "externally_verified",
  ],
  evidenceTier:
    input.evidenceTier ?? "externally_verified",
  importance: 1,
  kind: "procedural",
  knowledgeId: input.id,
  nonApplicability: [
    ...(input.nonApplicability ?? []),
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
    ...(input.sourceEvidenceIds ?? []),
  ],
  state: input.state ?? "active",
  topicKey: `topic-${input.id}`,
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-08-31T00:00:00.000Z",
});

const useRecord = (input: {
  readonly kind?: "branch_context" | "knowledge";
  readonly requestId: string;
  readonly sessionId: string;
  readonly targetId: string;
}): ContextUseRecord => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliedKnowledgeIds: [],
  candidateKnowledgeIds:
    input.kind === "branch_context"
      ? []
      : [
          input.targetId,
        ],
  createdAt: "2026-08-31T00:00:00.000Z",
  latencyMs: 1,
  renderedTokens: 10,
  requestId: input.requestId,
  returnedKnowledgeIds: [
    `${
      input.kind === "branch_context"
        ? "branch-context"
        : "knowledge"
    }:${input.targetId}`,
  ],
  sessionId: input.sessionId,
});

describe("M1 context retrieval", () => {
  it("returns scoped Branch Context and Knowledge within budget without session repeats", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.replaceBranchContextProjection({
        contexts: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            acceptedDecisions: [
              "Keep retrieval backend-neutral.",
            ],
            branch: "feat/mcp",
            branchContextId: "branch-context-mcp",
            sourceSessionIds: ["session-1"],
            explicitConstraints: [
              "Fail closed on degradation.",
            ],
            goal: "Wire MCP retrieval.",
            headSha: "abc123",
            implementationState: [
              "Knowledge backend is ready.",
            ],
            recentVerificationEvidenceIds: [],
            repoId: "repo-1",
            sourceEpisodeIds: [],
            sourceEventIds: [],
            unfinishedItems: [
              "Implement MCP tools.",
            ],
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        ],
      });
      store.upsertKnowledgeCandidates([
        candidate({
          content:
            "Run npm test before merging package changes.",
          id: "package-validation",
          nonApplicability: [
            "Editing migration manifests.",
          ],
          scopeId: "repo-1",
        }),
        candidate({
          content:
            "Run npm test before merging another repository.",
          id: "other-repository",
          scopeId: "repo-2",
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      let sequence = 0;
      const service = new ContextRetrievalService({
        backend,
        clockMs: () => 10,
        idGenerator: () => `request-${sequence += 1}`,
        now: () => new Date("2026-08-31T01:00:00.000Z"),
        store,
        timeoutMs: 5_000,
      });

      const first = await service.context({
        branch: "feat/mcp",
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt: "Run package validation with npm test.",
        repoId: "repo-1",
        sessionId: "session-1",
        tokenBudget: 500,
      });

      expect(first.status).toBe("ok");
      expect(first.items.map((item) => item.id)).toEqual([
        "branch-context-mcp",
        "package-validation",
      ]);
      expect(first.items).toHaveLength(2);
      expect(first.items.map((item) => item.id))
        .not.toContain("other-repository");
      expect(first.renderedTokens).toBeLessThanOrEqual(500);
      expect(first.renderedTokens).toBe(
        estimateRenderedTokens(JSON.stringify(first.items)),
      );

      const repeated = await service.context({
        branch: "feat/mcp",
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt: "Run package validation with npm test.",
        repoId: "repo-1",
        sessionId: "session-1",
        tokenBudget: 500,
      });
      expect(repeated.items).toEqual([]);

      const concurrent = await Promise.all([
        service.context({
          branch: "feat/mcp",
          cwd: "C:\\repo",
          headSha: "abc123",
          prompt: "Run package validation with npm test.",
          repoId: "repo-1",
          sessionId: "session-concurrent",
          tokenBudget: 500,
        }),
        service.context({
          branch: "feat/mcp",
          cwd: "C:\\repo",
          headSha: "abc123",
          prompt: "Run package validation with npm test.",
          repoId: "repo-1",
          sessionId: "session-concurrent",
          tokenBudget: 500,
        }),
      ]);
      expect(
        concurrent.flatMap((response) =>
          response.items.map((item) => item.id),
        ),
      ).toEqual([
        "package-validation",
      ]);

      const negative = await service.context({
        branch: "feat/mcp",
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt:
          "Run package validation while editing migration manifests.",
        repoId: "repo-1",
        sessionId: "session-negative",
        tokenBudget: 500,
      });
      expect(negative.items.map((item) => item.id))
        .not.toContain("package-validation");

      const tinyBudget = await service.context({
        branch: "feat/mcp",
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt: "Run package validation with npm test.",
        repoId: "repo-1",
        sessionId: "session-tiny",
        tokenBudget: 1,
      });
      expect(tinyBudget.items).toEqual([]);
      expect(tinyBudget.renderedTokens).toBeLessThanOrEqual(1);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("binds branch-scoped Knowledge to repository and branch identity", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        candidate({
          content: "Use repository one branch validation.",
          id: "repo-one-branch",
          scope: "branch",
          scopeId: branchScopeIdFor("repo-1", "main"),
        }),
        candidate({
          content: "Use repository two branch validation.",
          id: "repo-two-branch",
          scope: "branch",
          scopeId: branchScopeIdFor("repo-2", "main"),
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const response = await new ContextRetrievalService({
        backend,
        store,
      }).context({
        branch: "main",
        cwd: "C:\\repo-two",
        prompt: "Use branch validation.",
        repoId: "repo-2",
        sessionId: "session-branch-scope",
        tokenBudget: 300,
      });

      expect(response.items.map((item) => item.id)).toEqual([
        "repo-two-branch",
      ]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("filters potential secrets again before rendering", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        candidate({
          content:
            "Use token ghp_1234567890abcdefghijklmnopqrst for validation.",
          id: "secret-guidance",
          scopeId: "repo-1",
        }),
        {
          ...candidate({
            content: "Use safe token validation.",
            id: "generated-topic",
            scopeId: "repo-1",
          }),
          topicKey: "manual:9b1f9cafb5efd3f26414d33c",
        },
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const response = await new ContextRetrievalService({
        backend,
        store,
      }).context({
        cwd: "C:\\repo",
        prompt: "Use token validation.",
        repoId: "repo-1",
        sessionId: "session-secret-filter",
        tokenBudget: 300,
      });

      expect(response).toMatchObject({
        status: "ok",
      });
      expect(response.items.map((item) => item.id)).toEqual([
        "generated-topic",
      ]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("filters Branch Context with a secret-bearing branch name", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const branch = "ghp_1234567890abcdefghijklmnopqrst";
      store.replaceBranchContextProjection({
        contexts: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            acceptedDecisions: [],
            branch,
            branchContextId: "branch-context-secret",
            sourceSessionIds: ["session-secret-branch"],
            explicitConstraints: [],
            headSha: "abc123",
            implementationState: [
              "Continue safe work.",
            ],
            recentVerificationEvidenceIds: [],
            repoId: "repo-1",
            sourceEpisodeIds: [],
            sourceEventIds: [],
            unfinishedItems: [],
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        ],
      });
      const response = await new ContextRetrievalService({
        backend,
        store,
      }).context({
        branch,
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt: "Continue safe work.",
        repoId: "repo-1",
        sessionId: "session-secret-branch",
        tokenBudget: 300,
      });

      expect(response.items).toEqual([]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("rejects secrets in MCP feedback reason and resolved scope", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const target = candidate({
        id: "secret-feedback",
        scopeId: "repo-1",
      });
      store.upsertKnowledgeCandidates([
        target,
      ]);
      store.appendContextUseRecord(useRecord({
        requestId: "request-secret-feedback",
        sessionId: "session-secret-feedback",
        targetId: target.knowledgeId,
      }));
      const service = new ContextRetrievalService({
        backend,
        store,
      });
      const token = "ghp_1234567890abcdefghijklmnopqrst";

      await expect(service.feedback({
        action: "wrong",
        reason: `token=${token}`,
        requestId: "request-secret-feedback",
        sessionId: "session-secret-feedback",
        targetId: target.knowledgeId,
      })).rejects.toThrow(
        "Feedback rejected content that may contain a secret.",
      );
      await expect(service.feedback({
        action: "set_scope",
        repositoryScopeId: token,
        requestId: "request-secret-feedback",
        scope: "repository",
        sessionId: "session-secret-feedback",
        targetId: target.knowledgeId,
      })).rejects.toThrow(
        "Feedback rejected content that may contain a secret.",
      );
      expect(store.feedbackEvents()).toEqual([]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("clamps rendered context to the global token ceiling", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates(
        [
          "large-one",
          "large-two",
          "large-three",
        ].map((id) =>
          candidate({
            content: `test ${id} ${"test ".repeat(480)}`,
            id,
            scope: "personal",
          }),
        ),
      );
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const response = await new ContextRetrievalService({
        backend,
        store,
      }).context({
        cwd: "C:\\repo",
        prompt: "Run package validation tests",
        sessionId: "session-global-budget",
        tokenBudget: 4_096,
      });

      expect(response.items).toHaveLength(2);
      expect(response.renderedTokens).toBeLessThanOrEqual(
        MAX_CONTEXT_TOKENS,
      );
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("explains only items previously returned to the same session", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        candidate({
          content:
            "Run focused tests before the full package suite.",
          id: "focused-tests",
          scopeId: "repo-1",
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const service = new ContextRetrievalService({
        backend,
        idGenerator: () => "explain",
        now: () => new Date("2026-08-31T01:00:00.000Z"),
        store,
      });
      const response = await service.context({
        cwd: "C:\\repo",
        prompt: "Run focused tests.",
        repoId: "repo-1",
        sessionId: "session-explain",
        tokenBudget: 300,
      });
      const item = response.items[0];
      if (item === undefined) {
        throw new Error("Expected retrieved Knowledge.");
      }

      expect(service.explain({
        explanationRef: item.explanationRef,
        sessionId: "session-explain",
      })).toMatchObject({
        currentState: "active",
        evidenceTier: "externally_verified",
        id: "focused-tests",
        kind: "knowledge",
        status: "available",
      });
      expect(service.explain({
        explanationRef: item.explanationRef,
        sessionId: "other-session",
      })).toEqual({
        explanationRef: item.explanationRef,
        status: "not_previously_retrieved",
      });
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("does not authorize Knowledge through a colliding Branch Context ID", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.replaceBranchContextProjection({
        contexts: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            acceptedDecisions: [],
            branch: "feat/collision",
            branchContextId: "collision",
            sourceSessionIds: ["session-collision"],
            explicitConstraints: [],
            headSha: "abc123",
            implementationState: [
              "Continue branch work.",
            ],
            recentVerificationEvidenceIds: [],
            repoId: "repo-1",
            sourceEpisodeIds: [],
            sourceEventIds: [],
            unfinishedItems: [],
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        ],
      });
      store.upsertKnowledgeCandidates([
        candidate({
          content: "Use unrelated deployment guidance.",
          id: "collision",
          scopeId: "repo-1",
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const service = new ContextRetrievalService({
        backend,
        idGenerator: () => "collision",
        store,
        timeoutMs: 5_000,
      });
      const response = await service.context({
        branch: "feat/collision",
        cwd: "C:\\repo",
        headSha: "abc123",
        prompt: "Continue branch work.",
        repoId: "repo-1",
        sessionId: "session-collision",
        tokenBudget: 300,
      });

      expect(response.items.map((item) => item.kind)).toEqual([
        "branch_context",
      ]);
      expect(service.explain({
        explanationRef: "knowledge:collision",
        sessionId: "session-collision",
      })).toMatchObject({
        status: "not_previously_retrieved",
      });
      await expect(service.feedback({
        action: "wrong",
        requestId: response.requestId,
        sessionId: "session-collision",
        targetId: "collision",
      })).resolves.toEqual({
        status: "not_previously_retrieved",
      });
      expect(
        store.knowledgeCandidates([
          "collision",
        ])[0]?.state,
      ).toBe("active");
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("redacts potential secrets from explanation provenance", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      const episodeId = "episode-secret-explanation";
      store.replaceWorkEpisodeProjection({
        associations: [],
        corrections: [],
        episodes: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            associationConfidence: 1,
            associationEvidenceIds: [],
            branches: [],
            commitIds: [],
            correctionEventIds: [],
            episodeId,
            goal:
              "Use ghp_1234567890abcdefghijklmnopqrst during deployment.",
            issueIds: [],
            outcome: "unknown",
            outcomeEvidenceIds: [],
            outcomeQualification: "open",
            pullRequestIds: [],
            repoId: "repo-1",
            sessionIds: [
              "session-secret-explanation",
            ],
            sourceEventIds: [],
            startedAt: "2026-08-31T00:00:00.000Z",
          },
        ],
      });
      store.upsertKnowledgeCandidates([
        candidate({
          content: "Run deployment validation.",
          id: "safe-explanation",
          scopeId: "repo-1",
          sourceEpisodeIds: [
            episodeId,
          ],
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const service = new ContextRetrievalService({
        backend,
        store,
        timeoutMs: 5_000,
      });
      const response = await service.context({
        cwd: "C:\\repo",
        prompt: "Run deployment validation.",
        repoId: "repo-1",
        sessionId: "session-secret-explanation",
        tokenBudget: 300,
      });
      const explanation = service.explain({
        explanationRef:
          response.items[0]?.explanationRef ?? "",
        sessionId: "session-secret-explanation",
      });

      expect(JSON.stringify(explanation)).not.toContain(
        "ghp_1234567890abcdefghijklmnopqrst",
      );
      expect(JSON.stringify(explanation)).toContain("[REDACTED]");
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("records every deterministic feedback action and applies safety transitions", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    const actions: readonly {
      readonly action: ContextFeedbackAction;
      readonly branchScopeId?: string;
      readonly expectedKind: string;
      readonly id: string;
      readonly repositoryScopeId?: string;
      readonly scope?: Scope;
    }[] = [
      {
        action: "helpful",
        expectedKind: "strengthen",
        id: "helpful",
      },
      {
        action: "irrelevant",
        expectedKind: "irrelevant",
        id: "irrelevant",
      },
      {
        action: "wrong",
        expectedKind: "correct",
        id: "wrong",
      },
      {
        action: "stale",
        expectedKind: "stale",
        id: "stale",
      },
      {
        action: "confirm",
        expectedKind: "confirm",
        id: "confirm",
      },
      {
        action: "confirm",
        expectedKind: "confirm",
        id: "confirm-strong",
      },
      {
        action: "revoke",
        expectedKind: "revoke",
        id: "revoke",
      },
      {
        action: "mute_session",
        expectedKind: "mute_session",
        id: "mute",
      },
      {
        action: "set_scope",
        expectedKind: "set_scope",
        id: "scope",
        scope: "personal",
      },
      {
        action: "set_scope",
        branchScopeId: "main",
        expectedKind: "set_scope",
        id: "scope-branch",
        repositoryScopeId: "repo-1",
        scope: "branch",
      },
    ];
    try {
      store.upsertKnowledgeCandidates(
        [
          ...actions.map((action) =>
            candidate({
              ...(action.action === "confirm" &&
              action.id === "confirm"
                ? {
                    evidenceTier: "inferred",
                    state: "candidate",
                  }
                : {}),
              id: action.id,
              scopeId: "repo-1",
            }),
          ),
          candidate({
            id: "concurrent",
            scopeId: "repo-1",
          }),
        ],
      );
      for (const action of actions) {
        expect(store.appendContextUseRecord(useRecord({
          requestId: `request-${action.id}`,
          sessionId: `session-${action.id}`,
          targetId: action.id,
        }))).toBe(true);
      }
      for (const sequence of [
        1,
        2,
      ]) {
        expect(store.appendContextUseRecord(useRecord({
          requestId: `request-concurrent-${sequence}`,
          sessionId: `session-concurrent-${sequence}`,
          targetId: "concurrent",
        }))).toBe(true);
      }
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const service = new ContextRetrievalService({
        backend,
        now: () => new Date("2026-08-31T02:00:00.000Z"),
        store,
        syncKnowledge: async (updated) => {
          await backend.index([
            knowledgeProjectionFromCandidate(updated),
          ]);
        },
      });

      for (const action of actions) {
        const response = await service.feedback({
          action: action.action,
          ...(action.branchScopeId === undefined
            ? {}
            : {
                branchScopeId: action.branchScopeId,
              }),
          requestId: `request-${action.id}`,
          ...(action.repositoryScopeId === undefined
            ? {}
            : {
                repositoryScopeId:
                  action.repositoryScopeId,
              }),
          ...(action.scope === undefined
            ? {}
            : {
                scope: action.scope,
              }),
          sessionId: `session-${action.id}`,
          targetId: action.id,
        });
        expect(response).toMatchObject({
          recordedKind: action.expectedKind,
          status: "recorded",
        });
      }

      const byId = new Map(
        store.knowledgeCandidates().map((item) => [
          item.knowledgeId,
          item,
        ]),
      );
      expect(byId.get("helpful")?.utility).toMatchObject({
        applied: 1,
        helpful: 1,
      });
      expect(byId.get("irrelevant")?.state).toBe("active");
      expect(byId.get("wrong")).toMatchObject({
        evidenceTier: "disputed",
        state: "disputed",
        utility: {
          applied: 1,
          harmful: 1,
        },
      });
      expect(byId.get("stale")).toMatchObject({
        expiresAt: "2026-08-31T02:00:00.000Z",
        state: "archived",
      });
      expect(byId.get("confirm")).toMatchObject({
        evidenceTier: "user_confirmed",
        state: "active",
      });
      expect(byId.get("confirm")?.evidenceMarks)
        .toContain("user_confirmed");
      expect(byId.get("confirm-strong")?.evidenceTier)
        .toBe("externally_verified");
      expect(byId.get("revoke")?.state).toBe("archived");
      expect(byId.get("scope")).toMatchObject({
        scope: "personal",
      });
      expect(byId.get("scope")).not.toHaveProperty("scopeId");
      expect(byId.get("scope-branch")).toMatchObject({
        scope: "branch",
        scopeId: branchScopeIdFor("repo-1", "main"),
      });
      expect(Object.fromEntries(
        store.feedbackEvents().map((event) => [
          event.targetId,
          event.kind,
        ]),
      )).toEqual(Object.fromEntries(
        actions.map((action) => [
          action.id,
          action.expectedKind,
        ]),
      ));
      expect(
        store.contextUseRecords("session-wrong")[0],
      ).toMatchObject({
        appliedKnowledgeIds: [
          "knowledge:wrong",
        ],
        feedback: "wrong",
      });

      await expect(service.feedback({
        action: "helpful",
        requestId: "request-helpful",
        sessionId: "session-helpful",
        targetId: "helpful",
      })).resolves.toMatchObject({
        status: "already_recorded",
      });
      expect(
        store.knowledgeCandidates([
          "helpful",
        ])[0]?.utility.helpful,
      ).toBe(1);

      await Promise.all([
        service.feedback({
          action: "helpful",
          requestId: "request-concurrent-1",
          sessionId: "session-concurrent-1",
          targetId: "concurrent",
        }),
        service.feedback({
          action: "helpful",
          requestId: "request-concurrent-2",
          sessionId: "session-concurrent-2",
          targetId: "concurrent",
        }),
      ]);
      expect(
        store.knowledgeCandidates([
          "concurrent",
        ])[0]?.utility,
      ).toMatchObject({
        applied: 2,
        helpful: 2,
      });

      await expect(service.context({
        cwd: "C:\\repo",
        prompt: "Use mute guidance.",
        repoId: "repo-1",
        sessionId: "session-mute",
        tokenBudget: 300,
      })).resolves.toMatchObject({
        items: [],
        status: "muted",
      });
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("retries projection synchronization for idempotent feedback", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        candidate({
          id: "projection-retry",
          scopeId: "repo-1",
        }),
      ]);
      store.appendContextUseRecord(useRecord({
        requestId: "request-projection-retry",
        sessionId: "session-projection-retry",
        targetId: "projection-retry",
      }));
      let attempts = 0;
      const service = new ContextRetrievalService({
        backend,
        store,
        syncKnowledge: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary projection failure");
          }
        },
      });
      const request = {
        action: "helpful" as const,
        requestId: "request-projection-retry",
        sessionId: "session-projection-retry",
        targetId: "projection-retry",
      };

      await expect(service.feedback(request)).resolves.toMatchObject({
        projectionStatus: "degraded",
        status: "recorded",
      });
      await expect(service.feedback(request)).resolves.toMatchObject({
        projectionStatus: "synchronized",
        status: "already_recorded",
      });
      expect(attempts).toBe(2);
      expect(
        store.knowledgeCandidates([
          "projection-retry",
        ])[0]?.utility.helpful,
      ).toBe(1);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("removes feedback and usage records when source deletion removes Knowledge", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        content: {
          message: "Source-backed retrieval guidance.",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-delete-records",
        sourceEventId: "delete-records",
        timestamp: "2026-08-31T00:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(item).status).toBe("stored");
      store.upsertKnowledgeCandidates([
        candidate({
          id: "delete-records",
          scopeId: "repo-1",
          sourceEvidenceIds: [
            item.envelope.event.eventId,
          ],
        }),
      ]);
      store.appendContextUseRecord(useRecord({
        requestId: "request-delete-records",
        sessionId: "session-delete-records",
        targetId: "delete-records",
      }));
      const backend = new SqliteFtsKnowledgeBackend(
        join(root, "knowledge.db"),
      );
      try {
        const service = new ContextRetrievalService({
          backend,
          store,
        });
        await service.feedback({
          action: "helpful",
          requestId: "request-delete-records",
          sessionId: "session-delete-records",
          targetId: "delete-records",
        });
      } finally {
        await backend.closeAsync();
      }

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-retrieval-records",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });

      expect(store.knowledgeCandidates()).toEqual([]);
      expect(store.feedbackEvents()).toEqual([]);
      expect(store.contextUseRecords()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("removes usage records when source deletion removes Branch Context", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/deleted-context",
        commitSha: "abc123",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-deleted-context",
        sourceEventId: "deleted-context",
        timestamp: "2026-08-31T00:00:00.000Z",
        trust: "user",
      });
      expect(store.ingestQueueItem(item).status).toBe("stored");
      store.replaceBranchContextProjection({
        contexts: [
          {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            acceptedDecisions: [],
            branch: "feat/deleted-context",
            branchContextId: "branch-context-deleted",
            explicitConstraints: [],
            headSha: "abc123",
            implementationState: [
              "Context exists.",
            ],
            recentVerificationEvidenceIds: [],
            repoId: "repo-1",
            sourceEpisodeIds: [],
            sourceEventIds: [
              item.envelope.event.eventId,
            ],
            unfinishedItems: [],
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
        ],
      });
      store.upsertKnowledgeCandidates([
        candidate({
          id: "branch-context-deleted",
          scopeId: "repo-1",
        }),
      ]);
      store.appendContextUseRecord(useRecord({
        kind: "branch_context",
        requestId: "request-deleted-context",
        sessionId: "session-deleted-context",
        targetId: "branch-context-deleted",
      }));

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-branch-context-source",
        targetId: item.envelope.event.eventId,
        targetType: "source",
      });

      expect(store.branchContexts()).toEqual([]);
      expect(store.knowledgeCandidates().map(
        (candidate) => candidate.knowledgeId,
      )).toEqual([
        "branch-context-deleted",
      ]);
      expect(store.contextUseRecords()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves same-ID Branch Context usage when Knowledge is deleted", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const branchPrompt = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/collision-delete",
        commitSha: "abc123",
        content: {
          message: [
            "Continue collision-safe Branch Context.",
            "Decision: Preserve typed retrieval references.",
          ].join("\n"),
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-branch-collision",
        sourceEventId: "branch-collision-prompt",
        timestamp: "2026-08-31T00:00:00.000Z",
        trust: "user",
      });
      const branchChange = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        branch: "feat/collision-delete",
        commitSha: "abc123",
        eventType: "file.changed",
        repoId: "repo-1",
        sessionId: "session-branch-collision",
        sourceEventId: "branch-collision-change",
        timestamp: "2026-08-31T00:01:00.000Z",
        trust: "tool",
      });
      const knowledgeSource = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        content: {
          message: "Unrelated Knowledge source.",
        },
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-knowledge-collision",
        sourceEventId: "knowledge-collision",
        timestamp: "2026-08-31T00:02:00.000Z",
        trust: "user",
      });
      for (const item of [
        branchPrompt,
        branchChange,
        knowledgeSource,
      ]) {
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      new WorkEpisodeProjector({
        store,
      }).rebuild();
      const context = new BranchContextProjector({
        store,
      }).rebuild().contexts.find(
        (candidate) =>
          candidate.branch === "feat/collision-delete",
      );
      if (context === undefined) {
        throw new Error("Expected collision Branch Context.");
      }
      store.upsertKnowledgeCandidates([
        candidate({
          id: context.branchContextId,
          scopeId: "repo-1",
          sourceEvidenceIds: [
            knowledgeSource.envelope.event.eventId,
          ],
        }),
      ]);
      store.appendContextUseRecord(useRecord({
        kind: "branch_context",
        requestId: "request-collision-delete",
        sessionId: "session-branch-collision",
        targetId: context.branchContextId,
      }));

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-knowledge-collision",
        targetId: knowledgeSource.envelope.event.eventId,
        targetType: "source",
      });

      expect(store.knowledgeCandidates()).toEqual([]);
      expect(store.branchContexts().map(
        (context) => context.branchContextId,
      )).toEqual([
        context.branchContextId,
      ]);
      expect(store.contextUseRecords().map(
        (record) => record.requestId,
      )).toEqual([
        "request-collision-delete",
      ]);
    } finally {
      store.close();
    }
  });

  it("removes session mute feedback when that Session is deleted", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const source = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-source",
        sourceEventId: "session-source",
        timestamp: "2026-08-31T00:00:00.000Z",
        trust: "user",
      });
      const deletedSession = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        eventType: "prompt.submitted",
        repoId: "repo-1",
        sessionId: "session-delete",
        sourceEventId: "session-delete",
        timestamp: "2026-08-31T00:01:00.000Z",
        trust: "user",
      });
      for (const item of [
        source,
        deletedSession,
      ]) {
        expect(store.ingestQueueItem(item).status).toBe("stored");
      }
      store.upsertKnowledgeCandidates([
        candidate({
          id: "surviving-knowledge",
          scopeId: "repo-1",
          sourceEvidenceIds: [
            source.envelope.event.eventId,
          ],
        }),
        candidate({
          id: "helpful-surviving",
          scopeId: "repo-1",
          sourceEvidenceIds: [
            source.envelope.event.eventId,
          ],
        }),
      ]);
      store.appendContextUseRecord(useRecord({
        requestId: "request-session-mute",
        sessionId: "session-delete",
        targetId: "surviving-knowledge",
      }));
      store.appendContextUseRecord(useRecord({
        requestId: "request-session-helpful",
        sessionId: "session-delete",
        targetId: "helpful-surviving",
      }));
      const backend = new SqliteFtsKnowledgeBackend(
        join(root, "knowledge.db"),
      );
      try {
        await new ContextRetrievalService({
          backend,
          store,
        }).feedback({
          action: "mute_session",
          requestId: "request-session-mute",
          sessionId: "session-delete",
          targetId: "surviving-knowledge",
        });
        await new ContextRetrievalService({
          backend,
          store,
        }).feedback({
          action: "helpful",
          requestId: "request-session-helpful",
          sessionId: "session-delete",
          targetId: "helpful-surviving",
        });
      } finally {
        await backend.closeAsync();
      }

      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-muted-session",
        targetId: "session-delete",
        targetType: "session",
      });

      const remaining = new Map(
        store.knowledgeCandidates().map((item) => [
          item.knowledgeId,
          item,
        ]),
      );
      expect([...remaining.keys()]).toEqual([
        "helpful-surviving",
        "surviving-knowledge",
      ]);
      expect(remaining.get("surviving-knowledge")?.state)
        .toBe("active");
      expect(remaining.get("helpful-surviving")?.state)
        .toBe("archived");
      expect(store.feedbackEvents()).toEqual([]);
      expect(store.contextUseRecords()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves an earlier Session mute when the latest mute target is deleted", async () => {
    const root = await createTemporaryDirectory();
    const queue = new WindowsCaptureQueue(join(root, "queue"));
    await queue.initialize();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    try {
      const sources = await Promise.all(
        [
          1,
          2,
        ].map((sequence) =>
          queue.enqueue({
            adapter: "copilot-cli",
            adapterVersion: "1.0.82-0",
            eventType: "prompt.submitted",
            repoId: "repo-1",
            sessionId: `session-mute-source-${sequence}`,
            sourceEventId: `mute-source-${sequence}`,
            timestamp:
              `2026-08-31T00:0${sequence}:00.000Z`,
            trust: "user",
          }),
        ),
      );
      for (const source of sources) {
        expect(store.ingestQueueItem(source).status).toBe("stored");
      }
      store.upsertKnowledgeCandidates(
        sources.map((source, index) =>
          candidate({
            id: `mute-target-${index + 1}`,
            scopeId: "repo-1",
            sourceEvidenceIds: [
              source.envelope.event.eventId,
            ],
          }),
        ),
      );
      for (const sequence of [
        1,
        2,
      ]) {
        store.appendContextUseRecord(useRecord({
          requestId: `request-mute-${sequence}`,
          sessionId: "session-multi-mute",
          targetId: `mute-target-${sequence}`,
        }));
      }
      const backend = new SqliteFtsKnowledgeBackend(
        join(root, "knowledge.db"),
      );
      try {
        const service = new ContextRetrievalService({
          backend,
          store,
        });
        for (const sequence of [
          1,
          2,
        ]) {
          await service.feedback({
            action: "mute_session",
            requestId: `request-mute-${sequence}`,
            sessionId: "session-multi-mute",
            targetId: `mute-target-${sequence}`,
          });
        }
      } finally {
        await backend.closeAsync();
      }
      expect(store.sessionMuted("session-multi-mute"))
        .toBe(true);
      const latestMute = store.feedbackEvents(
        "mute-target-2",
      )[0];
      if (latestMute === undefined) {
        throw new Error("Expected the latest mute feedback.");
      }
      expect(() =>
        store.recordKnowledgeFeedback({
          event: {
            ...latestMute,
            evidenceRef: "different-session",
          },
        }),
      ).toThrow(
        "Feedback ID already exists with different content.",
      );
      expect(store.sessionMuted("different-session"))
        .toBe(false);

      const latestSource = sources[1];
      if (latestSource === undefined) {
        throw new Error("Expected the latest mute source.");
      }
      await new DeletionService({
        queue,
        recordEvidence: async () => undefined,
        store,
      }).delete({
        deletionId: "delete-latest-mute-target",
        targetId: latestSource.envelope.event.eventId,
        targetType: "source",
      });

      expect(store.sessionMuted("session-multi-mute"))
        .toBe(true);
      expect(store.feedbackEvents().map(
        (event) => event.targetId,
      )).toEqual([
        "mute-target-1",
      ]);
    } finally {
      store.close();
    }
  });

  it("fails closed when the SQLite backend exceeds its deadline", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(root, "knowledge.db"),
    );
    try {
      store.upsertKnowledgeCandidates([
        candidate({
          id: "timeout",
          scopeId: "repo-1",
        }),
      ]);
      await new KnowledgeProjectionManager({
        backend,
        store,
      }).rebuild();
      const service = new ContextRetrievalService({
        backend,
        store,
        timeoutMs: 1,
      });
      await expect(service.context({
        cwd: "C:\\repo",
        prompt: "Find validation guidance.",
        repoId: "repo-1",
        sessionId: "session-timeout",
        tokenBudget: 300,
      })).resolves.toMatchObject({
        items: [],
        renderedTokens: 0,
        status: "degraded",
      });
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("does not reset the deadline while waiting for a same-session request", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const knowledge = candidate({
      id: "queued-deadline",
      scopeId: "repo-1",
    });
    store.upsertKnowledgeCandidates([
      knowledge,
    ]);
    const projection = knowledgeProjectionFromCandidate(knowledge);
    const backend: KnowledgeBackend = {
      get: async () => undefined,
      health: async () => ({
        fts5Available: true,
        quickCheck: "ok",
        recordCount: 1,
        status: "healthy",
      }),
      index: async () => undefined,
      rebuild: async () => undefined,
      remove: async () => undefined,
      search: async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 80);
        });
        return [
          {
            ...projection,
            score: 1,
          },
        ];
      },
    };
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const service = new ContextRetrievalService({
        backend,
        store,
        timeoutMs: 100,
      });
      const pending = Promise.all([
        service.context({
          cwd: "C:\\repo",
          prompt: "queued deadline guidance",
          repoId: "repo-1",
          sessionId: "session-queued-deadline",
          tokenBudget: 300,
        }),
        service.context({
          cwd: "C:\\repo",
          prompt: "queued deadline guidance",
          repoId: "repo-1",
          sessionId: "session-queued-deadline",
          tokenBudget: 300,
        }),
      ]);
      await vi.advanceTimersByTimeAsync(101);
      const responses = await pending;

      expect(responses.map((response) => response.status)).toEqual([
        "ok",
        "degraded",
      ]);
      expect(responses[1]).toMatchObject({
        items: [],
      });
    } finally {
      vi.useRealTimers();
      store.close();
    }
  });
});
