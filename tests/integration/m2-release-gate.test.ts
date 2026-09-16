import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  loadCorrectionRecurrenceDataset,
  runM2ReleaseGate,
} from "@provenloop/evaluation";
import {
  CanonicalKnowledgeRetriever,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-m2-gate-"),
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

describe("M2 aggregate release gate", () => {
  it("retains a passing research report and replay databases", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m2-test-run",
    });

    expect(result.report).toMatchObject({
      codeVersion: "test-code-version",
      correctionRecurrence: {
        status: "pass",
      },
      automaticLearning: { status: "insufficient_evidence" },
      exitCode: 0,
      releaseTarget: "research",
      status: "pass",
    });
    expect(result.report.checks).toHaveLength(8);
    expect(
      result.report.checks.every((check) => check.status === "pass"),
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          join(result.runDirectory, "m2-report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      status: "pass",
    });
    expect(
      await readFile(
        join(result.runDirectory, "m2-report.md"),
        "utf8",
      ),
    ).toContain("Correction Recurrence Evaluation");
    expect(
      await readFile(
        join(result.runDirectory, "correction-recurrence.db"),
      ),
    ).not.toHaveLength(0);
    expect(
      await readFile(
        join(
          result.runDirectory,
          "correction-recurrence-knowledge.db",
        ),
      ),
    ).not.toHaveLength(0);
    const recurrence = result.report.correctionRecurrence;
    if (recurrence === undefined) {
      throw new Error("Expected Correction Recurrence report.");
    }
    const store = new CanonicalSqliteStore(
      join(result.runDirectory, "correction-recurrence.db"),
    );
    const backend = new SqliteFtsKnowledgeBackend(
      join(
        result.runDirectory,
        "correction-recurrence-knowledge.db",
      ),
    );
    try {
      const persistedOpportunities =
        store.correctionOpportunities();
      for (const testCase of recurrence.opportunities) {
        expect(
          persistedOpportunities.find(
            (opportunity) =>
              opportunity.episodeId ===
                `episode-context-${testCase.caseId}`,
          ),
        ).toMatchObject({
          correctionRepeated:
            testCase.contextCorrectionRepeated,
          knowledgeAppliedBeforeCorrection:
            testCase.contextKnowledgeAppliedBeforeCorrection,
          knowledgeAvailableBeforeCorrection: true,
        });
      }
      const wrong = recurrence.opportunities.find(
        (testCase) => testCase.contextCorrectionRepeated,
      );
      const helpful = recurrence.opportunities.find(
        (testCase) => !testCase.contextCorrectionRepeated,
      );
      if (
        wrong?.knowledgeId === undefined ||
        helpful?.knowledgeId === undefined
      ) {
        throw new Error(
          "Expected wrong and helpful Knowledge cases.",
        );
      }
      expect(
        store.knowledgeCandidates([
          wrong.knowledgeId,
        ])[0],
      ).toMatchObject({
        evidenceTier: "disputed",
        state: "disputed",
      });
      expect(
        store.knowledgeCandidates([
          helpful.knowledgeId,
        ])[0],
      ).toMatchObject({
        state: "active",
      });
      const retriever = new CanonicalKnowledgeRetriever({
        backend,
        store,
      });
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: `repo-${wrong.caseId}`,
          text: `package validation ${wrong.caseId}`,
        }),
      ).resolves.toEqual([]);
      await expect(
        retriever.search({
          limit: 3,
          repositoryScopeId: `repo-${helpful.caseId}`,
          text: `package validation ${helpful.caseId}`,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          candidate: expect.objectContaining({
            knowledgeId: helpful.knowledgeId,
          }),
        }),
      ]);
    } finally {
      await backend.closeAsync();
      store.close();
    }
  });

  it("supports the stable Wrong Injection threshold", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      releaseTarget: "stable",
      runId: "m2-stable-run",
    });

    expect(result.report).toMatchObject({
      correctionRecurrence: {
        thresholds: {
          wrongInjectionRate: 0.01,
        },
      },
      exitCode: 0,
      releaseTarget: "stable",
      status: "pass",
    });

  });

  it("retains an input-error report when the dataset is unavailable", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      datasetPath: join(outputRoot, "missing-dataset.json"),
      outputRoot,
      runId: "m2-failed-run",
    });

    expect(result.report).toMatchObject({
      exitCode: 2,
      status: "fail",
    });
    expect(result.report.correctionRecurrence).toBeUndefined();
    expect(
      await readFile(
        join(result.runDirectory, "m2-report.json"),
        "utf8",
      ),
    ).toContain('"exitCode": 2');
    expect(
      await readFile(
        join(result.runDirectory, "m2-report.json"),
        "utf8",
      ),
    ).not.toContain(outputRoot);
  });

  it("classifies a secret-bearing dataset as invalid input", async () => {
    const outputRoot = await createTemporaryDirectory();
    const dataset = await loadCorrectionRecurrenceDataset();
    const datasetPath = join(outputRoot, "unsafe-dataset.json");
    await writeFile(
      datasetPath,
      JSON.stringify({
        ...dataset,
        opportunities: dataset.opportunities.map(
          (testCase, index) =>
            index === 0
              ? {
                  ...testCase,
                  caseId:
                    "Q7wErTyUiOpAsDfGhJkLzXcVbNm1234567890",
                }
              : testCase,
        ),
      }),
    );

    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      datasetPath,
      outputRoot,
      runId: "m2-secret-input",
    });

    expect(result.report).toMatchObject({
      exitCode: 2,
      status: "fail",
    });
  });

  it("does not publish Markdown or paths from invalid datasets", async () => {
    const outputRoot = await createTemporaryDirectory();
    const dataset = await loadCorrectionRecurrenceDataset();
    const datasetPath = join(outputRoot, "unsafe-markdown.json");
    const remoteUrl = "https://example.invalid/private";
    await writeFile(
      datasetPath,
      JSON.stringify({
        ...dataset,
        datasetId: `![remote](${remoteUrl})`,
      }),
    );

    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      datasetPath,
      outputRoot,
      runId: "m2-markdown-input",
    });
    const json = await readFile(
      join(result.runDirectory, "m2-report.json"),
      "utf8",
    );
    const markdown = await readFile(
      join(result.runDirectory, "m2-report.md"),
      "utf8",
    );

    expect(result.report).toMatchObject({
      exitCode: 2,
      status: "fail",
    });
    expect(json).not.toContain(outputRoot);
    expect(json).not.toContain(remoteUrl);
    expect(markdown).not.toContain(outputRoot);
    expect(markdown).not.toContain(remoteUrl);
  });

  it("classifies normalized case ID collisions as invalid input", async () => {
    const outputRoot = await createTemporaryDirectory();
    const dataset = await loadCorrectionRecurrenceDataset();
    const datasetPath = join(outputRoot, "colliding-dataset.json");
    await writeFile(
      datasetPath,
      JSON.stringify({
        ...dataset,
        opportunities: dataset.opportunities.map(
          (testCase, index) =>
            index === 1
              ? {
                  ...testCase,
                  caseId:
                    dataset.opportunities[0]?.caseId.toUpperCase(),
                }
              : testCase,
        ),
      }),
    );

    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      datasetPath,
      outputRoot,
      runId: "m2-colliding-input",
    });

    expect(result.report).toMatchObject({
      exitCode: 2,
      status: "fail",
    });
  });

  it("rejects high-entropy code versions without persisting them", async () => {
    const outputRoot = await createTemporaryDirectory();
    const codeVersion =
      "Q7wErTyUiOpAsDfGhJkLzXcVbNm1234567890";
    const result = await runM2ReleaseGate({
      codeVersion,
      outputRoot,
      runId: "m2-secret-code-version",
    });

    expect(result.report).toMatchObject({
      codeVersion: "unavailable",
      exitCode: 2,
      status: "fail",
    });
    expect(
      await readFile(
        join(result.runDirectory, "m2-report.json"),
        "utf8",
      ),
    ).not.toContain(codeVersion);
  });

  it("accepts SHA-1 and SHA-256 code versions with dirty markers", async () => {
    const outputRoot = await createTemporaryDirectory();
    const codeVersions = [
      "a".repeat(40),
      "b".repeat(64),
      `${"c".repeat(40)}-dirty`,
      `${"d".repeat(64)}-dirty`,
      `${"e".repeat(64)}+dirty.${"f".repeat(16)}`,
    ];

    for (const [index, codeVersion] of codeVersions.entries()) {
      const result = await runM2ReleaseGate({
        codeVersion,
        datasetPath: join(outputRoot, "missing-dataset.json"),
        outputRoot,
        runId: `m2-git-version-${index}`,
      });

      expect(result.report).toMatchObject({
        codeVersion,
        exitCode: 2,
        status: "fail",
      });
    }
  });

  it("length-frames dirty working-tree provenance inputs", async () => {
    const root = await createTemporaryDirectory();
    const repository = join(root, "repository");
    const outputRoot = join(root, "runs");
    await mkdir(repository);
    const runGit = (args: readonly string[]): void => {
      const process = spawnSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        windowsHide: true,
      });
      if (process.status !== 0) {
        throw new Error(process.stderr || "git command failed");
      }
    };
    runGit([
      "init",
    ]);
    runGit([
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    runGit([
      "config",
      "user.name",
      "ProvenLoop Test",
    ]);
    runGit([
      "config",
      "core.autocrlf",
      "false",
    ]);
    runGit([
      "config",
      "core.safecrlf",
      "false",
    ]);
    await writeFile(
      join(repository, "tracked.txt"),
      "initial\n",
      "utf8",
    );
    runGit([
      "add",
      "tracked.txt",
    ]);
    runGit([
      "commit",
      "-m",
      "initial",
    ]);
    await writeFile(join(repository, "a"), "", "utf8");
    await writeFile(join(repository, "b"), "bx", "utf8");
    const first = await runM2ReleaseGate({
      cwd: repository,
      datasetPath: join(root, "missing-dataset.json"),
      outputRoot,
      runId: "m2-framed-one",
    });

    await writeFile(join(repository, "a"), "b", "utf8");
    await writeFile(join(repository, "b"), "x", "utf8");
    const second = await runM2ReleaseGate({
      cwd: repository,
      datasetPath: join(root, "missing-dataset.json"),
      outputRoot,
      runId: "m2-framed-two",
    });

    expect(first.report.codeVersion).toMatch(
      /^[a-f0-9]{40}\+dirty\.[a-f0-9]{16}$/u,
    );
    expect(second.report.codeVersion).not.toBe(
      first.report.codeVersion,
    );
  });

  it("does not overwrite an earlier run", async () => {
    const outputRoot = await createTemporaryDirectory();
    await runM2ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m2-existing-run",
    });

    await expect(
      runM2ReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId: "m2-existing-run",
      }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("rejects high-entropy custom run IDs", async () => {
    const outputRoot = await createTemporaryDirectory();

    await expect(
      runM2ReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId:
          "Q7wErTyUiOpAsDfGhJkLzXcVbNm1234567890",
      }),
    ).rejects.toThrow("safe non-secret");
  });

  it("replaces a partial publish with an infrastructure report", async () => {
    const outputRoot = await createTemporaryDirectory();
    const runId = "m2-partial-write";
    const runDirectory = join(outputRoot, runId);
    const stagingDirectory = join(
      outputRoot,
      `.${runId}.staging`,
    );
    let finalVisibleBeforePublish = false;
    let clockCalls = 0;
    const result = await runM2ReleaseGate({
      codeVersion: "test-code-version",
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) {
          finalVisibleBeforePublish = existsSync(runDirectory);
          mkdirSync(
            join(stagingDirectory, "m2-report.json"),
          );
        }
        return new Date(
          `2026-09-01T00:00:0${Math.min(clockCalls, 9)}.000Z`,
        );
      },
      outputRoot,
      runId,
    });

    expect(finalVisibleBeforePublish).toBe(false);
    expect(existsSync(stagingDirectory)).toBe(false);
    expect(result.report).toMatchObject({
      exitCode: 3,
      status: "fail",
    });
    expect(
      JSON.parse(
        await readFile(
          join(result.runDirectory, "m2-report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      exitCode: 3,
      status: "fail",
    });
    expect(
      await readFile(
        join(result.runDirectory, "m2-report.md"),
        "utf8",
      ),
    ).toContain("Status | **FAIL**");
  });
});
