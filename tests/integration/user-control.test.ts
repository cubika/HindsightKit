import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  runCli,
  type CliDependencies,
  type CliIo,
} from "@provenloop/cli";
import {
  CURRENT_SCHEMA_VERSION,
  feedbackEventSchema,
  type AgentAdapter,
  type KnowledgeCandidate,
} from "@provenloop/contracts";
import {
  KnowledgeControlService,
} from "@provenloop/host";
import { TrustedSessionContextPublisher } from "@provenloop/copilot-adapter";
import {
  resolveWindowsProvenLoopPaths,
} from "@provenloop/platform-windows";
import {
  branchScopeIdFor,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-user-control-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

const fakeAdapter = (): AgentAdapter => ({
  capabilities: vi.fn(async () => ({
    adapter: "copilot-cli",
    capabilities: [],
    compatibility: "supported" as const,
  })),
  disable: vi.fn(async () => ({
    message: "disabled",
    status: "changed" as const,
  })),
  doctor: vi.fn(async () => ({
    adapter: "copilot-cli",
    checkedAt: "2026-08-31T00:00:00.000Z",
    checks: [],
    status: "healthy" as const,
  })),
  enable: vi.fn(async () => ({
    message: "enabled",
    status: "changed" as const,
  })),
  install: vi.fn(async () => ({
    message: "installed",
    status: "changed" as const,
  })),
  normalizeEvent: vi.fn(() => ({
    status: "ignored",
  })),
  registerCaptureExtension: vi.fn(async () => ({
    message: "registered",
    status: "changed" as const,
  })),
  registerContextTools: vi.fn(async () => ({
    message: "registered",
    status: "changed" as const,
  })),
  resolveSession: vi.fn(async (context) => ({
    branch: "feat/user-control",
    commitSha: "abc123",
    internalSession: false,
    repositoryId: "repo-1",
    repositoryRoot: context.cwd,
    sessionId: context.sessionId,
    worktreePath: context.cwd,
  })),
  status: vi.fn(async () => ({
    capabilities: {
      adapter: "copilot-cli",
      capabilities: [],
      compatibility: "supported" as const,
    },
    dataRoot: "C:\\data",
    installed: true,
    marketplaceRegistered: true,
    pluginEnabled: true,
    pluginInstalled: true,
  })),
  uninstall: vi.fn(async () => ({
    message: "uninstalled",
    status: "changed" as const,
  })),
  upgrade: vi.fn(async () => ({
    message: "upgraded",
    status: "changed" as const,
  })),
});

const cliHarness = (
  adapter: AgentAdapter,
): {
  readonly dependencies: CliDependencies;
  readonly errors: string[];
  readonly io: CliIo;
  readonly logs: string[];
} => {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    dependencies: {
      createAdapter: () => adapter,
      runMcpServer: vi.fn(async () => undefined),
    },
    errors,
    io: {
      error: (message) => errors.push(message),
      log: (message) => logs.push(message),
    },
    logs,
  };
};

const dependentCandidate = (
  knowledgeId: string,
): KnowledgeCandidate => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  appliesWhen: [
    "The remembered rule applies.",
  ],
  conflictsWith: [
    knowledgeId,
  ],
  content: "Dependent guidance.",
  coverage: {
    applicableOpportunities: 1,
    observedOutcomes: 1,
  },
  createdAt: "2026-08-31T00:00:00.000Z",
  evidenceMarks: [
    "user_confirmed",
  ],
  evidenceTier: "user_confirmed",
  importance: 1,
  kind: "semantic",
  knowledgeId: "dependent-knowledge",
  nonApplicability: [],
  scope: "repository",
  scopeId: "repo-1",
  sourceEpisodeIds: [],
  sourceEvidenceIds: [],
  state: "active",
  supersedes: knowledgeId,
  topicKey: "dependent-topic",
  utility: {
    applied: 0,
    harmful: 0,
    helpful: 0,
  },
  validatedAt: "2026-08-31T00:00:00.000Z",
});

