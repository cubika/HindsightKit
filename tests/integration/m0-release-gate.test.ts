import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PROVENLOOP_VERSION } from "@provenloop/contracts";

import {
  type M0AcceptanceEvidence,
  runEvaluation,
  runM0ReleaseGate,
  verifyM0SuiteEvidence,
} from "@provenloop/evaluation";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-m0-gate-"),
  );
  temporaryDirectories.push(directory);
  await Promise.all(["1", "2", "3", "4", "5"].map((value) =>
    writeFile(join(directory, `artifact-${value}.json`), JSON.stringify({ fixtureArtifact: value }), "utf8"),
  ));
  return directory;
};

const digest = (suffix: string): string =>
  createHash("sha256").update(JSON.stringify({ fixtureArtifact: suffix })).digest("hex");

const passingEvidence = (
  codeVersion: string,
  runtimeDigest: string,
): M0AcceptanceEvidence => ({
  binding: {
    captureRunIds: [
      "capture-run-1",
    ],
    codeVersion,
    copilotCliVersion: "1.0.82-0",
    fixtureVersion: 1,
    operatingSystemVersions: [
      "Windows-10",
      "Windows-11",
    ],
    pluginVersion: PROVENLOOP_VERSION,
    probeVersion: 1,
    reportDigests: [
      digest("1"),
      digest("2"),
      digest("3"),
      digest("4"),
      digest("5"),
    ],
    reportArtifacts: ["1", "2", "3", "4", "5"].map((value) => ({
      path: `artifact-${value}.json`,
      sha256: digest(value),
    })),
    runtimeDigest,
  },
  capabilityIsolation: {
    automatedTestPassed: true,
    captureDisabledPassed: true,
    correctionLearningDisabledPassed: true,
    installedProbePassed: true,
    reportDigest: digest("1"),
    retrievalDisabledPassed: true,
    status: "pass",
    workerDisabledPassed: true,
  },
  capture: {
    callbackWorkDurationP95Ms: 1,
    duplicateCanonicalFactCount: 0,
    foregroundAddedLatencyP95Ms: 10,
    foregroundBlockingFailureCount: 0,
    internalSessionPersistenceCount: 0,
    missingRequiredEventCount: 0,
    reportDigest: digest("2"),
    seededSecretPersistenceCount: 0,
    status: "pass",
    windows10RepresentativeEventCount: 500,
    windows11RepresentativeEventCount: 500,
  },
  doctor: {
    onlineClassifications: [
      "available",
      "signed_out",
      "rate_limited",
      "incompatible",
      "unavailable",
    ],
    passiveCredentialInspection: false,
    passiveModelRequestCount: 0,
    passiveStatus: "unverified",
    reportDigest: digest("3"),
    status: "pass",
  },
  evidenceVersion: 1,
  marketplaceUpgrade: {
    disableEnablePassed: true,
    fromVersion: "0.0.0",
    knowledgeDataPreserved: true,
    queueDataPreserved: true,
    repeatedInstallPassed: true,
    reportDigest: digest("4"),
    settingsRestoredExactly: true,
    source: "cubika/ProvenLoop",
    status: "pass",
    toVersion: PROVENLOOP_VERSION,
    uninstallPreservedData: true,
  },
  observedGuardrails: {
    crossRepositoryLeakageCount: 0,
    deletionPropagationFailureCount: 0,
    foregroundBlockingFailureCount: 0,
    internalSessionPersistenceCount: 0,
    secretPersistenceCount: 0,
  },
  providerDegradation: {
    backlogDurable: true,
    boundedRetry: true,
    foregroundUsable: true,
    incompatible: "pass",
    rateLimited: "pass",
    reportDigest: digest("5"),
    signedOut: "pass",
    status: "pass",
    unavailable: "pass",
  },
});

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