describe("M1 user control", () => {
  it("remembers, corrects, mutes, and forgets Knowledge through stable CLI commands", async () => {
    const root = await createTemporaryDirectory();
    const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data, {
      recursive: true,
    });
    await writeFile(paths.rootMarker, "{}\n", "utf8");
    new CanonicalSqliteStore(paths.database).close();
    const harness = cliHarness(fakeAdapter());
    const rememberArgs = [
      "remember",
      "--content",
      "Run focused tests before the full suite.",
      "--when",
      "Changing package behavior.",
      "--not-when",
      "Editing documentation only.",
      "--scope",
      "branch",
      "--cwd",
      "C:\\repo",
      "--data-root",
      root,
    ];

    await expect(
      runCli(
        rememberArgs,
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        rememberArgs,
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    let store = new CanonicalSqliteStore(paths.database);
    const remembered = store.knowledgeCandidates()[0];
    if (remembered === undefined) {
      throw new Error("Expected remembered Knowledge.");
    }
    expect(store.knowledgeCandidates()).toHaveLength(1);
    expect(remembered).toMatchObject({
      appliesWhen: [
        "Changing package behavior.",
      ],
      content: "Run focused tests before the full suite.",
      evidenceTier: "user_confirmed",
      nonApplicability: [
        "Editing documentation only.",
      ],
      scope: "branch",
      scopeId: branchScopeIdFor(
        "repo-1",
        "feat/user-control",
      ),
      state: "active",
    });
    store.upsertKnowledgeCandidates([
      dependentCandidate(remembered.knowledgeId),
    ]);
    store.appendContextUseRecord({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appliedKnowledgeIds: [
        `knowledge:${remembered.knowledgeId}`,
      ],
      candidateKnowledgeIds: [
        remembered.knowledgeId,
      ],
      createdAt: "2026-08-31T00:00:00.000Z",
      latencyMs: 1,
      renderedTokens: 10,
      requestId: "request-user-control",
      returnedKnowledgeIds: [
        `knowledge:${remembered.knowledgeId}`,
      ],
      sessionId: "session-control",
    });
    store.close();

    await expect(
      runCli(
        [
          "correct",
          remembered.knowledgeId,
          "--reason",
          "The rule needs revision.",
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "mute",
          remembered.knowledgeId,
          "--session",
          "session-control",
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    store = new CanonicalSqliteStore(paths.database);
    expect(
      store.knowledgeCandidates([
        remembered.knowledgeId,
      ])[0],
    ).toMatchObject({
      evidenceTier: "disputed",
      state: "disputed",
    });
    expect(store.sessionMuted("session-control")).toBe(true);
    store.close();

    await expect(
      runCli(
        [
          "forget",
          remembered.knowledgeId,
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    store = new CanonicalSqliteStore(paths.database);
    const remaining = store.knowledgeCandidates();
    expect(remaining.map((item) => item.knowledgeId)).toEqual([
      "dependent-knowledge",
    ]);
    expect(remaining[0]).toMatchObject({
      conflictsWith: [],
      state: "archived",
    });
    expect(remaining[0]).not.toHaveProperty("supersedes");
    expect(store.feedbackEvents()).toEqual([]);
    expect(store.contextUseRecords()).toEqual([]);
    expect(store.sessionMuted("session-control")).toBe(false);
    expect(() =>
      store.upsertKnowledgeCandidates([
        remembered,
      ]),
    ).toThrow("was forgotten and cannot be restored");
    store.close();

    const backend = new SqliteFtsKnowledgeBackend(
      paths.knowledgeDatabase,
    );
    try {
      await expect(
        backend.get(remembered.knowledgeId),
      ).resolves.toBeUndefined();
      await expect(
        backend.get("dependent-knowledge"),
      ).resolves.toBeDefined();
    } finally {
      await backend.closeAsync();
    }

    await expect(
      runCli(
        [
          "forget",
          remembered.knowledgeId,
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    expect(harness.logs.some((message) =>
      message.startsWith("Remembered Knowledge "),
    )).toBe(true);
    expect(harness.logs.some((message) =>
      message.includes("marked disputed"),
    )).toBe(true);
    expect(harness.logs.some((message) =>
      message.includes("muted for Session"),
    )).toBe(true);
    expect(harness.logs.some((message) =>
      message.startsWith("Forget completed:"),
    )).toBe(true);
  });

  it("reviews and explicitly replaces disputed Knowledge through the installed CLI route", async () => {
    const root = await createTemporaryDirectory();
    const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data, { recursive: true });
    await writeFile(paths.rootMarker, "{}\n", "utf8");
    new CanonicalSqliteStore(paths.database).close();
    const harness = cliHarness(fakeAdapter());
    const common = ["--scope", "repository", "--cwd", "C:\\repo", "--data-root", root];
    expect(await runCli([
      "remember", "--content", "Run every test.", "--when", "Changing code.",
      ...common,
    ], harness.io, harness.dependencies)).toBe(0);
    let store = new CanonicalSqliteStore(paths.database);
    const originalId = store.knowledgeCandidates()[0]?.knowledgeId;
    store.close();
    if (originalId === undefined) {
      throw new Error("Expected a remembered rule.");
    }
    expect(await runCli([
      "correct", originalId, "--data-root", root,
    ], harness.io, harness.dependencies)).toBe(0);
    expect(await runCli([
      "knowledge", "list", "--state", "disputed", ...common,
    ], harness.io, harness.dependencies)).toBe(0);
    expect(JSON.parse(harness.logs.at(-1) ?? "[]")).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ knowledgeId: originalId, state: "disputed" }),
      }),
    ]);
    expect(await runCli([
      "knowledge", "show", originalId, ...common,
    ], harness.io, harness.dependencies)).toBe(0);
    const review = JSON.parse(harness.logs.at(-1) ?? "{}") as {
      expectedDigest: string;
      unresolvedEvidenceIds: readonly string[];
    };
    const replacement = [
      "knowledge", "replace", originalId,
      "--content", "Run focused tests before the full suite.",
      "--expect", review.expectedDigest,
      "--resolve", review.unresolvedEvidenceIds.join(","),
      ...common,
    ];
    expect(await runCli(replacement, harness.io, harness.dependencies)).toBe(2);
    expect(await runCli([
      ...replacement, "--confirm",
    ], harness.io, harness.dependencies)).toBe(0);
    store = new CanonicalSqliteStore(paths.database);
    try {
      expect(store.knowledgeCandidates([originalId])[0]?.state).toBe("superseded");
      expect(store.knowledgeCandidates().find((item) => item.supersedes === originalId))
        .toMatchObject({
          content: "Run focused tests before the full suite.",
          evidenceTier: "user_confirmed",
          state: "active",
        });
    } finally {
      store.close();
    }
  });

  it("binds workflow review writes to the live SDK workspace", async () => {
    const root = await createTemporaryDirectory();
    const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data, { recursive: true });
    await writeFile(paths.rootMarker, JSON.stringify({
      product: "ProvenLoop", root: paths.root, schemaVersion: 1,
    }), "utf8");
    new CanonicalSqliteStore(paths.database).close();
    const sessionId = `workflow-${randomUUID()}`;
    vi.stubEnv("SESSION_ID", sessionId);
    const errors: unknown[] = [];
    const publisher = new TrustedSessionContextPublisher({
      cwd: root,
      dataRoot: root,
      sessionId,
      repositoryState: "known_outside_repo",
      workflowScopeId: "focused-validation",
      onError: (error) => errors.push(error),
    });
    const harness = cliHarness(fakeAdapter());
    const common = [
      "--scope", "workflow", "--workflow", "focused-validation",
      "--cwd", root, "--data-root", root,
    ];
    const remember = [
      "remember", "--content", "Run focused tests.", "--when", "Changing code.",
      ...common,
    ];
    const readCandidate = () => {
      const store = new CanonicalSqliteStore(paths.database);
      try {
        const candidate = store.knowledgeCandidates().find((item) => item.state === "active");
        if (candidate === undefined) throw new Error("Expected active workflow Knowledge.");
        return candidate;
      } finally {
        store.close();
      }
    };
    try {
      expect(await runCli(remember, harness.io, harness.dependencies)).toBe(3);
      await publisher.start();
      expect(await runCli(remember, harness.io, harness.dependencies)).toBe(0);
      let candidate = readCandidate();
      expect(candidate).toMatchObject({ scope: "workflow", scopeId: "focused-validation" });
      expect(await runCli([
        "knowledge", "list", ...common,
      ], harness.io, harness.dependencies)).toBe(0);
      expect(JSON.parse(harness.logs.at(-1) ?? "[]")).toHaveLength(1);

      for (const action of ["confirm", "replace"] as const) {
        expect(await runCli([
          "knowledge", "show", candidate.knowledgeId, ...common,
        ], harness.io, harness.dependencies)).toBe(0);
        const review = JSON.parse(harness.logs.at(-1) ?? "{}") as { expectedDigest: string };
        expect(await runCli([
          "knowledge", action, candidate.knowledgeId,
          "--expect", review.expectedDigest, "--confirm",
          ...(action === "replace" ? ["--content", "Run focused tests before merging."] : []),
          ...common,
        ], harness.io, harness.dependencies)).toBe(0);
        candidate = readCandidate();
      }
      expect(candidate.content).toBe("Run focused tests before merging.");
      expect(await runCli(remember.map((value) =>
        value === "focused-validation" ? "other-workflow" : value,
      ), harness.io, harness.dependencies)).toBe(3);
      expect(await runCli([
        "knowledge", "list", "--scope", "workflow", "--workflow", "focused-validation",
        "--cwd", join(root, "other"), "--data-root", root,
      ], harness.io, harness.dependencies)).toBe(3);
      await publisher.stop();
      expect(await runCli([
        "knowledge", "list", ...common,
      ], harness.io, harness.dependencies)).toBe(3);
      expect(errors).toEqual([]);
    } finally {
      await publisher.stop();
    }
  });

  it("rejects potential secrets before remembering them", async () => {
    const root = await createTemporaryDirectory();
    const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data, {
      recursive: true,
    });
    await writeFile(paths.rootMarker, "{}\n", "utf8");
    new CanonicalSqliteStore(paths.database).close();
    const harness = cliHarness(fakeAdapter());

    await expect(
      runCli(
        [
          "remember",
          "--content",
          "Use token ghp_1234567890abcdefghijklmnopqrst",
          "--when",
          "Running deployment.",
          "--scope",
          "repository",
          "--cwd",
          "C:\\repo",
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(3);
    expect(harness.errors).toEqual([
      "Remember rejected content that may contain a secret.",
    ]);
    const store = new CanonicalSqliteStore(paths.database);
    expect(store.knowledgeCandidates()).toEqual([]);
    store.close();
  });

  it("rejects secrets in workflow scope and correction reason", async () => {
    const root = await createTemporaryDirectory();
    const paths = resolveWindowsProvenLoopPaths(root);
    await mkdir(paths.data, {
      recursive: true,
    });
    await writeFile(paths.rootMarker, "{}\n", "utf8");
    new CanonicalSqliteStore(paths.database).close();
    const harness = cliHarness(fakeAdapter());
    const token = "ghp_1234567890abcdefghijklmnopqrst";

    await expect(
      runCli(
        [
          "remember",
          "--content",
          "Use focused deployment validation.",
          "--when",
          "Running deployment.",
          "--scope",
          "workflow",
          "--workflow",
          token,
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(3);
    await expect(
      runCli(
        [
          "remember",
          "--content",
          "Use focused deployment validation.",
          "--when",
          "Running deployment.",
          "--scope",
          "repository",
          "--cwd",
          "C:\\repo",
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(0);
    const store = new CanonicalSqliteStore(paths.database);
    const remembered = store.knowledgeCandidates()[0];
    store.close();
    if (remembered === undefined) {
      throw new Error("Expected remembered Knowledge.");
    }
    await expect(
      runCli(
        [
          "correct",
          remembered.knowledgeId,
          "--reason",
          `token=${token}`,
          "--data-root",
          root,
        ],
        harness.io,
        harness.dependencies,
      ),
    ).resolves.toBe(3);

    const verification = new CanonicalSqliteStore(paths.database);
    expect(verification.feedbackEvents()).toEqual([]);
    expect(
      verification.knowledgeCandidates()[0]?.state,
    ).toBe("active");
    verification.close();
  });

  it("reads remembered state only after acquiring the shared lease", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const input = {
      appliesWhen: [
        "Changing package behavior.",
      ],
      content: "Run focused tests.",
      scope: "repository" as const,
      scopeId: "repo-1",
    };
    const immediate = new KnowledgeControlService({
      projection: {
        acquireLease: async () => ({
          release: async () => undefined,
        }),
        rebuild: async () => undefined,
      },
      store,
    });
    const remembered = await immediate.remember(input);
    if (remembered.candidate === undefined) {
      throw new Error("Expected remembered Knowledge.");
    }
    let allowAcquire: (() => void) | undefined;
    let enteredAcquire: (() => void) | undefined;
    const acquireEntered = new Promise<void>((resolve) => {
      enteredAcquire = resolve;
    });
    const acquireGate = new Promise<void>((resolve) => {
      allowAcquire = resolve;
    });
    const blocked = new KnowledgeControlService({
      projection: {
        acquireLease: async () => {
          enteredAcquire?.();
          await acquireGate;
          return {
            release: async () => undefined,
          };
        },
        rebuild: async () => undefined,
      },
      store,
    });

    const repeatedRemember = blocked.remember(input);
    await acquireEntered;
    store.recordKnowledgeFeedback({
      event: feedbackEventSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: "concurrent-correction",
        feedbackId: "concurrent-correction",
        kind: "correct",
        source: "user",
        targetId: remembered.candidate.knowledgeId,
        targetType: "knowledge",
        timestamp: "2026-08-31T01:00:00.000Z",
      }),
      updateCandidate: (candidate) => ({
        ...candidate,
        evidenceTier: "disputed",
        state: "disputed",
      }),
    });
    allowAcquire?.();
    await repeatedRemember;

    expect(
      store.knowledgeCandidates([
        remembered.candidate.knowledgeId,
      ])[0],
    ).toMatchObject({
      evidenceTier: "disputed",
      state: "disputed",
    });
    store.close();
  });

  it("does not report Session mute before acquiring the shared lease", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const candidate = dependentCandidate("other");
    store.upsertKnowledgeCandidates([
      candidate,
    ]);
    let allowAcquire: (() => void) | undefined;
    let enteredAcquire: (() => void) | undefined;
    const acquireEntered = new Promise<void>((resolve) => {
      enteredAcquire = resolve;
    });
    const acquireGate = new Promise<void>((resolve) => {
      allowAcquire = resolve;
    });
    const service = new KnowledgeControlService({
      projection: {
        acquireLease: async () => {
          enteredAcquire?.();
          await acquireGate;
          return {
            release: async () => undefined,
          };
        },
        rebuild: async () => undefined,
      },
      store,
    });

    const muting = service.mute({
      knowledgeId: candidate.knowledgeId,
      sessionId: "session-lease",
    });
    await acquireEntered;
    expect(store.sessionMuted("session-lease")).toBe(false);
    allowAcquire?.();
    await muting;
    expect(store.sessionMuted("session-lease")).toBe(true);
    store.close();
  });

  it("allows the same correction after Knowledge is reactivated", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    const projection = {
      acquireLease: async () => ({
        release: async () => undefined,
      }),
      rebuild: async () => undefined,
    };
    const service = new KnowledgeControlService({
      projection,
      store,
    });
    const remembered = await service.remember({
      appliesWhen: [
        "Changing package behavior.",
      ],
      content: "Run focused tests.",
      scope: "repository",
      scopeId: "repo-1",
    });
    if (remembered.candidate === undefined) {
      throw new Error("Expected remembered Knowledge.");
    }
    const knowledgeId = remembered.candidate.knowledgeId;

    await expect(service.correct({
      knowledgeId,
      reason: "The rule is incorrect.",
    })).resolves.toMatchObject({
      changed: true,
    });
    await expect(service.correct({
      knowledgeId,
      reason: "The rule is incorrect.",
    })).resolves.toMatchObject({
      changed: false,
    });
    store.recordKnowledgeFeedback({
      event: feedbackEventSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        evidenceRef: "reactivate",
        feedbackId: "reactivate",
        kind: "confirm",
        source: "user",
        targetId: knowledgeId,
        targetType: "knowledge",
        timestamp: "2026-08-31T02:00:00.000Z",
      }),
      updateCandidate: (candidate) => ({
        ...candidate,
        evidenceTier: "user_confirmed",
        state: "active",
      }),
    });
    await expect(service.correct({
      knowledgeId,
      reason: "The rule is incorrect.",
    })).resolves.toMatchObject({
      changed: true,
      candidate: {
        evidenceTier: "disputed",
        state: "disputed",
      },
    });
    expect(
      store.feedbackEvents(knowledgeId).filter(
        (event) => event.kind === "correct",
      ),
    ).toHaveLength(2);
    store.close();
  });

  it("retries projection rebuild after a committed correction", async () => {
    const root = await createTemporaryDirectory();
    const store = new CanonicalSqliteStore(
      join(root, "canonical.db"),
    );
    let rebuildAttempts = 0;
    const service = new KnowledgeControlService({
      projection: {
        acquireLease: async () => ({
          release: async () => undefined,
        }),
        rebuild: async () => {
          rebuildAttempts += 1;
          if (rebuildAttempts === 1) {
            throw new Error("temporary rebuild failure");
          }
        },
      },
      store,
    });
    const remembered = await new KnowledgeControlService({
      projection: {
        acquireLease: async () => ({
          release: async () => undefined,
        }),
        rebuild: async () => undefined,
      },
      store,
    }).remember({
      appliesWhen: [
        "Changing package behavior.",
      ],
      content: "Run focused tests.",
      scope: "repository",
      scopeId: "repo-1",
    });
    if (remembered.candidate === undefined) {
      throw new Error("Expected remembered Knowledge.");
    }

    await expect(service.correct({
      knowledgeId: remembered.candidate.knowledgeId,
      reason: "The rule is incorrect.",
    })).rejects.toThrow("temporary rebuild failure");
    await expect(service.correct({
      knowledgeId: remembered.candidate.knowledgeId,
      reason: "The rule is incorrect.",
    })).resolves.toMatchObject({
      changed: false,
      candidate: {
        evidenceTier: "disputed",
        state: "disputed",
      },
    });
    expect(rebuildAttempts).toBe(2);
    store.close();
  });
});