describe("M0 aggregate release gate", () => {
  it("retains passing deterministic evidence and explicit blockers", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-test-run",
    });

    expect(result.report).toMatchObject({
      codeVersion: "test-code-version",
      exitCode: 1,
      status: "blocked",
      episodeAssociation: {
        status: "pass",
      },
    });
    expect(result.report.suites).toHaveLength(11);
    expect(
      result.report.suites.every((suite) => suite.verified),
    ).toBe(true);
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "deterministic-evaluation-suites",
          status: "pass",
        }),
        expect.objectContaining({
          checkId: "capture-latency-windows",
          status: "blocked",
        }),
      ]),
    );
    expect(
      JSON.parse(
        await readFile(
          join(result.runDirectory, "m0-report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      status: "blocked",
    });
    expect(
      await readFile(
        join(result.runDirectory, "m0-report.md"),
        "utf8",
      ),
    ).toContain("Known failures and limitations");
    for (const suite of result.report.suites) {
      expect(
        await readFile(
          join(result.runDirectory, suite.reportPath),
          "utf8",
        ),
      ).toContain('"reportVersion": 1');
    }
  });

  it("does not overwrite a prior run with the same run ID", async () => {
    const outputRoot = await createTemporaryDirectory();
    const first = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-stable-run",
    });

    const original = await readFile(
      join(first.runDirectory, "m0-report.json"),
      "utf8",
    );

    await expect(
      runM0ReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId: "m0-stable-run",
      }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(
      await readFile(
        join(first.runDirectory, "m0-report.json"),
        "utf8",
      ),
    ).toBe(original);
  });

  it("passes when version-bound acceptance evidence meets every threshold", async () => {
    const outputRoot = await createTemporaryDirectory();
    const baseline = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-evidence-baseline",
    });
    const evidencePath = join(outputRoot, "m0-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        passingEvidence(
          baseline.report.codeVersion,
          baseline.report.runtimeDigest,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      evidencePath,
      outputRoot,
      runId: "m0-evidence-pass",
    });

    expect(result.report).toMatchObject({
      exitCode: 0,
      status: "pass",
    });
    expect(
      result.report.checks.every((check) => check.status === "pass"),
    ).toBe(true);
  });

  it("uses invalid-input exit code 2 for mismatched evidence bindings", async () => {
    const outputRoot = await createTemporaryDirectory();
    const baseline = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-mismatch-baseline",
    });

    const evidencePath = join(outputRoot, "m0-mismatch.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        passingEvidence(
          "another-code-version",
          baseline.report.runtimeDigest,
        ),
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      evidencePath,
      outputRoot,
      runId: "m0-mismatch",
    });

    expect(result.report).toMatchObject({
      exitCode: 2,
      status: "fail",
    });
    expect(result.report.checks[0]).toMatchObject({
      checkId: "m0-input",
    });
  });

  it("accepts PowerShell 5.1 BOM-prefixed acceptance evidence", async () => {
    const outputRoot = await createTemporaryDirectory();
    const baseline = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-bom-baseline",
    });
    const evidencePath = join(outputRoot, "m0-bom.json");
    await writeFile(
      evidencePath,
      `\uFEFF${JSON.stringify(
        passingEvidence(
          baseline.report.codeVersion,
          baseline.report.runtimeDigest,
        ),
      )}\n`,
      "utf8",
    );

    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      evidencePath,
      outputRoot,
      runId: "m0-bom-pass",
    });

    expect(result.report).toMatchObject({
      exitCode: 0,
      status: "pass",
    });
  });

  it("rejects incomplete and secret-bearing acceptance evidence", async () => {
    const outputRoot = await createTemporaryDirectory();
    const incompletePath = join(outputRoot, "incomplete.json");
    await writeFile(incompletePath, "{}\n", "utf8");

    const incomplete = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      evidencePath: incompletePath,
      outputRoot,
      runId: "m0-incomplete",
    });
    expect(incomplete.report.exitCode).toBe(2);

    const baseline = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m0-secret-baseline",
    });
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const secretPath = join(outputRoot, "secret.json");
    await writeFile(
      secretPath,
      `${JSON.stringify({
        ...passingEvidence(
          baseline.report.codeVersion,
          baseline.report.runtimeDigest,
        ),
        binding: {
          ...passingEvidence(
            baseline.report.codeVersion,
            baseline.report.runtimeDigest,
          ).binding,
          copilotCliVersion: secret,
        },
      })}\n`,
      "utf8",
    );

    const secretResult = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      evidencePath: secretPath,
      outputRoot,
      runId: "m0-secret",
    });
    expect(secretResult.report.exitCode).toBe(2);
    expect(
      await readFile(
        join(secretResult.runDirectory, "m0-report.json"),
        "utf8",
      ),
    ).not.toContain(secret);
  });

  it("retains coherent failure reports when the Episode dataset is unavailable", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      episodeDatasetPath: join(outputRoot, "missing-dataset.json"),
      outputRoot,
      runId: "m0-failed-run",
    });

    expect(result.report).toMatchObject({
      exitCode: 3,
      status: "fail",
    });
    expect(result.report.episodeAssociation).toBeUndefined();
    expect(
      await readFile(
        join(result.runDirectory, "m0-report.json"),
        "utf8",
      ),
    ).toContain('"exitCode": 3');
    expect(
      await readFile(
        join(result.runDirectory, "m0-report.md"),
        "utf8",
      ),
    ).toContain("Episode association\n\n- Unavailable");
  });

  it("rejects unsafe or secret-bearing run identifiers", async () => {
    const outputRoot = await createTemporaryDirectory();

    await expect(
      runM0ReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId: "..\\escape",
      }),
    ).rejects.toThrow("safe non-secret path segment");
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    const result = await runM0ReleaseGate({
      codeVersion: secret,
      outputRoot,
      runId: "safe-run",
    });
    expect(result.report.exitCode).toBe(3);
    expect(
      await readFile(
        join(result.runDirectory, "m0-report.json"),
        "utf8",
      ),
    ).not.toContain(secret);
  });

  it("records a deterministic dirty working-tree code version", async () => {
    const root = await createTemporaryDirectory();
    const repository = join(root, "repository");
    const outputRoot = join(root, "runs");
    await mkdir(repository);
    const runGit = (args: readonly string[]): void => {
      const result = spawnSync("git", args, {
        cwd: repository,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || "git command failed");
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
    await writeFile(
      join(repository, "tracked.txt"),
      "changed\n",
      "utf8",
    );
    await writeFile(
      join(repository, "untracked.txt"),
      "untracked\n",
      "utf8",
    );

    const first = await runM0ReleaseGate({
      cwd: repository,
      outputRoot,
      runId: "dirty-one",
    });
    const second = await runM0ReleaseGate({
      cwd: repository,
      outputRoot,
      runId: "dirty-two",
    });

    expect(first.report.codeVersion).toMatch(
      /^[a-f0-9]{40}\+dirty\.[a-f0-9]{16}$/u,
    );
    expect(second.report.codeVersion).toBe(
      first.report.codeVersion,
    );
  });

  it("requires every frozen gate evidence ID to exist in its Ledger", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite: "valid-supported-event",
    });
    const corrupted = {
      ...result,
      report: {
        ...result.report,
        case: {
          ...result.report.case,
          evidenceIds: [
            "missing-ledger-id",
          ],
          gates: result.report.case.gates.map((gate) => ({
            ...gate,
            evidenceIds: [
              "missing-ledger-id",
            ],
          })),
        },
      },
    };

    await expect(
      verifyM0SuiteEvidence(corrupted),
    ).resolves.toBe(false);
  });

  it("uses infrastructure exit code 3 for suite infrastructure failures", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "suite-infrastructure",
      runSuite: async (options) => {
        const suite = await runEvaluation(options);
        return options.suite === "valid-supported-event"
          ? {
              ...suite,
              report: {
                ...suite.report,
                exitCode: 3,
                status: "infrastructure_error",
              },
            }
          : suite;
      },
    });

    expect(result.report).toMatchObject({
      exitCode: 3,
      status: "fail",
    });
    expect(result.report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "suite-infrastructure",
          status: "fail",
        }),
      ]),
    );
  });

  it("does not accept duplicate suite identities", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM0ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "duplicate-suite-identities",
      runSuite: async (options) =>
        runEvaluation({
          ...options,
          suite: "valid-supported-event",
        }),
    });

    expect(result.report).toMatchObject({
      exitCode: 1,
      status: "fail",
    });
    expect(
      result.report.checks.find(
        (check) =>
          check.checkId === "deterministic-evaluation-suites",
      ),
    ).toMatchObject({
      status: "fail",
    });
  });

  it("retains an infrastructure report when Git provenance fails", async () => {
    const root = await createTemporaryDirectory();
    const notRepository = join(root, "not-a-repository");
    await mkdir(notRepository);
    await writeFile(join(notRepository, ".git"), "gitdir: missing-git-directory\n", "utf8");
    const result = await runM0ReleaseGate({
      cwd: notRepository,
      outputRoot: join(root, "runs"),
      runId: "git-failure",
    });

    expect(result.report).toMatchObject({
      codeVersion: "unavailable",
      exitCode: 3,
      status: "fail",
    });
    expect(result.report.checks[0]?.message).toContain(
      "Git provenance command failed",
    );
  });
});
